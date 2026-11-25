//! Bash process ownership. Journal ownership stays in core.
mod background;
mod sandbox;

use std::{env, path::Path, process::Stdio, sync::OnceLock, time::Duration};

use regex::Regex;
use serde::Deserialize;
use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt};
use xw_agent_types::{PermissionMode, PermissionTarget, ToolDeclaration};

pub use background::{BackgroundShells, background_declarations};

use super::ToolOutput;
use crate::CancellationToken;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_STREAM_BYTES: usize = 8 * 1024;
const MAX_OUTPUT_CHARS: usize = 7_500;
const SANDBOX_SETUP_FAILED: &str = "Bash 沙箱启动失败，命令未执行";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    description: String,
    command: String,
    timeout_ms: Option<u64>,
}

pub struct BashOutcome {
    pub output: ToolOutput,
    pub is_error: bool,
    pub cancelled: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum BashError {
    #[error("{0}")]
    NotStarted(String),
    #[error("{0}")]
    ResultUnknown(String),
}

pub fn declaration() -> Option<ToolDeclaration> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    Some(ToolDeclaration {
        name: "Bash".into(),
        description: "Execute a foreground bash command in cwd. Returns stdout, stderr and exit \
            code. No stdin or background mode. Default timeout 30000 ms, clamped to 100..600000 ms."
            .into(),
        parameters_json: json!({
            "type": "object",
            "properties": {
                "description": {"type": "string"},
                "command": {"type": "string"},
                "timeout_ms": {"type": "integer", "minimum": 0}
            },
            "required": ["description", "command"],
            "additionalProperties": false
        })
        .to_string(),
        constrained_sampling_json: None,
    })
}

pub async fn execute(
    cwd: &Path,
    mode: PermissionMode,
    grants: &[PermissionTarget],
    arguments: &str,
    cancellation: CancellationToken,
) -> Result<BashOutcome, BashError> {
    let not_started = |message: &str| BashError::NotStarted(message.into());
    let args: Arguments =
        serde_json::from_str(arguments).map_err(|_| not_started("Bash 参数无效"))?;
    let timeout_ms = args
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(100, 600_000);
    let started = std::time::Instant::now();
    let (mut child, mut group) = spawn(
        cwd,
        mode,
        grants,
        &args.command,
        &args.description,
        &cancellation,
        [Stdio::piped(), Stdio::piped()],
    )?;
    let stdout = tokio::spawn(read_capped(child.stdout.take().expect("piped stdout")));
    let stderr = tokio::spawn(read_capped(child.stderr.take().expect("piped stderr")));
    let mut cancelled = false;
    let mut timed_out = false;
    let exit = tokio::select! {
        biased;
        _ = cancellation.cancelled() => { cancelled = true; None }
        _ = tokio::time::sleep(Duration::from_millis(timeout_ms)) => { timed_out = true; None }
        status = child.wait() => Some(status),
    };
    let exit = reap(child, &mut group, exit).await?;
    let (stdout, stderr) = tokio::join!(reader_result(stdout), reader_result(stderr));
    let (stdout, stdout_bytes) = stdout.map_err(BashError::ResultUnknown)?;
    let (stderr, stderr_bytes) = stderr.map_err(BashError::ResultUnknown)?;
    let sandbox_failed = mode != PermissionMode::FullAccess && !exit.success();
    let sandbox_setup_failed = sandbox_failed && stderr.contains("sandbox-exec: sandbox_apply");
    let sandbox_denied = sandbox_failed
        && !sandbox_setup_failed
        && (stderr.contains("Operation not permitted")
            || stdout.contains("Operation not permitted"));
    let combined = format!(
        "{}{}{}",
        stdout,
        if stdout.is_empty() || stderr.is_empty() {
            ""
        } else {
            "\n"
        },
        stderr
    );
    let (combined, char_truncated) = truncate(&combined);
    let truncated =
        char_truncated || stdout_bytes > MAX_STREAM_BYTES || stderr_bytes > MAX_STREAM_BYTES;
    let combined = if truncated && !char_truncated {
        format!("{combined}\n[output truncated at capture limit]")
    } else {
        combined
    };
    let reason = if cancelled {
        "Cancelled".to_owned()
    } else if timed_out {
        format!("Timeout after {timeout_ms}ms")
    } else if sandbox_setup_failed {
        SANDBOX_SETUP_FAILED.into()
    } else if sandbox_denied {
        sandbox_denied_message(mode).into()
    } else {
        format!(
            "Exit: {}",
            exit.code()
                .map_or("unknown".into(), |code| code.to_string())
        )
    };
    let duration_ms = started.elapsed().as_millis() as u64;
    log::debug!(
        "Agent Bash exited pid={} mode={mode:?} exit_code={:?} \
         cancelled={cancelled} timed_out={timed_out} \
         sandbox_denied={sandbox_denied} sandbox_setup_failed={sandbox_setup_failed} \
         truncated={truncated} duration_ms={duration_ms}",
        group.pid,
        exit.code()
    );
    Ok(BashOutcome {
        output: ToolOutput {
            text: format!(
                "$ {}\n{combined}\n\n{reason}  Duration: {duration_ms}ms",
                args.command
            ),
            metadata_json: Some(
                json!({"bash": {
                    "command": args.command, "description": args.description, "cwd": cwd,
                    "exit_code": exit.code(), "duration_ms": duration_ms,
                    "stdout_bytes": stdout_bytes, "stderr_bytes": stderr_bytes,
                    "truncated": truncated, "timed_out": timed_out,
                    "cancelled": cancelled, "is_background": false
                }})
                .to_string(),
            ),
        },
        is_error: cancelled || timed_out || sandbox_setup_failed || sandbox_denied,
        cancelled,
    })
}

fn sandbox_denied_message(mode: PermissionMode) -> &'static str {
    if mode == PermissionMode::Interactive {
        concat!(
            "沙箱拒绝写入：权限不足，操作未获授权。",
            "若确需写入当前范围外的路径，可调用 RequestPermission 申请该路径的权限。"
        )
    } else {
        "沙箱拒绝写入：权限不足，操作未获授权"
    }
}

fn spawn(
    cwd: &Path,
    mode: PermissionMode,
    grants: &[PermissionTarget],
    script: &str,
    description: &str,
    cancellation: &CancellationToken,
    [stdout, stderr]: [Stdio; 2],
) -> Result<(tokio::process::Child, ProcessGroup), BashError> {
    if script.trim().is_empty() || description.trim().is_empty() {
        return Err(BashError::NotStarted(
            "Bash command 与 description 不能为空".into(),
        ));
    }
    if let Some(reason) = denied(script) {
        return Err(BashError::NotStarted(reason.into()));
    }
    let mut command = sandbox::command(cwd, mode, grants, script).map_err(BashError::NotStarted)?;
    if cancellation.is_cancelled() {
        return Err(BashError::NotStarted("运行已停止，命令未执行".into()));
    }
    if let Some(directory) = env::var_os("XIAOWEI_AGENT_BIN_DIR")
        && Path::new(&directory).is_absolute()
    {
        let inherited = env::var_os("PATH");
        let paths = std::iter::once(directory.into())
            .chain(inherited.as_deref().into_iter().flat_map(env::split_paths));
        match env::join_paths(paths) {
            Ok(path) => {
                command.env("PATH", path);
            }
            Err(error) => {
                log::warn!("Unable to prepend the embedded Agent command directory: {error}")
            }
        }
    }
    command.current_dir(cwd).kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    command.stdin(Stdio::null()).stdout(stdout).stderr(stderr);
    let child = command
        .spawn()
        .map_err(|error| BashError::NotStarted(format!("无法启动 Bash：{error}")))?;
    let group = ProcessGroup {
        pid: child.id().expect("spawned child has a PID"),
        armed: true,
    };
    Ok((child, group))
}

async fn reap(
    mut child: tokio::process::Child,
    group: &mut ProcessGroup,
    exit: Option<std::io::Result<std::process::ExitStatus>>,
) -> Result<std::process::ExitStatus, BashError> {
    // Reap first if exit raced cancellation; a zombie leader can make Darwin report EPERM.
    let initial = child
        .try_wait()
        .map_err(|error| BashError::ResultUnknown(format!("Bash 进程回收失败：{error}")))?;
    if let Err(error) = group.terminate().await {
        if initial.is_some() || !child.try_wait().is_ok_and(|status| status.is_some()) {
            return Err(BashError::ResultUnknown(error));
        }
        group.terminate().await.map_err(BashError::ResultUnknown)?;
    }
    // Reap an exited shell before the final group signal. Darwin may report EPERM
    // when a group contains only an unreaped zombie.
    let reaped = child
        .try_wait()
        .map_err(|error| BashError::ResultUnknown(format!("Bash 进程回收失败：{error}")))?;
    group.kill().map_err(BashError::ResultUnknown)?;
    let exit = match exit {
        Some(exit) => exit,
        None => match reaped {
            Some(exit) => Ok(exit),
            None => child.wait().await,
        },
    }
    .map_err(|error| BashError::ResultUnknown(format!("Bash 进程回收失败：{error}")))?;
    group
        .wait_terminated()
        .await
        .map_err(BashError::ResultUnknown)?;
    Ok(exit)
}

async fn read_capped(mut reader: impl AsyncRead + Unpin) -> std::io::Result<(String, usize)> {
    let mut bytes = Vec::new();
    let mut total = 0;
    let mut chunk = [0; 8192];
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            break;
        }
        let keep = count.min(MAX_STREAM_BYTES.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&chunk[..keep]);
        total += count;
    }
    Ok((String::from_utf8_lossy(&bytes).into_owned(), total))
}

async fn reader_result(
    mut task: tokio::task::JoinHandle<std::io::Result<(String, usize)>>,
) -> Result<(String, usize), String> {
    match tokio::time::timeout(Duration::from_secs(1), &mut task).await {
        Ok(Ok(Ok(output))) => Ok(output),
        _ => {
            task.abort();
            Err("Bash 输出读取未正常结束".into())
        }
    }
}

fn truncate(text: &str) -> (String, bool) {
    let count = text.chars().count();
    if count <= MAX_OUTPUT_CHARS {
        return (text.into(), false);
    }
    let half = MAX_OUTPUT_CHARS / 2;
    let head: String = text.chars().take(half).collect();
    let tail: String = text.chars().skip(count - half).collect();
    (
        format!(
            "{head}\n[... {} chars truncated ...]\n{tail}",
            count - half * 2
        ),
        true,
    )
}

struct ProcessGroup {
    pid: u32,
    armed: bool,
}

impl ProcessGroup {
    #[cfg(target_os = "macos")]
    fn signal(&self, signal: i32) -> Result<bool, String> {
        if unsafe { libc::kill(-(self.pid as i32), signal) } == 0 {
            return Ok(true);
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(false)
        } else {
            Err(format!("Bash 进程组清理失败：{error}"))
        }
    }

    async fn terminate(&mut self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        if self.signal(libc::SIGTERM)? {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Ok(())
    }

    fn kill(&self) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        self.signal(libc::SIGKILL)?;
        Ok(())
    }

    async fn wait_terminated(&mut self) -> Result<(), String> {
        // The direct child has been waited. Orphaned descendants may exit a little later.
        #[cfg(target_os = "macos")]
        tokio::time::timeout(Duration::from_secs(2), async {
            while self.signal(0)? {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Ok::<_, String>(())
        })
        .await
        .map_err(|_| "Bash 进程组未能确认退出".to_owned())??;
        self.armed = false;
        Ok(())
    }
}

impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        if self.armed {
            let _ = self.signal(libc::SIGKILL);
        }
    }
}

const DENY_RULES: &[(&str, &str)] = &[
    // rm -r on root / home
    (
        concat!(
            r"\brm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b[^|;&]*",
            r"\s(?:/\*?|~|\$HOME|\$\{HOME\})(?:\s|$)",
        ),
        "拒绝执行：禁止对根目录或 $HOME 执行递归删除（rm -r）",
    ),
    // fork bomb
    (
        r":\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:",
        "拒绝执行：检测到 fork bomb 模式",
    ),
    // dd to raw device
    (
        r"\bdd\b[^|;&]*\bof=/dev/",
        "拒绝执行：禁止使用 dd 向 /dev/* 写入",
    ),
    // disk format commands
    (
        r"\b(?:mkfs(?:\.\w+)?|fdisk|parted)\b",
        "拒绝执行：禁止使用磁盘格式化命令（mkfs/fdisk/parted）",
    ),
    // privilege escalation
    (
        r"\b(?:sudo|su)\b",
        "拒绝执行：当前环境无法交互输入密码，禁止使用 sudo/su 提权",
    ),
    // recursive chmod/chown on system dirs
    (
        concat!(
            r"\bch(?:mod|own)\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b[^|;&]*",
            r"\s(?:/|/etc|/usr|/bin|/sbin|/var|/opt)(?:\s|$)",
        ),
        "拒绝执行：禁止对系统目录递归 chmod/chown",
    ),
];

/// Compiled deny-list regexes (lazily initialized once).
fn deny_regexes() -> &'static [(Regex, &'static str)] {
    static CACHE: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    CACHE.get_or_init(|| {
        DENY_RULES
            .iter()
            .map(|(pattern, reason)| {
                (
                    Regex::new(pattern).expect("invalid deny-list regex"),
                    *reason,
                )
            })
            .collect()
    })
}

/// Check if a command matches any deny-list pattern.
/// Returns `Some((pattern_str, reason))` if denied, `None` if allowed.
fn denied(command: &str) -> Option<&'static str> {
    for (re, reason) in deny_regexes() {
        if re.is_match(command) {
            return Some(reason);
        }
    }
    None
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use std::{os::unix::process::CommandExt, process::Command};

    use super::*;

    #[tokio::test]
    async fn unreaped_process_group_returns_eperm_until_reaped() {
        let mut child = Command::new("/usr/bin/true")
            .process_group(0)
            .spawn()
            .unwrap();
        let mut group = ProcessGroup {
            pid: child.id(),
            armed: true,
        };

        // Observe exit without reaping, keeping the zombie window deterministic.
        let mut info = std::mem::MaybeUninit::<libc::siginfo_t>::uninit();
        let waited = unsafe {
            libc::waitid(
                libc::P_PID,
                child.id(),
                info.as_mut_ptr(),
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if waited != 0 {
            let error = std::io::Error::last_os_error();
            child.wait().unwrap();
            panic!("waitid failed: {error}");
        }

        let probe = unsafe { libc::kill(-(group.pid as i32), 0) };
        let probe_error = std::io::Error::last_os_error();
        let terminated = group.terminate().await;
        let killed = group.kill();
        let confirmed = group.wait_terminated().await;

        let exit = child.wait().unwrap();
        let after_reap = group.wait_terminated().await;

        assert!(exit.success());
        assert_eq!(probe, -1);
        assert_eq!(probe_error.raw_os_error(), Some(libc::EPERM));
        let expected = format!("Bash 进程组清理失败：{probe_error}");
        assert_eq!(terminated.unwrap_err(), expected);
        assert_eq!(killed.unwrap_err(), expected);
        assert_eq!(confirmed.unwrap_err(), expected);
        after_reap.unwrap();
        assert!(!group.armed);

        eprintln!("unreaped group: {probe_error}; reaped group: confirmed gone");
    }
}
