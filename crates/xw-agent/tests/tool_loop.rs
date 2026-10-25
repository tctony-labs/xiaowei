use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::stream;
use xw_agent::{
    AgentHost, AgentService, CancellationToken, GenerationEvent, GenerationFuture,
    GenerationRequest, GenerationStream, InputSource, SourceKind, protocol::*,
};
use xw_agent_types::{
    AgentMessage as History, AssistantMessage, ClientRequestId, ContentBlock, EntryPayload,
    FinishReason, InputId, TokenUsage, UsageCost,
};

struct Host {
    messages: Mutex<VecDeque<AssistantMessage>>,
    requests: Mutex<Vec<GenerationRequest>>,
}

impl Host {
    fn new(messages: Vec<AssistantMessage>) -> Arc<Self> {
        Arc::new(Self {
            messages: Mutex::new(messages.into()),
            requests: Mutex::new(vec![]),
        })
    }
}

impl AgentHost for Host {
    fn get_model_info(&self, _: String) -> xw_agent::ModelInfoFuture {
        Box::pin(async { Err(xw_agent::ModelInfoError::Unavailable) })
    }

    fn get_auxiliary_model_ref(&self) -> xw_agent::AuxiliaryModelRefFuture {
        Box::pin(async { Ok(None) })
    }

    fn generate(&self, request: GenerationRequest, _: CancellationToken) -> GenerationFuture {
        self.requests.lock().unwrap().push(request);
        let message = self
            .messages
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected generation");
        Box::pin(async move {
            Ok(
                Box::pin(stream::iter(vec![Ok(GenerationEvent::Finished(message))]))
                    as GenerationStream,
            )
        })
    }
}

fn message(calls: &[(&str, &str)], text: &str) -> AssistantMessage {
    let mut content: Vec<_> = calls
        .iter()
        .enumerate()
        .map(|(index, (name, arguments))| ContentBlock::ToolCall {
            id: format!("call-{index}"),
            name: (*name).into(),
            arguments_json: Some((*arguments).into()),
            thought_signature: None,
            namespace: None,
        })
        .collect();
    if !text.is_empty() {
        content.push(ContentBlock::Text {
            text: text.into(),
            signature: None,
        });
    }
    AssistantMessage {
        content,
        api: "fixture".into(),
        provider: "fixture".into(),
        model_id: "test".into(),
        usage: Some(TokenUsage {
            input: 12,
            output: 4,
            cache_read: 0,
            cache_write: 0,
            total: 16,
            reasoning: None,
            cache_write_1h: None,
            cost: Some(UsageCost {
                input: 0.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write: 0.0,
                total: 0.0,
            }),
        }),
        stop_reason: if calls.is_empty() {
            FinishReason::Stop
        } else {
            FinishReason::ToolUse
        },
        timestamp_ms: 1,
        response_id: None,
        response_model: None,
        provider_thinking_level: None,
        raw_stop_reason: None,
        end_turn: None,
    }
}

async fn create(service: &AgentService, cwd: Option<String>) -> AgentSession {
    service
        .create_session(CreateSessionRequest {
            client_request_id: ClientRequestId::new().to_string(),
            cwd,
            config: Some(AgentModelConfig {
                model_ref: "test".into(),
                reasoning: None,
            }),
            ..Default::default()
        })
        .await
        .unwrap()
        .session
        .unwrap()
}

async fn run(service: &AgentService, session: &AgentSession) -> AgentRun {
    let mut events = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .await
        .unwrap();
    start(service, session).await;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let update = events.recv().await.unwrap().unwrap();
            if let Some(agent_event::Payload::RunCompleted(end)) = update.payload {
                return end.run.unwrap();
            }
        }
    })
    .await
    .unwrap()
}

async fn start(service: &AgentService, session: &AgentSession) -> AgentRun {
    service
        .start_run(
            StartRunRequest {
                session_id: session.session_id.clone(),
                input_id: InputId::new().to_string(),
                input: vec![AgentUserInput {
                    content: Some(agent_user_input::Content::Text("执行工具任务".into())),
                }],
                ..Default::default()
            },
            InputSource {
                kind: SourceKind::Internal,
                principal_id: "test".into(),
            },
        )
        .await
        .unwrap()
        .run
        .unwrap()
}

fn entries(root: &std::path::Path) -> Vec<xw_agent_types::JournalEntry> {
    xw_agent_types::decode_history(&std::fs::read_to_string(journal_path(root)).unwrap()).unwrap()
}

fn journal_path(root: &std::path::Path) -> std::path::PathBuf {
    fn find(root: &std::path::Path) -> Option<std::path::PathBuf> {
        for entry in std::fs::read_dir(root).ok()?.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "jsonl") {
                return Some(path);
            }
            if path.is_dir()
                && let Some(path) = find(&path)
            {
                return Some(path);
            }
        }
        None
    }
    find(root).unwrap()
}

#[tokio::test]
async fn real_files_results_and_multiple_turns_survive_reopen_without_reexecution() {
    let root = tempfile::tempdir().unwrap();
    let host = Host::new(vec![
        message(
            &[(
                "Write",
                r#"{"path":"nested/file.txt","contents":"hello\nworld\n"}"#,
            )],
            "",
        ),
        message(
            &[
                ("Read", r#"{"path":"nested/file.txt"}"#),
                (
                    "Edit",
                    r#"{"path":"nested/file.txt","old_string":"world","new_string":"Rust"}"#,
                ),
            ],
            "",
        ),
        message(&[("Read", r#"{"path":"nested/file.txt"}"#)], ""),
        message(&[], "文件已更新"),
        message(&[], "继续对话"),
    ]);
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let session = create(&service, None).await;
    let cwd = std::path::PathBuf::from(session.cwd.as_ref().unwrap());
    assert_eq!(
        cwd,
        root.path()
            .canonicalize()
            .unwrap()
            .join("quick-chat")
            .join(&session.session_id)
    );
    let result = run(&service, &session).await;
    assert_eq!(
        result.status,
        AgentRunStatus::Completed as i32,
        "{:?}",
        result.error
    );
    assert_eq!(
        std::fs::read_to_string(cwd.join("nested/file.txt")).unwrap(),
        "hello\nRust\n"
    );
    let tools: Vec<_> = result
        .items
        .iter()
        .filter_map(|item| match &item.content {
            Some(agent_item::Content::ToolCall(tool)) => Some(tool),
            _ => None,
        })
        .collect();
    assert_eq!(
        tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
        ["Write", "Read", "Edit", "Read"]
    );
    assert!(
        tools
            .iter()
            .all(|tool| tool.status == xw_agent::protocol::AgentToolStatus::Completed as i32)
    );
    assert!(
        tools[2]
            .metadata_json
            .as_ref()
            .unwrap()
            .contains("filediff")
    );
    {
        let requests = host.requests.lock().unwrap();
        assert_eq!(requests.len(), 4);
        assert!(requests[3].messages.iter().any(|message| {
            let History::ToolResult(result) = message else {
                return false;
            };
            result.content.iter().any(
                |block| matches!(block, ContentBlock::Text { text, .. } if text.contains("Rust")),
            )
        }));
        assert!(requests[0].system_prompt.is_empty());
        let History::SystemContext {
            update: xw_agent_types::SystemContextUpdate::Baseline(context),
        } = &requests[0].messages[0]
        else {
            panic!("missing baseline");
        };
        let mut expected = vec!["Read", "Write", "Edit"];
        if cfg!(target_os = "macos") {
            expected.push("Bash");
        }
        assert_eq!(
            context
                .tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            expected
        );
        assert!(context.instructions["environment.cwd"].contains(cwd.to_str().unwrap()));
    }
    service.close().await.unwrap();
    let saved = entries(root.path());
    assert_eq!(
        saved
            .iter()
            .filter(|e| matches!(e.payload, EntryPayload::TurnStarted(_)))
            .count(),
        4
    );
    assert_eq!(
        saved
            .iter()
            .filter(|e| matches!(e.payload, EntryPayload::RunEnd(_)))
            .count(),
        1
    );
    let position = |predicate: fn(&EntryPayload) -> bool| {
        saved.iter().position(|e| predicate(&e.payload)).unwrap()
    };
    assert!(
        position(|p| matches!(p, EntryPayload::GenEnded(_)))
            < position(|p| matches!(p, EntryPayload::ToolIntent(_)))
    );
    assert!(
        position(|p| matches!(p, EntryPayload::ToolOutcome(_)))
            < position(|p| matches!(p, EntryPayload::TurnEnded(_)))
    );
    std::fs::write(cwd.join("nested/file.txt"), "sentinel").unwrap();
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let restored = service
        .read_session(ReadSessionRequest {
            session_id: session.session_id.clone(),
            include_runs: true,
        })
        .await
        .unwrap()
        .session
        .unwrap();
    assert_eq!(restored.cwd, session.cwd);
    assert_eq!(restored.runs[0].items, result.items);
    run(&service, &restored).await;
    assert_eq!(
        std::fs::read_to_string(cwd.join("nested/file.txt")).unwrap(),
        "sentinel"
    );
    service.close().await.unwrap();
    assert_eq!(
        entries(root.path())
            .iter()
            .filter(|e| matches!(e.payload, EntryPayload::SystemContext(_)))
            .count(),
        1
    );
}

#[tokio::test]
async fn errors_are_paired_results_and_external_cwd_is_retained_on_delete() {
    let root = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    let host = Host::new(vec![
        message(
            &[
                ("Missing", "{}"),
                ("Write", r#"{"path":2,"contents":"bad"}"#),
                ("Read", r#"{"path":"document.pdf"}"#),
            ],
            "",
        ),
        message(&[], "已说明错误"),
    ]);
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let session = create(&service, Some(external.path().to_str().unwrap().into())).await;
    let result = run(&service, &session).await;
    assert_eq!(
        result.status,
        AgentRunStatus::Completed as i32,
        "{:?}",
        result.error
    );
    {
        let calls = host.requests.lock().unwrap();
        assert_eq!(
            calls[1]
                .messages
                .iter()
                .filter(|m| matches!(m, History::ToolResult(r) if r.is_error))
                .count(),
            3
        );
    }
    service
        .delete_session(DeleteSessionRequest {
            targets: vec![DeleteSessionTarget {
                session_id: session.session_id,
                expected_metadata_revision: 1,
                expected_archive_revision: None,
            }],
        })
        .await
        .unwrap();
    assert!(external.path().exists());
    service.close().await.unwrap();
}

#[tokio::test]
async fn tool_limit_settles_run_and_never_executes_call_fifty_one() {
    let root = tempfile::tempdir().unwrap();
    let call = message(
        &[("Read", r#"{"path":"missing","allow_missing":true}"#)],
        "",
    );
    let host = Host::new(vec![call; 51]);
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let session = create(&service, None).await;
    let result = run(&service, &session).await;
    assert_eq!(result.status, AgentRunStatus::Failed as i32);
    assert!(result.error.unwrap().contains("limit"));
    assert_eq!(host.requests.lock().unwrap().len(), 51);
    service.close().await.unwrap();
    let saved = entries(root.path());
    assert_eq!(
        saved
            .iter()
            .filter(|e| matches!(e.payload, EntryPayload::ToolIntent(_)))
            .count(),
        50
    );
    assert!(matches!(
        saved.last().unwrap().payload,
        EntryPayload::RunEnd(_)
    ));
}

#[tokio::test]
async fn stopping_a_tool_batch_closes_results_without_starting_another_generation() {
    let root = tempfile::tempdir().unwrap();
    let contents = "x".repeat(400_000);
    let write = serde_json::json!({"path":"first","contents": contents}).to_string();
    let host = Host::new(vec![message(
        &[
            ("Write", &write),
            ("Write", r#"{"path":"must-not-run","contents":"bad"}"#),
        ],
        "",
    )]);
    let service = AgentService::open(host.clone(), root.path().into())
        .await
        .unwrap();
    let session = create(&service, None).await;
    let mut events = service
        .subscribe_session(SubscribeSessionRequest {
            session_id: session.session_id.clone(),
        })
        .await
        .unwrap();
    service
        .start_run(
            StartRunRequest {
                session_id: session.session_id.clone(),
                input_id: InputId::new().to_string(),
                input: vec![AgentUserInput {
                    content: Some(agent_user_input::Content::Text("stop test".into())),
                }],
                ..Default::default()
            },
            InputSource {
                kind: SourceKind::Internal,
                principal_id: "test".into(),
            },
        )
        .await
        .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let event = events.recv().await.unwrap().unwrap();
            match event.payload {
                Some(agent_event::Payload::ItemStarted(started))
                    if started.item.as_ref().is_some_and(|item| {
                        matches!(item.content, Some(agent_item::Content::ToolCall(_)))
                    }) =>
                {
                    service
                        .interrupt_run(InterruptRunRequest {
                            session_id: session.session_id.clone(),
                            run_id: started.run_id,
                        })
                        .unwrap();
                }
                Some(agent_event::Payload::RunCompleted(end)) => return end.run.unwrap(),
                _ => {}
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        result.status,
        AgentRunStatus::Interrupted as i32,
        "{:?}",
        result.error
    );
    assert_eq!(host.requests.lock().unwrap().len(), 1);
    assert!(
        !std::path::Path::new(session.cwd.as_ref().unwrap())
            .join("must-not-run")
            .exists()
    );
    service.close().await.unwrap();
    let saved = entries(root.path());
    assert_eq!(
        saved
            .iter()
            .filter(|e| matches!(e.payload, EntryPayload::ToolIntent(_)))
            .count(),
        2
    );
    assert_eq!(
        saved
            .iter()
            .filter(|e| matches!(e.payload, EntryPayload::ToolOutcome(_)))
            .count(),
        2
    );
    assert!(xw_agent::inspect_recovery(&saved).unwrap().tools.is_empty());
}

#[tokio::test]
async fn legacy_header_gets_a_stable_workspace_without_rewriting_the_header() {
    let root = tempfile::tempdir().unwrap();
    let id = xw_agent_types::SessionId::new();
    let store = xw_agent_rollout::RolloutStore::new(root.path());
    let journal = store
        .create(
            id,
            1000,
            xw_agent_types::SessionMeta {
                model_ref: Some("test".into()),
                reasoning: None,
                provider_name: None,
                model_name: None,
            },
        )
        .unwrap();
    let path = journal.path().to_owned();
    let before = std::fs::read(&path).unwrap();
    drop(journal);
    let service = AgentService::with_rollout(Host::new(vec![]), root.path().into()).unwrap();
    let view = service
        .read_session(ReadSessionRequest {
            session_id: id.to_string(),
            include_runs: false,
        })
        .await
        .unwrap()
        .session
        .unwrap();
    assert!(view.cwd.unwrap().ends_with(&format!("quick-chat/{id}")));
    assert_eq!(std::fs::read(path).unwrap(), before);
    service.close().await.unwrap();
}

#[cfg(target_os = "macos")]
mod bash {
    use super::*;
    use std::{path::Path, process::Stdio};
    use xw_agent_types::{SystemContextUpdate, encode_history};

    fn tools(run: &AgentRun) -> Vec<&AgentToolCall> {
        run.items
            .iter()
            .filter_map(|item| match &item.content {
                Some(agent_item::Content::ToolCall(tool)) => Some(tool),
                _ => None,
            })
            .collect()
    }

    async fn child_pid(cwd: &Path) -> String {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(pid) = std::fs::read_to_string(cwd.join("child.pid"))
                    && pid.trim().parse::<u32>().is_ok()
                {
                    return pid.trim().into();
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }

    fn assert_child_gone(pid: &str) {
        assert!(
            !std::process::Command::new("/bin/kill")
                .args(["-0", pid])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success(),
            "child is still alive: {pid}"
        );
    }

    #[tokio::test]
    async fn bash_result_feeds_read_and_survives_reopen_without_reexecution() {
        let root = tempfile::tempdir().unwrap();
        let arguments = serde_json::json!({
            "description": "create fixture",
            "command": "printf created > bash.txt; printf stdout; printf stderr >&2; exit 7",
        })
        .to_string();
        let host = Host::new(vec![
            message(&[("Bash", &arguments)], ""),
            message(&[("Read", r#"{"path":"bash.txt"}"#)], ""),
            message(&[], "已读取命令产物"),
            message(&[], "继续对话"),
        ]);
        let service = AgentService::open(host.clone(), root.path().into())
            .await
            .unwrap();
        let session = create(&service, None).await;
        let result = run(&service, &session).await;
        assert_eq!(
            result.status,
            AgentRunStatus::Completed as i32,
            "{result:?}"
        );
        let calls = tools(&result);
        assert_eq!(
            calls.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            ["Bash", "Read"]
        );
        assert!(
            calls
                .iter()
                .all(|t| t.status == AgentToolStatus::Completed as i32)
        );
        assert!(calls[0].output.contains("stdout\nstderr"));
        let metadata: serde_json::Value =
            serde_json::from_str(calls[0].metadata_json.as_ref().unwrap()).unwrap();
        assert_eq!(metadata["bash"]["exit_code"], 7);
        assert!(calls[1].output.contains("created"));
        {
            let requests = host.requests.lock().unwrap();
            assert_eq!(requests.len(), 3);
            assert!(requests[1].messages.iter().any(|m| {
                matches!(m, History::ToolResult(r) if !r.is_error && r.tool_name == "Bash")
            }));
        }
        service.close().await.unwrap();
        let file = Path::new(session.cwd.as_ref().unwrap()).join("bash.txt");
        std::fs::write(&file, "sentinel").unwrap();
        let service = AgentService::open(host.clone(), root.path().into())
            .await
            .unwrap();
        let restored = service
            .read_session(ReadSessionRequest {
                session_id: session.session_id.clone(),
                include_runs: true,
            })
            .await
            .unwrap()
            .session
            .unwrap();
        assert_eq!(restored.runs[0].items, result.items);
        run(&service, &restored).await;
        assert_eq!(std::fs::read_to_string(file).unwrap(), "sentinel");
        service.close().await.unwrap();
        let saved = entries(root.path());
        assert_eq!(
            saved
                .iter()
                .filter(|e| matches!(e.payload, EntryPayload::ToolIntent(_)))
                .count(),
            2
        );
        assert!(xw_agent::inspect_recovery(&saved).unwrap().tools.is_empty());
    }

    #[tokio::test]
    async fn invalid_parameters_and_timeout_are_committed_as_errors_before_continuing() {
        let root = tempfile::tempdir().unwrap();
        let arguments = serde_json::json!({
            "description": "timeout",
            "command": "printf partial; sleep 30",
            "timeout_ms": 1000,
        })
        .to_string();
        let host = Host::new(vec![
            message(
                &[
                    ("Bash", r#"{"command":"touch must-not-run"}"#),
                    ("Bash", &arguments),
                ],
                "",
            ),
            message(&[], "已说明错误"),
        ]);
        let service = AgentService::open(host.clone(), root.path().into())
            .await
            .unwrap();
        let session = create(&service, None).await;
        let result = run(&service, &session).await;
        assert_eq!(
            result.status,
            AgentRunStatus::Completed as i32,
            "{result:?}"
        );
        let calls = tools(&result);
        assert_eq!(calls.len(), 2);
        assert!(
            calls
                .iter()
                .all(|t| t.status == AgentToolStatus::Failed as i32)
        );
        assert!(calls[1].output.contains("partial"));
        let metadata: serde_json::Value =
            serde_json::from_str(calls[1].metadata_json.as_ref().unwrap()).unwrap();
        assert_eq!(metadata["bash"]["timed_out"], true);
        assert!(
            !Path::new(session.cwd.as_ref().unwrap())
                .join("must-not-run")
                .exists()
        );
        assert_eq!(
            host.requests.lock().unwrap()[1]
                .messages
                .iter()
                .filter(|m| matches!(m, History::ToolResult(r) if r.is_error))
                .count(),
            2
        );
        service.close().await.unwrap();
    }

    #[tokio::test]
    async fn stop_delete_and_close_wait_for_bash_cleanup_and_skip_unstarted_tools() {
        for action in ["stop", "delete", "close"] {
            let root = tempfile::tempdir().unwrap();
            let cwd = tempfile::tempdir().unwrap();
            let arguments = serde_json::json!({
                "description": "wait for cancellation",
                "command": "trap '' TERM; sleep 30 & echo $! > child.pid; printf partial; wait",
            })
            .to_string();
            let host = Host::new(vec![message(
                &[
                    ("Bash", &arguments),
                    ("Write", r#"{"path":"must-not-run","contents":"bad"}"#),
                ],
                "",
            )]);
            let service = AgentService::open(host.clone(), root.path().into())
                .await
                .unwrap();
            let session = create(&service, Some(cwd.path().to_str().unwrap().into())).await;
            let mut events = service
                .subscribe_session(SubscribeSessionRequest {
                    session_id: session.session_id.clone(),
                })
                .await
                .unwrap();
            let accepted = start(&service, &session).await;
            let pid = child_pid(cwd.path()).await;
            match action {
                "stop" => {
                    service
                        .interrupt_run(InterruptRunRequest {
                            session_id: session.session_id.clone(),
                            run_id: accepted.run_id,
                        })
                        .unwrap();
                    let result = tokio::time::timeout(Duration::from_secs(5), async {
                        loop {
                            if let Some(agent_event::Payload::RunCompleted(end)) =
                                events.recv().await.unwrap().unwrap().payload
                            {
                                break end.run.unwrap();
                            }
                        }
                    })
                    .await
                    .unwrap();
                    assert_eq!(result.status, AgentRunStatus::Interrupted as i32);
                    assert_eq!(tools(&result)[0].status, AgentToolStatus::Cancelled as i32);
                    assert!(tools(&result)[0].output.contains("partial"));
                    assert_eq!(tools(&result)[1].status, AgentToolStatus::Skipped as i32);
                }
                "delete" => {
                    let current = service
                        .read_session(ReadSessionRequest {
                            session_id: session.session_id.clone(),
                            include_runs: false,
                        })
                        .await
                        .unwrap()
                        .session
                        .unwrap();
                    let response = service
                        .delete_session(DeleteSessionRequest {
                            targets: vec![DeleteSessionTarget {
                                session_id: session.session_id.clone(),
                                expected_metadata_revision: current.metadata_revision,
                                expected_archive_revision: None,
                            }],
                        })
                        .await
                        .unwrap();
                    assert_eq!(
                        response.results[0].status,
                        DeleteSessionStatus::Deleted as i32,
                        "{response:?}"
                    );
                }
                "close" => service.close().await.unwrap(),
                _ => unreachable!(),
            }
            assert_child_gone(&pid);
            assert!(!cwd.path().join("must-not-run").exists());
            assert_eq!(host.requests.lock().unwrap().len(), 1);
            service.close().await.unwrap();
            if action != "delete" {
                let saved = entries(root.path());
                assert!(xw_agent::inspect_recovery(&saved).unwrap().tools.is_empty());
                assert_eq!(
                    saved
                        .iter()
                        .filter(|e| matches!(&e.payload,
                            EntryPayload::ToolOutcome(o)
                                if o.status == xw_agent_types::ToolStatus::Cancelled
                        ))
                        .count(),
                    1
                );
            }
        }
    }

    #[tokio::test]
    async fn file_only_sessions_receive_only_the_bash_addition_once() {
        let root = tempfile::tempdir().unwrap();
        let host = Host::new(vec![message(&[], "first"); 4]);
        let service = AgentService::open(host.clone(), root.path().into())
            .await
            .unwrap();
        let session = create(&service, None).await;
        run(&service, &session).await;
        service.close().await.unwrap();
        let path = journal_path(root.path());
        let mut saved = entries(root.path());
        // Model a session written by the previous file-only registry.
        for entry in &mut saved {
            if let EntryPayload::SystemContext(SystemContextUpdate::Baseline(context)) =
                &mut entry.payload
            {
                context.tools.retain(|t| t.name != "Bash");
                context.instructions.remove("tool.Bash");
            }
        }
        let original = encode_history(&saved).unwrap();
        std::fs::write(&path, &original).unwrap();
        let service = AgentService::open(host.clone(), root.path().into())
            .await
            .unwrap();
        run(&service, &session).await;
        run(&service, &session).await;
        service.close().await.unwrap();
        let service = AgentService::open(host.clone(), root.path().into())
            .await
            .unwrap();
        run(&service, &session).await;
        service.close().await.unwrap();
        assert!(
            std::fs::read_to_string(path)
                .unwrap()
                .starts_with(&original)
        );
        let saved = entries(root.path());
        let updates: Vec<_> = saved
            .iter()
            .filter_map(|e| match &e.payload {
                EntryPayload::SystemContext(update) => Some(update),
                _ => None,
            })
            .collect();
        assert_eq!(updates.len(), 2);
        let SystemContextUpdate::Delta(delta) = updates[1] else {
            panic!("missing delta")
        };
        assert_eq!(
            delta
                .tools_added
                .iter()
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>(),
            ["Bash"]
        );
        assert_eq!(
            delta
                .instructions
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["tool.Bash"]
        );
        assert!(delta.tools_removed.is_empty());
        assert!(delta.instructions_removed.is_empty());
        let requests = host.requests.lock().unwrap();
        assert!(requests[1].system_prompt.is_empty());
        assert_eq!(
            requests[1]
                .messages
                .iter()
                .filter(|m| matches!(
                    m,
                    History::SystemContext {
                        update: SystemContextUpdate::Delta(_)
                    }
                ))
                .count(),
            1
        );
    }
}
