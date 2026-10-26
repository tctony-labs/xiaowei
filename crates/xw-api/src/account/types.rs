use proto_server_rs::xiaowei::server::auth::{Authenticated, LoginRequest};

#[derive(Clone)]
pub struct Session {
    pub server: String,
    pub authenticated: Authenticated,
}

#[derive(Clone)]
pub enum Operation {
    Login(LoginRequest),
    Restore { force: bool },
    Maintain { force: bool },
    Logout,
    Revoke,
}

/// The embedding application's existing permissions, checked only when an action is needed.
/// Standalone native clients use the default unrestricted policy. This is not an API factory.
#[derive(Clone, Copy)]
pub struct Access {
    pub login: bool,
    pub refresh: bool,
    pub current_user: bool,
    pub logout: bool,
}

impl Default for Access {
    fn default() -> Self {
        Self {
            login: true,
            refresh: true,
            current_user: true,
            logout: true,
        }
    }
}

impl Access {
    pub(super) fn check(allowed: bool) -> crate::Result<()> {
        if allowed {
            return Ok(());
        }
        Err(crate::Error {
            code: 10003,
            message: "capability not authorized".into(),
            category: "permissions",
        })
    }
}

#[derive(Clone)]
pub struct Outcome {
    pub code: i32,
    pub message: String,
    pub session: Option<Session>,
    pub credential_version: u64,
    pub checkpoint: bool,
    pub next_maintenance_at_ms: i64,
}

#[derive(Clone)]
pub(super) enum Phase {
    Login(LoginRequest),
    Fresh { force: bool, next: Next },
    Validate { confirm_rejection: bool },
    Logout { retried: bool },
    Revoke,
    Complete,
}

#[derive(Clone, Copy)]
pub(super) enum Next {
    Complete,
    Validate { confirm_rejection: bool },
    Logout { retried: bool },
}

impl Next {
    pub fn phase(self) -> Phase {
        match self {
            Self::Complete => Phase::Complete,
            Self::Validate { confirm_rejection } => Phase::Validate { confirm_rejection },
            Self::Logout { retried } => Phase::Logout { retried },
        }
    }
}
