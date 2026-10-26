//! Generated desktop contracts.
pub const FILE_DESCRIPTOR_SET: &[u8] = include_bytes!("gen/descriptor.bin");

pub mod xiaowei {
    pub mod desktop {
        pub mod account {
            include!("gen/xiaowei.desktop.account.rs");
        }

        pub mod applications {
            include!("gen/xiaowei.desktop.applications.rs");
        }

        pub mod clipboard {
            include!("gen/xiaowei.desktop.clipboard.rs");
        }

        pub mod host {
            include!("gen/xiaowei.desktop.host.rs");
        }

        pub mod launcher {
            include!("gen/xiaowei.desktop.launcher.rs");
        }

        pub mod search {
            include!("gen/xiaowei.desktop.search.rs");
        }

        pub mod session {
            include!("gen/xiaowei.desktop.session.rs");
        }

        pub mod settings {
            include!("gen/xiaowei.desktop.settings.rs");
        }

        pub mod storage {
            include!("gen/xiaowei.desktop.storage.rs");
        }
    }
}
