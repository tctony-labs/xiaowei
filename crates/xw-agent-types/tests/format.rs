use serde_json::{Value, json};
use xw_agent_types::*;

const TEXT: &str = include_str!("fixtures/v2/text.jsonl");
const TOOLS: &str = include_str!("fixtures/v2/tools.jsonl");

fn objects(value: &Value, path: Vec<String>, result: &mut Vec<Vec<String>>) {
    match value {
        Value::Object(object) => {
            result.push(path.clone());
            for (key, value) in object {
                let mut path = path.clone();
                path.push(key.clone());
                objects(value, path, result);
            }
        }
        Value::Array(array) => {
            for (index, value) in array.iter().enumerate() {
                let mut path = path.clone();
                path.push(index.to_string());
                objects(value, path, result);
            }
        }
        _ => {}
    }
}

fn at<'a>(value: &'a mut Value, path: &[String]) -> &'a mut Value {
    let mut cursor = value;
    for key in path {
        cursor = if cursor.is_array() {
            &mut cursor[key.parse::<usize>().unwrap()]
        } else {
            &mut cursor[key]
        };
    }
    cursor
}

#[test]
fn all_nested_objects_reject_unknown_fields_and_malformed_shapes_without_leaking_values() {
    for fixture in [TEXT, TOOLS, include_str!("fixtures/v2/inputs.jsonl")] {
        let history = decode_history(fixture).unwrap();
        for (index, line) in fixture.lines().enumerate() {
            let original: Value = serde_json::from_str(line).unwrap();
            let mut paths = Vec::new();
            objects(&original, Vec::new(), &mut paths);
            for path in paths {
                let mut unknown = original.clone();
                at(&mut unknown, &path)
                    .as_object_mut()
                    .unwrap()
                    .insert("secret-unknown-key".into(), json!("secret-value"));
                let error = decode_entry(&unknown.to_string(), &history[..index]).unwrap_err();
                assert!(!format!("{error:?} {error}").contains("secret"));

                for malformed in [Value::Null, json!([]), json!("secret-value"), json!(42)] {
                    // Optional object values may legitimately become explicit null.
                    if malformed.is_null()
                        && path.last().is_some_and(|key| {
                            ["usage", "cost", "error", "selection", "capabilities"].contains(&key.as_str())
                        })
                    {
                        continue;
                    }
                    let mut invalid = original.clone();
                    *at(&mut invalid, &path) = malformed;
                    assert!(
                        decode_entry(&invalid.to_string(), &history[..index]).is_err(),
                        "{path:?}"
                    );
                }
            }
        }
    }
}

#[test]
fn only_first_record_is_session_header_and_config_has_no_ui_or_host_state() {
    let history = decode_history(TEXT).unwrap();
    for (index, line) in encode_history(&history).unwrap().lines().enumerate() {
        let value: Value = serde_json::from_str(line).unwrap();
        assert_eq!(value.get("session_id").is_some(), index == 0);
        assert_eq!(value.get("schema_version").is_some(), index == 0);
        assert!(value.get("sequence").is_none());
        if index == 0 {
            assert_eq!(value["payload"], json!({"type": "session_header"}));
        }
        if value["payload"]["type"] == "meta" {
            let keys = value["payload"]["data"].as_object().unwrap();
            assert!(
                keys.keys()
                    .all(|key| { ["model_ref", "reasoning", "provider_name", "model_name"].contains(&key.as_str()) })
            );
        }
        assert_ne!(value["payload"]["type"], "context_defined");
        if value["payload"]["type"] == "gen_started" && value["payload"]["data"]["purpose"]["type"] == "conversation" {
            assert!(value["payload"]["data"].get("context").is_none());
        }
    }
}

#[test]
fn header_is_immutable_and_initial_meta_must_precede_other_records() {
    let history = decode_history(TEXT).unwrap();
    validate_history(&history[..1]).unwrap();

    let mut duplicate = history[..2].to_vec();
    let mut header = history[0].clone();
    header.entry_id = EntryId::new();
    header.sequence = Sequence(3);
    duplicate.push(header);
    assert!(validate_history(&duplicate).is_err());

    let mut missing_meta = history.clone();
    missing_meta.remove(1);
    for (index, entry) in missing_meta.iter_mut().enumerate() {
        entry.sequence = Sequence(index as u64 + 1);
    }
    assert!(validate_history(&missing_meta).is_err());

    let mut header: Value = serde_json::from_str(TEXT.lines().next().unwrap()).unwrap();
    header["payload"]["data"] = json!({});
    assert!(decode_entry(&header.to_string(), &[]).is_err());

    let mut meta = history[1].clone();
    meta.sequence = Sequence(1);
    assert!(encode_entry(&meta, &[]).is_err());
}

#[test]
fn user_body_and_tool_arguments_are_recorded_once_and_terminal_statistics_are_shared() {
    let stored: Vec<Value> = TOOLS.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
    for row in stored {
        let data = &row["payload"]["data"];
        match row["payload"]["type"].as_str().unwrap() {
            "input_accepted" => {
                let msg = &data["message"];
                for key in ["input_id", "run_id", "turn_id", "gen_id", "completeness"] {
                    assert!(msg.get(key).is_none());
                }
                assert!(msg["message"].get("type").is_none());
            }
            "tool_intent" => {
                for key in ["key", "assistant_message_id", "tool_name", "arguments_json"] {
                    assert!(data.get(key).is_none());
                }
                assert!(data.get("block_id").is_some());
            }
            "gen_ended" => {
                assert!(data.get("assistant_message_id").is_none());
                assert!(data.get("usage").is_none());
            }
            "run_end" => {
                for key in ["had_assistant_output", "tool_calls_used", "context_tokens"] {
                    assert!(data.get(key).is_none());
                }
            }
            _ => {}
        }
    }
}

#[test]
fn version_dispatch_is_header_only_and_redundant_later_headers_are_rejected() {
    assert_eq!(
        decode_entry(r#"{"schema_version":99,"future":{"n":1e400}}"#, &[]),
        Err(FormatError::UnsupportedVersion { version: 99 })
    );
    for invalid in [
        "{}",
        "{",
        r#"{"schema_version":null}"#,
        r#"{"schema_version":2,"schema_version":2}"#,
    ] {
        assert!(matches!(
            decode_entry(invalid, &[]),
            Err(FormatError::InvalidStructure { .. })
        ));
    }
    let history = decode_history(TEXT).unwrap();
    for key in ["sequence", "session_id", "schema_version"] {
        let mut later: Value = serde_json::from_str(TEXT.lines().nth(1).unwrap()).unwrap();
        later[key] = json!(1);
        assert!(decode_entry(&later.to_string(), &history[..1]).is_err());
    }
    let mut old = history[0].clone();
    old.schema_version = 1;
    assert!(encode_entry(&old, &[]).is_err());
}

#[test]
fn duplicate_keys_unknown_tags_and_extra_unit_variant_data_are_rejected() {
    let header = TEXT.lines().next().unwrap();
    let meta = TEXT.lines().nth(1).unwrap();
    let duplicate = header.replacen("\"schema_version\":2", "\"schema_version\":2,\"schema_version\":2", 1);
    assert!(decode_entry(&duplicate, &[]).is_err());
    let duplicate = meta.replacen("\"model_ref\":", "\"model_ref\":\"secret\",\"model_ref\":", 1);
    assert!(decode_entry(&duplicate, &decode_history(TEXT).unwrap()[..1]).is_err());
    let mut entry: Value = serde_json::from_str(meta).unwrap();
    entry["payload"]["type"] = json!("secret-unknown-kind");
    assert!(decode_entry(&entry.to_string(), &decode_history(TEXT).unwrap()[..1]).is_err());

    let history = decode_history(TEXT).unwrap();
    let index = history
        .iter()
        .position(|row| matches!(row.payload, EntryPayload::GenStarted(_)))
        .unwrap();
    let mut entry: Value = serde_json::from_str(TEXT.lines().nth(index).unwrap()).unwrap();
    entry["payload"]["data"]["purpose"]["data"] = Value::Null;
    assert!(decode_entry(&entry.to_string(), &history[..index]).is_err());
}

#[test]
fn raw_provider_json_large_integers_and_finite_float_bits_survive_replay() {
    let mut history = decode_history(TOOLS).unwrap();
    let raw = " {\"integer\":18446744073709551615, \"huge\":1e400, \"n\":9007199254740993} ";
    let block_id = history
        .iter_mut()
        .find_map(|row| match &mut row.payload {
            EntryPayload::Message(recorded) => {
                let AgentMessage::Assistant(message) = &mut recorded.message else {
                    return None;
                };
                let ContentBlock::ToolCall { arguments_json, .. } = &mut message.content[0] else {
                    return None;
                };
                *arguments_json = Some(raw.into());
                Some(recorded.block_ids[0])
            }
            _ => None,
        })
        .unwrap();
    for row in &mut history {
        if let EntryPayload::ToolIntent(intent) = &mut row.payload
            && intent.block_id == block_id
        {
            intent.arguments_json = raw.into();
        }
    }
    let restored = decode_history(&encode_history(&history).unwrap()).unwrap();
    assert_eq!(restored, history);

    let mut history = decode_history(TEXT).unwrap();
    let index = history
        .iter()
        .position(|row| matches!(row.payload, EntryPayload::RunStarted(_)))
        .unwrap();
    let mut bits = 41_u64;
    for _ in 0..500 {
        bits = bits.wrapping_mul(6364136223846793005).wrapping_add(1);
        let sample = f64::from_bits(bits & 0x3fff_ffff_ffff_ffff);
        if !sample.is_finite() || sample > 2.0 {
            continue;
        }
        let EntryPayload::RunStarted(run) = &mut history[index].payload else {
            unreachable!()
        };
        run.context.generation.temperature = Some(sample);
        let encoded = encode_entry(&history[index], &history[..index]).unwrap();
        let restored = decode_entry(&encoded, &history[..index]).unwrap();
        let EntryPayload::RunStarted(run) = restored.payload else {
            unreachable!()
        };
        assert_eq!(run.context.generation.temperature.unwrap().to_bits(), sample.to_bits());
    }
}

#[test]
fn recovery_keeps_unknown_gen_end_time_and_partial_statistics_without_guessing() {
    let mut history = decode_history(TEXT).unwrap();
    let index = history
        .iter()
        .position(|row| matches!(&row.payload, EntryPayload::GenEnded(end) if end.status == GenStatus::Failed))
        .unwrap();
    history.truncate(index + 1);
    for row in &mut history {
        if let EntryPayload::Message(recorded) = &mut row.payload
            && let AgentMessage::Assistant(message) = &mut recorded.message
        {
            message.usage = None;
        }
    }
    let EntryPayload::GenEnded(end) = &mut history[index].payload else {
        unreachable!()
    };
    end.status = GenStatus::Interrupted;
    end.stop_reason = None;
    end.ended_at_ms = None;
    end.duration_ms = None;
    end.reasoning_duration_ms = None;
    let encoded = encode_history(&history).unwrap();
    let stored: Value = serde_json::from_str(encoded.lines().last().unwrap()).unwrap();
    assert!(stored["payload"]["data"].get("ended_at_ms").unwrap().is_null());
    assert_eq!(decode_history(&encoded).unwrap(), history);
}

#[test]
fn field_order_does_not_change_domain_values() {
    for fixture in [TEXT, TOOLS, include_str!("fixtures/v2/inputs.jsonl")] {
        let history = decode_history(fixture).unwrap();
        for (index, line) in fixture.lines().enumerate() {
            let sorted = serde_json::from_str::<Value>(line).unwrap().to_string();
            assert_eq!(decode_entry(&sorted, &history[..index]).unwrap(), history[index]);
        }
    }
}

#[test]
fn explicit_deletion_marker_api_keeps_its_separate_format_and_path_validation() {
    let entry = decode_entry(TEXT.lines().next().unwrap(), &[]).unwrap();
    let marker = DeletionMarker {
        schema_version: 1,
        session_id: entry.session_id,
        journal_relpath: format!("sessions/2026/10/{}.jsonl", entry.session_id),
        workspace_relpath: format!("workspaces/{}", entry.session_id),
        deleted_at_ms: 1000,
        committed_sequence: Sequence(10),
    };
    assert_eq!(
        decode_deletion_marker(r#"{"schema_version":99,"future":{"n":1e400}}"#),
        Err(FormatError::UnsupportedVersion { version: 99 })
    );
    let encoded = encode_deletion_marker(&marker).unwrap();
    assert_eq!(decode_deletion_marker(&encoded).unwrap(), marker);
    for path in ["../outside", "/absolute/path", "a/../../b", "", "a\\b"] {
        let mut invalid = marker.clone();
        invalid.journal_relpath = path.into();
        assert!(encode_deletion_marker(&invalid).is_err());
    }
    let mut object: Value = serde_json::from_str(&encoded).unwrap();
    object.as_object_mut().unwrap().remove("committed_sequence");
    assert!(decode_deletion_marker(&object.to_string()).is_err());
}

#[test]
fn propagated_error_is_saved_once_but_terminal_status_and_duration_stay_independent() {
    let mut history = decode_history(TEXT).unwrap();
    let index = history
        .iter()
        .position(|entry| matches!(&entry.payload, EntryPayload::GenEnded(end) if end.status == GenStatus::Failed))
        .unwrap();
    history.truncate(index + 1);
    let EntryPayload::GenEnded(end) = &history[index].payload else {
        unreachable!()
    };
    let error = end.error.clone().unwrap();
    let gen_id = end.gen_id;
    let context_tokens = end.context_tokens;
    let generation = history
        .iter()
        .find_map(|entry| match &entry.payload {
            EntryPayload::GenStarted(generation) if generation.gen_id == gen_id => Some(generation),
            _ => None,
        })
        .unwrap();
    let run_id = generation.run_id.unwrap();
    let turn_id = generation.turn_id.unwrap();
    let next = |payload, sequence| JournalEntry {
        schema_version: HISTORY_VERSION,
        session_id: history[0].session_id,
        entry_id: EntryId::new(),
        sequence: Sequence(sequence),
        timestamp_ms: 1200,
        payload,
    };
    let turn = next(
        EntryPayload::TurnEnded(TurnEnded {
            turn_id,
            status: TurnStatus::Failed,
            final_gen_id: Some(gen_id),
            preempting_input_id: None,
            duration_ms: Some(21),
            error: Some(error.clone()),
        }),
        history.len() as u64 + 1,
    );
    let run = next(
        EntryPayload::RunEnd(RunEnd {
            run_id,
            status: RunStatus::Failed,
            error: Some(error),
            duration_ms: Some(u64::MAX),
            had_assistant_output: true,
            tool_calls_used: 0,
            context_tokens,
        }),
        history.len() as u64 + 2,
    );
    history.extend([turn, run]);
    let encoded = encode_history(&history).unwrap();
    assert_eq!(encoded.matches("Generation stopped").count(), 1);
    let stored: Vec<Value> = encoded
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        stored[index + 1]["payload"]["data"]["error_ref"],
        json!(history[index].entry_id)
    );
    assert_eq!(
        stored[index + 2]["payload"]["data"]["error_ref"],
        json!(history[index + 1].entry_id)
    );
    assert_eq!(decode_history(&encoded).unwrap(), history);

    // An unrelated error body must survive instead of inheriting the child's error.
    let EntryPayload::RunEnd(end) = &mut history.last_mut().unwrap().payload else {
        unreachable!()
    };
    end.error = Some(SafeError {
        code: "other".into(),
        message: "different failure".into(),
    });
    let encoded = encode_history(&history).unwrap();
    let stored: Value = serde_json::from_str(encoded.lines().last().unwrap()).unwrap();
    assert!(stored["payload"]["data"].get("error_ref").is_none());
    assert_eq!(decode_history(&encoded).unwrap(), history);
}
