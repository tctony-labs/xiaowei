// Generated Gateway bindings. Do not edit.
#[rustfmt::skip]
pub mod xiaowei_app_app_service {
    pub const READ_ICON: xw_gateway::binding::Method<xw_contracts::xiaowei::app::ReadIconRequest, xw_contracts::xiaowei::app::AppIcon> =
        xw_gateway::binding::Method::new("xiaowei.app.App.ReadIcon", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_search_search_service {
    pub const QUERY: xw_gateway::binding::Method<xw_contracts::xiaowei::search::SearchRequest, xw_contracts::xiaowei::search::SearchResults> =
        xw_gateway::binding::Method::new("xiaowei.search.Search.Query", xw_gateway::MethodKind::Unary);
    pub const RECORD_USAGE: xw_gateway::binding::Method<xw_contracts::xiaowei::search::RecordUsageRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.search.Search.RecordUsage", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_system_system_service {
    pub const SET_AUTOSTART: xw_gateway::binding::Method<xw_contracts::xiaowei::system::SetAutostartRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.system.System.SetAutostart", xw_gateway::MethodKind::Unary);
    pub const HIDE_WINDOW: xw_gateway::binding::Method<xw_contracts::xiaowei::common::Empty, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.system.System.HideWindow", xw_gateway::MethodKind::Unary);
    pub const WRITE_CLIPBOARD_TEXT: xw_gateway::binding::Method<xw_contracts::xiaowei::system::WriteClipboardTextRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.system.System.WriteClipboardText", xw_gateway::MethodKind::Unary);
    pub const TOGGLE_THEME: xw_gateway::binding::Method<xw_contracts::xiaowei::common::Empty, xw_contracts::xiaowei::system::ToggleThemeResponse> =
        xw_gateway::binding::Method::new("xiaowei.system.System.ToggleTheme", xw_gateway::MethodKind::Unary);
    pub const OPEN_URL: xw_gateway::binding::Method<xw_contracts::xiaowei::system::OpenUrlRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.system.System.OpenUrl", xw_gateway::MethodKind::Unary);
    pub const OPEN_PATH: xw_gateway::binding::Method<xw_contracts::xiaowei::system::LocalPathRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.system.System.OpenPath", xw_gateway::MethodKind::Unary);
    pub const REVEAL_PATH: xw_gateway::binding::Method<xw_contracts::xiaowei::system::LocalPathRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.system.System.RevealPath", xw_gateway::MethodKind::Unary);
}
