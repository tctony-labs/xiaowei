// Generated Gateway bindings. Do not edit.
#[rustfmt::skip]
pub mod xiaowei_desktop_clipboard_biz_service {
    pub const LIST: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ClipboardListOptions, proto_desktop_rs::xiaowei::desktop::ClipboardItems> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.List", xw_gateway::MethodKind::Unary);
    pub const GET: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ClipboardItemRequest, proto_desktop_rs::xiaowei::desktop::OptionalItem> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.Get", xw_gateway::MethodKind::Unary);
    pub const READ_TEXT: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ClipboardItemRequest, proto_desktop_rs::xiaowei::desktop::ReadTextResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.ReadText", xw_gateway::MethodKind::Unary);
    pub const READ_IMAGE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ClipboardItemRequest, proto_desktop_rs::xiaowei::desktop::ReadImageResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.ReadImage", xw_gateway::MethodKind::Unary);
    pub const COPY: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ClipboardItemRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.Copy", xw_gateway::MethodKind::Unary);
    pub const SELECT: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ClipboardItemRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.Select", xw_gateway::MethodKind::Unary);
    pub const DELETE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ClipboardItemRequest, proto_desktop_rs::xiaowei::desktop::DeleteResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.Delete", xw_gateway::MethodKind::Unary);
    pub const SET_FAVORITE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::FavoriteRequest, proto_desktop_rs::xiaowei::desktop::SetFavoriteResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.SetFavorite", xw_gateway::MethodKind::Unary);
    pub const CLEAR_HISTORY: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::ClearHistoryResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.ClearHistory", xw_gateway::MethodKind::Unary);
    pub const PURGE_ORDINARY: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::PurgeOrdinaryResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.PurgeOrdinary", xw_gateway::MethodKind::Unary);
    pub const PURGE_EXPIRED: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::PurgeExpiredRequest, proto_desktop_rs::xiaowei::desktop::PurgeOrdinaryResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.PurgeExpired", xw_gateway::MethodKind::Unary);
    pub const STORAGE_USAGE: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::ClipboardStorageUsage> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.StorageUsage", xw_gateway::MethodKind::Unary);
    pub const CATEGORIES: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::ClipboardCategories> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.Categories", xw_gateway::MethodKind::Unary);
    pub const SAVE_CATEGORY: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::SaveCategoryRequest, proto_desktop_rs::xiaowei::desktop::ClipboardCategory> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.SaveCategory", xw_gateway::MethodKind::Unary);
    pub const DELETE_CATEGORY: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ClipboardCategoryRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.DeleteCategory", xw_gateway::MethodKind::Unary);
    pub const SET_REMARK: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::SetRemarkRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.SetRemark", xw_gateway::MethodKind::Unary);
    pub const EDIT_TEXT: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::EditTextRequest, proto_desktop_rs::xiaowei::desktop::ClipboardItem> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.EditText", xw_gateway::MethodKind::Unary);
    pub const SET_CATEGORY: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::SetCategoryRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.SetCategory", xw_gateway::MethodKind::Unary);
    pub const OPEN_RESOURCE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ClipboardResourceRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.OpenResource", xw_gateway::MethodKind::Unary);
    pub const REVEAL_RESOURCE: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::ClipboardResourceRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.RevealResource", xw_gateway::MethodKind::Unary);
    pub const COPY_RESOURCE_PATH: xw_gateway::binding::Method<proto_desktop_rs::xiaowei::desktop::CopyResourcePathRequest, ()> =
        xw_gateway::binding::Method::new("xiaowei.desktop.ClipboardBiz.CopyResourcePath", xw_gateway::MethodKind::Unary);
}
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
}
#[rustfmt::skip]
pub mod xiaowei_desktop_storage_service {
    pub const DATABASE_USAGE: xw_gateway::binding::Method<(), proto_desktop_rs::xiaowei::desktop::DatabaseUsageResponse> =
        xw_gateway::binding::Method::new("xiaowei.desktop.Storage.DatabaseUsage", xw_gateway::MethodKind::Unary);
}
