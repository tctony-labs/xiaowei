//! Generated desktop contracts.
pub const FILE_DESCRIPTOR_SET: &[u8] = include_bytes!("gen/descriptor.bin");

pub mod xiaowei {
    pub mod desktop {
        include!("gen/xiaowei.desktop.rs");
    }
}
