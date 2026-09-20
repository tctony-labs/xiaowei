//! Environment-independent Gateway. Host APIs must not be exposed to untrusted callers.
pub mod binding;
pub mod event;
pub mod invoke;
pub mod protocol;

pub use invoke::{Client, InvokeRegistration, XwInvokeRegistry};
pub use protocol::{CallContext, ErrorCode, GatewayError, MethodKind, Route};
