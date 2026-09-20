//! Typed PB adapters. Message code generation remains in contracts.
use std::future::Future;
use std::marker::PhantomData;

use heck::{ToShoutySnakeCase, ToSnakeCase};
use prost::{Message, Name};

use crate::invoke::{Client, InvokeRegistration};
use crate::protocol::*;

/// The descriptor-generated method fixes both request and response types.
///
/// ```compile_fail
/// use xw_gateway::{binding::Method, MethodKind};
/// use xw_contracts::testing::{Envelope, Changed};
/// let echo = Method::<Envelope, Envelope>::new("testing.Fixture.Echo", MethodKind::Unary);
/// echo.handler(|_: Changed, _| async { Ok(Envelope::default()) });
/// ```
///
/// ```compile_fail
/// use xw_gateway::{binding::Method, MethodKind};
/// use xw_contracts::testing::{Envelope, Changed};
/// let echo = Method::<Envelope, Envelope>::new("testing.Fixture.Echo", MethodKind::Unary);
/// echo.handler(|_: Envelope, _| async { Ok(Changed::default()) });
/// ```
pub struct Method<Req, Res> {
    pub name: &'static str,
    pub kind: MethodKind,
    marker: PhantomData<fn(Req) -> Res>,
}

impl<Req, Res> Method<Req, Res>
where
    Req: Message + Default + Name + 'static,
    Res: Message + Default + Name + 'static,
{
    pub const fn new(name: &'static str, kind: MethodKind) -> Self {
        Self {
            name,
            kind,
            marker: PhantomData,
        }
    }

    pub fn route(&self) -> Route {
        Route {
            name: self.name.into(),
            kind: self.kind,
            control_version: CONTROL_VERSION,
            contract_version: CONTRACT_VERSION,
            input: Req::full_name(),
            output: Res::full_name(),
        }
    }

    pub async fn call(&self, client: &Client, request: Req) -> Result<Res, GatewayError> {
        let bytes = client.invoke(&self.route(), request.encode_to_vec()).await?;
        Res::decode(bytes.as_slice())
            .map_err(|_| GatewayError::new(ErrorCode::HandlerError, "invalid response protobuf"))
    }

    pub fn handler<F, Fut>(&self, handler: F) -> InvokeRegistration
    where
        F: Fn(Req, Client) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Res, GatewayError>> + Send + 'static,
    {
        let handler = std::sync::Arc::new(handler);
        InvokeRegistration::unary(self.route(), move |bytes, client| {
            let handler = handler.clone();
            async move {
                let request = Req::decode(bytes.as_slice())
                    .map_err(|_| GatewayError::new(ErrorCode::InvalidArgument, "invalid request protobuf"))?;
                Ok(handler(request, client).await?.encode_to_vec())
            }
        })
    }
}

/// Checked string-ID facade for existing APIs; PB remains u64 on the wire.
pub fn parse_id(value: &str) -> Result<u64, GatewayError> {
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err(GatewayError::new(ErrorCode::InvalidArgument, "invalid uint64 ID"));
    }
    value
        .parse()
        .map_err(|_| GatewayError::new(ErrorCode::InvalidArgument, "uint64 ID out of range"))
}

/// Generate Gateway method constants from the language contract descriptor.
/// `types` maps PB full names to existing Rust message paths (including nested types).
/// No messages or codecs are generated here.
pub fn generate_methods(
    descriptor: &[u8],
    types: &std::collections::HashMap<String, String>,
) -> Result<String, GatewayError> {
    let descriptor = prost_types::FileDescriptorSet::decode(descriptor)
        .map_err(|_| GatewayError::new(ErrorCode::InvalidArgument, "invalid descriptor"))?;
    let mut output = String::from("// Generated Gateway bindings. Do not edit.\n");
    let mut modules = std::collections::HashSet::new();
    for file in descriptor.file {
        for service in file.service {
            let service_name = service.name.unwrap_or_default();
            let package = file.package.as_deref().unwrap_or("");
            let full_name = if package.is_empty() {
                service_name.clone()
            } else {
                format!("{package}.{service_name}")
            };
            let module = format!("{}_service", full_name.replace('.', "_").to_snake_case());
            if !modules.insert(module.clone()) {
                return Err(GatewayError::new(
                    ErrorCode::Conflict,
                    "generated service module collision",
                ));
            }
            output.push_str(&format!("#[rustfmt::skip]\npub mod {module} {{\n"));
            let mut methods = std::collections::HashSet::new();
            for method in service.method {
                if method.client_streaming.unwrap_or(false) {
                    return Err(GatewayError::new(
                        ErrorCode::WrongMethodKind,
                        "client streaming is unsupported",
                    ));
                }
                let input = types.get(method.input_type.as_deref().unwrap_or("").trim_start_matches('.'));
                let output_type = types.get(method.output_type.as_deref().unwrap_or("").trim_start_matches('.'));
                let (Some(input), Some(output_type)) = (input, output_type) else {
                    return Err(GatewayError::new(
                        ErrorCode::InvalidArgument,
                        "missing Rust message path",
                    ));
                };
                let name = method.name.unwrap_or_default();
                let kind = if method.server_streaming.unwrap_or(false) {
                    "ServerStreaming"
                } else {
                    "Unary"
                };
                let constant = name.to_shouty_snake_case();
                if !methods.insert(constant.clone()) {
                    return Err(GatewayError::new(
                        ErrorCode::Conflict,
                        "generated method name collision",
                    ));
                }
                output.push_str(&format!(
                    concat!(
                        "    pub const {}: xw_gateway::binding::Method<{}, {}> =\n",
                        "        xw_gateway::binding::Method::new(\"{}.{}\", xw_gateway::MethodKind::{});\n",
                    ),
                    constant, input, output_type, full_name, name, kind,
                ));
            }
            output.push_str("}\n");
        }
    }
    Ok(output)
}
