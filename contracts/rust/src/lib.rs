//! Shared Protobuf contracts. Generated files are refreshed by contracts:generate.
pub mod testing {
    include!("gen/testing.rs");
}

pub const FILE_DESCRIPTOR_SET: &[u8] = include_bytes!("gen/descriptor.bin");
