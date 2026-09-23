pub struct BindingModule {
    pub name: &'static str,
    pub services: &'static [&'static str],
}

#[rustfmt::skip]
pub const MODULES: &[BindingModule] = &[
    BindingModule {
        name: "xiaowei-search",
        services: &[
            "xiaowei.search.Search",
            "xiaowei.app.App",
            "xiaowei.system.System",
        ],
    },
    BindingModule {
        name: "xiaowei-clipboard",
        services: &[
            "xiaowei.clipboard.ClipboardBiz",
            "xiaowei.clipboard.ClipboardDao",
        ],
    },
    BindingModule {
        name: "xiaowei-storage",
        services: &[
            "xiaowei.storage.KeyValue",
            "xiaowei.storage.Settings",
            "xiaowei.clipboard.ClipboardDao",
        ],
    },
];
