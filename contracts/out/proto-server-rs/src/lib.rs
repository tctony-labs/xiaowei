//! Generated server network contracts shared by Rust clients.
pub const FILE_DESCRIPTOR_SET: &[u8] = include_bytes!("gen/descriptor.bin");

pub mod xiaowei {
    pub mod server {
        include!("gen/xiaowei.server.rs");
    }
}
