pub struct BindingModule {
    pub name: &'static str,
    pub services: &'static [&'static str],
}

#[rustfmt::skip]
pub const MODULES: &[BindingModule] = &[
    BindingModule {
        name: "xiaowei-rust/napi",
        services: &[
            "xiaowei.server.Auth",
            "xiaowei.server.Health",
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
            "xiaowei.desktop.Search",
            "xiaowei.desktop.App",
            "xiaowei.desktop.System",
        ],
    },
    BindingModule {
        name: "xw-clipboard",
        services: &[
            "xiaowei.desktop.Settings",
            "xiaowei.desktop.Storage",
            "xiaowei.desktop.System",
            "xiaowei.desktop.ClipboardBiz",
            "xiaowei.desktop.ClipboardDao",
        ],
    },
    BindingModule {
        name: "xw-storage",
        services: &[
            "xiaowei.desktop.System",
            "xiaowei.desktop.Shortcuts",
            "xiaowei.desktop.Storage",
            "xiaowei.desktop.KeyValue",
            "xiaowei.desktop.Settings",
            "xiaowei.desktop.ClipboardDao",
        ],
    },
];
