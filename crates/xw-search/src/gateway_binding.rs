// Generated Gateway bindings. Do not edit.
#[rustfmt::skip]
pub mod xiaowei_desktop_app_service {
    pub const READ_ICON: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ReadIconRequest, proto_desktop_rs::xiaowei::desktop::AppIcon> =
        xw_gateway::binding::Method::new("xiaowei.desktop.App.ReadIcon", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_desktop_system_service {
    pub const OPEN_SETTINGS: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::OpenSettingsRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.System.OpenSettings", xw_gateway::MethodKind::Unary);
    pub const TAKE_SETTINGS_NAVIGATION: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::TakeSettingsNavigationResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.System.TakeSettingsNavigation", xw_gateway::MethodKind::Unary);
    pub const SET_AUTOSTART: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::SetAutostartRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.System.SetAutostart", xw_gateway::MethodKind::Unary);
    pub const HIDE_WINDOW: xw_gateway::binding::Method<(), ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.System.HideWindow", xw_gateway::MethodKind::Unary);
    pub const WRITE_CLIPBOARD_TEXT: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::WriteClipboardTextRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.System.WriteClipboardText", xw_gateway::MethodKind::Unary);
    pub const TOGGLE_THEME: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::ToggleThemeResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.System.ToggleTheme", xw_gateway::MethodKind::Unary);
    pub const OPEN_URL: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::OpenUrlRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.System.OpenUrl", xw_gateway::MethodKind::Unary);
    pub const OPEN_PATH: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::LocalPathRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.System.OpenPath", xw_gateway::MethodKind::Unary);
    pub const REVEAL_PATH: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::LocalPathRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.System.RevealPath", xw_gateway::MethodKind::Unary);
    pub const CHECK_FOR_UPDATES: xw_gateway::binding::Method<(), ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.System.CheckForUpdates", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_desktop_search_service {
    pub const QUERY: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::SearchRequest, proto_desktop_rs::xiaowei::desktop::SearchResults> =
        xw_gateway::binding::Method::new("xiaowei.desktop.Search.Query", xw_gateway::MethodKind::Unary);
    pub const RECORD_USAGE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::RecordUsageRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.Search.RecordUsage", xw_gateway::MethodKind::Unary);
}
