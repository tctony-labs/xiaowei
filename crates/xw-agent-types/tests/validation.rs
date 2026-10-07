use xw_agent_types::*;

fn history(name: &str) -> Vec<JournalEntry> {
    let fixture = match name {
        "text" => include_str!("fixtures/v2/text.jsonl"),
        "tools" => include_str!("fixtures/v2/tools.jsonl"),
        "inputs" => include_str!("fixtures/v2/inputs.jsonl"),
        "interactions" => include_str!("fixtures/v2/interactions.jsonl"),
        "compaction" => include_str!("fixtures/v2/compaction.jsonl"),
        "continue" => include_str!("fixtures/v2/continue.jsonl"),
        "interrupted" => include_str!("fixtures/v2/interrupted.jsonl"),
        _ => panic!("unknown fixture"),
    };
    decode_history(fixture).unwrap()
}

fn run_context(rows: &mut [JournalEntry]) -> &mut RunContext {
    rows.iter_mut()
        .find_map(|row| match &mut row.payload {
            EntryPayload::RunStarted(run) => Some(&mut run.context),
            _ => None,
        })
        .unwrap()
}

fn rejects(name: &str, mutate: impl FnOnce(&mut Vec<JournalEntry>)) -> ValidationError {
    let mut entries = history(name);
    mutate(&mut entries);
    let error = validate_history(&entries).unwrap_err();
    assert!(error.entry_id.is_some());
    assert!(!format!("{error:?} {error}").contains("secret"));
    error
}

fn append(entries: &mut Vec<JournalEntry>, payload: EntryPayload) {
    let previous = entries.last().unwrap();
    entries.push(JournalEntry {
        schema_version: 2,
        session_id: previous.session_id,
        entry_id: EntryId::new(),
        sequence: Sequence(entries.len() as u64 + 1),
        timestamp_ms: 1000,
        payload,
    });
}

#[test]
fn rejects_wrong_sequence_session_duplicate_identity_and_mutable_context() {
    rejects("text", |rows| rows[1].sequence = Sequence(999));
    rejects("text", |rows| rows[1].session_id = SessionId::new());
    rejects("text", |rows| rows[1].entry_id = rows[0].entry_id);
    rejects("text", |rows| {
        let run = rows
            .iter()
            .find(|row| matches!(row.payload, EntryPayload::RunStarted(_)))
            .unwrap();
        let payload = run.payload.clone();
        append(rows, payload);
    });
    rejects("text", |rows| {
        let EntryPayload::Meta(meta) = &mut rows.last_mut().unwrap().payload else {
            unreachable!()
        };
        meta.model_ref = None;
    });
}

#[test]
fn input_consumption_is_unique_ordered_and_owned_by_its_target() {
    rejects("inputs", |rows| {
        let consume = rows
            .iter()
            .find_map(|row| match &row.payload {
                EntryPayload::InputConsumed(input) => Some(input.clone()),
                _ => None,
            })
            .unwrap();
        let index = rows
            .iter()
            .position(|row| matches!(row.payload, EntryPayload::GenStarted(_)))
            .unwrap();
        let mut entry = rows[index].clone();
        entry.entry_id = EntryId::new();
        entry.payload = EntryPayload::InputConsumed(consume);
        rows.insert(index, entry);
        for (i, row) in rows.iter_mut().enumerate() {
            row.sequence = Sequence(i as u64 + 1);
        }
    });
    rejects("inputs", |rows| {
        for row in rows {
            if let EntryPayload::InputConsumed(input) = &mut row.payload
                && input.input_ids.len() == 2
            {
                input.input_ids.reverse();
                break;
            }
        }
    });
    rejects("inputs", |rows| {
        for row in rows {
            if let EntryPayload::InputAccepted(input) = &mut row.payload
                && input.mode == InputMode::Steering
            {
                input.expected_run_id = Some(RunId::new());
                break;
            }
        }
    });
    rejects("text", |rows| {
        let old_head = rows[0].entry_id;
        let EntryPayload::GenStarted(generation) = &mut rows[6].payload else {
            unreachable!()
        };
        generation.boundary.through_entry_id = Some(old_head);
    });
}

#[test]
fn gen_end_is_separate_from_turn_end_and_pending_tools_are_a_valid_prefix() {
    let entries = history("tools");
    let first_end = entries
        .iter()
        .position(|row| matches!(row.payload, EntryPayload::GenEnded(_)))
        .unwrap();
    validate_history(&entries[..=first_end]).unwrap();
    let generation = match &entries[first_end].payload {
        EntryPayload::GenEnded(generation) => generation.gen_id,
        _ => unreachable!(),
    };
    let turn = entries
        .iter()
        .find_map(|row| match &row.payload {
            EntryPayload::TurnStarted(turn) => Some(turn.turn_id),
            _ => None,
        })
        .unwrap();
    let mut prefix = entries[..=first_end].to_vec();
    append(
        &mut prefix,
        EntryPayload::TurnEnded(TurnEnded {
            turn_id: turn,
            status: TurnStatus::Completed,
            final_gen_id: Some(generation),
            preempting_input_id: None,
            duration_ms: None,
            error: None,
        }),
    );
    assert_eq!(
        validate_history(&prefix).unwrap_err().code,
        ValidationCode::UnpairedToolCall
    );
}

#[test]
fn tool_scope_and_result_pairing_are_checked() {
    rejects("tools", |rows| {
        for row in rows {
            if let EntryPayload::ToolOutcome(outcome) = &mut row.payload {
                outcome.key.gen_id = GenId::new();
                break;
            }
        }
    });
    rejects("tools", |rows| {
        for row in rows {
            if let EntryPayload::ToolOutcome(outcome) = &mut row.payload {
                let AgentMessage::ToolResult(result) = &mut outcome.result.message else {
                    unreachable!()
                };
                result.tool_call_id = "secret-wrong-call".into();
                break;
            }
        }
    });
    rejects("tools", |rows| {
        for row in rows {
            if let EntryPayload::ToolIntent(intent) = &mut row.payload {
                intent.arguments_json = "{\"secret\":true}".into();
                break;
            }
        }
    });
    rejects("tools", |rows| {
        let duplicate = rows
            .iter()
            .find_map(|row| match &row.payload {
                EntryPayload::ToolOutcome(outcome) => Some(outcome.clone()),
                _ => None,
            })
            .unwrap();
        append(rows, EntryPayload::ToolOutcome(duplicate));
    });
}

#[test]
fn tool_extraction_has_an_owner_and_must_finish_before_the_tool() {
    rejects("tools", |rows| {
        for row in rows {
            if let EntryPayload::GenStarted(generation) = &mut row.payload
                && matches!(generation.purpose, GenPurpose::ToolExtraction { .. })
            {
                generation.purpose = GenPurpose::ToolExtraction { tool_id: ToolId::new() };
                break;
            }
        }
    });
    rejects("tools", |rows| {
        let extraction = rows
            .iter()
            .find_map(|row| match &row.payload {
                EntryPayload::GenStarted(generation)
                    if matches!(generation.purpose, GenPurpose::ToolExtraction { .. }) =>
                {
                    Some(generation.gen_id)
                }
                _ => None,
            })
            .unwrap();
        let index = rows
            .iter()
            .position(|row| {
                matches!(&row.payload,
            EntryPayload::GenEnded(end) if end.gen_id == extraction)
            })
            .unwrap();
        rows.remove(index);
        for (i, row) in rows.iter_mut().enumerate() {
            row.sequence = Sequence(i as u64 + 1);
        }
    });
    rejects("tools", |rows| {
        let extraction = rows
            .iter()
            .find_map(|row| match &row.payload {
                EntryPayload::GenStarted(generation)
                    if matches!(generation.purpose, GenPurpose::ToolExtraction { .. }) =>
                {
                    Some(generation.gen_id)
                }
                _ => None,
            })
            .unwrap();
        let ended = rows
            .iter_mut()
            .find_map(|row| match &mut row.payload {
                EntryPayload::TurnEnded(turn) => Some(turn),
                _ => None,
            })
            .unwrap();
        ended.final_gen_id = Some(extraction);
    });
}

#[test]
fn preemption_causality_is_preserved_in_a_prefix_and_must_match_terminal_facts() {
    let entries = history("inputs");
    let prefix = entries
        .iter()
        .position(|row| {
            matches!(&row.payload,
        EntryPayload::GenEnded(end) if end.status == GenStatus::Preempted)
        })
        .unwrap();
    validate_history(&entries[..=prefix]).unwrap();
    rejects("inputs", |rows| {
        for row in rows {
            if let EntryPayload::GenEnded(end) = &mut row.payload
                && end.status == GenStatus::Preempted
            {
                end.preempting_input_id = None;
                break;
            }
        }
    });
    rejects("inputs", |rows| {
        let send = rows
            .iter()
            .find_map(|row| match &row.payload {
                EntryPayload::InputAccepted(input) if input.mode == InputMode::Send => Some(input.input_id),
                _ => None,
            })
            .unwrap();
        for row in rows {
            if let EntryPayload::GenEnded(end) = &mut row.payload
                && end.status == GenStatus::Preempted
            {
                end.preempting_input_id = Some(send);
                break;
            }
        }
    });
    rejects("inputs", |rows| {
        for row in rows {
            if let EntryPayload::InteractionExpired(expired) = &mut row.payload
                && expired.reason == InteractionExpireReason::Preempted
            {
                expired.preempting_input_id = Some(InputId::new());
                break;
            }
        }
    });
    rejects("inputs", |rows| {
        for row in rows {
            if let EntryPayload::TurnEnded(end) = &mut row.payload
                && end.status == TurnStatus::Preempted
            {
                end.preempting_input_id = Some(InputId::new());
                break;
            }
        }
    });
}

#[test]
fn first_sse_is_unique_and_cannot_arrive_after_a_committed_end() {
    rejects("text", |rows| {
        let first = rows
            .iter()
            .find_map(|row| match &row.payload {
                EntryPayload::GenFirstSseReceived(first) => Some(first.clone()),
                _ => None,
            })
            .unwrap();
        append(rows, EntryPayload::GenFirstSseReceived(first));
    });
    rejects("interrupted", |rows| {
        let first = rows
            .iter()
            .find_map(|row| match &row.payload {
                EntryPayload::GenFirstSseReceived(first) => Some(first.clone()),
                _ => None,
            })
            .unwrap();
        append(rows, EntryPayload::GenFirstSseReceived(first));
    });
    rejects("interrupted", |rows| {
        for row in rows {
            if let EntryPayload::GenFirstSseReceived(first) = &mut row.payload {
                first.gen_id = GenId::new();
                break;
            }
        }
    });
}

#[test]
fn interrupted_gen_can_have_unknown_end_time_and_wall_clock_rollback_is_valid() {
    let mut entries = history("interrupted");
    let first = entries
        .iter()
        .position(|row| matches!(row.payload, EntryPayload::GenFirstSseReceived(_)))
        .unwrap();
    entries.truncate(first + 1);
    let generation = entries
        .iter()
        .find_map(|row| match &row.payload {
            EntryPayload::GenStarted(generation) => Some(generation.clone()),
            _ => None,
        })
        .unwrap();
    append(
        &mut entries,
        EntryPayload::GenEnded(GenEnded {
            gen_id: generation.gen_id,
            status: GenStatus::Interrupted,
            preempting_input_id: None,
            ended_at_ms: None,
            stop_reason: None,
            assistant_message_id: None,
            usage: None,
            context_tokens: None,
            duration_ms: None,
            reasoning_duration_ms: None,
            error: None,
        }),
    );
    validate_history(&entries).unwrap();
    let EntryPayload::GenEnded(end) = &mut entries.last_mut().unwrap().payload else {
        unreachable!()
    };
    end.status = GenStatus::Aborted;
    assert!(validate_history(&entries).is_err());

    let mut entries = history("text");
    for (index, row) in entries.iter_mut().enumerate() {
        row.timestamp_ms = 1000 - index as i64;
    }
    for row in &mut entries {
        if let EntryPayload::GenFirstSseReceived(first) = &mut row.payload {
            first.received_at_ms = 100;
        }
        if let EntryPayload::GenEnded(end) = &mut row.payload {
            end.ended_at_ms = Some(90);
        }
    }
    validate_history(&entries).unwrap();
}

#[test]
fn interaction_answers_are_typed_bounded_and_cannot_win_twice() {
    rejects("interactions", |rows| {
        for row in rows {
            if let EntryPayload::InteractionResolved(resolved) = &mut row.payload {
                resolved.answer = InteractionAnswer::Question {
                    selected_indices: vec![0, 1],
                    text: None,
                };
                break;
            }
        }
    });
    rejects("interactions", |rows| {
        for row in rows {
            if let EntryPayload::InteractionResolved(resolved) = &mut row.payload {
                resolved.answer = InteractionAnswer::Permission { allow: true };
                break;
            }
        }
    });
    rejects("interactions", |rows| {
        let resolved = rows
            .iter()
            .find_map(|row| match &row.payload {
                EntryPayload::InteractionResolved(resolved) => Some(resolved.clone()),
                _ => None,
            })
            .unwrap();
        append(rows, EntryPayload::InteractionResolved(resolved));
    });
}

#[test]
fn checkpoint_provenance_and_tool_closure_are_required() {
    rejects("compaction", |rows| {
        for row in rows {
            if let EntryPayload::Compacted(compacted) = &mut row.payload {
                compacted.replaced_through_entry_id = EntryId::new();
                break;
            }
        }
    });
    rejects("compaction", |rows| {
        let EntryPayload::Compacted(compacted) = &mut rows.last_mut().unwrap().payload else {
            unreachable!()
        };
        compacted.previous_checkpoint_id = None;
    });
    rejects("compaction", |rows| {
        for row in rows {
            if let EntryPayload::Compacted(compacted) = &mut row.payload {
                compacted.kept_from_entry_id = Some(EntryId::new());
                break;
            }
        }
    });
    rejects("continue", |rows| {
        for row in rows {
            if let EntryPayload::ToolOutcome(outcome) = &mut row.payload {
                outcome.status = ToolStatus::Completed;
                let AgentMessage::ToolResult(result) = &mut outcome.result.message else {
                    unreachable!()
                };
                result.is_error = false;
                break;
            }
        }
    });
}

fn capabilities_and_messages() -> (ModelCapabilities, Vec<AgentMessage>) {
    let entries = history("tools");
    let capabilities = entries
        .iter()
        .find_map(|row| match &row.payload {
            EntryPayload::RunStarted(run) => run.context.model.capabilities.clone(),
            _ => None,
        })
        .unwrap();
    let mut messages = Vec::new();
    for row in &entries {
        match &row.payload {
            EntryPayload::InputAccepted(input) => messages.push(input.message.message.clone()),
            EntryPayload::Message(message) if message.turn_id.is_some() => messages.push(message.message.clone()),
            EntryPayload::ToolOutcome(outcome) => messages.push(outcome.result.message.clone()),
            _ => {}
        }
    }
    (capabilities, messages)
}

#[test]
fn model_context_accepts_repeated_provider_ids_in_distinct_assistant_batches() {
    let (capabilities, messages) = capabilities_and_messages();
    validate_model_context(&messages, &capabilities).unwrap();
    let mut invalid = messages.clone();
    invalid.remove(2);
    assert_eq!(
        validate_model_context(&invalid, &capabilities).unwrap_err().code,
        ValidationCode::UnpairedToolCall
    );
}

#[test]
fn model_context_checks_actual_worker_roles_images_usage_and_final_parameters() {
    let (capabilities, messages) = capabilities_and_messages();
    let reject = |messages: &[AgentMessage]| assert!(validate_model_context(messages, &capabilities).is_err());
    let mut invalid = messages.clone();
    let AgentMessage::Assistant(assistant) = &mut invalid[1] else {
        unreachable!()
    };
    assistant.usage.as_mut().unwrap().cost = None;
    reject(&invalid);
    let mut invalid = messages.clone();
    let AgentMessage::Assistant(assistant) = &mut invalid[1] else {
        unreachable!()
    };
    assistant.content.push(ContentBlock::Image {
        mime_type: "image/png".into(),
        data: vec![1],
    });
    reject(&invalid);
    let mut invalid = messages.clone();
    let AgentMessage::Assistant(assistant) = &mut invalid[1] else {
        unreachable!()
    };
    let ContentBlock::ToolCall { arguments_json, .. } = &mut assistant.content[0] else {
        unreachable!()
    };
    *arguments_json = None;
    reject(&invalid);
    let mut invalid = messages.clone();
    let AgentMessage::Assistant(assistant) = &mut invalid[1] else {
        unreachable!()
    };
    assistant.stop_reason = FinishReason::Length;
    reject(&invalid);
    let mut invalid = messages.clone();
    let AgentMessage::ToolResult(result) = &mut invalid[2] else {
        unreachable!()
    };
    result.usage = Some(TokenUsage {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
        total: 0,
        reasoning: None,
        cache_write_1h: None,
        cost: None,
    });
    reject(&invalid);
    let mut invalid = messages.clone();
    let AgentMessage::User(user) = &mut invalid[0] else {
        unreachable!()
    };
    user.timestamp_ms = -1;
    reject(&invalid);
    let mut invalid = messages.clone();
    let AgentMessage::Assistant(assistant) = &mut invalid[1] else {
        unreachable!()
    };
    assistant.usage.as_mut().unwrap().total = u64::MAX;
    reject(&invalid);

    let mut images = messages.clone();
    let AgentMessage::User(user) = &mut images[0] else {
        unreachable!()
    };
    user.content.push(ContentBlock::Image {
        mime_type: "image/png".into(),
        data: vec![1],
    });
    validate_model_context(&images, &capabilities).unwrap();
    let mut text_only = capabilities;
    text_only.input_modalities = vec![InputModality::Text];
    assert!(validate_model_context(&images, &text_only).is_err());
}

#[test]
fn invalid_configuration_and_secrets_produce_field_only_diagnostics() {
    for json in ["secret-invalid", "[]", "{\"apiKey\":\"secret-key\"}"] {
        rejects("text", |rows| {
            let context = run_context(rows);
            context.generation.metadata_json = Some(json.into());
        });
    }
    rejects("text", |rows| {
        let context = run_context(rows);
        context.generation.api_options_json = Some("{\"headers\":{\"secret\":true}}".into());
    });
    rejects("text", |rows| {
        let context = run_context(rows);
        context.generation.temperature = Some(f64::NAN);
    });
}

#[test]
fn capabilities_alone_validate_images_in_user_and_tool_result_messages() {
    let (mut capabilities, mut messages) = capabilities_and_messages();
    let AgentMessage::ToolResult(result) = &mut messages[2] else {
        unreachable!()
    };
    result.content.push(ContentBlock::Image {
        mime_type: "image/png".into(),
        data: vec![1],
    });
    validate_model_context(&messages, &capabilities).unwrap();

    capabilities.input_modalities = vec![InputModality::Text];
    let error = validate_model_context(&messages, &capabilities).unwrap_err();
    assert_eq!(error.message_index, Some(2));
}

#[test]
fn model_capabilities_enforce_budgets_and_reasoning_support() {
    for limits in [(0, 1), (100, 0), (100, 101), (9_007_199_254_740_992, 1)] {
        rejects("text", |rows| {
            let context = run_context(rows);
            context.model.capabilities.as_mut().unwrap().context_window = limits.0;
            context.model.capabilities.as_mut().unwrap().max_output_tokens = limits.1;
        });
    }
    for modalities in [vec![], vec![InputModality::Text, InputModality::Text]] {
        rejects("text", |rows| {
            let context = run_context(rows);
            context.model.capabilities.as_mut().unwrap().input_modalities = modalities;
        });
    }
    rejects("text", |rows| {
        let context = run_context(rows);
        context.generation.max_tokens = Some(context.model.capabilities.as_mut().unwrap().max_output_tokens as u32 + 1);
    });
    rejects("text", |rows| {
        let context = run_context(rows);
        context.model.capabilities.as_mut().unwrap().supports_reasoning = false;
        context.generation.reasoning = Some("adaptive".into());
    });

    let (mut capabilities, messages) = capabilities_and_messages();
    capabilities.context_window = 0;
    assert!(validate_model_context(&messages, &capabilities).is_err());
}

#[test]
fn provider_specific_options_are_preserved_without_interpreting_provider_rules() {
    let mut rows = history("text");
    let context = run_context(&mut rows);
    context.model.model_ref = "host-selected-model".into();
    context.generation.temperature = Some(3.0);
    context.generation.reasoning = Some("adaptive".into());
    context.generation.cache_retention = Some("automatic".into());
    context.generation.transport = Some("host-stream".into());
    context.generation.thinking_budgets_json = Some(" {\"adaptive\":512} ".into());
    context.generation.tool_choice_json = Some(" {\"type\":\"tool\",\"name\":\"Read\"} ".into());
    context.generation.api_options_json = Some(" {\"customMode\":{\"budget\":9007199254740993}} ".into());
    context.tools[0].constrained_sampling_json =
        Some(" {\"type\":\"grammar\",\"variants\":{\"host_engine\":\"start: text\"}} ".into());

    validate_history(&rows).unwrap();
    assert_eq!(decode_history(&encode_history(&rows).unwrap()).unwrap(), rows);
}

#[test]
fn opaque_generation_options_still_require_valid_structure_and_safe_diagnostics() {
    for json in ["secret-invalid", "[]", "{\"credentials\":\"secret-key\"}"] {
        rejects("text", |rows| {
            let context = run_context(rows);
            context.generation.api_options_json = Some(json.into());
        });
    }
    rejects("text", |rows| {
        let context = run_context(rows);
        context.generation.thinking_budgets_json = Some("[]".into());
    });
    rejects("text", |rows| {
        let context = run_context(rows);
        context.tools[0].constrained_sampling_json = Some("true".into());
    });
}

#[test]
fn continue_can_explicitly_consume_an_input_left_unconsumed_by_a_crash() {
    let mut rows = history("text");
    rows.truncate(4); // Header + Meta + Accepted + RunStarted committed, no Turn or consumption yet.
    let EntryPayload::RunStarted(old) = &rows[3].payload else {
        unreachable!()
    };
    let old = old.clone();
    let RunCause::Send { input_id } = old.cause else {
        unreachable!()
    };
    append(
        &mut rows,
        EntryPayload::RunEnd(RunEnd {
            run_id: old.run_id,
            status: RunStatus::Interrupted,
            error: None,
            duration_ms: None,
            had_assistant_output: false,
            tool_calls_used: 0,
            context_tokens: None,
        }),
    );
    let run_id = RunId::new();
    let boundary = ContextBoundary {
        through_entry_id: Some(rows.last().unwrap().entry_id),
        after_turn_id: None,
    };
    append(
        &mut rows,
        EntryPayload::RunStarted(RunStarted {
            run_id,
            cause: RunCause::Continue {
                previous_run_id: old.run_id,
                client_request_id: ClientRequestId::new(),
                source: InputSource {
                    kind: SourceKind::Cli,
                    principal_id: "local-user".into(),
                },
            },
            base_context: boundary,
            context: old.context.clone(),
        }),
    );
    let turn_id = TurnId::new();
    let boundary = ContextBoundary {
        through_entry_id: Some(rows.last().unwrap().entry_id),
        after_turn_id: None,
    };
    append(
        &mut rows,
        EntryPayload::TurnStarted(TurnStarted {
            turn_id,
            run_id,
            ordinal: 1,
            boundary,
        }),
    );
    let boundary = ContextBoundary {
        through_entry_id: Some(rows.last().unwrap().entry_id),
        after_turn_id: None,
    };
    let turn_entry = boundary.through_entry_id;
    append(
        &mut rows,
        EntryPayload::InputConsumed(InputConsumed {
            input_ids: vec![input_id],
            run_id,
            turn_id,
            boundary,
        }),
    );
    let boundary = ContextBoundary {
        through_entry_id: Some(rows.last().unwrap().entry_id),
        after_turn_id: None,
    };
    append(
        &mut rows,
        EntryPayload::GenStarted(GenStarted {
            gen_id: GenId::new(),
            run_id: Some(run_id),
            turn_id: Some(turn_id),
            attempt: 1,
            purpose: GenPurpose::Conversation,
            context: None,
            boundary,
            started_at_ms: 1000,
        }),
    );
    validate_history(&rows).unwrap();
    let consume = rows.len() - 2;
    rows.remove(consume);
    let EntryPayload::GenStarted(generation) = &mut rows.last_mut().unwrap().payload else {
        unreachable!()
    };
    generation.boundary.through_entry_id = turn_entry;
    for (index, row) in rows.iter_mut().enumerate() {
        row.sequence = Sequence(index as u64 + 1);
    }
    assert!(validate_history(&rows).is_err());
}

#[test]
fn unstarted_calls_can_only_be_supplemented_as_skipped_during_continue() {
    let complete = history("tools");
    let index = complete
        .iter()
        .position(|row| matches!(row.payload, EntryPayload::GenEnded(_)))
        .unwrap();
    let mut rows = complete[..=index].to_vec();
    let turn = rows
        .iter()
        .find_map(|row| match &row.payload {
            EntryPayload::TurnStarted(turn) => Some(turn.clone()),
            _ => None,
        })
        .unwrap();
    let run = rows
        .iter()
        .find_map(|row| match &row.payload {
            EntryPayload::RunStarted(run) => Some(run.clone()),
            _ => None,
        })
        .unwrap();
    let EntryPayload::GenEnded(end) = &rows[index].payload else {
        unreachable!()
    };
    let gen_id = end.gen_id;
    append(
        &mut rows,
        EntryPayload::TurnEnded(TurnEnded {
            turn_id: turn.turn_id,
            status: TurnStatus::Interrupted,
            final_gen_id: Some(gen_id),
            preempting_input_id: None,
            duration_ms: None,
            error: None,
        }),
    );
    append(
        &mut rows,
        EntryPayload::RunEnd(RunEnd {
            run_id: run.run_id,
            status: RunStatus::Interrupted,
            error: None,
            duration_ms: None,
            had_assistant_output: true,
            tool_calls_used: 0,
            context_tokens: None,
        }),
    );
    let continue_id = RunId::new();
    let boundary = ContextBoundary {
        through_entry_id: Some(rows.last().unwrap().entry_id),
        after_turn_id: None,
    };
    append(
        &mut rows,
        EntryPayload::RunStarted(RunStarted {
            run_id: continue_id,
            cause: RunCause::Continue {
                previous_run_id: run.run_id,
                client_request_id: ClientRequestId::new(),
                source: InputSource {
                    kind: SourceKind::Cli,
                    principal_id: "local-user".into(),
                },
            },
            base_context: boundary,
            context: run.context.clone(),
        }),
    );
    let intents: Vec<_> = complete
        .iter()
        .filter_map(|row| match &row.payload {
            EntryPayload::ToolIntent(tool) if tool.key.gen_id == gen_id => Some(tool.clone()),
            _ => None,
        })
        .collect();
    let outcomes: Vec<_> = complete
        .iter()
        .filter_map(|row| match &row.payload {
            EntryPayload::ToolOutcome(tool) if tool.key.gen_id == gen_id => Some(tool.clone()),
            _ => None,
        })
        .collect();
    for (intent, mut outcome) in intents.into_iter().zip(outcomes) {
        append(&mut rows, EntryPayload::ToolIntent(intent));
        outcome.status = ToolStatus::Skipped;
        outcome.settled_by_run_id = Some(continue_id);
        let AgentMessage::ToolResult(result) = &mut outcome.result.message else {
            unreachable!()
        };
        result.is_error = true;
        append(&mut rows, EntryPayload::ToolOutcome(outcome));
    }
    validate_history(&rows).unwrap();
    let EntryPayload::ToolOutcome(outcome) = &mut rows.last_mut().unwrap().payload else {
        unreachable!()
    };
    outcome.status = ToolStatus::ResultUnknown;
    assert!(validate_history(&rows).is_err());
}

#[test]
fn generation_cannot_start_before_old_tool_pairs_have_been_settled() {
    rejects("continue", |rows| {
        let outcome = rows
            .iter()
            .position(|row| matches!(row.payload, EntryPayload::ToolOutcome(_)))
            .unwrap();
        let entry = rows.remove(outcome);
        let turn = rows
            .iter()
            .position(|row| {
                matches!(&row.payload,
                EntryPayload::TurnStarted(turn) if turn.ordinal == 1 && turn.run_id != match &rows[3].payload {
                    EntryPayload::RunStarted(run) => run.run_id, _ => unreachable!(),
                })
            })
            .unwrap();
        rows.insert(turn + 1, entry);
        for (index, row) in rows.iter_mut().enumerate() {
            row.sequence = Sequence(index as u64 + 1);
        }
    });
}

#[test]
fn normal_ended_time_and_gen_terminal_uniqueness_are_enforced() {
    rejects("text", |rows| {
        let end = rows
            .iter_mut()
            .find_map(|row| match &mut row.payload {
                EntryPayload::GenEnded(end) => Some(end),
                _ => None,
            })
            .unwrap();
        end.ended_at_ms = None;
    });
    rejects("text", |rows| {
        let end = rows
            .iter()
            .find_map(|row| match &row.payload {
                EntryPayload::GenEnded(end) => Some(end.clone()),
                _ => None,
            })
            .unwrap();
        append(rows, EntryPayload::GenEnded(end));
    });
    rejects("text", |rows| {
        for row in rows {
            if let EntryPayload::GenStarted(generation) = &mut row.payload
                && generation.attempt == 2
            {
                generation.attempt = 3;
                break;
            }
        }
    });
}

#[test]
fn partial_message_does_not_erase_separately_observed_usage_or_guess_a_stop_reason() {
    let mut rows = history("text");
    let index = rows
        .iter()
        .position(|row| {
            matches!(&row.payload,
        EntryPayload::GenEnded(end) if end.status == GenStatus::Failed)
        })
        .unwrap();
    rows.truncate(index + 1);
    let message = rows
        .iter_mut()
        .find_map(|row| match &mut row.payload {
            EntryPayload::Message(message) => Some(message),
            _ => None,
        })
        .unwrap();
    let AgentMessage::Assistant(assistant) = &mut message.message else {
        unreachable!()
    };
    assistant.usage = None;
    let EntryPayload::GenEnded(end) = &mut rows.last_mut().unwrap().payload else {
        unreachable!()
    };
    assert!(end.usage.is_some());
    end.stop_reason = None;
    validate_history(&rows).unwrap();
}

#[test]
fn duplicate_first_sse_while_the_generation_is_active_is_rejected() {
    let mut rows = history("interrupted");
    let index = rows
        .iter()
        .position(|row| matches!(row.payload, EntryPayload::GenFirstSseReceived(_)))
        .unwrap();
    rows.truncate(index + 1);
    let first = rows[index].payload.clone();
    append(&mut rows, first);
    assert_eq!(
        validate_history(&rows).unwrap_err().code,
        ValidationCode::DuplicateIdentity
    );
}
