//! Shared Protobuf contracts. Generated files are refreshed by contracts:generate.
pub mod testing {
    include!("gen/testing.rs");
}

pub const FILE_DESCRIPTOR_SET: &[u8] = include_bytes!("gen/descriptor.bin");

pub mod xiaowei {
    pub mod agent {
        include!("gen/xiaowei.agent.rs");
    }

    pub mod server {
        pub mod common {
            include!("gen/xiaowei.server.common.rs");
        }

        pub mod auth {
            include!("gen/xiaowei.server.auth.rs");
        }
    }

    pub mod llm {
        include!("gen/xiaowei.llm.rs");
    }

    pub mod storage {
        include!("gen/xiaowei.storage.rs");
    }

    pub mod system {
        include!("gen/xiaowei.system.rs");
    }
    pub mod app {
        include!("gen/xiaowei.app.rs");
    }
    pub mod common {
        include!("gen/xiaowei.common.rs");
    }
    pub mod search {
        include!("gen/xiaowei.search.rs");
    }
    pub mod clipboard {
        include!("gen/xiaowei.clipboard.rs");
    }
    pub mod launcher {
        include!("gen/xiaowei.launcher.rs");
    }
}
