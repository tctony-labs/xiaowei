use xw_contracts::xiaowei::llm as pb;

use xw_agent_types::*;

/// Diagnostics name fields without exposing message text, signatures, or tool arguments.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CodecError {
    #[error("missing oneof: {0}")]
    MissingOneof(&'static str),
    #[error("unknown finish reason: {0}")]
    UnknownFinishReason(i32),
    #[error("invalid JSON: {0}")]
    InvalidJson(&'static str),
    #[error("expected JSON object: {0}")]
    ExpectedObject(&'static str),
    #[error("cost must be finite and nonnegative: {0}")]
    InvalidCost(&'static str),
}

pub fn decode_message(value: pb::ChatMessage) -> Result<AgentMessage, CodecError> {
    match value.message.ok_or(CodecError::MissingOneof("message"))? {
        pb::chat_message::Message::User(message) => Ok(AgentMessage::User(UserMessage {
            content: decode_blocks(message.content)?,
            timestamp_ms: message.timestamp_ms,
        })),
        pb::chat_message::Message::Assistant(message) => Ok(AgentMessage::Assistant(AssistantMessage {
            content: decode_blocks(message.content)?,
            api: message.api,
            provider: message.provider,
            model_id: message.model_id,
            usage: message.usage.map(decode_usage).transpose()?,
            stop_reason: decode_reason(message.stop_reason)?,
            timestamp_ms: message.timestamp_ms,
            response_id: message.response_id,
            response_model: message.response_model,
            provider_thinking_level: message.provider_thinking_level,
            raw_stop_reason: message.raw_stop_reason,
            end_turn: message.end_turn,
        })),
        pb::chat_message::Message::ToolResult(message) => {
            validate_json(message.details_json.as_deref(), "details_json", false)?;

            Ok(AgentMessage::ToolResult(ToolResultMessage {
                tool_call_id: message.tool_call_id,
                tool_name: message.tool_name,
                content: decode_blocks(message.content)?,
                is_error: message.is_error,
                timestamp_ms: message.timestamp_ms,
                details_json: message.details_json,
                added_tool_names: message.added_tool_names,
                usage: message.usage.map(decode_usage).transpose()?,
            }))
        }
    }
}

pub fn encode_message(value: AgentMessage) -> Result<pb::ChatMessage, CodecError> {
    let message = match value {
        AgentMessage::User(message) => pb::chat_message::Message::User(pb::UserMessage {
            content: encode_blocks(message.content)?,
            timestamp_ms: message.timestamp_ms,
        }),
        AgentMessage::Assistant(message) => pb::chat_message::Message::Assistant(pb::AssistantMessage {
            content: encode_blocks(message.content)?,
            api: message.api,
            provider: message.provider,
            model_id: message.model_id,
            usage: message.usage.map(encode_usage).transpose()?,
            stop_reason: encode_reason(message.stop_reason),
            timestamp_ms: message.timestamp_ms,
            response_id: message.response_id,
            response_model: message.response_model,
            provider_thinking_level: message.provider_thinking_level,
            raw_stop_reason: message.raw_stop_reason,
            end_turn: message.end_turn,
        }),
        AgentMessage::ToolResult(message) => {
            validate_json(message.details_json.as_deref(), "details_json", false)?;

            pb::chat_message::Message::ToolResult(pb::ToolResultMessage {
                tool_call_id: message.tool_call_id,
                tool_name: message.tool_name,
                content: encode_blocks(message.content)?,
                is_error: message.is_error,
                timestamp_ms: message.timestamp_ms,
                details_json: message.details_json,
                added_tool_names: message.added_tool_names,
                usage: message.usage.map(encode_usage).transpose()?,
            })
        }
    };

    Ok(pb::ChatMessage { message: Some(message) })
}

pub fn decode_block(value: pb::ContentBlock) -> Result<ContentBlock, CodecError> {
    match value.content.ok_or(CodecError::MissingOneof("content"))? {
        pb::content_block::Content::Text(block) => Ok(ContentBlock::Text {
            text: block.text,
            signature: block.signature,
        }),
        pb::content_block::Content::Image(block) => Ok(ContentBlock::Image {
            mime_type: block.mime_type,
            data: block.data,
        }),
        pb::content_block::Content::Thinking(block) => Ok(ContentBlock::Thinking {
            text: block.text,
            signature: block.signature,
            redacted: block.redacted,
        }),
        pb::content_block::Content::ToolCall(block) => {
            validate_json(block.arguments_json.as_deref(), "arguments_json", true)?;

            Ok(ContentBlock::ToolCall {
                id: block.id,
                name: block.name,
                arguments_json: block.arguments_json,
                thought_signature: block.thought_signature,
                namespace: block.namespace,
            })
        }
    }
}

pub fn encode_block(value: ContentBlock) -> Result<pb::ContentBlock, CodecError> {
    let content = match value {
        ContentBlock::Text { text, signature } => pb::content_block::Content::Text(pb::TextContent { text, signature }),
        ContentBlock::Image { mime_type, data } => {
            pb::content_block::Content::Image(pb::ImageContent { mime_type, data })
        }
        ContentBlock::Thinking {
            text,
            signature,
            redacted,
        } => pb::content_block::Content::Thinking(pb::ThinkingContent {
            text,
            signature,
            redacted,
        }),
        ContentBlock::ToolCall {
            id,
            name,
            arguments_json,
            thought_signature,
            namespace,
        } => {
            validate_json(arguments_json.as_deref(), "arguments_json", true)?;

            pb::content_block::Content::ToolCall(pb::ToolCallContent {
                id,
                name,
                arguments_json,
                thought_signature,
                namespace,
            })
        }
    };

    Ok(pb::ContentBlock { content: Some(content) })
}

pub fn decode_reason(value: i32) -> Result<FinishReason, CodecError> {
    match pb::FinishReason::try_from(value).map_err(|_| CodecError::UnknownFinishReason(value))? {
        pb::FinishReason::Unspecified => Ok(FinishReason::Unspecified),
        pb::FinishReason::Stop => Ok(FinishReason::Stop),
        pb::FinishReason::Length => Ok(FinishReason::Length),
        pb::FinishReason::ToolUse => Ok(FinishReason::ToolUse),
        pb::FinishReason::Error => Ok(FinishReason::Error),
        pb::FinishReason::Aborted => Ok(FinishReason::Aborted),
    }
}

pub fn encode_reason(value: FinishReason) -> i32 {
    let reason = match value {
        FinishReason::Unspecified => pb::FinishReason::Unspecified,
        FinishReason::Stop => pb::FinishReason::Stop,
        FinishReason::Length => pb::FinishReason::Length,
        FinishReason::ToolUse => pb::FinishReason::ToolUse,
        FinishReason::Error => pb::FinishReason::Error,
        FinishReason::Aborted => pb::FinishReason::Aborted,
    };

    reason as i32
}

pub fn decode_usage(value: pb::TokenUsage) -> Result<TokenUsage, CodecError> {
    Ok(TokenUsage {
        input: value.input,
        output: value.output,
        cache_read: value.cache_read,
        cache_write: value.cache_write,
        total: value.total,
        reasoning: value.reasoning,
        cache_write_1h: value.cache_write_1h,
        cost: value.cost.map(decode_cost).transpose()?,
    })
}

pub fn encode_usage(value: TokenUsage) -> Result<pb::TokenUsage, CodecError> {
    Ok(pb::TokenUsage {
        input: value.input,
        output: value.output,
        cache_read: value.cache_read,
        cache_write: value.cache_write,
        total: value.total,
        reasoning: value.reasoning,
        cache_write_1h: value.cache_write_1h,
        cost: value.cost.map(encode_cost).transpose()?,
    })
}

pub fn decode_cost(value: pb::UsageCost) -> Result<UsageCost, CodecError> {
    let cost = UsageCost {
        input: value.input,
        output: value.output,
        cache_read: value.cache_read,
        cache_write: value.cache_write,
        total: value.total,
    };
    validate_cost(&cost)?;

    Ok(cost)
}

pub fn encode_cost(value: UsageCost) -> Result<pb::UsageCost, CodecError> {
    validate_cost(&value)?;

    Ok(pb::UsageCost {
        input: value.input,
        output: value.output,
        cache_read: value.cache_read,
        cache_write: value.cache_write,
        total: value.total,
    })
}

fn decode_blocks(blocks: Vec<pb::ContentBlock>) -> Result<Vec<ContentBlock>, CodecError> {
    blocks.into_iter().map(decode_block).collect()
}

fn encode_blocks(blocks: Vec<ContentBlock>) -> Result<Vec<pb::ContentBlock>, CodecError> {
    blocks.into_iter().map(encode_block).collect()
}

fn validate_json(value: Option<&str>, field: &'static str, object: bool) -> Result<(), CodecError> {
    let Some(value) = value else {
        return Ok(());
    };
    let parsed: &serde_json::value::RawValue =
        serde_json::from_str(value).map_err(|_| CodecError::InvalidJson(field))?;
    if object && !parsed.get().starts_with('{') {
        return Err(CodecError::ExpectedObject(field));
    }

    Ok(())
}

fn validate_cost(cost: &UsageCost) -> Result<(), CodecError> {
    for (field, value) in [
        ("input", cost.input),
        ("output", cost.output),
        ("cache_read", cost.cache_read),
        ("cache_write", cost.cache_write),
        ("total", cost.total),
    ] {
        if !value.is_finite() || value < 0.0 {
            return Err(CodecError::InvalidCost(field));
        }
    }

    Ok(())
}
