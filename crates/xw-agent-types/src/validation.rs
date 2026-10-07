use std::collections::{HashMap, HashSet};
use std::path::{Component, Path};

use serde_json::value::RawValue;

use crate::*;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationCode {
    InvalidValue,
    MissingReference,
    DuplicateIdentity,
    InvalidTransition,
    InvalidOwnership,
    UnpairedToolCall,
    InvalidModelContext,
}

/// Field paths are constructed from schema constants and numeric indices only.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code:?} at {path}")]
pub struct ValidationError {
    pub code: ValidationCode,
    pub entry_id: Option<EntryId>,
    pub message_index: Option<usize>,
    pub path: String,
}

fn require(condition: bool, code: ValidationCode, path: &str) -> Result<(), ValidationError> {
    if condition {
        return Ok(());
    }

    Err(ValidationError {
        code,
        entry_id: None,
        message_index: None,
        path: path.into(),
    })
}

fn value(condition: bool, path: &str) -> Result<(), ValidationError> {
    require(condition, ValidationCode::InvalidValue, path)
}

fn transition(condition: bool, path: &str) -> Result<(), ValidationError> {
    require(condition, ValidationCode::InvalidTransition, path)
}

fn ownership(condition: bool, path: &str) -> Result<(), ValidationError> {
    require(condition, ValidationCode::InvalidOwnership, path)
}

fn reference<T: Copy>(item: Option<T>, path: &str) -> Result<T, ValidationError> {
    item.ok_or_else(|| ValidationError {
        code: ValidationCode::MissingReference,
        entry_id: None,
        message_index: None,
        path: path.into(),
    })
}

fn unique<T: Eq + std::hash::Hash>(set: &mut HashSet<T>, id: T, path: &str) -> Result<(), ValidationError> {
    require(set.insert(id), ValidationCode::DuplicateIdentity, path)
}

fn timestamp(time: i64, path: &str) -> Result<(), ValidationError> {
    value(time >= 0 && time as u64 <= MAX_SAFE_INTEGER, path)
}

fn relative_path(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        && !path.contains('\\')
}

fn source(source: &InputSource) -> Result<(), ValidationError> {
    value(!source.principal_id.is_empty(), "source.principal_id")
}

fn json_raw<'a>(json: &'a str, object: bool, path: &str) -> Result<&'a RawValue, ValidationError> {
    let parsed = serde_json::from_str::<&RawValue>(json);
    value(parsed.is_ok(), path)?;
    let parsed = parsed.expect("validated JSON");
    value(!object || parsed.get().starts_with('{'), path)?;
    Ok(parsed)
}

fn json_object<'a>(json: &'a str, path: &str) -> Result<HashMap<String, &'a RawValue>, ValidationError> {
    json_raw(json, true, path)?;
    serde_json::from_str(json).map_err(|_| ValidationError {
        code: ValidationCode::InvalidValue,
        entry_id: None,
        message_index: None,
        path: path.into(),
    })
}

fn usage(usage: &TokenUsage, replay: bool) -> Result<(), ValidationError> {
    for tokens in [
        usage.input,
        usage.output,
        usage.cache_read,
        usage.cache_write,
        usage.total,
    ] {
        value(tokens <= MAX_SAFE_INTEGER, "usage.tokens")?;
    }
    for tokens in [usage.reasoning, usage.cache_write_1h].into_iter().flatten() {
        value(tokens <= MAX_SAFE_INTEGER, "usage.tokens")?;
    }
    if replay {
        value(usage.cost.is_some(), "usage.cost")?;
    }
    if let Some(cost) = &usage.cost {
        for cost in [cost.input, cost.output, cost.cache_read, cost.cache_write, cost.total] {
            value(cost.is_finite() && cost >= 0.0, "usage.cost")?;
        }
    }
    Ok(())
}

fn message(message: &AgentMessage, complete: bool, replay: bool, images: bool) -> Result<(), ValidationError> {
    let (blocks, time, assistant) = match message {
        AgentMessage::User(message) => (&message.content, message.timestamp_ms, false),
        AgentMessage::Assistant(message) => {
            if complete {
                value(!message.api.is_empty(), "message.api")?;
                value(!message.provider.is_empty(), "message.provider")?;
                value(!message.model_id.is_empty(), "message.model_id")?;
            }
            if replay {
                value(
                    matches!(
                        message.stop_reason,
                        FinishReason::Stop | FinishReason::Length | FinishReason::ToolUse
                    ),
                    "message.stop_reason",
                )?;
                usage(reference(message.usage.as_ref(), "message.usage")?, true)?;
            } else if let Some(tokens) = &message.usage {
                usage(tokens, false)?;
            }
            (&message.content, message.timestamp_ms, true)
        }
        AgentMessage::ToolResult(message) => {
            value(
                !message.tool_call_id.is_empty() && !message.tool_name.is_empty(),
                "message.tool_identity",
            )?;
            if let Some(json) = &message.details_json {
                json_raw(json, false, "message.details_json")?;
            }
            if let Some(tokens) = &message.usage {
                usage(tokens, replay)?;
            }
            (&message.content, message.timestamp_ms, false)
        }
    };
    timestamp(time, "message.timestamp_ms")?;
    if !assistant {
        value(!blocks.is_empty(), "message.content")?;
    }
    let mut calls = HashSet::new();
    for (index, block) in blocks.iter().enumerate() {
        let path = format!("message.content[{index}]");
        match block {
            ContentBlock::Text { .. } => {}
            ContentBlock::Image { mime_type, data } => {
                value(
                    !assistant && images && mime_type.starts_with("image/") && !data.is_empty(),
                    &path,
                )?;
            }
            ContentBlock::Thinking { .. } => value(assistant, &path)?,
            ContentBlock::ToolCall {
                id,
                name,
                arguments_json,
                ..
            } => {
                value(assistant, &path)?;
                if complete {
                    value(!id.is_empty() && !name.is_empty(), &path)?;
                    unique(&mut calls, id, &path)?;
                    value(arguments_json.is_some(), &path)?;
                }
                if let Some(json) = arguments_json {
                    json_raw(json, true, &path)?;
                }
                if replay {
                    let AgentMessage::Assistant(assistant) = message else {
                        unreachable!()
                    };
                    value(assistant.stop_reason == FinishReason::ToolUse, "message.stop_reason")?;
                }
            }
        }
    }
    Ok(())
}

fn recorded(message: &RecordedMessage) -> Result<(), ValidationError> {
    let blocks = match &message.message {
        AgentMessage::User(message) => &message.content,
        AgentMessage::Assistant(message) => &message.content,
        AgentMessage::ToolResult(message) => &message.content,
    };
    value(message.block_ids.len() == blocks.len(), "message.block_ids")?;
    let mut ids = HashSet::new();
    for id in &message.block_ids {
        unique(&mut ids, id, "message.block_ids")?;
    }
    self::message(
        &message.message,
        message.completeness == MessageCompleteness::Complete,
        false,
        true,
    )
}

fn model_capabilities(capabilities: &ModelCapabilities) -> Result<(), ValidationError> {
    value(
        capabilities.context_window > 0
            && capabilities.context_window <= MAX_SAFE_INTEGER
            && capabilities.max_output_tokens > 0
            && capabilities.max_output_tokens <= capabilities.context_window,
        "context.model.capabilities.limits",
    )?;
    value(
        !capabilities.input_modalities.is_empty(),
        "context.model.capabilities.input_modalities",
    )?;
    for (index, modality) in capabilities.input_modalities.iter().enumerate() {
        value(
            !capabilities.input_modalities[..index].contains(modality),
            "context.model.capabilities.input_modalities",
        )?;
    }
    Ok(())
}

fn context(context: &RunContext) -> Result<(), ValidationError> {
    let model = &context.model;
    value(!model.model_ref.trim().is_empty(), "context.model.identity")?;
    value(
        model.budget.context_window > 0
            && model.budget.context_window <= MAX_SAFE_INTEGER
            && model.budget.max_output_tokens > 0
            && model.budget.max_output_tokens <= model.budget.context_window,
        "context.model.budget",
    )?;
    if let Some(capabilities) = &model.capabilities {
        model_capabilities(capabilities)?;
        value(
            model.budget.source == BudgetSource::Host
                && model.budget.context_window == capabilities.context_window
                && model.budget.max_output_tokens == capabilities.max_output_tokens,
            "context.model.budget",
        )?;
    } else {
        value(
            model.budget.source == BudgetSource::Default,
            "context.model.budget.source",
        )?;
    }
    for name in [&model.provider_name, &model.model_name] {
        value(
            name.as_ref().is_none_or(|name| !name.trim().is_empty()),
            "context.model.name",
        )?;
    }

    let p = &context.generation;
    value(p.temperature.is_none_or(|n| n.is_finite()), "generation.temperature")?;
    value(
        p.max_tokens
            .is_none_or(|n| n > 0 && n as u64 <= model.budget.max_output_tokens),
        "generation.max_tokens",
    )?;
    value(
        p.timeout_ms != Some(0) && p.websocket_connect_timeout_ms != Some(0),
        "generation.timeout_ms",
    )?;
    if let Some(reasoning) = &p.reasoning {
        value(
            !reasoning.is_empty()
                && (reasoning == "off" || model.capabilities.as_ref().is_none_or(|c| c.supports_reasoning)),
            "generation.reasoning",
        )?;
    }
    for (option, path) in [
        (&p.cache_retention, "generation.cache_retention"),
        (&p.transport, "generation.transport"),
    ] {
        value(option.as_ref().is_none_or(|value| !value.is_empty()), path)?;
    }
    if let Some(json) = &p.tool_choice_json {
        let raw = json_raw(json, false, "generation.tool_choice_json")?;
        value(
            raw.get().starts_with('{') || raw.get().starts_with('"'),
            "generation.tool_choice_json",
        )?;
    }
    for (json, path) in [
        (&p.thinking_budgets_json, "generation.thinking_budgets_json"),
        (&p.sampling_params_json, "generation.sampling_params_json"),
        (&p.metadata_json, "generation.metadata_json"),
        (&p.api_options_json, "generation.api_options_json"),
    ] {
        if let Some(json) = json {
            let object = json_object(json, path)?;
            // Reject known top-level credential/input overrides in generic option bags.
            // Adapters must also sanitize and validate their own provider-specific options.
            for key in object.keys() {
                value(
                    ![
                        "apiKey",
                        "api_key",
                        "authorization",
                        "headers",
                        "credentials",
                        "model",
                        "messages",
                        "signal",
                        "onPayload",
                        "onResponse",
                    ]
                    .contains(&key.as_str()),
                    path,
                )?;
            }
        }
    }
    let mut names = HashSet::new();
    for tool in &context.tools {
        value(!tool.name.is_empty(), "tools.name")?;
        unique(&mut names, &tool.name, "tools.name")?;
        let schema = json_object(&tool.parameters_json, "tools.parameters_json")?;
        value(
            schema
                .get("type")
                .is_some_and(|raw| serde_json::from_str::<String>(raw.get()).is_ok_and(|s| s == "object")),
            "tools.parameters_json",
        )?;
        if let Some(json) = &tool.constrained_sampling_json {
            let raw = json_raw(json, false, "tools.constrained_sampling_json")?;
            value(
                raw.get() == "false" || raw.get().starts_with('{'),
                "tools.constrained_sampling_json",
            )?;
        }
    }
    Ok(())
}

fn preempt_field(is_preempted: bool, input: Option<InputId>) -> Result<(), ValidationError> {
    value(is_preempted == input.is_some(), "preempting_input_id")
}

pub fn validate_entry(entry: &JournalEntry) -> Result<(), ValidationError> {
    validate_payload(entry).map_err(|mut error| {
        error.entry_id = Some(entry.entry_id);
        error
    })
}

fn validate_payload(entry: &JournalEntry) -> Result<(), ValidationError> {
    value(entry.schema_version == HISTORY_VERSION, "schema_version")?;
    value(entry.sequence.0 > 0, "sequence")?;
    timestamp(entry.timestamp_ms, "timestamp_ms")?;
    match &entry.payload {
        EntryPayload::SessionHeader => {}
        EntryPayload::Meta(meta) => {
            value(
                meta.model_ref
                    .as_ref()
                    .is_some_and(|reference| !reference.trim().is_empty()),
                "model_ref",
            )?;
        }
        EntryPayload::InputAccepted(input) => {
            if let Some(selection) = &input.selection {
                value(
                    !selection.model_ref.trim().is_empty() && selection.model_ref.len() <= 1024,
                    "selection.model_ref",
                )?;
                value(
                    selection
                        .reasoning
                        .as_ref()
                        .is_none_or(|reasoning| !reasoning.trim().is_empty() && reasoning.len() <= 128),
                    "selection.reasoning",
                )?;
            }
            source(&input.source)?;
            value(
                matches!(input.mode, InputMode::Steering | InputMode::Preempt) == input.expected_run_id.is_some(),
                "expected_run_id",
            )?;
            recorded(&input.message)?;
            ownership(
                matches!(input.message.message, AgentMessage::User(_))
                    && input.message.input_id == Some(input.input_id)
                    && input.message.run_id.is_none()
                    && input.message.turn_id.is_none()
                    && input.message.gen_id.is_none(),
                "message",
            )?;
            value(
                input.message.completeness == MessageCompleteness::Complete,
                "message.completeness",
            )?;
        }
        EntryPayload::InputConsumed(input) => {
            value(!input.input_ids.is_empty(), "input_ids")?;
            let mut ids = HashSet::new();
            for id in &input.input_ids {
                unique(&mut ids, id, "input_ids")?;
            }
        }
        EntryPayload::RunStarted(run) => {
            context(&run.context)?;
            match &run.cause {
                RunCause::FollowUp { input_ids } => value(!input_ids.is_empty(), "cause.input_ids")?,
                RunCause::Continue { source: origin, .. } => source(origin)?,
                _ => {}
            }
        }
        EntryPayload::TurnStarted(turn) => value(turn.ordinal > 0, "ordinal")?,
        EntryPayload::TurnEnded(turn) => {
            preempt_field(turn.status == TurnStatus::Preempted, turn.preempting_input_id)?;
            value(
                turn.status != TurnStatus::Completed || turn.final_gen_id.is_some(),
                "final_gen_id",
            )?;
        }
        EntryPayload::GenStarted(generation) => {
            timestamp(generation.started_at_ms, "started_at_ms")?;
            if let Some(configuration) = &generation.context {
                context(configuration)?;
            }
            value(
                (generation.purpose == GenPurpose::Conversation) == generation.context.is_none(),
                "context",
            )?;
            match generation.purpose {
                GenPurpose::Conversation => value(
                    generation.run_id.is_some() && generation.turn_id.is_some() && generation.attempt > 0,
                    "purpose",
                )?,
                GenPurpose::Title => value(
                    generation.run_id.is_none() && generation.turn_id.is_none() && generation.attempt == 1,
                    "purpose",
                )?,
                GenPurpose::ToolExtraction { .. } => value(
                    generation.run_id.is_some() && generation.turn_id.is_none() && generation.attempt == 1,
                    "purpose",
                )?,
                GenPurpose::Compaction => value(generation.turn_id.is_none() && generation.attempt == 1, "purpose")?,
            }
        }
        EntryPayload::GenFirstSseReceived(first) => timestamp(first.received_at_ms, "received_at_ms")?,
        EntryPayload::GenEnded(generation) => {
            preempt_field(
                generation.status == GenStatus::Preempted,
                generation.preempting_input_id,
            )?;
            value(
                generation.status == GenStatus::Interrupted || generation.ended_at_ms.is_some(),
                "ended_at_ms",
            )?;
            if let Some(time) = generation.ended_at_ms {
                timestamp(time, "ended_at_ms")?;
            }
            if let Some(tokens) = &generation.usage {
                usage(tokens, false)?;
            }
            value(
                generation.context_tokens.is_none_or(|n| n <= MAX_SAFE_INTEGER),
                "context_tokens",
            )?;
        }
        EntryPayload::Message(msg) => {
            recorded(msg)?;
            ownership(
                matches!(msg.message, AgentMessage::Assistant(_)) && msg.gen_id.is_some() && msg.input_id.is_none(),
                "message",
            )?;
        }
        EntryPayload::ToolIntent(tool) => {
            value(
                !tool.tool_name.is_empty() && !tool.key.provider_call_id.is_empty(),
                "tool_identity",
            )?;
            json_raw(&tool.arguments_json, true, "arguments_json")?;
        }
        EntryPayload::ToolOutcome(tool) => {
            recorded(&tool.result)?;
            ownership(
                matches!(tool.result.message, AgentMessage::ToolResult(_)),
                "result.message",
            )?;
            value(
                tool.result.completeness == MessageCompleteness::Complete && tool.result.input_id.is_none(),
                "result.completeness",
            )?;
            if let Some(json) = &tool.metadata_json {
                json_raw(json, false, "metadata_json")?;
            }
        }
        EntryPayload::InteractionOpened(interaction) => {
            value(interaction.revision == 1, "revision")?;
            match &interaction.request {
                InteractionRequest::Question { question, options, .. } => {
                    value(!question.trim().is_empty() && options.len() <= 12, "request.question")?;
                }
                InteractionRequest::Permission { target, .. } => {
                    value(Path::new(&target.path).is_absolute(), "request.target.path")?;
                }
                InteractionRequest::ToolExecution { .. } => {}
            }
        }
        EntryPayload::InteractionResolved(interaction) => {
            value(interaction.revision == 2, "revision")?;
            source(&interaction.source)?;
        }
        EntryPayload::InteractionExpired(interaction) => {
            value(interaction.revision == 2, "revision")?;
            preempt_field(
                interaction.reason == InteractionExpireReason::Preempted,
                interaction.preempting_input_id,
            )?;
        }
        EntryPayload::Compacted(compacted) => {
            value(
                !compacted.summary.trim().is_empty() && !compacted.replacement_history.is_empty(),
                "summary",
            )?;
            value(
                compacted.context_window > 0 && compacted.context_window <= MAX_SAFE_INTEGER,
                "context_window",
            )?;
            value(
                compacted.tokens_before.is_none_or(|n| n <= MAX_SAFE_INTEGER)
                    && compacted.estimated_tokens_before.is_none_or(|n| n <= MAX_SAFE_INTEGER),
                "tokens_before",
            )?;
        }
        EntryPayload::RunEnd(run) => value(
            run.context_tokens.is_none_or(|n| n <= MAX_SAFE_INTEGER),
            "context_tokens",
        )?,
        EntryPayload::InputCancelled(_) => {}
    }
    Ok(())
}

pub(crate) fn validate_deletion_marker(marker: &DeletionMarker) -> Result<(), ValidationError> {
    value(
        marker.schema_version == 1 && marker.committed_sequence.0 > 0,
        "schema_version",
    )?;
    timestamp(marker.deleted_at_ms, "deleted_at_ms")?;
    value(relative_path(&marker.journal_relpath), "journal_relpath")?;
    let components: Vec<_> = marker.journal_relpath.split('/').collect();
    value(
        components.len() == 4
            && components[0] == "sessions"
            && components[1].len() == 4
            && components[1].bytes().all(|byte| byte.is_ascii_digit())
            && components[2].len() == 2
            && components[2].parse::<u8>().is_ok_and(|month| (1..=12).contains(&month))
            && components[3] == format!("{}.jsonl", marker.session_id),
        "journal_relpath",
    )?;
    value(
        marker.workspace_relpath == format!("workspaces/{}", marker.session_id),
        "workspace_relpath",
    )
}

pub fn validate_model_context(
    messages: &[AgentMessage],
    capabilities: &ModelCapabilities,
) -> Result<(), ValidationError> {
    value(!messages.is_empty(), "messages")?;
    model_capabilities(capabilities)?;
    let mut pending: HashMap<&str, &str> = HashMap::new();
    for (index, msg) in messages.iter().enumerate() {
        let result: Result<(), ValidationError> = (|| {
            message(
                msg,
                true,
                true,
                capabilities.input_modalities.contains(&InputModality::Image),
            )?;
            match msg {
                AgentMessage::Assistant(assistant) => {
                    require(pending.is_empty(), ValidationCode::UnpairedToolCall, "content")?;
                    for block in &assistant.content {
                        if let ContentBlock::ToolCall { id, name, .. } = block {
                            pending.insert(id, name);
                        }
                    }
                }
                AgentMessage::ToolResult(tool) => {
                    require(
                        pending.remove(tool.tool_call_id.as_str()) == Some(tool.tool_name.as_str()),
                        ValidationCode::UnpairedToolCall,
                        "tool_call_id",
                    )?;
                }
                AgentMessage::User(_) => require(pending.is_empty(), ValidationCode::UnpairedToolCall, "content")?,
            }
            Ok(())
        })();
        if let Err(mut error) = result {
            error.message_index = Some(index);
            return Err(error);
        }
    }
    require(pending.is_empty(), ValidationCode::UnpairedToolCall, "messages")
}

#[derive(Default)]
struct History<'a> {
    entries: HashMap<EntryId, usize>,
    inputs: HashMap<InputId, (&'a InputAccepted, bool)>,
    runs: HashMap<RunId, (&'a RunStarted, Option<&'a RunEnd>)>,
    turns: HashMap<TurnId, (&'a TurnStarted, Option<&'a TurnEnded>)>,
    gens: HashMap<GenId, (&'a GenStarted, Option<&'a GenEnded>)>,
    first_sse: HashSet<GenId>,
    messages: HashMap<MessageId, &'a RecordedMessage>,
    blocks: HashSet<BlockId>,
    tools: HashMap<ToolId, (&'a ToolIntent, Option<&'a ToolOutcome>)>,
    provider_keys: HashSet<(GenId, &'a str)>,
    recovery_intents: HashSet<ToolId>,
    interactions: HashMap<InteractionId, (&'a InteractionOpened, bool)>,
    checkpoints: HashMap<EntryId, &'a Compacted>,
    active_run: Option<RunId>,
    last_run_end: Option<&'a RunEnd>,
    input_positions: HashMap<InputId, usize>,
    turn_positions: HashMap<TurnId, usize>,
    consumed_positions: HashMap<TurnId, usize>,
    consumed_turns: HashSet<TurnId>,
    consumed_inputs: HashSet<InputId>,
    continue_requests: HashSet<(&'a String, ClientRequestId)>,
    ended_turn_entries: HashMap<TurnId, EntryId>,
    interaction_preempts: HashMap<TurnId, InputId>,
    message_entries: HashMap<MessageId, EntryId>,
    effective: Vec<(EntryId, usize, &'a AgentMessage)>,
}

impl<'a> History<'a> {
    fn origin(&self, mut run: &'a RunStarted) -> &'a RunCause {
        while let RunCause::Continue { previous_run_id, .. } = run.cause {
            run = self.runs[&previous_run_id].0;
        }
        &run.cause
    }

    fn run(&self, id: RunId) -> Result<&'a RunStarted, ValidationError> {
        let (run, end) = reference(self.runs.get(&id).copied(), "run_id")?;
        transition(end.is_none() && self.active_run == Some(id), "run_id")?;
        Ok(run)
    }

    fn turn(&self, id: TurnId) -> Result<&'a TurnStarted, ValidationError> {
        let (turn, end) = reference(self.turns.get(&id).copied(), "turn_id")?;
        transition(end.is_none(), "turn_id")?;
        self.run(turn.run_id)?;
        Ok(turn)
    }

    fn generation(&self, id: GenId) -> Result<&'a GenStarted, ValidationError> {
        let (generation, end) = reference(self.gens.get(&id).copied(), "gen_id")?;
        transition(end.is_none(), "gen_id")?;
        if let Some(run) = generation.run_id {
            self.run(run)?;
        }
        if let Some(turn) = generation.turn_id {
            self.turn(turn)?;
        }
        Ok(generation)
    }

    fn boundary(&self, boundary: &ContextBoundary) -> Result<(), ValidationError> {
        let upper = boundary
            .through_entry_id
            .map(|id| reference(self.entries.get(&id).copied(), "boundary.through_entry_id"))
            .transpose()?;
        if let Some(id) = boundary.after_turn_id {
            let (turn, end) = reference(self.turns.get(&id).copied(), "boundary.after_turn_id")?;
            reference(end, "boundary.after_turn_id")?;
            let end_position = self
                .ended_turn_entries
                .get(&turn.turn_id)
                .and_then(|id| self.entries.get(id))
                .copied();
            value(
                upper.zip(end_position).is_some_and(|(upper, end)| end <= upper),
                "boundary.after_turn_id",
            )?;
            self.closed_tools(turn.turn_id)?;
        }
        Ok(())
    }

    fn preempt(&self, input_id: InputId, run_id: RunId) -> Result<(), ValidationError> {
        let (input, finished) = reference(self.inputs.get(&input_id).copied(), "preempting_input_id")?;
        ownership(
            input.mode == InputMode::Preempt && input.expected_run_id == Some(run_id),
            "preempting_input_id",
        )?;
        transition(!finished, "preempting_input_id")
    }

    fn message(&mut self, msg: &'a RecordedMessage) -> Result<(), ValidationError> {
        require(
            !self.messages.contains_key(&msg.message_id),
            ValidationCode::DuplicateIdentity,
            "message.message_id",
        )?;
        for block in &msg.block_ids {
            unique(&mut self.blocks, *block, "message.block_ids")?;
        }
        self.messages.insert(msg.message_id, msg);
        Ok(())
    }

    fn key(&self, key: &ProviderToolKey) -> Result<&'a GenEnded, ValidationError> {
        let (generation, end) = reference(self.gens.get(&key.gen_id).copied(), "key.gen_id")?;
        ownership(
            generation.purpose == GenPurpose::Conversation
                && generation.run_id == Some(key.run_id)
                && generation.turn_id == Some(key.turn_id),
            "key",
        )?;
        let end = reference(end, "key.gen_id")?;
        transition(
            end.status == GenStatus::Completed && end.stop_reason == Some(FinishReason::ToolUse),
            "key.gen_id",
        )?;
        Ok(end)
    }

    fn closed_tools(&self, turn_id: TurnId) -> Result<(), ValidationError> {
        let mut generations: Vec<_> = self
            .gens
            .values()
            .filter(|(generation, _)| generation.turn_id == Some(turn_id))
            .collect();
        generations.sort_by_key(|(generation, _)| generation.attempt);
        for (generation, end) in generations {
            let end = reference(*end, "gen_id")?;
            if end.status != GenStatus::Completed {
                continue;
            }
            let msg = reference(
                end.assistant_message_id.and_then(|id| self.messages.get(&id).copied()),
                "assistant_message_id",
            )?;
            let AgentMessage::Assistant(assistant) = &msg.message else {
                unreachable!()
            };
            for block in &assistant.content {
                if let ContentBlock::ToolCall { id, .. } = block {
                    let outcome = self
                        .tools
                        .values()
                        .find(|(tool, _)| tool.key.gen_id == generation.gen_id && tool.key.provider_call_id == *id)
                        .and_then(|(_, outcome)| *outcome);
                    require(outcome.is_some(), ValidationCode::UnpairedToolCall, "tool_outcome")?;
                }
            }
        }
        Ok(())
    }

    fn push(&mut self, entry: &'a JournalEntry) -> Result<(), ValidationError> {
        match &entry.payload {
            EntryPayload::SessionHeader | EntryPayload::Meta(_) => {}
            EntryPayload::InputAccepted(input) => {
                require(
                    !self.inputs.contains_key(&input.input_id),
                    ValidationCode::DuplicateIdentity,
                    "input_id",
                )?;
                if let Some(run) = input.expected_run_id {
                    self.run(run)?;
                }
                if let Some(head) = input.expected_head {
                    let position = reference(self.entries.get(&head).copied(), "expected_head")?;
                    transition(position == self.entries.len(), "expected_head")?;
                }
                self.message(&input.message)?;
                self.inputs.insert(input.input_id, (input, false));
                self.input_positions.insert(input.input_id, entry.sequence.0 as usize);
            }
            EntryPayload::InputConsumed(input) => {
                let turn = self.turn(input.turn_id)?;
                ownership(turn.run_id == input.run_id, "turn_id")?;
                transition(
                    !self
                        .gens
                        .values()
                        .any(|(generation, _)| generation.turn_id == Some(input.turn_id)),
                    "turn_id",
                )?;
                self.boundary(&input.boundary)?;
                let run = self.run(input.run_id)?;
                let mut previous_sequence = 0;
                for id in &input.input_ids {
                    let (accepted, finished) = reference(self.inputs.get(id).copied(), "input_ids")?;
                    transition(!finished, "input_ids")?;
                    let position = self.input_positions[id];
                    transition(position > previous_sequence, "input_ids")?;
                    previous_sequence = position;
                    match accepted.mode {
                        InputMode::Send => ownership(
                            matches!(self.origin(run), RunCause::Send { input_id } if input_id == id)
                                && turn.ordinal == 1,
                            "input_ids",
                        )?,
                        InputMode::FollowUp => {
                            let RunCause::FollowUp { input_ids } = self.origin(run) else {
                                return ownership(false, "input_ids");
                            };
                            ownership(input_ids == &input.input_ids && turn.ordinal == 1, "input_ids")?;
                            let earlier = self.inputs.iter().any(|(candidate, (input, done))| {
                                !done
                                    && input.mode == InputMode::FollowUp
                                    && self.input_positions[candidate] < position
                                    && !input_ids.contains(candidate)
                            });
                            transition(!earlier, "input_ids")?;
                        }
                        InputMode::Steering | InputMode::Preempt => {
                            ownership(accepted.expected_run_id == Some(input.run_id), "input_ids")?;
                            // Acceptance between Turns is legal; no fabricated interrupted Turn is required.
                            let accepted_at = self.input_positions[id];
                            let current_at = self.turn_positions[&turn.turn_id];
                            transition(accepted_at < current_at, "input_ids")?;
                        }
                    }
                }
                for id in &input.input_ids {
                    let accepted = self.inputs[id].0;
                    self.effective
                        .push((entry.entry_id, entry.sequence.0 as usize, &accepted.message.message));
                    self.inputs.get_mut(id).expect("checked").1 = true;
                    self.consumed_inputs.insert(*id);
                }
                self.consumed_turns.insert(input.turn_id);
                self.consumed_positions.insert(input.turn_id, entry.sequence.0 as usize);
            }
            EntryPayload::InputCancelled(input) => {
                let (_, done) = reference(self.inputs.get(&input.input_id).copied(), "input_id")?;
                transition(!done, "input_id")?;
                self.inputs.get_mut(&input.input_id).expect("checked").1 = true;
            }
            EntryPayload::RunStarted(run) => {
                transition(self.active_run.is_none(), "run_id")?;
                require(
                    !self.runs.contains_key(&run.run_id),
                    ValidationCode::DuplicateIdentity,
                    "run_id",
                )?;
                self.boundary(&run.base_context)?;
                match &run.cause {
                    RunCause::Send { input_id } => {
                        let (input, done) = reference(self.inputs.get(input_id).copied(), "cause.input_id")?;
                        transition(!done && input.mode == InputMode::Send, "cause.input_id")?;
                        let duplicate = self.runs.values().any(|(old, _)| match old.cause {
                            RunCause::Send { input_id: old_id } => old_id == *input_id,
                            _ => false,
                        });
                        transition(!duplicate, "cause.input_id")?;
                    }
                    RunCause::FollowUp { input_ids } => {
                        transition(
                            self.last_run_end.is_some_and(|end| end.status == RunStatus::Completed),
                            "cause",
                        )?;
                        let mut seen = HashSet::new();
                        let mut last = 0;
                        for id in input_ids {
                            unique(&mut seen, id, "cause.input_ids")?;
                            let (input, done) = reference(self.inputs.get(id).copied(), "cause.input_ids")?;
                            transition(
                                !done && input.mode == InputMode::FollowUp && self.input_positions[id] > last,
                                "cause.input_ids",
                            )?;
                            last = self.input_positions[id];
                        }
                    }
                    RunCause::Continue {
                        previous_run_id,
                        client_request_id,
                        source,
                    } => {
                        let (_, end) = reference(self.runs.get(previous_run_id).copied(), "cause.previous_run_id")?;
                        let end = reference(end, "cause.previous_run_id")?;
                        transition(
                            end.status != RunStatus::Completed && self.last_run_end == Some(end),
                            "cause.previous_run_id",
                        )?;
                        unique(
                            &mut self.continue_requests,
                            (&source.principal_id, *client_request_id),
                            "cause.client_request_id",
                        )?;
                    }
                }
                self.runs.insert(run.run_id, (run, None));
                self.active_run = Some(run.run_id);
            }
            EntryPayload::TurnStarted(turn) => {
                let run = self.run(turn.run_id)?;
                if let RunCause::Continue { previous_run_id, .. } = run.cause {
                    for (old, _) in self.turns.values().filter(|(old, _)| old.run_id == previous_run_id) {
                        self.closed_tools(old.turn_id)?;
                    }
                }
                require(
                    !self.turns.contains_key(&turn.turn_id),
                    ValidationCode::DuplicateIdentity,
                    "turn_id",
                )?;
                let previous: Vec<_> = self
                    .turns
                    .values()
                    .filter(|(turn, _)| turn.run_id == run.run_id)
                    .collect();
                transition(
                    previous.iter().all(|(_, end)| end.is_some()) && turn.ordinal as usize == previous.len() + 1,
                    "ordinal",
                )?;
                self.boundary(&turn.boundary)?;
                self.turns.insert(turn.turn_id, (turn, None));
                self.turn_positions.insert(turn.turn_id, entry.sequence.0 as usize);
            }
            EntryPayload::GenStarted(generation) => {
                require(
                    !self.gens.contains_key(&generation.gen_id),
                    ValidationCode::DuplicateIdentity,
                    "gen_id",
                )?;
                self.boundary(&generation.boundary)?;
                if let Some(run) = generation.run_id {
                    self.run(run)?;
                }
                match generation.purpose {
                    GenPurpose::Conversation => {
                        let turn = self.turn(generation.turn_id.expect("validated"))?;
                        ownership(generation.run_id == Some(turn.run_id), "run_id")?;
                        let previous = self
                            .gens
                            .values()
                            .filter(|(old, _)| old.turn_id == generation.turn_id)
                            .max_by_key(|(old, _)| old.attempt);
                        if let Some((old, end)) = previous {
                            let end = reference(*end, "attempt")?;
                            transition(
                                end.status == GenStatus::Failed
                                    && generation.attempt == old.attempt + 1
                                    && !self.tools.values().any(|(tool, _)| tool.key.gen_id == old.gen_id),
                                "attempt",
                            )?;
                        } else {
                            transition(generation.attempt == 1, "attempt")?;
                            if turn.ordinal == 1 && !matches!(self.run(turn.run_id)?.cause, RunCause::Continue { .. }) {
                                transition(self.consumed_turns.contains(&turn.turn_id), "input_consumed")?;
                            }
                            let run = self.run(turn.run_id)?;
                            let origin_inputs = match self.origin(run) {
                                RunCause::Send { input_id } => std::slice::from_ref(input_id),
                                RunCause::FollowUp { input_ids } => input_ids.as_slice(),
                                RunCause::Continue { .. } => unreachable!(),
                            };
                            transition(
                                origin_inputs.iter().all(|id| self.consumed_inputs.contains(id)),
                                "input_consumed",
                            )?;
                        }
                        if let Some(consumed) = self.consumed_positions.get(&turn.turn_id) {
                            let upper = generation
                                .boundary
                                .through_entry_id
                                .and_then(|id| self.entries.get(&id));
                            value(
                                upper.is_some_and(|upper| upper >= consumed),
                                "boundary.through_entry_id",
                            )?;
                        }
                        let run = self.run(turn.run_id)?;
                        let context = &run.context;
                        let count = self
                            .gens
                            .values()
                            .filter(|(g, _)| g.run_id == generation.run_id && g.purpose == GenPurpose::Conversation)
                            .count();
                        transition(
                            context.limits.max_gens.is_none_or(|limit| count < limit as usize),
                            "limits.max_gens",
                        )?;
                    }
                    GenPurpose::ToolExtraction { tool_id } => {
                        let (tool, outcome) = reference(self.tools.get(&tool_id).copied(), "purpose.tool_id")?;
                        ownership(generation.run_id == Some(tool.key.run_id), "purpose.tool_id")?;
                        transition(outcome.is_none(), "purpose.tool_id")?;
                        self.turn(tool.key.turn_id)?;
                        transition(
                            !self
                                .gens
                                .values()
                                .any(|(g, end)| g.purpose == generation.purpose && end.is_none()),
                            "purpose.tool_id",
                        )?;
                    }
                    GenPurpose::Compaction => {
                        transition(
                            !self
                                .turns
                                .values()
                                .any(|(turn, end)| Some(turn.run_id) == generation.run_id && end.is_none()),
                            "purpose",
                        )?;
                    }
                    GenPurpose::Title => {}
                }
                self.gens.insert(generation.gen_id, (generation, None));
            }
            EntryPayload::GenFirstSseReceived(first) => {
                self.generation(first.gen_id)?;
                unique(&mut self.first_sse, first.gen_id, "gen_id")?;
            }
            EntryPayload::Message(msg) => {
                let generation = self.generation(msg.gen_id.expect("validated"))?;
                ownership(
                    msg.run_id == generation.run_id && msg.turn_id == generation.turn_id,
                    "message",
                )?;
                transition(
                    !self.messages.values().any(|old| old.gen_id == msg.gen_id),
                    "message.gen_id",
                )?;
                self.message(msg)?;
                self.message_entries.insert(msg.message_id, entry.entry_id);
            }
            EntryPayload::GenEnded(end) => {
                let generation = self.generation(end.gen_id)?;
                if let Some(input) = end.preempting_input_id {
                    self.preempt(input, reference(generation.run_id, "preempting_input_id")?)?;
                }
                if let Some(id) = end.assistant_message_id {
                    let msg = reference(self.messages.get(&id).copied(), "assistant_message_id")?;
                    ownership(msg.gen_id == Some(generation.gen_id), "assistant_message_id")?;
                    let AgentMessage::Assistant(assistant) = &msg.message else {
                        unreachable!()
                    };
                    if end.status == GenStatus::Completed {
                        transition(
                            msg.completeness == MessageCompleteness::Complete,
                            "assistant_message_id",
                        )?;
                        message(&msg.message, true, true, false)?;
                        if generation.purpose != GenPurpose::Conversation {
                            value(assistant.stop_reason != FinishReason::ToolUse, "stop_reason")?;
                        }
                    }
                    // A complete response may have committed just before its GenEnded write failed.
                    // Non-completed Gen status still excludes it from replay regardless of completeness.
                    ownership(
                        end.stop_reason.is_none_or(|reason| reason == assistant.stop_reason),
                        "stop_reason",
                    )?;
                    if end.status == GenStatus::Completed {
                        ownership(end.stop_reason == Some(assistant.stop_reason), "stop_reason")?;
                    }
                    if assistant.usage.is_some() {
                        ownership(end.usage == assistant.usage, "usage")?;
                    }
                } else {
                    transition(
                        end.status != GenStatus::Completed
                            && !self.messages.values().any(|msg| msg.gen_id == Some(generation.gen_id)),
                        "assistant_message_id",
                    )?;
                }
                if generation.purpose == GenPurpose::Conversation && end.status == GenStatus::Completed {
                    let id = end.assistant_message_id.expect("checked");
                    self.effective.push((
                        self.message_entries[&id],
                        entry.sequence.0 as usize,
                        &self.messages[&id].message,
                    ));
                }
                self.gens.get_mut(&end.gen_id).expect("checked").1 = Some(end);
            }
            EntryPayload::ToolIntent(tool) => {
                let (_, ended) = reference(self.turns.get(&tool.key.turn_id).copied(), "key.turn_id")?;
                if let Some(ended) = ended {
                    let active = reference(self.active_run, "settled_by_run_id")?;
                    let run = self.run(active)?;
                    transition(ended.status == TurnStatus::Interrupted, "key.turn_id")?;
                    ownership(
                        matches!(run.cause, RunCause::Continue { previous_run_id, .. }
                        if previous_run_id == tool.key.run_id),
                        "key.run_id",
                    )?;
                    self.recovery_intents.insert(tool.tool_id);
                } else {
                    self.turn(tool.key.turn_id)?;
                }
                let generation = self.key(&tool.key)?;
                ownership(
                    generation.assistant_message_id == Some(tool.assistant_message_id),
                    "assistant_message_id",
                )?;
                let msg = self.messages[&tool.assistant_message_id];
                let block_index = reference(msg.block_ids.iter().position(|id| *id == tool.block_id), "block_id")?;
                let AgentMessage::Assistant(assistant) = &msg.message else {
                    unreachable!()
                };
                let same_call = matches!(
                    &assistant.content[block_index],
                    ContentBlock::ToolCall { id, name, arguments_json, .. }
                        if id == &tool.key.provider_call_id && name == &tool.tool_name
                            && arguments_json.as_deref() == Some(tool.arguments_json.as_str())
                );
                ownership(same_call, "block_id")?;
                require(
                    !self.tools.contains_key(&tool.tool_id),
                    ValidationCode::DuplicateIdentity,
                    "tool_id",
                )?;
                unique(
                    &mut self.provider_keys,
                    (tool.key.gen_id, &tool.key.provider_call_id),
                    "key.provider_call_id",
                )?;
                self.tools.insert(tool.tool_id, (tool, None));
            }
            EntryPayload::ToolOutcome(outcome) => {
                let (tool, end) = reference(self.tools.get(&outcome.tool_id).copied(), "tool_id")?;
                transition(end.is_none(), "tool_id")?;
                ownership(tool.key == outcome.key, "key")?;
                let (turn, turn_end) = self.turns[&tool.key.turn_id];
                if let Some(turn_end) = turn_end {
                    transition(
                        turn_end.status == TurnStatus::Interrupted && outcome.settled_by_run_id.is_some(),
                        "tool_id",
                    )?;
                    let run = self.run(outcome.settled_by_run_id.expect("checked"))?;
                    let RunCause::Continue { previous_run_id, .. } = run.cause else {
                        return ownership(false, "settled_by_run_id");
                    };
                    ownership(previous_run_id == turn.run_id, "settled_by_run_id")?;
                    transition(
                        outcome.status
                            == if self.recovery_intents.contains(&tool.tool_id) {
                                ToolStatus::Skipped
                            } else {
                                ToolStatus::ResultUnknown
                            },
                        "status",
                    )?;
                } else {
                    self.turn(turn.turn_id)?;
                    ownership(outcome.settled_by_run_id.is_none(), "settled_by_run_id")?;
                }
                transition(
                    !self.gens.values().any(|(generation, end)| {
                        generation.purpose == GenPurpose::ToolExtraction { tool_id: tool.tool_id } && end.is_none()
                    }),
                    "tool_id",
                )?;
                transition(
                    !self
                        .interactions
                        .values()
                        .any(|(opened, done)| opened.tool_id == tool.tool_id && !done),
                    "tool_id",
                )?;
                let result = &outcome.result;
                ownership(
                    result.run_id == Some(tool.key.run_id)
                        && result.turn_id == Some(tool.key.turn_id)
                        && result.gen_id == Some(tool.key.gen_id),
                    "result",
                )?;
                let AgentMessage::ToolResult(result_msg) = &result.message else {
                    unreachable!()
                };
                ownership(
                    result_msg.tool_call_id == tool.key.provider_call_id && result_msg.tool_name == tool.tool_name,
                    "result.message",
                )?;
                value(
                    result_msg.is_error == (outcome.status != ToolStatus::Completed),
                    "result.message.is_error",
                )?;
                self.message(result)?;
                self.effective
                    .push((entry.entry_id, entry.sequence.0 as usize, &result.message));
                self.tools.get_mut(&tool.tool_id).expect("checked").1 = Some(outcome);
            }
            EntryPayload::InteractionOpened(opened) => {
                let (tool, end) = reference(self.tools.get(&opened.tool_id).copied(), "tool_id")?;
                ownership(opened.run_id == tool.key.run_id, "run_id")?;
                transition(end.is_none(), "tool_id")?;
                self.turn(tool.key.turn_id)?;
                transition(
                    !self
                        .interactions
                        .values()
                        .any(|(other, done)| other.tool_id == opened.tool_id && !done),
                    "tool_id",
                )?;
                if matches!(opened.request, InteractionRequest::ToolExecution { .. }) {
                    let run = self.run(opened.run_id)?;
                    let RunCause::Continue { previous_run_id, .. } = run.cause else {
                        return transition(false, "request");
                    };
                    transition(
                        self.tools.values().any(|(old, outcome)| {
                            old.key.run_id == previous_run_id
                                && old.tool_name == tool.tool_name
                                && outcome.is_some_and(|outcome| outcome.status == ToolStatus::ResultUnknown)
                        }),
                        "request",
                    )?;
                }
                require(
                    !self.interactions.contains_key(&opened.interaction_id),
                    ValidationCode::DuplicateIdentity,
                    "interaction_id",
                )?;
                self.interactions.insert(opened.interaction_id, (opened, false));
            }
            EntryPayload::InteractionResolved(resolved) => {
                let (opened, done) = reference(
                    self.interactions.get(&resolved.interaction_id).copied(),
                    "interaction_id",
                )?;
                transition(!done, "interaction_id")?;
                answer(&opened.request, &resolved.answer)?;
                self.interactions.get_mut(&resolved.interaction_id).expect("checked").1 = true;
            }
            EntryPayload::InteractionExpired(expired) => {
                let (opened, done) = reference(
                    self.interactions.get(&expired.interaction_id).copied(),
                    "interaction_id",
                )?;
                transition(!done, "interaction_id")?;
                if let Some(input) = expired.preempting_input_id {
                    self.preempt(input, opened.run_id)?;
                    self.interaction_preempts
                        .insert(self.tools[&opened.tool_id].0.key.turn_id, input);
                }
                self.interactions.get_mut(&expired.interaction_id).expect("checked").1 = true;
            }
            EntryPayload::TurnEnded(end) => {
                let turn = self.turn(end.turn_id)?;
                let latest = self
                    .gens
                    .values()
                    .filter(|(generation, _)| generation.turn_id == Some(end.turn_id))
                    .max_by_key(|(generation, _)| generation.attempt);
                if let Some((generation, gen_end)) = latest {
                    let gen_end = reference(*gen_end, "final_gen_id")?;
                    ownership(end.final_gen_id == Some(generation.gen_id), "final_gen_id")?;
                    if end.status == TurnStatus::Completed {
                        transition(gen_end.status == GenStatus::Completed, "status")?;
                    }
                    if let Some(trigger) = gen_end.preempting_input_id
                        && end.status == TurnStatus::Preempted
                    {
                        ownership(end.preempting_input_id == Some(trigger), "preempting_input_id")?;
                    }
                } else {
                    transition(
                        end.final_gen_id.is_none() && end.status != TurnStatus::Completed,
                        "final_gen_id",
                    )?;
                }
                if let Some(input) = end.preempting_input_id {
                    self.preempt(input, turn.run_id)?;
                    if let Some(trigger) = self.interaction_preempts.get(&turn.turn_id) {
                        ownership(*trigger == input, "preempting_input_id")?;
                    }
                }
                if end.status != TurnStatus::Interrupted {
                    self.closed_tools(turn.turn_id)?;
                }
                transition(
                    !self
                        .interactions
                        .values()
                        .any(|(opened, done)| self.tools[&opened.tool_id].0.key.turn_id == turn.turn_id && !done),
                    "interaction_id",
                )?;
                self.turns.get_mut(&turn.turn_id).expect("checked").1 = Some(end);
                self.ended_turn_entries.insert(turn.turn_id, entry.entry_id);
            }
            EntryPayload::RunEnd(end) => {
                let run = self.run(end.run_id)?;
                transition(
                    self.turns
                        .values()
                        .all(|(turn, end)| turn.run_id != run.run_id || end.is_some()),
                    "run_id",
                )?;
                transition(
                    self.gens
                        .values()
                        .all(|(generation, end)| generation.run_id != Some(run.run_id) || end.is_some()),
                    "run_id",
                )?;
                let limits = &run.context.limits;
                value(end.tool_calls_used <= limits.max_tool_calls, "tool_calls_used")?;
                if end.status == RunStatus::Completed {
                    let last_turn = self
                        .turns
                        .values()
                        .filter(|(turn, _)| turn.run_id == run.run_id)
                        .max_by_key(|(turn, _)| turn.ordinal);
                    transition(
                        last_turn.is_some_and(|(_, end)| end.is_some_and(|end| end.status == TurnStatus::Completed)),
                        "status",
                    )?;
                    transition(
                        !self
                            .inputs
                            .values()
                            .any(|(input, done)| !done && input.expected_run_id == Some(run.run_id)),
                        "input_ids",
                    )?;
                }
                self.runs.get_mut(&run.run_id).expect("checked").1 = Some(end);
                self.active_run = None;
                self.last_run_end = Some(end);
            }
            EntryPayload::Compacted(compacted) => self.compaction(entry.entry_id, compacted)?,
        }
        Ok(())
    }
}

fn answer(request: &InteractionRequest, answer: &InteractionAnswer) -> Result<(), ValidationError> {
    match (request, answer) {
        (
            InteractionRequest::Question {
                options, multi_select, ..
            },
            InteractionAnswer::Question { selected_indices, text },
        ) => {
            value(*multi_select || selected_indices.len() <= 1, "answer.selected_indices")?;
            value(
                !selected_indices.is_empty() || text.as_ref().is_some_and(|s| !s.trim().is_empty()),
                "answer",
            )?;
            let mut selected = HashSet::new();
            for index in selected_indices {
                value((*index as usize) < options.len(), "answer.selected_indices")?;
                unique(&mut selected, index, "answer.selected_indices")?;
            }
        }
        (InteractionRequest::Permission { .. }, InteractionAnswer::Permission { .. })
        | (InteractionRequest::ToolExecution { .. }, InteractionAnswer::ToolExecution { .. }) => {}
        _ => ownership(false, "answer")?,
    }
    Ok(())
}

impl<'a> History<'a> {
    fn replaced_position(&self, mut id: EntryId) -> usize {
        // A synthetic checkpoint message may replace only an older prefix, not its kept suffix.
        while let Some(checkpoint) = self.checkpoints.get(&id) {
            id = checkpoint.replaced_through_entry_id;
        }
        self.entries[&id]
    }

    fn effective_at(&self, upper: usize) -> Vec<(EntryId, &'a AgentMessage)> {
        let checkpoint = self
            .checkpoints
            .iter()
            .filter(|(id, compacted)| {
                self.entries[id] <= upper
                    && compacted
                        .boundary
                        .through_entry_id
                        .is_some_and(|id| self.entries[&id] <= upper)
            })
            .max_by_key(|(id, _)| self.entries[id]);
        let mut history = Vec::new();
        let mut replaced = 0;
        if let Some((id, compacted)) = checkpoint {
            history.extend(compacted.replacement_history.iter().map(|msg| (*id, msg)));
            replaced = self.replaced_position(compacted.replaced_through_entry_id);
        }
        history.extend(
            self.effective
                .iter()
                .filter(|(id, committed, _)| *committed <= upper && self.entries[id] > replaced)
                .map(|(id, _, msg)| (*id, *msg)),
        );
        history
    }

    fn compaction(&mut self, id: EntryId, compacted: &'a Compacted) -> Result<(), ValidationError> {
        self.boundary(&compacted.boundary)?;
        let (generation, end) = reference(self.gens.get(&compacted.gen_id).copied(), "gen_id")?;
        let end = reference(end, "gen_id")?;
        ownership(
            generation.purpose == GenPurpose::Compaction
                && generation.run_id == compacted.run_id
                && generation.boundary == compacted.boundary,
            "gen_id",
        )?;
        transition(end.status == GenStatus::Completed, "gen_id")?;
        transition(
            !self.checkpoints.values().any(|old| old.gen_id == generation.gen_id),
            "gen_id",
        )?;
        let upper_id = reference(compacted.boundary.through_entry_id, "boundary.through_entry_id")?;
        let upper = self.entries[&upper_id];
        let replaced = reference(
            self.entries.get(&compacted.replaced_through_entry_id).copied(),
            "replaced_through_entry_id",
        )?;
        value(replaced <= upper, "replaced_through_entry_id")?;
        let latest = self
            .checkpoints
            .iter()
            .filter(|(id, _)| self.entries[id] <= upper)
            .max_by_key(|(id, _)| self.entries[id])
            .map(|(id, _)| *id);
        ownership(latest == compacted.previous_checkpoint_id, "previous_checkpoint_id")?;
        let input = self.effective_at(upper);
        let split = reference(
            input
                .iter()
                .rposition(|(id, _)| *id == compacted.replaced_through_entry_id),
            "replaced_through_entry_id",
        )?;
        ownership(
            input.get(split + 1).map(|(id, _)| *id) == compacted.kept_from_entry_id,
            "kept_from_entry_id",
        )?;
        let configuration = if let Some(configuration) = &generation.context {
            configuration
        } else {
            &reference(
                generation
                    .run_id
                    .and_then(|run| self.runs.get(&run).map(|(run, _)| *run)),
                "run_id",
            )?
            .context
        };
        let model = &configuration.model;
        let original: Vec<_> = input.iter().map(|(_, msg)| (*msg).clone()).collect();
        let unknown = ModelCapabilities {
            input_modalities: vec![InputModality::Text, InputModality::Image],
            supports_reasoning: true,
            context_window: model.budget.context_window,
            max_output_tokens: model.budget.max_output_tokens,
        };
        let capabilities = model.capabilities.as_ref().unwrap_or(&unknown);
        validate_model_context(&original, capabilities)?;
        let prefix: Vec<_> = input[..=split].iter().map(|(_, msg)| (*msg).clone()).collect();
        validate_model_context(&prefix, capabilities)?;
        validate_model_context(&compacted.replacement_history, capabilities)?;
        if let Some(run) = compacted.run_id {
            self.run(run)?;
        }
        transition(
            !self
                .turns
                .values()
                .any(|(turn, end)| Some(turn.run_id) == compacted.run_id && end.is_none()),
            "boundary",
        )?;
        self.checkpoints.insert(id, compacted);
        Ok(())
    }
}

/// Validates a committed prefix, including legal unfinished states. Does not recover or execute it.
pub fn validate_history(entries: &[JournalEntry]) -> Result<(), ValidationError> {
    if entries.is_empty() {
        return Ok(());
    }
    let session_id = entries[0].session_id;
    let mut history = History::default();
    for (index, entry) in entries.iter().enumerate() {
        let result: Result<(), ValidationError> = (|| {
            validate_entry(entry)?;
            ownership(entry.session_id == session_id, "session_id")?;
            value(entry.sequence.0 == index as u64 + 1, "sequence")?;
            require(
                !history.entries.contains_key(&entry.entry_id),
                ValidationCode::DuplicateIdentity,
                "entry_id",
            )?;
            if index == 0 {
                value(matches!(entry.payload, EntryPayload::SessionHeader), "payload")?;
            } else {
                value(!matches!(entry.payload, EntryPayload::SessionHeader), "payload")?;
                if index == 1 {
                    value(matches!(entry.payload, EntryPayload::Meta(_)), "payload")?;
                }
            }
            // Current entry is deliberately absent while checking all preceding references.
            history.push(entry)?;
            history.entries.insert(entry.entry_id, index + 1);
            Ok(())
        })();
        if let Err(mut error) = result {
            error.entry_id = Some(entry.entry_id);
            return Err(error);
        }
    }
    Ok(())
}

impl ContextBudgetSnapshot {
    /// Reconstructs measurements only; title/extraction usage cannot overwrite chat context tokens.
    pub fn from_entries(entries: &[JournalEntry]) -> Result<Self, ValidationError> {
        validate_history(entries)?;
        let mut snapshot = Self {
            context_tokens: None,
            latest_gen_end_id: None,
            latest_compaction_id: None,
            stale: false,
        };
        let mut conversation_gens = HashSet::new();
        let mut model_preferences = None;
        for entry in entries {
            match &entry.payload {
                EntryPayload::GenStarted(generation) if generation.purpose == GenPurpose::Conversation => {
                    conversation_gens.insert(generation.gen_id);
                }
                EntryPayload::GenEnded(generation) if conversation_gens.contains(&generation.gen_id) => {
                    snapshot.context_tokens = generation.context_tokens;
                    snapshot.latest_gen_end_id = Some(entry.entry_id);
                    snapshot.stale = generation.context_tokens.is_none();
                }
                EntryPayload::Compacted(_) => {
                    snapshot.latest_compaction_id = Some(entry.entry_id);
                    snapshot.stale = true;
                }
                EntryPayload::InputConsumed(_) | EntryPayload::ToolOutcome(_) => snapshot.stale = true,
                EntryPayload::Meta(meta) => {
                    let preferences = (&meta.model_ref, &meta.reasoning);
                    if model_preferences.is_some_and(|old| old != preferences) {
                        snapshot.stale = true;
                    }
                    model_preferences = Some(preferences);
                }
                _ => {}
            }
        }
        Ok(snapshot)
    }
}

/// Resolves the checkpoint chain and kept suffix from the effective input at this boundary.
pub(crate) fn compaction_references(
    entries: &[JournalEntry],
    boundary: &ContextBoundary,
    replaced: EntryId,
) -> Result<(Option<EntryId>, Option<EntryId>), ValidationError> {
    let mut history = History::default();
    for (index, entry) in entries.iter().enumerate() {
        history.push(entry)?;
        history.entries.insert(entry.entry_id, index + 1);
    }
    history.boundary(boundary)?;
    let upper_id = reference(boundary.through_entry_id, "boundary.through_entry_id")?;
    let upper = history.entries[&upper_id];
    let previous = history
        .checkpoints
        .keys()
        .filter(|id| history.entries[id] <= upper)
        .max_by_key(|id| history.entries[id])
        .copied();
    let input = history.effective_at(upper);
    let split = reference(
        input.iter().rposition(|(id, _)| *id == replaced),
        "replaced_through_entry_id",
    )?;
    Ok((previous, input.get(split + 1).map(|(id, _)| *id)))
}
