use std::sync::Mutex;

use futures_util::{StreamExt, stream};
use xw_agent::{
    AgentHost, AuxiliaryModelError, AuxiliaryModelRefFuture, CancellationToken, GenerationError, GenerationEvent,
    GenerationFuture, GenerationRequest, GenerationStream, ModelInfo, ModelInfoError, ModelInfoFuture,
};
use xw_agent_types::AgentMessage;
use xw_contracts::xiaowei::llm as pb;
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
            let response = crate::gateway_binding::xiaowei_llm_model_settings_service::GET_AUXILIARY_MODEL_REF
                .call(&client, xw_contracts::xiaowei::common::Empty {})
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

    fn generate(&self, request: GenerationRequest, cancellation: CancellationToken) -> GenerationFuture {
        let client = self.client.lock().unwrap().clone();
        Box::pin(async move {
            let client = client.ok_or(GenerationError::Unavailable)?;
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
                upstream = llm::GENERATE.stream(&client, request) => upstream.map_err(|_| unavailable())?,
            };
            // TypedResponseStream's lease cancels the remote source on drop, including
            // cancellation while next() is pending and rejection of a terminal message.
            let stream = stream::unfold((upstream, cancellation), |(mut upstream, cancellation)| async move {
                let result = tokio::select! {
                    biased;
                    _ = cancellation.cancelled() => return None,
                    event = upstream.next() => event?,
                };
                let event = result.map_err(|_| unavailable()).and_then(decode_event);
                Some((event, (upstream, cancellation)))
            });
            Ok(Box::pin(stream) as GenerationStream)
        })
    }
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
        Event::BlockDelta(_) => return Err(GenerationError::Failed("tools are not supported in text runs".into())),
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
