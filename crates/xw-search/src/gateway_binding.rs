// Generated Gateway bindings. Do not edit.
#[rustfmt::skip]
pub mod xiaowei_desktop_applications_app_service {
    pub const READ_ICON: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::applications::ReadIconRequest, proto_desktop_rs::xiaowei::desktop::applications::AppIcon> =
        xw_gateway::binding::Method::new("xiaowei.desktop.applications.App.ReadIcon", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_desktop_host_system_service {
    pub const OPEN_SETTINGS: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::host::OpenSettingsRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.host.System.OpenSettings", xw_gateway::MethodKind::Unary);
    pub const TAKE_SETTINGS_NAVIGATION: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::host::TakeSettingsNavigationResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.host.System.TakeSettingsNavigation", xw_gateway::MethodKind::Unary);
    pub const SET_AUTOSTART: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::host::SetAutostartRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.host.System.SetAutostart", xw_gateway::MethodKind::Unary);
    pub const HIDE_WINDOW: xw_gateway::binding::Method<(), ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.host.System.HideWindow", xw_gateway::MethodKind::Unary);
    pub const WRITE_CLIPBOARD_TEXT: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::host::WriteClipboardTextRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.host.System.WriteClipboardText", xw_gateway::MethodKind::Unary);
    pub const TOGGLE_THEME: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::host::ToggleThemeResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.host.System.ToggleTheme", xw_gateway::MethodKind::Unary);
    pub const OPEN_URL: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::host::OpenUrlRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.host.System.OpenUrl", xw_gateway::MethodKind::Unary);
    pub const OPEN_PATH: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::host::LocalPathRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.host.System.OpenPath", xw_gateway::MethodKind::Unary);
    pub const REVEAL_PATH: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::host::LocalPathRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.host.System.RevealPath", xw_gateway::MethodKind::Unary);
    pub const CHECK_FOR_UPDATES: xw_gateway::binding::Method<(), ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.host.System.CheckForUpdates", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_desktop_search_search_service {
    pub const QUERY: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::search::SearchRequest, proto_desktop_rs::xiaowei::desktop::search::SearchResults> =
        xw_gateway::binding::Method::new("xiaowei.desktop.search.Search.Query", xw_gateway::MethodKind::Unary);
    pub const RECORD_USAGE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::search::RecordUsageRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.search.Search.RecordUsage", xw_gateway::MethodKind::Unary);
}
