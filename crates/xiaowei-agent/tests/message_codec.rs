use xiaowei_agent::message_codec::*;
use xw_agent_types::{AgentMessage, ContentBlock, UsageCost};
use xw_contracts::xiaowei::llm as pb;

fn block(content: pb::content_block::Content) -> pb::ContentBlock {
    pb::ContentBlock { content: Some(content) }
}

fn usage() -> pb::TokenUsage {
    pb::TokenUsage {
        input: u64::MAX,
        output: 9007199254740993,
        cache_read: 23,
        cache_write: 7,
        total: 101,
        reasoning: Some(0),
        cache_write_1h: Some(u64::MAX),
        cost: Some(pb::UsageCost {
            input: 0.10000000000000002,
            output: 1.2345678901234567,
            cache_read: 0.0003,
            cache_write: f64::MIN_POSITIVE,
            total: f64::MAX,
        }),
    }
}

fn assistant() -> pb::AssistantMessage {
    pb::AssistantMessage {
        content: vec![
            block(pb::content_block::Content::Text(pb::TextContent {
                text: "前文\n```rust\nfn main() {}\n```".into(),
                signature: Some("text-signature".into()),
            })),
            block(pb::content_block::Content::Thinking(pb::ThinkingContent {
                text: "思考".into(),
                signature: Some(String::new()),
                redacted: false,
            })),
            block(pb::content_block::Content::ToolCall(pb::ToolCallContent {
                id: "call-1".into(),
                name: "Read".into(),
                arguments_json: Some(" {\"path\": \"a.txt\", \"n\": 9007199254740993} ".into()),
                thought_signature: Some("tool-signature".into()),
                namespace: Some("files".into()),
            })),
            block(pb::content_block::Content::Text(pb::TextContent {
                text: "中间文本".into(),
                signature: None,
            })),
            block(pb::content_block::Content::Thinking(pb::ThinkingContent {
                text: String::new(),
                signature: Some("redacted-signature".into()),
                redacted: true,
            })),
            block(pb::content_block::Content::ToolCall(pb::ToolCallContent {
                id: "call-2".into(),
                name: "OtherTool".into(),
                arguments_json: Some("{\"large\":1e400}".into()),
                thought_signature: None,
                namespace: Some(String::new()),
            })),
        ],
        api: "openai-responses".into(),
        provider: "original-provider".into(),
        model_id: "original-model".into(),
        usage: Some(usage()),
        stop_reason: pb::FinishReason::ToolUse as i32,
        timestamp_ms: i64::MAX,
        response_id: Some("response-1".into()),
        response_model: Some("upstream-model-version".into()),
        provider_thinking_level: Some("high".into()),
        raw_stop_reason: Some("requires_action".into()),
        end_turn: Some(false),
    }
}

fn roundtrip(message: pb::ChatMessage) {
    let domain = decode_message(message.clone()).unwrap();
    let json = serde_json::to_string(&domain).unwrap();
    let restored: AgentMessage = serde_json::from_str(&json).unwrap();
    assert_eq!(restored, domain);
    assert_eq!(encode_message(restored).unwrap(), message);
}

#[test]
fn complete_history_preserves_every_known_message_field() {
    let image = block(pb::content_block::Content::Image(pb::ImageContent {
        mime_type: "image/png".into(),
        data: (0..=255).collect(),
    }));
    let messages = vec![
        pb::chat_message::Message::User(pb::UserMessage {
            content: vec![
                block(pb::content_block::Content::Text(pb::TextContent {
                    text: "问题\n\"\\\t".into(),
                    signature: None,
                })),
                image.clone(),
            ],
            timestamp_ms: i64::MIN,
        }),
        pb::chat_message::Message::Assistant(assistant()),
        pb::chat_message::Message::ToolResult(pb::ToolResultMessage {
            tool_call_id: "call-1".into(),
            tool_name: "Read".into(),
            content: vec![
                image,
                block(pb::content_block::Content::Text(pb::TextContent {
                    text: "工具错误\n".into(),
                    signature: Some(String::new()),
                })),
            ],
            is_error: true,
            timestamp_ms: 1720000000123,
            details_json: Some(" [null, {\"count\":9007199254740993}, true] ".into()),
            added_tool_names: vec!["AddedA".into(), "AddedB".into()],
            usage: Some(usage()),
        }),
    ];

    for message in messages {
        roundtrip(pb::ChatMessage { message: Some(message) });
    }
}

#[test]
fn absent_and_present_empty_metadata_remain_distinct() {
    for present in [false, true] {
        let mut message = assistant();
        message.content.clear();
        message.usage = present.then_some(pb::TokenUsage {
            cost: present.then_some(pb::UsageCost::default()),
            ..Default::default()
        });
        message.response_id = present.then(String::new);
        message.response_model = present.then(String::new);
        message.provider_thinking_level = present.then(String::new);
        message.raw_stop_reason = present.then(String::new);
        message.end_turn = present.then_some(false);

        roundtrip(pb::ChatMessage {
            message: Some(pb::chat_message::Message::Assistant(message)),
        });
        roundtrip(pb::ChatMessage {
            message: Some(pb::chat_message::Message::ToolResult(pb::ToolResultMessage {
                details_json: present.then(|| "null".into()),
                usage: present.then_some(pb::TokenUsage::default()),
                ..Default::default()
            })),
        });
    }
}

#[test]
fn all_known_finish_reasons_roundtrip_without_guessing() {
    for reason in [
        pb::FinishReason::Unspecified,
        pb::FinishReason::Stop,
        pb::FinishReason::Length,
        pb::FinishReason::ToolUse,
        pb::FinishReason::Error,
        pb::FinishReason::Aborted,
    ] {
        let mut message = assistant();
        message.stop_reason = reason as i32;
        roundtrip(pb::ChatMessage {
            message: Some(pb::chat_message::Message::Assistant(message)),
        });
    }
}

#[test]
fn incomplete_tool_blocks_preserve_absent_arguments() {
    for signature in [None, Some(String::new())] {
        let original = block(pb::content_block::Content::ToolCall(pb::ToolCallContent {
            id: "partial".into(),
            name: "Read".into(),
            arguments_json: None,
            thought_signature: signature,
            namespace: None,
        }));
        let domain = decode_block(original.clone()).unwrap();
        let json = serde_json::to_string(&domain).unwrap();
        let restored: ContentBlock = serde_json::from_str(&json).unwrap();
        assert_eq!(encode_block(restored).unwrap(), original);
    }
}

#[test]
fn missing_oneofs_and_unknown_enums_fail_explicitly() {
    assert_eq!(
        decode_message(pb::ChatMessage::default()),
        Err(CodecError::MissingOneof("message"))
    );
    assert_eq!(
        decode_block(pb::ContentBlock::default()),
        Err(CodecError::MissingOneof("content"))
    );

    let mut message = assistant();
    message.stop_reason = 999;
    assert_eq!(
        decode_message(pb::ChatMessage {
            message: Some(pb::chat_message::Message::Assistant(message)),
        }),
        Err(CodecError::UnknownFinishReason(999))
    );
}

#[test]
fn invalid_nested_json_is_rejected_in_both_directions_without_echoing_it() {
    for (arguments, expected) in [
        ("secret-invalid", CodecError::InvalidJson("arguments_json")),
        ("", CodecError::InvalidJson("arguments_json")),
        ("[]", CodecError::ExpectedObject("arguments_json")),
        ("null", CodecError::ExpectedObject("arguments_json")),
    ] {
        let domain = ContentBlock::ToolCall {
            id: "call".into(),
            name: "Tool".into(),
            arguments_json: Some(arguments.into()),
            thought_signature: None,
            namespace: None,
        };
        let protobuf = block(pb::content_block::Content::ToolCall(pb::ToolCallContent {
            id: "call".into(),
            name: "Tool".into(),
            arguments_json: Some(arguments.into()),
            thought_signature: None,
            namespace: None,
        }));
        assert_eq!(encode_block(domain), Err(expected.clone()));
        assert_eq!(decode_block(protobuf), Err(expected));
    }

    let invalid = pb::ChatMessage {
        message: Some(pb::chat_message::Message::ToolResult(pb::ToolResultMessage {
            details_json: Some("secret-invalid".into()),
            ..Default::default()
        })),
    };
    let error = decode_message(invalid).unwrap_err();
    assert_eq!(error, CodecError::InvalidJson("details_json"));
    assert!(!error.to_string().contains("secret"));
}

#[test]
fn invalid_costs_cannot_become_null_or_valid_pb_values() {
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -0.1] {
        let cost = UsageCost {
            input: value,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
            total: 0.0,
        };
        assert!(serde_json::to_string(&cost).is_err());
        assert_eq!(encode_cost(cost), Err(CodecError::InvalidCost("input")));
        assert_eq!(
            decode_cost(pb::UsageCost {
                input: value,
                ..Default::default()
            }),
            Err(CodecError::InvalidCost("input"))
        );
    }
    assert!(
        serde_json::from_str::<UsageCost>(r#"{"input":-1,"output":0,"cache_read":0,"cache_write":0,"total":0}"#)
            .is_err()
    );
}

#[test]
fn json_rejects_unknown_structure_and_integer_overflow() {
    assert!(serde_json::from_str::<AgentMessage>(r#"{"type":"unknown","content":[],"timestamp_ms":0}"#).is_err());
    assert!(
        serde_json::from_str::<AgentMessage>(r#"{"type":"user","content":[],"timestamp_ms":0,"unknown":true}"#)
            .is_err()
    );
    assert!(
        serde_json::from_str::<AgentMessage>(r#"{"type":"user","content":[],"timestamp_ms":9223372036854775808}"#)
            .is_err()
    );
    assert!(
        serde_json::from_str::<xw_agent_types::TokenUsage>(
            r#"{"input":18446744073709551616,"output":0,"cache_read":0,"cache_write":0,"total":0}"#
        )
        .is_err()
    );
}

#[test]
fn finite_costs_preserve_exact_floating_point_values() {
    // Fixed samples span exponent and mantissa ranges without another test dependency.
    let mut bits = 42_u64;
    for _ in 0..1000 {
        bits = bits.wrapping_mul(6364136223846793005).wrapping_add(1);
        let value = f64::from_bits(bits & 0x7fff_ffff_ffff_ffff);
        if !value.is_finite() {
            continue;
        }
        let cost = UsageCost {
            input: value,
            output: 0.0,
            cache_read: 0.0,
            cache_write: 0.0,
            total: 0.0,
        };
        let json = serde_json::to_string(&cost).unwrap();
        let restored: UsageCost = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.input.to_bits(), value.to_bits());
    }
}
