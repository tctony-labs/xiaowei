use super::{Context, Control, Endpoint, argument, parse, unavailable};
use crate::protocol::{CONTROL_VERSION, WireResult};
use crate::{CancelHandle, ErrorCode, GatewayError, Route};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcControl {
    version: u32,
    operation: String,
    rpc_id: String,
    route: Option<Route>,
}

struct Session {
    token: String,
    cancellation: CancelHandle,
}

#[derive(Default)]
pub(super) struct Sessions(Mutex<HashMap<String, Session>>);

impl Sessions {
    pub fn close(&self) {
        for (_, session) in self.0.lock().unwrap().drain() {
            session.cancellation.cancel();
        }
    }
}

impl Endpoint {
    /// Register and cancel synchronously before spawning work, so cancel cannot overtake invoke.
    pub fn prepare_rpc(&self, metadata: &str, context: &str) -> Result<(), GatewayError> {
        self.ready()?;
        let control: RpcControl = parse(metadata)?;
        let context: Context = parse(context)?;
        if control.version != CONTROL_VERSION {
            return Err(GatewayError::new(ErrorCode::Incompatible, "RPC control version"));
        }
        if control.rpc_id.is_empty() || control.rpc_id.len() > 200 {
            return Err(argument());
        }
        let mut sessions = self.rpcs.0.lock().unwrap();
        match control.operation.as_str() {
            "invoke" => {
                let route = control.route.as_ref().ok_or_else(argument)?;
                route.validate()?;
                context.core().authorize(&route.name, false)?;
                if route.kind != crate::MethodKind::Unary || sessions.contains_key(&control.rpc_id) {
                    return Err(argument());
                }
                if sessions.len() >= 256 {
                    return Err(GatewayError::new(ErrorCode::ResourceExhausted, "endpoint RPCs full"));
                }
                sessions.insert(
                    control.rpc_id,
                    Session {
                        token: context.token,
                        cancellation: CancelHandle::new(),
                    },
                );
            }
            "invoke.cancel" => {
                if let Some(session) = sessions.get(&control.rpc_id) {
                    if session.token != context.token {
                        return Err(GatewayError::new(ErrorCode::Unauthorized, "RPC caller mismatch"));
                    }
                    session.cancellation.cancel();
                }
            }
            _ => return Err(argument()),
        }
        Ok(())
    }

    pub async fn rpc_control(self: &Arc<Self>, metadata: &str, payload: Vec<u8>, context: &str) -> WireResult {
        self.ready()?;
        let control: RpcControl = parse(metadata)?;
        let context: Context = parse(context)?;
        if control.version != CONTROL_VERSION {
            return Err(GatewayError::new(ErrorCode::Incompatible, "RPC control version"));
        }
        if control.operation == "invoke.cancel" {
            return Ok(vec![]);
        }
        if control.operation != "invoke" {
            return Err(argument());
        }
        let cancellation = {
            let sessions = self.rpcs.0.lock().unwrap();
            let session = sessions.get(&control.rpc_id).ok_or_else(unavailable)?;
            if session.token != context.token {
                return Err(GatewayError::new(ErrorCode::Unauthorized, "RPC caller mismatch"));
            }
            session.cancellation.clone()
        };
        let result = async {
            let (payload, service_options) = decode_invoke_frame(payload)?;
            self.registry
                .dispatch_local_cancellable(
                    &self.owner,
                    &control.route.ok_or_else(argument)?,
                    payload,
                    context.core(),
                    cancellation,
                    service_options,
                )
                .await
        }
        .await;
        self.rpcs.0.lock().unwrap().remove(&control.rpc_id);
        result
    }

    pub(super) async fn remote_invoke(
        self: &Arc<Self>,
        route: Route,
        payload: Vec<u8>,
        context: crate::CallContext,
        service_options: Option<Vec<u8>>,
    ) -> WireResult {
        let id = {
            let mut state = self.state.lock().unwrap();
            state.next_subscription += 1;
            format!("rpc:{}", state.next_subscription)
        };
        let mut lease = RpcLease {
            endpoint: Arc::downgrade(self),
            id,
            token: context.caller().into(),
            completed: false,
        };
        let result = self
            .outbound(
                lease.control("invoke", Some(route)),
                encode_invoke_frame(payload, service_options)?,
            )
            .await;
        lease.completed = true;
        result
    }
}

struct RpcLease {
    endpoint: std::sync::Weak<Endpoint>,
    id: String,
    token: String,
    completed: bool,
}

impl RpcLease {
    fn control(&self, operation: &str, route: Option<Route>) -> Control {
        Control {
            version: CONTROL_VERSION,
            operation: operation.into(),
            context_token: self.token.clone(),
            route,
            event: None,
            subscription_id: None,
            filter_present: false,
            stream_id: None,
            rpc_id: Some(self.id.clone()),
        }
    }
}

impl Drop for RpcLease {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        let Some(endpoint) = self.endpoint.upgrade() else {
            return;
        };
        let control = self.control("invoke.cancel", None);
        ::napi::bindgen_prelude::spawn(async move {
            if let Err(error) =
                tokio::time::timeout(std::time::Duration::from_secs(1), endpoint.outbound(control, vec![]))
                    .await
                    .unwrap_or_else(|_| Err(GatewayError::new(ErrorCode::Timeout, "RPC cancellation timed out")))
            {
                eprintln!("Gateway native RPC cancellation failed: {error}");
            }
        });
    }
}

fn encode_invoke_frame(payload: Vec<u8>, options: Option<Vec<u8>>) -> Result<Vec<u8>, GatewayError> {
    if options.as_ref().is_some_and(|bytes| bytes.len() > 65_536) {
        return Err(argument());
    }
    let length = options.as_ref().map_or(u32::MAX, |bytes| bytes.len() as u32);
    let mut frame = Vec::with_capacity(4 + options.as_ref().map_or(0, Vec::len) + payload.len());
    frame.extend_from_slice(&length.to_le_bytes());
    if let Some(options) = options {
        frame.extend_from_slice(&options);
    }
    frame.extend_from_slice(&payload);
    Ok(frame)
}

fn decode_invoke_frame(frame: Vec<u8>) -> Result<(Vec<u8>, Option<Vec<u8>>), GatewayError> {
    let length = u32::from_le_bytes(frame.get(..4).ok_or_else(argument)?.try_into().unwrap());
    if length == u32::MAX {
        return Ok((frame[4..].to_vec(), None));
    }
    let length = length as usize;
    if length > 65_536 || length > frame.len() - 4 {
        return Err(argument());
    }
    Ok((frame[4 + length..].to_vec(), Some(frame[4..4 + length].to_vec())))
}
