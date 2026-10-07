//! Environment-independent Gateway. Host APIs must not be exposed to untrusted callers.
extern crate self as xw_gateway;

pub mod binding;
pub mod event;
pub mod invoke;
pub mod protocol;
pub mod rpc;
pub mod stream;

pub use invoke::{Client, InvokeRegistration, XwInvokeRegistry};
pub use protocol::{CallContext, ErrorCode, GatewayError, MethodKind, Route};
pub use rpc::{CancelHandle, Rpc};

#[cfg(feature = "napi")]
pub mod napi;
