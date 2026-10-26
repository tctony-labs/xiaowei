//! The published client/server wire protocol. It deliberately has no Gateway dependency.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

use crate::contract::Method;

pub const MAX_PAYLOAD: usize = 8 * 1024 * 1024;
pub const MAX_METADATA: usize = 64 * 1024;
pub const MAX_OPTIONS: usize = 64 * 1024;
pub const LIMIT: usize = 128;

pub type Result<T> = std::result::Result<T, WireError>;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct WireError {
    pub code: String,
    pub message: String,
}

impl WireError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn unavailable() -> Self {
        Self::new("OWNER_UNAVAILABLE", "WebSocket connection unavailable")
    }
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WireError {}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamPolicy {
    pub max_chunk_bytes: u32,
    pub queue_items: u32,
    pub queue_bytes: u32,
    pub max_owner_streams: u32,
    pub max_caller_streams: u32,
    pub open_timeout_ms: u32,
    pub producer_idle_ms: u32,
    pub consumer_idle_ms: u32,
    pub total_ms: u32,
}

impl StreamPolicy {
    pub fn validate(&self) -> Result<()> {
        let sizes = [self.max_chunk_bytes, self.queue_bytes];
        let counts = [
            self.queue_items,
            self.max_owner_streams,
            self.max_caller_streams,
        ];
        let waits = [
            self.open_timeout_ms,
            self.producer_idle_ms,
            self.consumer_idle_ms,
        ];
        if sizes.iter().any(|v| *v == 0 || *v > 64 * 1024 * 1024)
            || counts.iter().any(|v| *v == 0 || *v > 4096)
            || waits.iter().any(|v| *v == 0 || *v > i32::MAX as u32)
            || self.total_ms > i32::MAX as u32
        {
            return Err(WireError::new("INCOMPATIBLE", "invalid stream policy"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub name: String,
    pub kind: String,
    pub control_version: u32,
    pub contract_version: u32,
    pub input: String,
    pub output: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrency: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_policy: Option<StreamPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options_schema: Option<String>,
}

impl Route {
    pub fn unary(method: &Method) -> Self {
        Self {
            name: method.id.clone(),
            kind: "unary".into(),
            control_version: 3,
            contract_version: 1,
            input: method.descriptor.input().full_name().into(),
            output: method.descriptor.output().full_name().into(),
            timeout_ms: None,
            max_concurrency: None,
            stream_policy: None,
            options_schema: None,
        }
    }

    pub fn compatible(&self, other: &Self) -> bool {
        self.name == other.name
            && self.kind == other.kind
            && self.input == other.input
            && self.output == other.output
            && self.control_version == other.control_version
            && self.contract_version == other.contract_version
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Event {
    pub name: String,
    pub policy: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Manifest {
    pub routes: Vec<Route>,
    pub events: Vec<Event>,
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 200 && name.split('.').all(|part| !part.is_empty())
}

impl Manifest {
    pub fn validate(&self) -> Result<()> {
        let invalid = || WireError::new("INCOMPATIBLE", "invalid remote manifest");
        if self.routes.len() > 256 || self.events.len() > 256 {
            return Err(invalid());
        }
        let mut names = HashSet::new();
        for route in &self.routes {
            if !valid_name(&route.name)
                || !valid_name(&route.input)
                || !valid_name(&route.output)
                || !names.insert(&route.name)
                || route.control_version != 3
                || route.contract_version != 1
                || !matches!(route.kind.as_str(), "unary" | "serverStreaming")
                || !route
                    .timeout_ms
                    .is_some_and(|v| v > 0 && v <= i32::MAX as u32)
                || !route.max_concurrency.is_some_and(|v| v > 0 && v <= 4096)
            {
                return Err(invalid());
            }
            if let Some(policy) = &route.stream_policy {
                policy.validate()?;
            }
        }
        names.clear();
        for event in &self.events {
            if !valid_name(&event.name)
                || !names.insert(&event.name)
                || !matches!(event.policy.as_str(), "ordered" | "coalesce" | "drop")
            {
                return Err(invalid());
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Header {
    pub v: u32,
    pub generation: String,
    pub op: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<Route>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<WireError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest: Option<Manifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<StreamPolicy>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub done: bool,
    pub options_bytes: usize,
}

impl Header {
    pub fn new(op: &str) -> Self {
        Self {
            v: 1,
            generation: String::new(),
            op: op.into(),
            id: None,
            target: None,
            route: None,
            event: None,
            error: None,
            manifest: None,
            token: None,
            policy: None,
            done: false,
            options_bytes: 0,
        }
    }
}

#[derive(Debug)]
pub struct Frame {
    pub header: Header,
    pub payload: Vec<u8>,
    pub options: Vec<u8>,
}

pub fn encode(mut header: Header, payload: &[u8], options: &[u8]) -> Result<Vec<u8>> {
    if payload.len() > MAX_PAYLOAD || options.len() > MAX_OPTIONS {
        return Err(WireError::new(
            "RESOURCE_EXHAUSTED",
            "WebSocket payload too large",
        ));
    }
    header.options_bytes = options.len();
    let metadata = serde_json::to_vec(&header).map_err(|_| WireError::unavailable())?;
    if metadata.len() > MAX_METADATA {
        return Err(WireError::new(
            "RESOURCE_EXHAUSTED",
            "WebSocket metadata too large",
        ));
    }
    let mut bytes = Vec::with_capacity(4 + metadata.len() + payload.len() + options.len());
    bytes.extend_from_slice(&(metadata.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&metadata);
    bytes.extend_from_slice(payload);
    bytes.extend_from_slice(options);
    Ok(bytes)
}

pub fn decode(bytes: &[u8]) -> Result<Frame> {
    let invalid = || WireError::new("INCOMPATIBLE", "invalid WebSocket frame");
    if bytes.len() < 4 || bytes.len() > 4 + MAX_METADATA + MAX_PAYLOAD + MAX_OPTIONS {
        return Err(invalid());
    }
    let size = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
    if size > MAX_METADATA || size + 4 > bytes.len() {
        return Err(invalid());
    }
    let header: Header = serde_json::from_slice(&bytes[4..4 + size]).map_err(|_| invalid())?;
    if header.v != 1
        || header.generation.len() > 100
        || header.op.is_empty()
        || header.id.as_ref().is_some_and(|v| v.len() > 100)
        || header.target.as_ref().is_some_and(|v| v.len() > 100)
        || header.options_bytes > MAX_OPTIONS
        || header.options_bytes > bytes.len() - 4 - size
    {
        return Err(invalid());
    }
    let end = bytes.len() - header.options_bytes;
    if end - 4 - size > MAX_PAYLOAD {
        return Err(invalid());
    }
    Ok(Frame {
        header,
        payload: bytes[4 + size..end].to_vec(),
        options: bytes[end..].to_vec(),
    })
}
