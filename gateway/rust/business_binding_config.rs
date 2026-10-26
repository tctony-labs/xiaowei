pub struct BindingModule {
    pub name: &'static str,
    pub services: &'static [&'static str],
}

#[rustfmt::skip]
pub const MODULES: &[BindingModule] = &[
    BindingModule {
        name: "xiaowei-rust/napi",
        services: &[
            "xiaowei.server.auth.Auth",
            "xiaowei.server.common.Health",
        ],
    },
    BindingModule {
        name: "xiaowei-agent",
        services: &[
            "xiaowei.agent.Agent",
            "xiaowei.llm.Llm",
            "xiaowei.llm.ModelSettings",
        ],
    },
    BindingModule {
        name: "xw-search",
        services: &[
            "xiaowei.desktop.search.Search",
            "xiaowei.desktop.applications.App",
            "xiaowei.desktop.host.System",
        ],
    },
    BindingModule {
        name: "xw-clipboard",
        services: &[
            "xiaowei.desktop.settings.Settings",
            "xiaowei.desktop.storage.Storage",
            "xiaowei.desktop.host.System",
            "xiaowei.desktop.clipboard.ClipboardBiz",
            "xiaowei.desktop.clipboard.ClipboardDao",
        ],
    },
    BindingModule {
        name: "xw-storage",
        services: &[
            "xiaowei.desktop.host.System",
            "xiaowei.desktop.shortcuts.Shortcuts",
            "xiaowei.desktop.storage.Storage",
            "xiaowei.desktop.storage.KeyValue",
            "xiaowei.desktop.settings.Settings",
            "xiaowei.desktop.clipboard.ClipboardDao",
        ],
    },
];
