// Generated Gateway bindings. Do not edit.
#[rustfmt::skip]
pub mod xiaowei_clipboard_clipboard_dao_service {
    pub const CAPTURE: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::CaptureClipboardEntityRequest, xw_contracts::xiaowei::clipboard::ClipboardEntity> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardDao.Capture", xw_gateway::MethodKind::Unary);
    pub const LIST: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardListOptions, xw_contracts::xiaowei::clipboard::ClipboardEntityList> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardDao.List", xw_gateway::MethodKind::Unary);
    pub const SEARCH: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::SearchClipboardEntitiesRequest, xw_contracts::xiaowei::clipboard::ClipboardEntityHits> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardDao.Search", xw_gateway::MethodKind::Unary);
    pub const GET: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardItemRequest, xw_contracts::xiaowei::clipboard::OptionalClipboardEntity> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardDao.Get", xw_gateway::MethodKind::Unary);
    pub const TOUCH: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::TouchClipboardEntityRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardDao.Touch", xw_gateway::MethodKind::Unary);
    pub const SET_FAVORITE: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::FavoriteRequest, xw_contracts::xiaowei::clipboard::SetFavoriteResponse> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardDao.SetFavorite", xw_gateway::MethodKind::Unary);
    pub const SET_REMARK: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::SetRemarkRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardDao.SetRemark", xw_gateway::MethodKind::Unary);
    pub const SET_CATEGORY: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::SetCategoryRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardDao.SetCategory", xw_gateway::MethodKind::Unary);
    pub const CATEGORIES: xw_gateway::binding::Method<xw_contracts::xiaowei::common::Empty, xw_contracts::xiaowei::clipboard::ClipboardCategories> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardDao.Categories", xw_gateway::MethodKind::Unary);
    pub const SAVE_CATEGORY: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::SaveCategoryRequest, xw_contracts::xiaowei::clipboard::ClipboardCategory> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardDao.SaveCategory", xw_gateway::MethodKind::Unary);
    pub const DELETE_CATEGORY: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardCategoryRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardDao.DeleteCategory", xw_gateway::MethodKind::Unary);
    pub const EDIT_TEXT: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::EditClipboardEntityTextRequest, xw_contracts::xiaowei::clipboard::EditClipboardEntityTextResponse> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardDao.EditText", xw_gateway::MethodKind::Unary);
    pub const DELETE: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardItemRequest, xw_contracts::xiaowei::clipboard::DeletedClipboardEntities> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardDao.Delete", xw_gateway::MethodKind::Unary);
    pub const PURGE_ORDINARY_BATCH: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::PurgeClipboardEntitiesRequest, xw_contracts::xiaowei::clipboard::DeletedClipboardEntities> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardDao.PurgeOrdinaryBatch", xw_gateway::MethodKind::Unary);
    pub const CLEAR_HISTORY_BATCH: xw_gateway::binding::Method<xw_contracts::xiaowei::common::Empty, xw_contracts::xiaowei::clipboard::DeletedClipboardEntities> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardDao.ClearHistoryBatch", xw_gateway::MethodKind::Unary);
    pub const HASH_REFERENCED: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardEntityHashRequest, xw_contracts::xiaowei::clipboard::ClipboardEntityHashReference> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardDao.HashReferenced", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_storage_key_value_service {
    pub const GET: xw_gateway::binding::Method<xw_contracts::xiaowei::storage::KvKey, xw_contracts::xiaowei::storage::KvValue> =
        xw_gateway::binding::Method::new("xiaowei.storage.KeyValue.Get", xw_gateway::MethodKind::Unary);
    pub const SET: xw_gateway::binding::Method<xw_contracts::xiaowei::storage::KvEntry, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.storage.KeyValue.Set", xw_gateway::MethodKind::Unary);
    pub const DELETE: xw_gateway::binding::Method<xw_contracts::xiaowei::storage::KvKey, xw_contracts::xiaowei::storage::KvDeleted> =
        xw_gateway::binding::Method::new("xiaowei.storage.KeyValue.Delete", xw_gateway::MethodKind::Unary);
    pub const LIST: xw_gateway::binding::Method<xw_contracts::xiaowei::storage::KvPrefix, xw_contracts::xiaowei::storage::KvEntries> =
        xw_gateway::binding::Method::new("xiaowei.storage.KeyValue.List", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_storage_settings_service {
    pub const GET: xw_gateway::binding::Method<xw_contracts::xiaowei::common::Empty, xw_contracts::xiaowei::storage::SettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.storage.Settings.Get", xw_gateway::MethodKind::Unary);
    pub const UPDATE: xw_gateway::binding::Method<xw_contracts::xiaowei::storage::UpdateSettingsRequest, xw_contracts::xiaowei::storage::SettingsSnapshot> =
        xw_gateway::binding::Method::new("xiaowei.storage.Settings.Update", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_shortcuts_shortcuts_service {
    pub const APPLY: xw_gateway::binding::Method<xw_contracts::xiaowei::storage::ShortcutConfiguration, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.shortcuts.Shortcuts.Apply", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_storage_storage_service {
    pub const DATABASE_USAGE: xw_gateway::binding::Method<xw_contracts::xiaowei::common::Empty, xw_contracts::xiaowei::storage::DatabaseUsageResponse> =
        xw_gateway::binding::Method::new("xiaowei.storage.Storage.DatabaseUsage", xw_gateway::MethodKind::Unary);
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
