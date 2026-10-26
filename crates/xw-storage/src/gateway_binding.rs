// Generated Gateway bindings. Do not edit.
#[rustfmt::skip]
pub mod xiaowei_desktop_clipboard_clipboard_dao_service {
    pub const CAPTURE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::clipboard::CaptureClipboardEntityRequest, proto_desktop_rs::xiaowei::desktop::clipboard::ClipboardEntity> =
        xw_gateway::binding::Method::new("xiaowei.desktop.clipboard.ClipboardDao.Capture", xw_gateway::MethodKind::Unary);
    pub const LIST: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::clipboard::ClipboardListOptions, proto_desktop_rs::xiaowei::desktop::clipboard::ClipboardEntityList> =
        xw_gateway::binding::Method::new("xiaowei.desktop.clipboard.ClipboardDao.List", xw_gateway::MethodKind::Unary);
    pub const SEARCH: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::clipboard::SearchClipboardEntitiesRequest, proto_desktop_rs::xiaowei::desktop::clipboard::ClipboardEntityHits> =
        xw_gateway::binding::Method::new("xiaowei.desktop.clipboard.ClipboardDao.Search", xw_gateway::MethodKind::Unary);
    pub const GET: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::clipboard::ClipboardItemRequest, proto_desktop_rs::xiaowei::desktop::clipboard::OptionalClipboardEntity> =
        xw_gateway::binding::Method::new("xiaowei.desktop.clipboard.ClipboardDao.Get", xw_gateway::MethodKind::Unary);
    pub const TOUCH: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::clipboard::TouchClipboardEntityRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.clipboard.ClipboardDao.Touch", xw_gateway::MethodKind::Unary);
    pub const SET_FAVORITE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::clipboard::FavoriteRequest, proto_desktop_rs::xiaowei::desktop::clipboard::SetFavoriteResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.clipboard.ClipboardDao.SetFavorite", xw_gateway::MethodKind::Unary);
    pub const SET_REMARK: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::clipboard::SetRemarkRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.clipboard.ClipboardDao.SetRemark", xw_gateway::MethodKind::Unary);
    pub const SET_CATEGORY: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::clipboard::SetCategoryRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.clipboard.ClipboardDao.SetCategory", xw_gateway::MethodKind::Unary);
    pub const CATEGORIES: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::clipboard::ClipboardCategories> =
        xw_gateway::binding::Method::new("xiaowei.desktop.clipboard.ClipboardDao.Categories", xw_gateway::MethodKind::Unary);
    pub const SAVE_CATEGORY: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::clipboard::SaveCategoryRequest, proto_desktop_rs::xiaowei::desktop::clipboard::ClipboardCategory> =
        xw_gateway::binding::Method::new("xiaowei.desktop.clipboard.ClipboardDao.SaveCategory", xw_gateway::MethodKind::Unary);
    pub const DELETE_CATEGORY: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::clipboard::ClipboardCategoryRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.clipboard.ClipboardDao.DeleteCategory", xw_gateway::MethodKind::Unary);
    pub const EDIT_TEXT: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::clipboard::EditClipboardEntityTextRequest, proto_desktop_rs::xiaowei::desktop::clipboard::EditClipboardEntityTextResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.clipboard.ClipboardDao.EditText", xw_gateway::MethodKind::Unary);
    pub const DELETE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::clipboard::ClipboardItemRequest, proto_desktop_rs::xiaowei::desktop::clipboard::DeletedClipboardEntities> =
        xw_gateway::binding::Method::new("xiaowei.desktop.clipboard.ClipboardDao.Delete", xw_gateway::MethodKind::Unary);
    pub const PURGE_ORDINARY_BATCH: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::clipboard::PurgeClipboardEntitiesRequest, proto_desktop_rs::xiaowei::desktop::clipboard::DeletedClipboardEntities> =
        xw_gateway::binding::Method::new("xiaowei.desktop.clipboard.ClipboardDao.PurgeOrdinaryBatch", xw_gateway::MethodKind::Unary);
    pub const CLEAR_HISTORY_BATCH: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::clipboard::DeletedClipboardEntities> =
        xw_gateway::binding::Method::new("xiaowei.desktop.clipboard.ClipboardDao.ClearHistoryBatch", xw_gateway::MethodKind::Unary);
    pub const HASH_REFERENCED: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::clipboard::ClipboardEntityHashRequest, proto_desktop_rs::xiaowei::desktop::clipboard::ClipboardEntityHashReference> =
        xw_gateway::binding::Method::new("xiaowei.desktop.clipboard.ClipboardDao.HashReferenced", xw_gateway::MethodKind::Unary);
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
pub mod xiaowei_desktop_settings_settings_service {
    pub const GET: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::settings::SettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.desktop.settings.Settings.Get", xw_gateway::MethodKind::Unary);
    pub const UPDATE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::settings::UpdateSettingsRequest, proto_desktop_rs::xiaowei::desktop::settings::SettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.desktop.settings.Settings.Update", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_desktop_shortcuts_shortcuts_service {
    pub const APPLY: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::settings::ShortcutConfiguration, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.shortcuts.Shortcuts.Apply", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_desktop_storage_key_value_service {
    pub const GET: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::storage::KvKey, proto_desktop_rs::xiaowei::desktop::storage::KvValue> =
        xw_gateway::binding::Method::new("xiaowei.desktop.storage.KeyValue.Get", xw_gateway::MethodKind::Unary);
    pub const SET: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::storage::KvEntry, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.storage.KeyValue.Set", xw_gateway::MethodKind::Unary);
    pub const DELETE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::storage::KvKey, proto_desktop_rs::xiaowei::desktop::storage::KvDeleted> =
        xw_gateway::binding::Method::new("xiaowei.desktop.storage.KeyValue.Delete", xw_gateway::MethodKind::Unary);
    pub const LIST: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::storage::KvPrefix, proto_desktop_rs::xiaowei::desktop::storage::KvEntries> =
        xw_gateway::binding::Method::new("xiaowei.desktop.storage.KeyValue.List", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_desktop_storage_storage_service {
    pub const DATABASE_USAGE: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::storage::DatabaseUsageResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.storage.Storage.DatabaseUsage", xw_gateway::MethodKind::Unary);
}
