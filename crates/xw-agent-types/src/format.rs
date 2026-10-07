use serde::Deserialize;
use serde_json::{Map, Value};

use crate::*;

pub const HISTORY_VERSION: u32 = 2;

/// Diagnostics never retain source values, unknown keys or message contents.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FormatError {
    #[error("unsupported history version: {version}")]
    UnsupportedVersion { version: u32 },
    #[error("invalid history structure at {path:?}")]
    InvalidStructure { path: Option<String> },
}

fn invalid() -> FormatError {
    FormatError::InvalidStructure { path: None }
}

fn object(value: &mut Value) -> Result<&mut Map<String, Value>, FormatError> {
    value.as_object_mut().ok_or_else(invalid)
}

fn member<'a>(value: &'a mut Value, key: &str) -> Result<&'a mut Value, FormatError> {
    object(value)?.get_mut(key).ok_or_else(invalid)
}

fn get<T: serde::de::DeserializeOwned>(value: &Value, key: &str) -> Result<T, FormatError> {
    serde_json::from_value(value.get(key).cloned().ok_or_else(invalid)?).map_err(|_| invalid())
}

fn put<T: serde::Serialize>(value: &mut Value, key: &str, field: T) -> Result<(), FormatError> {
    object(value)?.insert(key.into(), serde_json::to_value(field).map_err(|_| invalid())?);
    Ok(())
}

fn remove(value: &mut Value, keys: &[&str]) -> Result<(), FormatError> {
    for key in keys {
        object(value)?.remove(*key);
    }
    Ok(())
}

fn absent(value: &Value, keys: &[&str]) -> Result<(), FormatError> {
    if keys.iter().any(|key| value.get(key).is_some()) {
        return Err(invalid());
    }
    Ok(())
}

// Serde accepts positional arrays for some structs. Stored history requires named objects.
fn check_object_shapes(stored: &Value, canonical: &Value) -> Result<(), FormatError> {
    match canonical {
        Value::Object(fields) => {
            let source = stored.as_object().ok_or_else(invalid)?;
            for (key, value) in fields {
                if let Some(stored) = source.get(key) {
                    check_object_shapes(stored, value)?;
                }
            }
        }
        Value::Array(values) => {
            let source = stored.as_array().ok_or_else(invalid)?;
            for (stored, canonical) in source.iter().zip(values) {
                check_object_shapes(stored, canonical)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn find<'a, T>(
    history: &'a [JournalEntry],
    select: impl Fn(&'a EntryPayload) -> Option<&'a T>,
) -> Result<&'a T, FormatError> {
    history
        .iter()
        .rev()
        .find_map(|entry| select(&entry.payload))
        .ok_or_else(invalid)
}

fn turn(history: &[JournalEntry], id: TurnId) -> Result<&TurnStarted, FormatError> {
    find(history, |payload| match payload {
        EntryPayload::TurnStarted(turn) if turn.turn_id == id => Some(turn),
        _ => None,
    })
}

fn generation(history: &[JournalEntry], id: GenId) -> Result<&GenStarted, FormatError> {
    find(history, |payload| match payload {
        EntryPayload::GenStarted(generation) if generation.gen_id == id => Some(generation),
        _ => None,
    })
}

fn configuration<'a>(history: &'a [JournalEntry], generation: &'a GenStarted) -> Result<&'a RunContext, FormatError> {
    if let Some(context) = &generation.context {
        return Ok(context);
    }
    find(history, |payload| match payload {
        EntryPayload::RunStarted(run) if Some(run.run_id) == generation.run_id => Some(&run.context),
        _ => None,
    })
}

fn assistant(history: &[JournalEntry], id: GenId) -> Option<&RecordedMessage> {
    history.iter().rev().find_map(|entry| match &entry.payload {
        EntryPayload::Message(message) if message.gen_id == Some(id) => Some(message),
        _ => None,
    })
}

fn tool(history: &[JournalEntry], id: ToolId) -> Result<&ToolIntent, FormatError> {
    find(history, |payload| match payload {
        EntryPayload::ToolIntent(intent) if intent.tool_id == id => Some(intent),
        _ => None,
    })
}

fn call(history: &[JournalEntry], id: BlockId) -> Result<(&RecordedMessage, &ContentBlock), FormatError> {
    for entry in history.iter().rev() {
        if let EntryPayload::Message(message) = &entry.payload
            && let Some(index) = message.block_ids.iter().position(|block| *block == id)
            && let AgentMessage::Assistant(assistant) = &message.message
        {
            return assistant
                .content
                .get(index)
                .map(|block| (message, block))
                .ok_or_else(invalid);
        }
    }
    Err(invalid())
}

fn last_gen(history: &[JournalEntry], id: TurnId) -> Option<GenId> {
    history.iter().rev().find_map(|entry| match &entry.payload {
        EntryPayload::GenStarted(generation)
            if generation.turn_id == Some(id) && generation.purpose == GenPurpose::Conversation =>
        {
            Some(generation.gen_id)
        }
        _ => None,
    })
}

fn error_cause<'a>(history: &'a [JournalEntry], payload: &EntryPayload) -> Option<(&'a JournalEntry, &'a SafeError)> {
    history.iter().rev().find_map(|entry| match (payload, &entry.payload) {
        (EntryPayload::TurnEnded(turn), EntryPayload::GenEnded(end)) if turn.final_gen_id == Some(end.gen_id) => {
            end.error.as_ref().map(|error| (entry, error))
        }
        (EntryPayload::RunEnd(run), EntryPayload::TurnEnded(end))
            if turn(history, end.turn_id).is_ok_and(|turn| turn.run_id == run.run_id) =>
        {
            end.error.as_ref().map(|error| (entry, error))
        }
        _ => None,
    })
}

fn context_encode(value: &mut Value) -> Result<(), FormatError> {
    let model = member(value, "model")?;
    if let Some(capabilities) = model.get_mut("capabilities") {
        remove(capabilities, &["context_window", "max_output_tokens"])?;
    }
    Ok(())
}

fn context_decode(value: &mut Value) -> Result<(), FormatError> {
    let model = member(value, "model")?;
    let budget = model.get("budget").cloned().ok_or_else(invalid)?;
    if let Some(capabilities) = model.get_mut("capabilities") {
        absent(capabilities, &["context_window", "max_output_tokens"])?;
        put(capabilities, "context_window", get::<u64>(&budget, "context_window")?)?;
        put(
            capabilities,
            "max_output_tokens",
            get::<u64>(&budget, "max_output_tokens")?,
        )?;
    }
    Ok(())
}

fn compact_message(value: &mut Value, outer_time: i64) -> Result<(), FormatError> {
    remove(value, &["run_id", "turn_id", "input_id"])?;
    let message = member(value, "message")?;
    remove(message, &["type"])?;
    if message.get("timestamp_ms").and_then(Value::as_i64) == Some(outer_time) {
        remove(message, &["timestamp_ms"])?;
    }
    Ok(())
}

fn restore_message(value: &mut Value, role: &str, outer_time: i64) -> Result<(), FormatError> {
    absent(value, &["run_id", "turn_id", "input_id"])?;
    let message = member(value, "message")?;
    absent(message, &["type"])?;
    put(message, "type", role)?;
    if message.get("timestamp_ms").is_none() {
        put(message, "timestamp_ms", outer_time)?;
    }
    Ok(())
}

/// Encodes one record against its preceding validated prefix, without a newline.
pub fn encode_entry(entry: &JournalEntry, history: &[JournalEntry]) -> Result<String, FormatError> {
    if entry.schema_version != HISTORY_VERSION {
        return Err(FormatError::UnsupportedVersion {
            version: entry.schema_version,
        });
    }
    let mut candidate = history.to_vec();
    candidate.push(entry.clone());
    validate_history(&candidate).map_err(|error| FormatError::InvalidStructure { path: Some(error.path) })?;
    let mut stored = serde_json::to_value(entry).map_err(|_| invalid())?;
    remove(&mut stored, &["sequence"])?;
    if !history.is_empty() {
        remove(&mut stored, &["session_id", "schema_version"])?;
    }
    if matches!(entry.payload, EntryPayload::SessionHeader) {
        return serde_json::to_string(&stored).map_err(|_| invalid());
    }
    let data = member(member(&mut stored, "payload")?, "data")?;
    match &entry.payload {
        EntryPayload::SessionHeader => unreachable!("header encoded above"),
        EntryPayload::Meta(_) => {}
        EntryPayload::RunStarted(_) => context_encode(member(data, "context")?)?,
        EntryPayload::TurnStarted(_) => remove(data, &["ordinal"])?,
        EntryPayload::InputAccepted(_) => {
            compact_message(member(data, "message")?, entry.timestamp_ms)?;
            remove(member(data, "message")?, &["gen_id", "completeness"])?;
        }
        EntryPayload::InputConsumed(input) => {
            remove(data, &["run_id"])?;
            if input.boundary == turn(history, input.turn_id)?.boundary {
                remove(data, &["boundary"])?;
            }
        }
        EntryPayload::GenStarted(generation) => {
            remove(data, &["attempt"])?;
            if generation.turn_id.is_some() || matches!(generation.purpose, GenPurpose::ToolExtraction { .. }) {
                remove(data, &["run_id"])?;
            }
            if generation.started_at_ms == entry.timestamp_ms {
                remove(data, &["started_at_ms"])?;
            }
            if let Some(context) = data.get_mut("context") {
                context_encode(context)?;
            }
        }
        EntryPayload::GenFirstSseReceived(first) => {
            if first.received_at_ms == entry.timestamp_ms {
                remove(data, &["received_at_ms"])?;
            }
        }
        EntryPayload::Message(_) => compact_message(data, entry.timestamp_ms)?,
        EntryPayload::GenEnded(end) => {
            remove(data, &["assistant_message_id"])?;
            if end.ended_at_ms == Some(entry.timestamp_ms) {
                remove(data, &["ended_at_ms"])?;
            } else if end.ended_at_ms.is_none() {
                put(data, "ended_at_ms", Value::Null)?;
            }
            if let Some(message) = assistant(history, end.gen_id)
                && let AgentMessage::Assistant(message) = &message.message
            {
                if message.usage.is_some() && end.usage == message.usage {
                    remove(data, &["usage"])?;
                } else if end.usage.is_none() && message.usage.is_some() {
                    put(data, "usage", Value::Null)?;
                }
                if end.stop_reason == Some(message.stop_reason) {
                    remove(data, &["stop_reason"])?;
                } else if end.stop_reason.is_none() {
                    put(data, "stop_reason", Value::Null)?;
                }
            }
        }
        EntryPayload::TurnEnded(_) => remove(data, &["final_gen_id"])?,
        EntryPayload::RunEnd(_) => remove(data, &["had_assistant_output", "tool_calls_used", "context_tokens"])?,
        EntryPayload::ToolIntent(_) => {
            remove(data, &["key", "assistant_message_id", "tool_name", "arguments_json"])?;
        }
        EntryPayload::ToolOutcome(_) => {
            remove(data, &["key"])?;
            compact_message(member(data, "result")?, entry.timestamp_ms)?;
            remove(member(data, "result")?, &["gen_id", "completeness"])?;
            remove(
                member(member(data, "result")?, "message")?,
                &["tool_call_id", "tool_name", "is_error"],
            )?;
        }
        EntryPayload::InteractionOpened(_) => remove(data, &["run_id", "revision"])?,
        EntryPayload::InteractionResolved(_) | EntryPayload::InteractionExpired(_) => remove(data, &["revision"])?,
        EntryPayload::Compacted(_) => remove(
            data,
            &[
                "run_id",
                "boundary",
                "kept_from_entry_id",
                "previous_checkpoint_id",
                "summary",
                "context_window",
                "duration_ms",
            ],
        )?,
        EntryPayload::InputCancelled(_) => {}
    }
    if let Some((cause, error)) = error_cause(history, &entry.payload)
        && data.get("error") == Some(&serde_json::to_value(error).map_err(|_| invalid())?)
    {
        remove(data, &["error"])?;
        put(data, "error_ref", cause.entry_id)?;
    }
    serde_json::to_string(&stored).map_err(|_| invalid())
}

/// Restores omitted ownership and configuration from the preceding file records.
pub fn decode_entry(line: &str, history: &[JournalEntry]) -> Result<JournalEntry, FormatError> {
    if history.is_empty() {
        #[derive(Deserialize)]
        struct Header {
            schema_version: u32,
        }
        let header: Header = serde_json::from_str(line).map_err(|_| invalid())?;
        if header.schema_version != HISTORY_VERSION {
            return Err(FormatError::UnsupportedVersion {
                version: header.schema_version,
            });
        }
    }
    let mut stored = crate::stored_json::parse(line).map_err(|_| invalid())?;
    absent(&stored, &["sequence"])?;
    if let Some(first) = history.first() {
        absent(&stored, &["session_id", "schema_version"])?;
        put(&mut stored, "session_id", first.session_id)?;
        put(&mut stored, "schema_version", HISTORY_VERSION)?;
    }
    put(&mut stored, "sequence", history.len() as u64 + 1)?;
    let outer_time: i64 = get(&stored, "timestamp_ms")?;
    let kind: String = get(&stored["payload"], "type")?;
    if kind == "session_header" {
        return decode_stored(stored, history);
    }
    let data = member(member(&mut stored, "payload")?, "data")?;
    match kind.as_str() {
        "meta" => {}
        "run_started" => context_decode(member(data, "context")?)?,
        "turn_started" => {
            absent(data, &["ordinal"])?;
            let run_id: RunId = get(data, "run_id")?;
            let ordinal = history
                .iter()
                .filter(|entry| matches!(&entry.payload, EntryPayload::TurnStarted(turn) if turn.run_id == run_id))
                .count() as u32
                + 1;
            put(data, "ordinal", ordinal)?;
        }
        "input_accepted" => {
            let id: InputId = get(data, "input_id")?;
            let message = member(data, "message")?;
            absent(message, &["gen_id", "completeness"])?;
            restore_message(message, "user", outer_time)?;
            put(message, "input_id", id)?;
            put(message, "completeness", MessageCompleteness::Complete)?;
        }
        "input_consumed" => {
            absent(data, &["run_id"])?;
            let turn = turn(history, get(data, "turn_id")?)?;
            put(data, "run_id", turn.run_id)?;
            if data.get("boundary").is_none() {
                put(data, "boundary", &turn.boundary)?;
            }
        }
        "gen_started" => {
            absent(data, &["attempt"])?;
            let turn_id: Option<TurnId> = data
                .get("turn_id")
                .map(|v| serde_json::from_value(v.clone()))
                .transpose()
                .map_err(|_| invalid())?
                .flatten();
            let purpose: GenPurpose = get(data, "purpose")?;
            if let Some(turn_id) = turn_id {
                absent(data, &["run_id"])?;
                put(data, "run_id", turn(history, turn_id)?.run_id)?;
            } else if let GenPurpose::ToolExtraction { tool_id } = purpose {
                absent(data, &["run_id"])?;
                put(data, "run_id", tool(history, tool_id)?.key.run_id)?;
            }
            let attempt = if turn_id.is_some() {
                history.iter().filter(|entry| matches!(&entry.payload,
                    EntryPayload::GenStarted(old) if old.turn_id == turn_id && old.purpose == GenPurpose::Conversation
                )).count() as u32 + 1
            } else {
                1
            };
            put(data, "attempt", attempt)?;
            if data.get("started_at_ms").is_none() {
                put(data, "started_at_ms", outer_time)?;
            }
            if let Some(context) = data.get_mut("context") {
                context_decode(context)?;
            }
        }
        "gen_first_sse_received" => {
            if data.get("received_at_ms").is_none() {
                put(data, "received_at_ms", outer_time)?;
            }
        }
        "message" => {
            let generation = generation(history, get(data, "gen_id")?)?;
            restore_message(data, "assistant", outer_time)?;
            put(data, "run_id", generation.run_id)?;
            put(data, "turn_id", generation.turn_id)?;
        }
        "gen_ended" => {
            absent(data, &["assistant_message_id"])?;
            let id: GenId = get(data, "gen_id")?;
            let message = assistant(history, id);
            put(data, "assistant_message_id", message.map(|message| message.message_id))?;
            if data.get("ended_at_ms").is_none() {
                put(data, "ended_at_ms", outer_time)?;
            }
            if let Some(message) = message
                && let AgentMessage::Assistant(message) = &message.message
            {
                if data.get("usage").is_none() {
                    put(data, "usage", &message.usage)?;
                }
                if data.get("stop_reason").is_none() {
                    put(data, "stop_reason", message.stop_reason)?;
                }
            }
        }
        "turn_ended" => {
            absent(data, &["final_gen_id"])?;
            put(data, "final_gen_id", last_gen(history, get(data, "turn_id")?))?;
        }
        "run_end" => {
            absent(data, &["had_assistant_output", "tool_calls_used", "context_tokens"])?;
            let id: RunId = get(data, "run_id")?;
            let had_output = history.iter().any(|entry| {
                matches!(&entry.payload,
                    EntryPayload::Message(message) if message.run_id == Some(id)
                )
            });
            let tools = history
                .iter()
                .filter(|entry| {
                    matches!(&entry.payload,
                        EntryPayload::ToolIntent(tool) if tool.key.run_id == id
                    )
                })
                .count() as u32;
            let tokens = history
                .iter()
                .rev()
                .find_map(|entry| match &entry.payload {
                    EntryPayload::GenEnded(end)
                        if generation(history, end.gen_id)
                            .is_ok_and(|g| g.run_id == Some(id) && g.purpose == GenPurpose::Conversation) =>
                    {
                        Some(end.context_tokens)
                    }
                    _ => None,
                })
                .flatten();
            put(data, "had_assistant_output", had_output)?;
            put(data, "tool_calls_used", tools)?;
            put(data, "context_tokens", tokens)?;
        }
        "tool_intent" => {
            absent(data, &["key", "assistant_message_id", "tool_name", "arguments_json"])?;
            let block_id: BlockId = get(data, "block_id")?;
            let (message, block) = call(history, block_id)?;
            let ContentBlock::ToolCall {
                id,
                name,
                arguments_json: Some(arguments),
                ..
            } = block
            else {
                return Err(invalid());
            };
            let key = ProviderToolKey {
                run_id: message.run_id.ok_or_else(invalid)?,
                turn_id: message.turn_id.ok_or_else(invalid)?,
                gen_id: message.gen_id.ok_or_else(invalid)?,
                provider_call_id: id.clone(),
            };
            put(data, "key", key)?;
            put(data, "assistant_message_id", message.message_id)?;
            put(data, "tool_name", name)?;
            put(data, "arguments_json", arguments)?;
        }
        "tool_outcome" => {
            absent(data, &["key"])?;
            let intent = tool(history, get(data, "tool_id")?)?;
            let status: ToolStatus = get(data, "status")?;
            put(data, "key", &intent.key)?;
            let result = member(data, "result")?;
            absent(result, &["gen_id", "completeness"])?;
            restore_message(result, "tool_result", outer_time)?;
            put(result, "run_id", intent.key.run_id)?;
            put(result, "turn_id", intent.key.turn_id)?;
            put(result, "gen_id", intent.key.gen_id)?;
            put(result, "completeness", MessageCompleteness::Complete)?;
            let message = member(result, "message")?;
            absent(message, &["tool_call_id", "tool_name", "is_error"])?;
            put(message, "tool_call_id", &intent.key.provider_call_id)?;
            put(message, "tool_name", &intent.tool_name)?;
            put(message, "is_error", status != ToolStatus::Completed)?;
        }
        "interaction_opened" => {
            absent(data, &["run_id", "revision"])?;
            put(data, "run_id", tool(history, get(data, "tool_id")?)?.key.run_id)?;
            put(data, "revision", 1)?;
        }
        "interaction_resolved" | "interaction_expired" => {
            absent(data, &["revision"])?;
            put(data, "revision", 2)?;
        }
        "compacted" => {
            absent(
                data,
                &[
                    "run_id",
                    "boundary",
                    "kept_from_entry_id",
                    "previous_checkpoint_id",
                    "summary",
                    "context_window",
                    "duration_ms",
                ],
            )?;
            let generation = generation(history, get(data, "gen_id")?)?;
            let end = find(history, |payload| match payload {
                EntryPayload::GenEnded(end) if end.gen_id == generation.gen_id => Some(end),
                _ => None,
            })?;
            let replacement: Vec<AgentMessage> = get(data, "replacement_history")?;
            let summary = replacement
                .iter()
                .flat_map(|message| match message {
                    AgentMessage::User(message) => &message.content,
                    AgentMessage::Assistant(message) => &message.content,
                    AgentMessage::ToolResult(message) => &message.content,
                })
                .filter_map(|block| match block {
                    ContentBlock::Text { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            let (previous, kept) = crate::validation::compaction_references(
                history,
                &generation.boundary,
                get(data, "replaced_through_entry_id")?,
            )
            .map_err(|_| invalid())?;
            put(data, "run_id", generation.run_id)?;
            put(data, "boundary", &generation.boundary)?;
            put(data, "summary", summary)?;
            put(data, "previous_checkpoint_id", previous)?;
            put(data, "kept_from_entry_id", kept)?;
            put(
                data,
                "context_window",
                configuration(history, generation)?.model.budget.context_window,
            )?;
            put(data, "duration_ms", end.duration_ms)?;
        }
        "input_cancelled" => {}
        _ => return Err(invalid()),
    }
    let error_ref = object(data)?.remove("error_ref");
    if let Some(reference) = error_ref {
        absent(data, &["error"])?;
        let payload: EntryPayload = serde_json::from_value(stored["payload"].clone()).map_err(|_| invalid())?;
        let (cause, error) = error_cause(history, &payload).ok_or_else(invalid)?;
        if serde_json::from_value::<EntryId>(reference).map_err(|_| invalid())? != cause.entry_id {
            return Err(invalid());
        }
        put(member(member(&mut stored, "payload")?, "data")?, "error", error)?;
    }
    decode_stored(stored, history)
}

fn decode_stored(stored: Value, history: &[JournalEntry]) -> Result<JournalEntry, FormatError> {
    let entry: JournalEntry = serde_json::from_value(stored.clone()).map_err(|_| invalid())?;
    check_object_shapes(&stored, &serde_json::to_value(&entry).map_err(|_| invalid())?)?;
    let mut candidate = history.to_vec();
    candidate.push(entry.clone());
    validate_history(&candidate).map_err(|error| FormatError::InvalidStructure { path: Some(error.path) })?;
    Ok(entry)
}

pub fn decode_history(text: &str) -> Result<Vec<JournalEntry>, FormatError> {
    let mut entries = Vec::new();
    for line in text.lines() {
        entries.push(decode_entry(line, &entries)?);
    }
    Ok(entries)
}

pub fn encode_history(entries: &[JournalEntry]) -> Result<String, FormatError> {
    let mut encoded = String::new();
    for (index, entry) in entries.iter().enumerate() {
        encoded.push_str(&encode_entry(entry, &entries[..index])?);
        encoded.push('\n');
    }
    Ok(encoded)
}

pub fn encode_deletion_marker(marker: &DeletionMarker) -> Result<String, FormatError> {
    if marker.schema_version != 1 {
        return Err(FormatError::UnsupportedVersion {
            version: marker.schema_version,
        });
    }
    crate::validation::validate_deletion_marker(marker)
        .map_err(|error| FormatError::InvalidStructure { path: Some(error.path) })?;
    serde_json::to_string(marker).map_err(|_| invalid())
}

pub fn decode_deletion_marker(text: &str) -> Result<DeletionMarker, FormatError> {
    #[derive(Deserialize)]
    struct Header {
        schema_version: u32,
    }
    let header: Header = serde_json::from_str(text).map_err(|_| invalid())?;
    if header.schema_version != 1 {
        return Err(FormatError::UnsupportedVersion {
            version: header.schema_version,
        });
    }
    let marker = serde_json::from_str(text).map_err(|_| invalid())?;
    crate::validation::validate_deletion_marker(&marker)
        .map_err(|error| FormatError::InvalidStructure { path: Some(error.path) })?;
    Ok(marker)
}
