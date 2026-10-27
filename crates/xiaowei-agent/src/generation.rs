use std::sync::Mutex;

use futures_util::{StreamExt, stream};
use proto_llm_rs::xiaowei::llm as pb;
use xw_agent::{
    AgentHost, AuxiliaryModelError, AuxiliaryModelRefFuture, CancellationToken, GenerationError,
    GenerationEvent, GenerationFuture, GenerationRequest, GenerationStream, ModelInfo,
    ModelInfoError, ModelInfoFuture,
};
use xw_agent_types::AgentMessage;
use xw_gateway::Client;

use crate::{gateway_binding::xiaowei_llm_llm_service as llm, message_codec as codec};

#[derive(Default)]
pub(crate) struct GatewayGeneration {
    client: Mutex<Option<Client>>,
}

impl GatewayGeneration {
    pub fn bind(&self, client: Client) {
        *self.client.lock().unwrap() = Some(client);
    }
    pub fn clear(&self) {
        self.client.lock().unwrap().take();
    }
    pub fn ready(&self) -> bool {
        self.client.lock().unwrap().is_some()
    }
}

impl AgentHost for GatewayGeneration {
    fn get_model_info(&self, model_ref: String) -> ModelInfoFuture {
        let client = self.client.lock().unwrap().clone();
        Box::pin(async move {
            let client = client.ok_or(ModelInfoError::Unavailable)?;
            let info = llm::GET_MODEL_INFO
                .call(
                    &client,
                    pb::GetModelInfoRequest {
                        model_ref: model_ref.clone(),
                    },
                )
                .await
                .map_err(|error| {
                    if error.code == xw_gateway::ErrorCode::NotFound {
                        ModelInfoError::NotFound
                    } else {
                        ModelInfoError::Unavailable
                    }
                })?;
            if info.model_ref != model_ref
                || info.provider_name.trim().is_empty()
                || info.name.trim().is_empty()
                || !valid_budget(info.context_window)
                || !valid_budget(info.max_tokens)
                || info.max_tokens > info.context_window
                || !info.input.contains(&i32::from(pb::ModelInput::Text))
            {
                return Err(ModelInfoError::InvalidResponse);
            }
            let input_modalities = info
                .input
                .into_iter()
                .map(|input| match pb::ModelInput::try_from(input) {
                    Ok(pb::ModelInput::Text) => Ok(xw_agent_types::InputModality::Text),
                    Ok(pb::ModelInput::Image) => Ok(xw_agent_types::InputModality::Image),
                    _ => Err(ModelInfoError::InvalidResponse),
                })
                .collect::<Result<_, _>>()?;
            Ok(ModelInfo {
                model_ref,
                provider_name: info.provider_name,
                model_name: info.name,
                capabilities: xw_agent_types::ModelCapabilities {
                    input_modalities,
                    supports_reasoning: info.reasoning,
                    context_window: info.context_window as u64,
                    max_output_tokens: info.max_tokens as u64,
                },
            })
        })
    }

    fn get_auxiliary_model_ref(&self) -> AuxiliaryModelRefFuture {
        let client = self.client.lock().unwrap().clone();
        Box::pin(async move {
            let client = client.ok_or(AuxiliaryModelError::Unavailable)?;
            let response =
                crate::gateway_binding::xiaowei_llm_model_settings_service::GET_AUXILIARY_MODEL_REF
                    .call(&client, ())
                    .await
                    .map_err(|_| AuxiliaryModelError::Unavailable)?;
            if response
                .model_ref
                .as_ref()
                .is_some_and(|reference| reference.trim().is_empty() || reference.len() > 1024)
            {
                return Err(AuxiliaryModelError::InvalidResponse);
            }
            Ok(response.model_ref)
        })
    }

    fn generate(
        &self,
        request: GenerationRequest,
        cancellation: CancellationToken,
    ) -> GenerationFuture {
        let client = self.client.lock().unwrap().clone();
        Box::pin(async move {
            let client = client.ok_or(GenerationError::Unavailable)?;
            let session_id = request.session_id;
            let model_ref = request.model_ref.clone();
            let request = pb::GenerateRequest {
                model_ref: request.model_ref,
                system_prompt: request.system_prompt,
                temperature: request.temperature,
                max_tokens: request.max_tokens,
                messages: request
                    .messages
                    .into_iter()
                    .map(codec::encode_message)
                    .collect::<Result<_, _>>()
                    .map_err(|_| invalid())?,
                options: Some(pb::GenerationOptions {
                    session_id: Some(request.session_id.to_string()),
                    reasoning: request.reasoning,
                    ..Default::default()
                }),
                ..Default::default()
            };
            let upstream = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(GenerationError::Cancelled),
                upstream = llm::GENERATE.stream(&client, request) => {
                    upstream.map_err(|error| {
                        log_gateway_failure("open", session_id, &model_ref, &error);
                        unavailable()
                    })?
                },
            };
            // TypedResponseStream's lease cancels the remote source on drop, including
            // cancellation while next() is pending and rejection of a terminal message.
            let stream = stream::unfold(
                (upstream, cancellation, model_ref),
                move |(mut upstream, cancellation, model_ref)| async move {
                    let result = tokio::select! {
                        biased;
                        _ = cancellation.cancelled() => return None,
                        event = upstream.next() => event?,
                    };
                    let event = result
                        .map_err(|error| {
                            log_gateway_failure("consume", session_id, &model_ref, &error);
                            unavailable()
                        })
                        .and_then(decode_event);
                    Some((event, (upstream, cancellation, model_ref)))
                },
            );
            Ok(Box::pin(stream) as GenerationStream)
        })
    }
}

fn log_gateway_failure(
    stage: &str,
    session_id: xw_agent_types::SessionId,
    model_ref: &str,
    error: &xw_gateway::GatewayError,
) {
    log::warn!(
        "LLM Gateway stream failed stage={stage} session={session_id} \
         model={model_ref} code={:?}",
        error.code,
    );
}

fn invalid() -> GenerationError {
    GenerationError::Failed("invalid model response".into())
}
fn unavailable() -> GenerationError {
    GenerationError::Failed("model request failed; check model configuration".into())
}

fn decode_event(event: pb::GenerateEvent) -> Result<GenerationEvent, GenerationError> {
    use pb::generate_event::Event;
    Ok(match event.event.ok_or_else(invalid)? {
        Event::Started(_) => GenerationEvent::Started,
        Event::FirstSseReceived(event) => GenerationEvent::FirstSseReceived {
            received_at_ms: event.received_at_ms,
        },
        Event::TextDelta(d) => GenerationEvent::TextDelta {
            content_index: d.content_index,
            text: d.text,
        },
        Event::BlockDelta(d) if d.kind == "thinking" => GenerationEvent::ThinkingDelta {
            content_index: d.content_index,
            text: d.delta,
        },
        Event::BlockDelta(d) if d.kind == "toolcall" => GenerationEvent::ToolCallDelta {
            content_index: d.content_index,
            delta: d.delta,
        },
        Event::BlockDelta(_) => return Err(invalid()),
        Event::BlockStarted(b) => GenerationEvent::BlockStarted {
            content_index: b.content_index,
            block: codec::decode_block(b.block.ok_or_else(invalid)?).map_err(|_| invalid())?,
        },
        Event::BlockFinished(b) => GenerationEvent::BlockFinished {
            content_index: b.content_index,
            block: codec::decode_block(b.block.ok_or_else(invalid)?).map_err(|_| invalid())?,
        },
        Event::Usage(u) => GenerationEvent::Usage(codec::decode_usage(u).map_err(|_| invalid())?),
        Event::Finished(f) => {
            let message = f.message.ok_or_else(invalid)?;
            if message.stop_reason != f.reason {
                return Err(invalid());
            }
            let AgentMessage::Assistant(message) = codec::decode_message(pb::ChatMessage {
                message: Some(pb::chat_message::Message::Assistant(message)),
            })
            .map_err(|_| invalid())?
            else {
                return Err(invalid());
            };
            GenerationEvent::Finished(message)
        }
        Event::Failed(f) => {
            let partial = f
                .partial
                .map(|message| {
                    codec::decode_message(pb::ChatMessage {
                        message: Some(pb::chat_message::Message::Assistant(message)),
                    })
                })
                .transpose()
                .map_err(|_| invalid())?
                .and_then(|m| match m {
                    AgentMessage::Assistant(m) => Some(m),
                    _ => None,
                });
            GenerationEvent::Failed {
                error: unavailable(),
                partial,
            }
        }
    })
}

fn valid_budget(value: f64) -> bool {
    value.is_finite() && value > 0.0 && value.fract() == 0.0 && value <= 9_007_199_254_740_991.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use xw_agent_types::SessionId;
    use xw_gateway::{CallContext, ErrorCode, GatewayError, XwInvokeRegistry};

    struct Logs(Mutex<Vec<String>>);

    impl log::Log for Logs {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool {
            true
        }

        fn log(&self, record: &log::Record<'_>) {
            if record.target() == module_path!().trim_end_matches("::tests") {
                self.0.lock().unwrap().push(record.args().to_string());
            }
        }

        fn flush(&self) {}
    }

    static LOGS: Logs = Logs(Mutex::new(Vec::new()));

    #[tokio::test]
    async fn gateway_open_and_consumption_failures_log_safe_origin_context() {
        log::set_logger(&LOGS).unwrap();
        log::set_max_level(log::LevelFilter::Warn);

        let registry = XwInvokeRegistry::new();
        let adapter = GatewayGeneration::default();
        adapter.bind(registry.client(CallContext::trusted("test")));
        let session_id = SessionId::new();
        let request = GenerationRequest {
            session_id,
            model_ref: "fixture-model".into(),
            system_prompt: "private prompt".into(),
            messages: vec![],
            reasoning: None,
            temperature: None,
            max_tokens: None,
        };

        let result = adapter
            .generate(request.clone(), CancellationToken::new())
            .await;
        assert!(matches!(result, Err(GenerationError::Failed(_))));

        registry
            .register_owner(
                "llm",
                vec![llm::GENERATE.handler(|_, _| async {
                    Ok(stream::once(async {
                        Err::<pb::GenerateEvent, _>(GatewayError::new(
                            ErrorCode::HandlerError,
                            "private upstream response api-key",
                        ))
                    }))
                })],
                vec![],
            )
            .unwrap();
        let mut stream = adapter
            .generate(request, CancellationToken::new())
            .await
            .unwrap();
        assert!(matches!(
            stream.next().await,
            Some(Err(GenerationError::Failed(_)))
        ));

        let logs = LOGS.0.lock().unwrap();
        assert_eq!(logs.len(), 2);
        assert!(logs[0].contains("stage=open"));
        assert!(logs[0].contains("code=UnknownRoute"));
        assert!(logs[1].contains("stage=consume"));
        assert!(logs[1].contains("code=HandlerError"));
        for line in logs.iter() {
            assert!(line.contains(&session_id.to_string()));
            assert!(line.contains("model=fixture-model"));
            assert!(!line.contains("private"));
            assert!(!line.contains("api-key"));
        }
    }
}
