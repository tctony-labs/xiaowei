#![cfg(target_os = "macos")]

use std::{path::Path, time::Duration};

use serde_json::json;
use xw_agent_runtime::{CancellationToken, tools::bash::BackgroundShells};
use xw_agent_types::{PermissionMode, RunId, ToolId};

async fn run(
    shells: &BackgroundShells,
    dir: &Path,
    run: RunId,
    id: ToolId,
    command: &str,
    token: &CancellationToken,
) -> Result<String, String> {
    shells
        .run(
            (run, id),
            dir,
            PermissionMode::Interactive,
            &[],
            &json!({"command": command, "description": "test"}).to_string(),
            token,
        )
        .await
        .map(|result| result.output.text)
        .map_err(|error| error.to_string())
}

async fn wait_for_file(path: &Path) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while !path.is_file() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn deltas_and_natural_exit_use_the_same_shell() {
    let temp = tempfile::tempdir().unwrap();
    let shells = BackgroundShells::default();
    let id = ToolId::new();
    let args = json!({"bash_id": id}).to_string();
    let start = run(
        &shells,
        temp.path(),
        RunId::new(),
        id,
        concat!(
            "[[ -f /dev/fd/1 && /dev/fd/1 -ef /dev/fd/2 ]] || exit 90; ",
            "printf first-stdout/; printf first-stderr/ >&2; ",
            "printf first-end; while [ ! -f go ]; do sleep .05; done; ",
            "printf second-stderr/ >&2; printf second-stdout; exit 7",
        ),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(
        start.contains("status=running") && start.ends_with("first-stdout/first-stderr/first-end"),
        "{start}"
    );
    assert!(
        !shells
            .output(&args)
            .await
            .unwrap()
            .output
            .text
            .contains("first")
    );
    std::fs::write(temp.path().join("go"), "").unwrap();
    let mut output = String::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let update = shells.output(&args).await.unwrap().output.text;
            let (_, body) = update.split_once('\n').unwrap();
            output.push_str(body);
            if update.contains("status=exited code=7") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(output.contains("second-stderr/second-stdout"), "{output}");
    assert!(!output.contains("first"));
    assert!(
        shells
            .stop(&args)
            .await
            .unwrap()
            .output
            .text
            .contains("status=exited code=7")
    );
    assert!(BackgroundShells::default().output(&args).await.is_err());
}

#[tokio::test]
async fn limit_stop_and_run_scoped_cleanup_reap_real_process_groups() {
    let temp = tempfile::tempdir().unwrap();
    let shells = BackgroundShells::default();
    let owner = RunId::new();
    let other = RunId::new();
    let token = CancellationToken::new();
    let ids: [ToolId; 5] = std::array::from_fn(|_| ToolId::new());
    let mut starts = tokio::task::JoinSet::new();
    let shells = std::sync::Arc::new(shells);
    for (index, id) in ids.into_iter().enumerate() {
        let shells = shells.clone();
        let cwd = temp.path().to_path_buf();
        let token = token.clone();
        starts.spawn(async move {
            let run_id = if index == 0 { other } else { owner };
            let cmd = if index == 1 {
                concat!(
                    "printf '%s' $$ > pid-1; sleep 60 & child=$!; ",
                    "printf '%s' \"$child\" > descendant.pid; ",
                    "trap 'wait \"$child\"; exit 0' TERM; wait",
                )
                .to_owned()
            } else {
                format!("printf '%s' $$ > pid-{index}; exec sleep 60")
            };
            run(&shells, &cwd, run_id, id, &cmd, &token).await.unwrap();
        });
    }
    while let Some(start) = starts.join_next().await {
        start.unwrap();
    }
    let err = run(&shells, temp.path(), owner, ToolId::new(), "exit 0", &token)
        .await
        .unwrap_err();
    assert!(err.contains("最多运行 5 个"));
    let pids: Vec<i32> = (0..5)
        .map(|index| {
            std::fs::read_to_string(temp.path().join(format!("pid-{index}")))
                .unwrap()
                .parse()
                .unwrap()
        })
        .collect();

    let stop = shells
        .stop(&json!({"bash_id": ids[1]}).to_string())
        .await
        .unwrap();
    assert!(stop.output.text.contains("status=killed"));
    let descendant: i32 = std::fs::read_to_string(temp.path().join("descendant.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(unsafe { libc::kill(descendant, 0) }, -1);
    for done in shells.cancel(Some(owner)) {
        done.cancelled().await;
    }
    assert_eq!(unsafe { libc::kill(pids[0], 0) }, 0);
    for &pid in &pids[1..] {
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    }
    for done in shells.cancel(None) {
        done.cancelled().await;
    }
    assert_eq!(unsafe { libc::kill(pids[0], 0) }, -1);
}

#[tokio::test]
async fn bounded_output_samples_the_unread_window_and_advances_the_cursor() {
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path();
    let shells = BackgroundShells::default();
    let id = ToolId::new();
    let args = json!({"bash_id": id}).to_string();
    let window = 64 * 1024;
    let skipped = 4 * 1024;
    let mut payload = vec![b'x'; window + skipped];
    for (offset, marker) in [
        (0, "before-window"),
        (skipped, "window-head"),
        (skipped + window / 2, "window-middle"),
        (skipped + window - 11, "window-tail"),
    ] {
        payload[offset..offset + marker.len()].copy_from_slice(marker.as_bytes());
    }
    std::fs::write(dir.join("payload"), payload).unwrap();
    let started = run(
        &shells,
        dir,
        RunId::new(),
        id,
        concat!(
            "while [ ! -f emit ]; do sleep .05; done; cat payload; : > emitted; ",
            "while [ ! -f next ]; do sleep .05; done; printf next-output; : > next-emitted",
        ),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert!(started.contains("status=running"), "{started}");

    std::fs::write(dir.join("emit"), "").unwrap();
    wait_for_file(&dir.join("emitted")).await;
    let output = shells.output(&args).await.unwrap().output;
    let metadata: serde_json::Value =
        serde_json::from_str(output.metadata_json.as_deref().unwrap()).unwrap();
    assert_eq!(metadata["bg_output"]["delta_bytes"], window);
    assert_eq!(metadata["bg_output"]["dropped_bytes"], skipped);
    assert_eq!(metadata["bg_output"]["truncated"], true);

    let (_, body) = output.text.split_once('\n').unwrap();
    let (head, remainder) = body.split_once("\n[... ").unwrap();
    let (_, tail) = remainder.split_once(" chars truncated ...]\n").unwrap();
    assert_eq!(head.chars().count(), 3_750);
    assert_eq!(tail.chars().count(), 3_750);
    assert!(head.contains("4096 bytes dropped"));
    assert!(head.contains("window-head"));
    assert!(tail.ends_with("window-tail"));
    assert!(!body.contains("before-window"));
    assert!(!body.contains("window-middle"));
    assert!(
        shells
            .output(&args)
            .await
            .unwrap()
            .output
            .text
            .ends_with('\n')
    );

    std::fs::write(dir.join("next"), "").unwrap();
    wait_for_file(&dir.join("next-emitted")).await;
    let output = shells.output(&args).await.unwrap().output.text;
    assert_eq!(output.split_once('\n').unwrap().1, "next-output");
}

#[tokio::test]
async fn output_file_limit_stops_shell_only_after_the_threshold() {
    let temp = tempfile::tempdir().unwrap();
    let shells = BackgroundShells::default();
    let id = ToolId::new();
    let command = format!(
        concat!(
            "printf '%s' $$ > shell.pid; ",
            "dd if=/dev/zero bs=1 count=1 seek={} 2>/dev/null || exit 90; ",
            ": > at-limit; while [ ! -f exceed ]; do sleep .05; done; ",
            "printf x; exec sleep 60",
        ),
        128 * 1024 * 1024 - 1,
    );
    let output = run(
        &shells,
        temp.path(),
        RunId::new(),
        id,
        &command,
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    wait_for_file(&temp.path().join("at-limit")).await;
    assert!(output.contains("status=running"), "{:.180}", output);
    let pid: i32 = std::fs::read_to_string(temp.path().join("shell.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, 0);

    let args = json!({"bash_id": id}).to_string();
    std::fs::write(temp.path().join("exceed"), "").unwrap();
    let failed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let update = shells.output(&args).await.unwrap();
            if update.is_error {
                break update.output.text;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(failed.contains("status=failed"), "{:.180}", failed);
    assert!(failed.contains("输出超过 128 MiB 上限"));
    assert_ne!(unsafe { libc::kill(pid, 0) }, 0);
}
