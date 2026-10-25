#[cfg(unix)]
mod client;
#[cfg(unix)]
mod target;

#[cfg(unix)]
use std::path::PathBuf;

#[cfg(unix)]
use client::{InspectError, Response};
#[cfg(unix)]
use serde_json::{Value, json};

const HELP: &str = "Inspect a running XiaoWei App through its local socket.

Usage:
  just inspect [--json] COMMAND
  xiaowei-inspect [--json] COMMAND
  xiaowei-inspect --workspace ABSOLUTE_PATH [--json] COMMAND

Commands:
  identify                    Read App source, PID, version and data path
  capabilities                Discover the running App's supported methods
  status                      Read window, focus, Dock and shortcut state
  windows                     List windows, including hidden windows
  shortcuts                   Read actual shortcut registration state
  show MODE                   Show search, clipboard or quick-chat (not toggle)
  hide                        Hide Launcher and report focus restoration
  help, --help                Show this help without connecting to an App
  --version                   Show CLI and protocol versions offline

Development uses --workspace; a bundled CLI selects its own App installation.
The CLI never starts an App, changes data paths, or falls back to another instance.";

#[cfg(unix)]
struct Command {
    name: String,
    method: &'static str,
    params: Value,
    workspace: Option<PathBuf>,
}

#[cfg(unix)]
fn parse(args: &[String]) -> Result<Option<Command>, InspectError> {
    let mut workspace = None;
    let mut words = Vec::new();
    let mut arguments = args.iter();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--json" => {}
            "--workspace" => {
                if workspace.is_some() {
                    return Err(InspectError::new("USAGE", "Duplicate --workspace"));
                }
                workspace = Some(PathBuf::from(arguments.next().ok_or_else(|| {
                    InspectError::new("USAGE", "--workspace requires an absolute directory")
                })?));
            }
            "--help" | "-h" => {
                println!("{HELP}");
                return Ok(None);
            }
            "--version" => {
                println!(
                    "xiaowei-inspect {} (protocol {})",
                    env!("CARGO_PKG_VERSION"),
                    client::VERSION,
                );
                return Ok(None);
            }
            value if value.starts_with('-') => {
                return Err(InspectError::new(
                    "USAGE",
                    format!("Unknown option: {value}"),
                ));
            }
            _ => words.push(argument.as_str()),
        }
    }
    let (method, params) = match words.as_slice() {
        [] | ["help"] => {
            println!("{HELP}");
            return Ok(None);
        }
        ["identify"] => ("system.identify", json!({})),
        ["capabilities"] => ("system.capabilities", json!({})),
        ["status"] => ("app.status", json!({})),
        ["windows"] => ("window.list", json!({})),
        ["shortcuts"] => ("shortcut.list", json!({})),
        ["show", mode @ ("search" | "clipboard" | "quick-chat")] => {
            ("launcher.show", json!({ "mode": mode }))
        }
        ["hide"] => ("launcher.hide", json!({})),
        _ => return Err(InspectError::new("USAGE", "Invalid command; use --help")),
    };
    Ok(Some(Command {
        name: words[0].to_owned(),
        method,
        params,
        workspace,
    }))
}

#[cfg(unix)]
fn render_windows(windows: &Value) {
    for window in windows.as_array().into_iter().flatten() {
        println!(
            "  {} #{}: visible={} focused={} alwaysOnTop={} bounds={}",
            window["role"].as_str().unwrap_or("window"),
            window["id"],
            window["visible"],
            window["focused"],
            window["alwaysOnTop"],
            window["bounds"],
        );
    }
}

#[cfg(unix)]
fn render_shortcuts(shortcuts: &Value) {
    for shortcut in shortcuts.as_array().into_iter().flatten() {
        println!(
            "  {}: {} ({})",
            shortcut["action"].as_str().unwrap_or("shortcut"),
            shortcut["accelerator"].as_str().unwrap_or("disabled"),
            shortcut["state"].as_str().unwrap_or("unknown"),
        );
    }
}

#[cfg(unix)]
fn render(command: &Command, response: &Response) {
    let value = response
        .result
        .as_ref()
        .expect("validated successful response");
    println!("Source: {}", response.source.path);
    match command.name.as_str() {
        "windows" => render_windows(value),
        "shortcuts" => render_shortcuts(value),
        "capabilities" => {
            for method in value["methods"].as_array().into_iter().flatten() {
                let access = if method["mutates"] == true {
                    "write"
                } else {
                    "read"
                };
                println!(
                    "  [{access}] {}",
                    method["name"].as_str().unwrap_or("unknown")
                );
            }
        }
        "identify" => {
            println!("PID: {}  App version: {}", value["pid"], value["version"]);
            println!("Instance: {}", value["instanceId"]);
            println!("Data: {}", value["dataPath"]);
        }
        _ => {
            println!(
                "PID: {}  Mode: {}",
                value["instance"]["pid"], value["state"]["launcher"]["mode"]
            );
            render_windows(&value["windows"]);
            println!("Dock: {}", value["state"]["dock"]);
            println!("Focus: {}", value["state"]["launcher"]["focus"]);
            if command.name == "hide" {
                println!("Focus restored: {}", value["focusRestored"]);
            }
            render_shortcuts(&value["shortcuts"]);
        }
    }
}

#[cfg(unix)]
fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let json_output = args.iter().any(|argument| argument == "--json");
    let run = || -> Result<bool, InspectError> {
        let Some(command) = parse(&args)? else {
            return Ok(true);
        };
        let source = target::Source::resolve(command.workspace.as_deref())?;
        let response = client::call(&source, command.method, command.params.clone())?;
        if json_output {
            println!(
                "{}",
                serde_json::to_string(&response).expect("JSON response")
            );
        } else if response.ok {
            render(&command, &response);
        } else if let Some(error) = &response.error {
            eprintln!("{}: {}", error.code, error.message);
        }
        Ok(response.ok)
    };
    match run() {
        Ok(true) => std::process::ExitCode::SUCCESS,
        Ok(false) => std::process::ExitCode::FAILURE,
        Err(error) => {
            let code = if error.code == "USAGE" { 2 } else { 1 };
            if json_output {
                println!("{}", json!({ "ok": false, "error": error }));
            } else {
                eprintln!("{}: {}", error.code, error.message);
            }
            std::process::ExitCode::from(code)
        }
    }
}

#[cfg(not(unix))]
fn main() -> std::process::ExitCode {
    eprintln!("xiaowei-inspect currently requires Unix sockets");
    std::process::ExitCode::FAILURE
}
