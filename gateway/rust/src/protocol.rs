use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

pub const CONTROL_VERSION: u32 = 1;
pub const CONTRACT_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    UnknownRoute,
    OwnerUnavailable,
    InvalidArgument,
    ConcurrencyFull,
    Timeout,
    Unauthorized,
    HandlerError,
    Conflict,
    Incompatible,
    WrongMethodKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayError {
    pub code: ErrorCode,
    pub message: String,
}

impl GatewayError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for GatewayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}
impl std::error::Error for GatewayError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MethodKind {
    Unary,
    ServerStreaming,
}

/// Contract versions represent explicit breaking revisions, not descriptor hashes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub name: String,
    pub kind: MethodKind,
    pub control_version: u32,
    pub contract_version: u32,
    pub input: String,
    pub output: String,
}

impl Route {
    pub fn validate(&self) -> Result<(), GatewayError> {
        validate_name(&self.name)?;
        if self.control_version != CONTROL_VERSION || self.contract_version != CONTRACT_VERSION {
            return Err(GatewayError::new(
                ErrorCode::Incompatible,
                "unsupported protocol or contract version",
            ));
        }
        validate_name(&self.input)?;
        validate_name(&self.output)
    }

    pub fn accepts(&self, requested: &Self) -> Result<(), GatewayError> {
        requested.validate()?;
        if self != requested {
            return Err(GatewayError::new(ErrorCode::Incompatible, "route contract mismatch"));
        }
        if self.kind != MethodKind::Unary {
            return Err(GatewayError::new(
                ErrorCode::WrongMethodKind,
                "stream execution requires stream API",
            ));
        }
        Ok(())
    }
}

pub fn validate_name(name: &str) -> Result<(), GatewayError> {
    if name.is_empty() || name.len() > 200 || name.split('.').any(str::is_empty) {
        return Err(GatewayError::new(ErrorCode::InvalidArgument, "invalid gateway name"));
    }
    Ok(())
}

/// Created by the host, never decoded from a business payload. Clients retain this
/// context across nested calls. Loading arbitrary code is not a sandbox boundary.
#[derive(Debug, Clone)]
pub struct CallContext(Arc<Permissions>);

#[derive(Debug)]
struct Permissions {
    caller: String,
    trusted: bool,
    invoke: HashSet<String>,
    subscribe: HashSet<String>,
}

impl CallContext {
    pub fn trusted(caller: impl Into<String>) -> Self {
        Self(Arc::new(Permissions {
            caller: caller.into(),
            trusted: true,
            invoke: HashSet::new(),
            subscribe: HashSet::new(),
        }))
    }

    pub fn restricted(caller: impl Into<String>, invoke: Vec<String>, subscribe: Vec<String>) -> Self {
        Self(Arc::new(Permissions {
            caller: caller.into(),
            trusted: false,
            invoke: invoke.into_iter().collect(),
            subscribe: subscribe.into_iter().collect(),
        }))
    }

    pub fn caller(&self) -> &str {
        &self.0.caller
    }

    pub fn authorize(&self, name: &str, event: bool) -> Result<(), GatewayError> {
        let allowed = if event { &self.0.subscribe } else { &self.0.invoke };
        if self.0.trusted || allowed.contains(name) {
            return Ok(());
        }
        Err(GatewayError::new(ErrorCode::Unauthorized, "capability not authorized"))
    }
}

pub type WireResult = Result<Vec<u8>, GatewayError>;

/// Owner announcement. Execution policy is descriptive at forwarding hosts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteRegistration {
    #[serde(flatten)]
    pub route: Route,
    pub timeout_ms: u64,
    pub max_concurrency: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub routes: Vec<RouteRegistration>,
    pub events: Vec<crate::event::EventDescriptor>,
}
