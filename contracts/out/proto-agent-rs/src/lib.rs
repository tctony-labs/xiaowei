//! Protobuf contracts; generated definitions are refreshed by contracts:generate.
pub const FILE_DESCRIPTOR_SET: &[u8] = include_bytes!("gen/descriptor.bin");

pub mod xiaowei {
    pub mod agent {
        include!("gen/xiaowei.agent.rs");
    }
}
