use xw_agent_types::{InputId, InputSource, SessionId};

use crate::{AgentError, protocol::*, session::parse_id};

pub(crate) fn validate(request: &StartRunRequest, source: &InputSource) -> Result<SessionId, AgentError> {
    let session = parse_id(&request.session_id, "session_id")?;
    let _: InputId = parse_id(&request.input_id, "input_id")?;
    if request.input.is_empty() || request.input.len() > 64 {
        return Err(AgentError::InvalidArgument("input"));
    }
    let mut total_bytes = 0;
    for input in &request.input {
        let Some(agent_user_input::Content::Text(text)) = &input.content else {
            return Err(AgentError::InvalidArgument("input.content"));
        };
        bounded_text(text, 64 * 1024, "input.text")?;
        total_bytes += text.len();
    }
    if total_bytes > 64 * 1024 {
        return Err(AgentError::InvalidArgument("input.text"));
    }
    if let Some(config) = &request.config {
        validate_config(config)?;
    }
    bounded_text(&source.principal_id, 1024, "source.principal_id")?;
    Ok(session)
}

pub(crate) fn validate_config(config: &AgentModelConfig) -> Result<(), AgentError> {
    bounded_text(&config.model_ref, 1024, "config.model_ref")?;
    if let Some(reasoning) = &config.reasoning {
        bounded_text(reasoning, 128, "config.reasoning")?;
    }
    Ok(())
}

fn bounded_text(value: &str, limit: usize, field: &'static str) -> Result<(), AgentError> {
    if value.trim().is_empty() || value.len() > limit {
        return Err(AgentError::InvalidArgument(field));
    }
    Ok(())
}
