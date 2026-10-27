// Generated Gateway bindings. Do not edit.
#[rustfmt::skip]
pub mod xiaowei_desktop_clipboard_dao_service {
    pub const CAPTURE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::CaptureClipboardEntityRequest, proto_desktop_rs::xiaowei::desktop::ClipboardEntity> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardDao.Capture", xw_gateway::MethodKind::Unary);
    pub const LIST: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ClipboardListOptions, proto_desktop_rs::xiaowei::desktop::ClipboardEntityList> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardDao.List", xw_gateway::MethodKind::Unary);
    pub const SEARCH: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::SearchClipboardEntitiesRequest, proto_desktop_rs::xiaowei::desktop::ClipboardEntityHits> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardDao.Search", xw_gateway::MethodKind::Unary);
    pub const GET: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ClipboardItemRequest, proto_desktop_rs::xiaowei::desktop::OptionalClipboardEntity> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardDao.Get", xw_gateway::MethodKind::Unary);
    pub const TOUCH: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::TouchClipboardEntityRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardDao.Touch", xw_gateway::MethodKind::Unary);
    pub const SET_FAVORITE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::FavoriteRequest, proto_desktop_rs::xiaowei::desktop::SetFavoriteResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardDao.SetFavorite", xw_gateway::MethodKind::Unary);
    pub const SET_REMARK: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::SetRemarkRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardDao.SetRemark", xw_gateway::MethodKind::Unary);
    pub const SET_CATEGORY: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::SetCategoryRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardDao.SetCategory", xw_gateway::MethodKind::Unary);
    pub const CATEGORIES: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::ClipboardCategories> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardDao.Categories", xw_gateway::MethodKind::Unary);
    pub const SAVE_CATEGORY: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::SaveCategoryRequest, proto_desktop_rs::xiaowei::desktop::ClipboardCategory> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardDao.SaveCategory", xw_gateway::MethodKind::Unary);
    pub const DELETE_CATEGORY: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ClipboardCategoryRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardDao.DeleteCategory", xw_gateway::MethodKind::Unary);
    pub const EDIT_TEXT: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::EditClipboardEntityTextRequest, proto_desktop_rs::xiaowei::desktop::EditClipboardEntityTextResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardDao.EditText", xw_gateway::MethodKind::Unary);
    pub const DELETE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ClipboardItemRequest, proto_desktop_rs::xiaowei::desktop::DeletedClipboardEntities> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardDao.Delete", xw_gateway::MethodKind::Unary);
    pub const PURGE_ORDINARY_BATCH: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::PurgeClipboardEntitiesRequest, proto_desktop_rs::xiaowei::desktop::DeletedClipboardEntities> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardDao.PurgeOrdinaryBatch", xw_gateway::MethodKind::Unary);
    pub const CLEAR_HISTORY_BATCH: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::DeletedClipboardEntities> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardDao.ClearHistoryBatch", xw_gateway::MethodKind::Unary);
    pub const HASH_REFERENCED: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ClipboardEntityHashRequest, proto_desktop_rs::xiaowei::desktop::ClipboardEntityHashReference> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardDao.HashReferenced", xw_gateway::MethodKind::Unary);
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
pub mod xiaowei_desktop_settings_service {
    pub const GET: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::SettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.desktop.Settings.Get", xw_gateway::MethodKind::Unary);
    pub const UPDATE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::UpdateSettingsRequest, proto_desktop_rs::xiaowei::desktop::SettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.desktop.Settings.Update", xw_gateway::MethodKind::Unary);
    pub const GET_WEB_SEARCH_RUNTIME_CONFIG: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::GetWebSearchRuntimeConfigRequest, proto_desktop_rs::xiaowei::desktop::WebSearchRuntimeConfig> =
        xw_gateway::binding::Method::new("xiaowei.desktop.Settings.GetWebSearchRuntimeConfig", xw_gateway::MethodKind::Unary);
    pub const TEST_WEB_SEARCH_PROVIDER: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::TestWebSearchProviderRequest, proto_desktop_rs::xiaowei::desktop::WebSearchProviderTestResult> =
        xw_gateway::binding::Method::new("xiaowei.desktop.Settings.TestWebSearchProvider", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_desktop_shortcuts_service {
    pub const APPLY: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ShortcutConfiguration, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.Shortcuts.Apply", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_desktop_key_value_service {
    pub const GET: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::KvKey, proto_desktop_rs::xiaowei::desktop::KvValue> =
        xw_gateway::binding::Method::new("xiaowei.desktop.KeyValue.Get", xw_gateway::MethodKind::Unary);
    pub const SET: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::KvEntry, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.KeyValue.Set", xw_gateway::MethodKind::Unary);
    pub const DELETE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::KvKey, proto_desktop_rs::xiaowei::desktop::KvDeleted> =
        xw_gateway::binding::Method::new("xiaowei.desktop.KeyValue.Delete", xw_gateway::MethodKind::Unary);
    pub const LIST: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::KvPrefix, proto_desktop_rs::xiaowei::desktop::KvEntries> =
        xw_gateway::binding::Method::new("xiaowei.desktop.KeyValue.List", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_desktop_storage_service {
    pub const DATABASE_USAGE: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::DatabaseUsageResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.Storage.DatabaseUsage", xw_gateway::MethodKind::Unary);
}
