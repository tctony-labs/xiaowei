use std::{
    collections::BTreeMap,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
    process::{ExitStatus, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::json;
use xw_agent_types::{PermissionMode, PermissionTarget, RunId, ToolDeclaration, ToolId};

use super::{BashError, BashOutcome, ProcessGroup, ToolOutput, reap, spawn, truncate};
use crate::CancellationToken;

const MAX_ACTIVE: usize = 5;
const MAX_FINISHED: usize = 20;
const MAX_READ_BYTES: u64 = 64 * 1024;
const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
const SIZE_CHECK_INTERVAL: Duration = Duration::from_millis(100);
const STARTUP_WAIT: Duration = Duration::from_secs(2);
const OUTPUT_LIMIT_REACHED: &str = "后台 Bash 输出超过 128 MiB 上限";

#[derive(Default)]
pub struct BackgroundShells {
    shells: Mutex<BTreeMap<ToolId, Arc<Shell>>>,
}

struct Shell {
    run_id: RunId,
    started: Instant,
    stop: CancellationToken,
    done: CancellationToken,
    output: File,
    state: Mutex<ShellState>,
}

#[derive(Default)]
struct ShellState {
    cursor: u64,
    end: Option<(Duration, End)>,
}

enum End {
    Exited(i32),
    Killed,
    Failed {
        code: Option<i32>,
        reason: &'static str,
    },
    Unknown(String),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunArgs {
    command: String,
    description: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ShellArgs {
    bash_id: ToolId,
}

pub fn background_declarations() -> Vec<ToolDeclaration> {
    if !cfg!(target_os = "macos") {
        return vec![];
    }
    [
        (
            "BgRun",
            "Start a background Bash command in cwd. Returns a bash_id and initial output. \
             Up to 5 shells can run per session. Use BgOutput to read and BgStop to stop.",
            json!({"command": {"type": "string"}, "description": {"type": "string"}}),
            json!(["command", "description"]),
        ),
        (
            "BgOutput",
            "Return new stdout and stderr since the last read, along with the shell status. \
             Returns immediately.",
            json!({"bash_id": {"type": "string"}}),
            json!(["bash_id"]),
        ),
        (
            "BgStop",
            "Stop a background shell by bash_id and wait for process cleanup.",
            json!({"bash_id": {"type": "string"}}),
            json!(["bash_id"]),
        ),
    ]
    .into_iter()
    .map(
        |(name, description, properties, required)| ToolDeclaration {
            name: name.into(),
            description: description.into(),
            parameters_json: json!({
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": false,
            })
            .to_string(),
            constrained_sampling_json: None,
        },
    )
    .collect()
}

impl BackgroundShells {
    pub async fn run(
        &self,
        owner: (RunId, ToolId),
        cwd: &Path,
        mode: PermissionMode,
        grants: &[PermissionTarget],
        arguments: &str,
        cancellation: &CancellationToken,
    ) -> Result<BashOutcome, BashError> {
        let args: RunArgs = serde_json::from_str(arguments)
            .map_err(|_| BashError::NotStarted("BgRun 参数无效".into()))?;
        let (run_id, bash_id) = owner;
        let shell = {
            let mut shells = self.shells.lock().unwrap();
            let mut finished = shells
                .iter()
                .filter(|(_, shell)| shell.done.is_cancelled())
                .map(|(id, _)| *id)
                .collect::<Vec<_>>();
            if shells.len() - finished.len() >= MAX_ACTIVE {
                return Err(BashError::NotStarted(
                    "每个会话最多运行 5 个后台 shell".into(),
                ));
            }
            let excess = finished.len().saturating_sub(MAX_FINISHED);
            for id in finished.drain(..excess) {
                shells.remove(&id);
            }
            let (output, stdio) = temporary_output()
                .map_err(|error| BashError::NotStarted(format!("无法创建后台输出文件：{error}")))?;
            let (child, group) = spawn(
                cwd,
                mode,
                grants,
                &args.command,
                &args.description,
                cancellation,
                stdio,
            )?;
            let shell = Arc::new(Shell {
                run_id,
                started: Instant::now(),
                stop: CancellationToken::new(),
                done: CancellationToken::new(),
                output,
                state: Mutex::new(ShellState::default()),
            });
            shells.insert(bash_id, shell.clone());
            log::debug!("Agent background shell started run={run_id} bash_id={bash_id}");
            tokio::spawn(watch(shell.clone(), child, group, mode));
            shell
        };

        tokio::select! {
            biased;
            _ = cancellation.cancelled() => {
                shell.stop.cancel();
                shell.done.cancelled().await;
            }
            _ = shell.done.cancelled() => {}
            _ = tokio::time::sleep(STARTUP_WAIT) => {}
        }
        match shell.read_output(bash_id, "bg_run").await {
            Ok(mut outcome) => {
                outcome.cancelled = cancellation.is_cancelled();
                Ok(outcome)
            }
            Err(error) => {
                self.cancel_shell(bash_id).await;
                Err(error)
            }
        }
    }

    pub async fn output(&self, arguments: &str) -> Result<BashOutcome, BashError> {
        let (id, shell) = self.lookup(arguments)?;
        shell.read_output(id, "bg_output").await
    }

    pub async fn stop(&self, arguments: &str) -> Result<BashOutcome, BashError> {
        let (id, shell) = self.lookup(arguments)?;
        shell.stop.cancel();
        shell.done.cancelled().await;
        shell.report(id, "bg_stop", false)
    }

    /// The shell ID could not be delivered because its tool result did not commit.
    pub async fn cancel_shell(&self, id: ToolId) {
        let shell = self.shells.lock().unwrap().get(&id).cloned();
        if let Some(shell) = shell {
            shell.stop.cancel();
            shell.done.cancelled().await;
            self.shells.lock().unwrap().remove(&id);
        }
    }

    /// Cancels matching process groups and returns completion tokens for their cleanup.
    pub fn cancel(&self, run_id: Option<RunId>) -> Vec<CancellationToken> {
        self.shells
            .lock()
            .unwrap()
            .values()
            .filter(|shell| run_id.is_none_or(|id| shell.run_id == id))
            .filter(|shell| !shell.done.is_cancelled())
            .map(|shell| {
                shell.stop.cancel();
                shell.done.clone()
            })
            .collect()
    }

    fn lookup(&self, arguments: &str) -> Result<(ToolId, Arc<Shell>), BashError> {
        let args: ShellArgs = serde_json::from_str(arguments)
            .map_err(|_| BashError::NotStarted("后台工具参数无效".into()))?;
        self.shells
            .lock()
            .unwrap()
            .get(&args.bash_id)
            .cloned()
            .map(|shell| (args.bash_id, shell))
            .ok_or_else(|| BashError::NotStarted("当前会话找不到该后台 shell".into()))
    }
}

impl Drop for BackgroundShells {
    fn drop(&mut self) {
        self.cancel(None);
    }
}

impl Shell {
    async fn read_output(
        self: Arc<Self>,
        id: ToolId,
        key: &'static str,
    ) -> Result<BashOutcome, BashError> {
        tokio::task::spawn_blocking(move || self.report(id, key, true))
            .await
            .map_err(|error| BashError::ResultUnknown(format!("后台输出读取中断：{error}")))?
    }

    fn report(&self, id: ToolId, key: &str, take_output: bool) -> Result<BashOutcome, BashError> {
        let mut state = self.state.lock().unwrap();
        let (duration, status, exit_code, error) = match &state.end {
            None => (self.started.elapsed(), "running", None, None),
            Some((duration, end)) => match end {
                End::Exited(code) => (*duration, "exited", Some(*code), None),
                End::Killed => (*duration, "killed", None, None),
                End::Failed { code, reason } => (*duration, "failed", *code, Some(*reason)),
                End::Unknown(reason) => return Err(BashError::ResultUnknown(reason.clone())),
            },
        };
        let duration_ms = duration.as_millis() as u64;
        let (bytes, dropped_bytes) = if take_output {
            self.read_delta(&mut state.cursor)
                .map_err(|error| BashError::ResultUnknown(format!("无法读取后台输出：{error}")))?
        } else {
            (Vec::new(), 0)
        };
        drop(state);
        let mut body = String::new();
        if dropped_bytes > 0 {
            body.push_str(&format!(
                "[... {dropped_bytes} bytes dropped from unread output ...]\n"
            ));
        }
        body.push_str(&String::from_utf8_lossy(&bytes));
        let (body, clipped) = truncate(&body);
        let truncated = clipped || dropped_bytes > 0;
        let code = exit_code.map_or(String::new(), |code| format!(" code={code}"));
        let reason = error.map_or(String::new(), |reason| format!("\n{reason}"));
        Ok(BashOutcome {
            output: ToolOutput {
                text: format!(
                    "[{id}] status={status}{code} duration={duration_ms}ms{reason}\n{body}"
                ),
                metadata_json: Some(
                    json!({key: {
                        "bash_id": id, "status": status, "exit_code": exit_code,
                        "duration_ms": duration_ms, "delta_bytes": bytes.len(),
                        "dropped_bytes": dropped_bytes, "truncated": truncated
                    }})
                    .to_string(),
                ),
            },
            is_error: error.is_some(),
            cancelled: false,
        })
    }

    // Both callers that seek the output file hold state. The shell writes through a
    // different open file description and keeps its own offset.
    fn read_delta(&self, cursor: &mut u64) -> io::Result<(Vec<u8>, u64)> {
        let mut file = &self.output;
        let end = file.metadata()?.len();
        let previous = (*cursor).min(end);
        let offset = previous.max(end.saturating_sub(MAX_READ_BYTES));
        let mut bytes = Vec::with_capacity((end - offset) as usize);
        file.seek(SeekFrom::Start(offset))?;
        file.take(end - offset).read_to_end(&mut bytes)?;
        *cursor = offset + bytes.len() as u64;
        Ok((bytes, offset - previous))
    }
}

fn temporary_output() -> io::Result<(File, [Stdio; 2])> {
    let file = tempfile::NamedTempFile::new()?;
    let writer = file.reopen()?;
    let stderr = writer.try_clone()?;
    // Reopen gives the writer an independent offset. Its clone shares that offset
    // with stdout, so the kernel orders writes from both streams in one file.
    Ok((file.into_file(), [writer.into(), stderr.into()]))
}

async fn watch(
    shell: Arc<Shell>,
    mut child: tokio::process::Child,
    mut group: ProcessGroup,
    mode: PermissionMode,
) {
    let _done = shell.done.clone().drop_guard();
    let mut check_size = tokio::time::interval(SIZE_CHECK_INTERVAL);
    check_size.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut output_failure = None;
    let exit = loop {
        tokio::select! {
            biased;
            exit = child.wait() => break Some(exit),
            _ = shell.stop.cancelled() => break None,
            _ = check_size.tick() => {
                output_failure = match shell.output.metadata() {
                    Ok(metadata) if metadata.len() > MAX_FILE_BYTES => Some(End::Failed {
                        code: None,
                        reason: OUTPUT_LIMIT_REACHED,
                    }),
                    Err(error) => Some(unknown_output(error)),
                    _ => None,
                };
                if output_failure.is_some() {
                    break None;
                }
            }
        }
    };
    let stopped = exit.is_none();
    let end = match reap(child, &mut group, exit, output_failure.is_some()).await {
        Err(error) => End::Unknown(error.to_string()),
        Ok(_) if stopped => output_failure.unwrap_or(End::Killed),
        Ok(exit) => {
            let shell = shell.clone();
            match tokio::task::spawn_blocking(move || shell.exit_status(mode, exit)).await {
                Ok(Ok(end)) => end,
                Ok(Err(error)) => unknown_output(error),
                Err(error) => End::Unknown(format!("后台输出结算中断：{error}")),
            }
        }
    };
    if let End::Unknown(reason) = &end {
        log::error!(
            "Agent background shell outcome unknown run={}: {reason}",
            shell.run_id
        );
    }
    shell.state.lock().unwrap().end = Some((shell.started.elapsed(), end));
}

fn unknown_output(error: io::Error) -> End {
    End::Unknown(format!("无法读取后台输出：{error}"))
}

impl Shell {
    fn exit_status(&self, mode: PermissionMode, exit: ExitStatus) -> io::Result<End> {
        if self.output.metadata()?.len() > MAX_FILE_BYTES {
            return Ok(End::Failed {
                code: exit.code(),
                reason: OUTPUT_LIMIT_REACHED,
            });
        }
        let Some(code) = exit.code() else {
            return Ok(End::Killed);
        };
        if mode != PermissionMode::FullAccess && code != 0 {
            let _state = self.state.lock().unwrap();
            let mut file = &self.output;
            file.seek(SeekFrom::Start(0))?;
            if let Some(reason) = sandbox_error(file, mode)? {
                return Ok(End::Failed {
                    code: Some(code),
                    reason,
                });
            }
        }
        Ok(End::Exited(code))
    }
}

fn sandbox_error(mut reader: impl Read, mode: PermissionMode) -> io::Result<Option<&'static str>> {
    let mut chunk = [0; 8192];
    let mut tail = Vec::new();
    let mut denied = false;
    loop {
        let count = reader.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        tail.extend_from_slice(&chunk[..count]);
        let text = String::from_utf8_lossy(&tail);
        if text.contains("sandbox-exec: sandbox_apply") {
            return Ok(Some(super::SANDBOX_SETUP_FAILED));
        }
        denied |= text.contains("Operation not permitted");
        tail.drain(..tail.len().saturating_sub(32));
    }
    Ok(denied.then(|| super::sandbox_denied_message(mode)))
}
