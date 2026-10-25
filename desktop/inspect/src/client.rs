use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use socket2::{Domain, SockAddr, Socket, Type};

use crate::target::{Source, user_id, validate_socket};

pub const PROTOCOL: &str = "xiaowei-inspect";
pub const VERSION: u32 = 1;
pub const MAX_BYTES: usize = 1024 * 1024;
pub const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Serialize, Deserialize)]
pub struct InspectError {
    pub code: String,
    pub message: String,
}

impl InspectError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Response {
    pub protocol: String,
    pub version: u32,
    pub id: String,
    pub source: Source,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<InspectError>,
}

fn io_error(error: std::io::Error) -> InspectError {
    let code = match error.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => "TIMEOUT",
        std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused => "APP_NOT_RUNNING",
        _ => "CONNECTION_FAILED",
    };
    let message = if code == "TIMEOUT" {
        "Inspect timed out; an action may have completed. Query status before retrying".to_owned()
    } else {
        error.to_string()
    };
    InspectError::new(code, message)
}

fn remaining(deadline: Instant) -> Result<Duration, InspectError> {
    deadline
        .checked_duration_since(Instant::now())
        .ok_or_else(|| {
            InspectError::new(
                "TIMEOUT",
                "Inspect timed out; query status to check whether an action completed",
            )
        })
}

pub fn call(source: &Source, method: &str, params: Value) -> Result<Response, InspectError> {
    let path = source.socket_path(user_id());
    validate_socket(&path)?;
    let id = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    );
    let request = json!({
        "protocol": PROTOCOL,
        "version": VERSION,
        "id": id,
        "source": source,
        "method": method,
        "params": params,
    });
    let mut frame = serde_json::to_vec(&request)
        .map_err(|error| InspectError::new("INVALID_REQUEST", error.to_string()))?;
    frame.push(b'\n');
    if frame.len() > MAX_BYTES {
        return Err(InspectError::new(
            "FRAME_TOO_LARGE",
            "Request exceeds size limit",
        ));
    }

    let deadline = Instant::now() + TIMEOUT;
    let socket = Socket::new(Domain::UNIX, Type::STREAM, None).map_err(io_error)?;
    let address = SockAddr::unix(path).map_err(io_error)?;
    socket
        .connect_timeout(&address, remaining(deadline)?)
        .map_err(io_error)?;
    let descriptor: OwnedFd = socket.into();
    let mut stream = UnixStream::from(descriptor);
    stream
        .set_write_timeout(Some(remaining(deadline)?))
        .map_err(io_error)?;
    stream.write_all(&frame).map_err(io_error)?;

    let mut received = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        stream
            .set_read_timeout(Some(remaining(deadline)?))
            .map_err(io_error)?;
        let count = stream.read(&mut buffer).map_err(io_error)?;
        if count == 0 {
            return Err(InspectError::new(
                "NO_RESPONSE",
                "App closed without a complete response",
            ));
        }
        received.extend_from_slice(&buffer[..count]);
        if received.len() > MAX_BYTES {
            return Err(InspectError::new(
                "FRAME_TOO_LARGE",
                "Response exceeds size limit",
            ));
        }
        let Some(newline) = received.iter().position(|byte| *byte == b'\n') else {
            continue;
        };
        let response: Response = serde_json::from_slice(&received[..newline])
            .map_err(|error| InspectError::new("INVALID_RESPONSE", error.to_string()))?;
        if response.protocol != PROTOCOL || response.version != VERSION {
            return Err(InspectError::new(
                "VERSION_MISMATCH",
                "Incompatible inspect protocol",
            ));
        }
        if response.id != id {
            return Err(InspectError::new(
                "INVALID_RESPONSE",
                "Response request ID does not match",
            ));
        }
        if response.source != *source {
            return Err(InspectError::new(
                "SOURCE_MISMATCH",
                "Response belongs to another App",
            ));
        }
        if (response.ok && (response.result.is_none() || response.error.is_some()))
            || (!response.ok && response.error.is_none())
        {
            return Err(InspectError::new(
                "INVALID_RESPONSE",
                "Invalid result or error envelope",
            ));
        }
        return Ok(response);
    }
}
