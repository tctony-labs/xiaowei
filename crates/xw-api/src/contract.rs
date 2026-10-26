use prost::Message;
use prost_reflect::{DescriptorPool, DynamicMessage, MethodDescriptor, SerializeOptions, Value};
use std::sync::OnceLock;

use crate::{Error, Result};

fn pool() -> &'static DescriptorPool {
    static POOL: OnceLock<DescriptorPool> = OnceLock::new();
    POOL.get_or_init(|| {
        // Decode original bytes: a prost_types round trip would discard custom method options.
        DescriptorPool::decode(proto_server_rs::FILE_DESCRIPTOR_SET)
            .expect("generated client descriptors are valid")
    })
}

#[derive(Clone)]
pub struct Method {
    pub descriptor: MethodDescriptor,
    pub id: String,
    pub path: String,
    pub requires_login: bool,
}

impl Method {
    pub fn resolve(full_name: &str) -> Result<Self> {
        let (service, method) = full_name
            .rsplit_once('.')
            .ok_or_else(|| Error::invalid("无效的服务器接口"))?;
        let short = service
            .strip_prefix("xiaowei.server.")
            .ok_or_else(|| Error::invalid("无效的服务器接口命名空间"))?;
        let descriptor = pool()
            .get_service_by_name(service)
            .and_then(|service| service.methods().find(|value| value.name() == method))
            .ok_or_else(|| Error::invalid("未知的服务器接口"))?;
        if descriptor.is_client_streaming() || descriptor.is_server_streaming() {
            return Err(Error::invalid("此服务器接口不是 unary 方法"));
        }
        let extension = pool()
            .get_extension_by_name("xiaowei.server.common.api")
            .expect("generated api option exists");
        let options = descriptor.options();
        let option = options.get_extension(&extension);
        let no_login = match option.as_ref() {
            Value::Message(value) => value
                .get_field_by_name("no_login")
                .is_some_and(|value| value.as_bool() == Some(true)),
            _ => false,
        };
        let id = format!("{short}/{method}");
        Ok(Self {
            descriptor,
            path: format!("/api/{id}"),
            id,
            requires_login: !no_login,
        })
    }

    pub fn encode_json(&self, payload: &[u8]) -> Result<String> {
        let message = DynamicMessage::decode(self.descriptor.input(), payload)
            .map_err(|_| Error::invalid("无效的请求消息"))?;
        let mut bytes = Vec::new();
        let mut serializer = serde_json::Serializer::new(&mut bytes);
        message
            .serialize_with_options(
                &mut serializer,
                &SerializeOptions::new().use_proto_field_name(true),
            )
            .map_err(|_| Error::invalid("无法编码请求消息"))?;
        String::from_utf8(bytes).map_err(|_| Error::invalid("无法编码请求消息"))
    }

    pub fn decode_json(&self, bytes: &[u8]) -> Result<Vec<u8>> {
        let value: serde_json::Value = serde_json::from_slice(bytes)
            .map_err(|_| Error::unavailable("服务器返回了无效的响应"))?;
        let code = value
            .get("code")
            .and_then(|value| value.as_i64())
            .and_then(|value| i32::try_from(value).ok());
        let message = value.get("msg").and_then(|value| value.as_str());
        let (Some(code), Some(message)) = (code, message) else {
            return Err(Error::unavailable("服务器返回了无效的响应"));
        };
        if code != 0 {
            return Err(Error {
                code,
                message: if message.is_empty() {
                    "服务器拒绝了此操作"
                } else {
                    message
                }
                .into(),
                category: "business",
            });
        }
        if !value.get("data").is_some_and(|value| value.is_object()) {
            return Err(Error::unavailable("服务器返回了无效的响应"));
        }
        let mut deserializer = serde_json::Deserializer::from_slice(bytes);
        let message = DynamicMessage::deserialize(self.descriptor.output(), &mut deserializer)
            .map_err(|_| Error::unavailable("服务器返回了无效的响应"))?;
        deserializer
            .end()
            .map_err(|_| Error::unavailable("服务器返回了无效的响应"))?;
        Ok(message.encode_to_vec())
    }
}
