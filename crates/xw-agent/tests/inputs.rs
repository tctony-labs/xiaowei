mod support;

use futures_util::FutureExt;
use support::{config, create, service};
use xw_agent::{AgentError, InputSource, SourceKind, protocol::*};
use xw_agent_types::{InputId, RunId};

fn source() -> InputSource {
    InputSource {
        kind: SourceKind::Cli,
        principal_id: "test-cli".into(),
    }
}

fn text(value: &str) -> AgentUserInput {
    AgentUserInput {
        content: Some(agent_user_input::Content::Text(value.into())),
    }
}

#[test]
fn valid_start_without_an_executor_does_not_mutate_config_or_create_a_run() {
    let service = service();
    let session = create(&service);
    let request = StartRunRequest {
        title_model_ref: None,
        session_id: session.session_id.clone(),
        input_id: InputId::new().to_string(),
        input: vec![text("你好")],
        config: Some(AgentModelConfig {
            model_ref: "changed-model".into(),
            reasoning: None,
        }),
    };
    for _ in 0..2 {
        assert_eq!(
            service.start_run(request.clone(), source()).now_or_never().unwrap(),
            Err(AgentError::ExecutionUnavailable)
        );
    }
    let interrupted = service
        .interrupt_run(InterruptRunRequest {
            session_id: session.session_id.clone(),
            run_id: RunId::new().to_string(),
        })
        .unwrap();
    assert!(!interrupted.found && !interrupted.cancellation_requested);
    assert_eq!(
        service
            .read_session(ReadSessionRequest {
                session_id: session.session_id.clone(),
                include_runs: true,
            })
            .now_or_never()
            .expect("memory operation completes immediately")
            .unwrap()
            .session,
        Some(session)
    );
}

#[test]
fn input_validates_presence_total_utf8_bytes_config_source_and_session() {
    let service = service();
    let session = create(&service);
    let request = StartRunRequest {
        title_model_ref: None,
        session_id: session.session_id.clone(),
        input_id: InputId::new().to_string(),
        input: vec![text(&"a".repeat(64 * 1024))],
        config: None,
    };
    assert_eq!(
        service.start_run(request.clone(), source()).now_or_never().unwrap(),
        Err(AgentError::ExecutionUnavailable)
    );
    for input in [
        vec![],
        vec![AgentUserInput::default()],
        vec![text(" \n")],
        vec![text(&"中".repeat(22000))],
        vec![text(&"a".repeat(40000)); 2],
        vec![text("a"); 65],
    ] {
        assert!(matches!(
            service
                .start_run(
                    StartRunRequest {
                        title_model_ref: None,
                        input,
                        ..request.clone()
                    },
                    source()
                )
                .now_or_never()
                .unwrap(),
            Err(AgentError::InvalidArgument(_))
        ));
    }
    assert!(matches!(
        service
            .start_run(
                StartRunRequest {
                    title_model_ref: None,
                    config: Some(AgentModelConfig {
                        reasoning: Some(String::new()),
                        ..config()
                    }),
                    ..request.clone()
                },
                source()
            )
            .now_or_never()
            .unwrap(),
        Err(AgentError::InvalidArgument(_))
    ));
    let mut invalid_source = source();
    invalid_source.principal_id.clear();
    assert!(matches!(
        service
            .start_run(request.clone(), invalid_source)
            .now_or_never()
            .unwrap(),
        Err(AgentError::InvalidArgument(_))
    ));
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(service.delete_session(DeleteSessionRequest {
            targets: vec![DeleteSessionTarget {
                session_id: session.session_id,
                expected_metadata_revision: 1,
                expected_archive_revision: None,
            }],
        }))
        .unwrap();
    assert!(matches!(
        service.start_run(request, source()).now_or_never().unwrap(),
        Err(AgentError::NotFound(_))
    ));
}
