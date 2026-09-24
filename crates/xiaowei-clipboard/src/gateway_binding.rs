// Generated Gateway bindings. Do not edit.
#[rustfmt::skip]
pub mod xiaowei_clipboard_clipboard_biz_service {
    pub const LIST: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardListOptions, xw_contracts::xiaowei::clipboard::ClipboardItems> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.List", xw_gateway::MethodKind::Unary);
    pub const GET: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardItemRequest, xw_contracts::xiaowei::clipboard::OptionalItem> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.Get", xw_gateway::MethodKind::Unary);
    pub const READ_TEXT: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardItemRequest, xw_contracts::xiaowei::clipboard::ReadTextResponse> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.ReadText", xw_gateway::MethodKind::Unary);
    pub const READ_IMAGE: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardItemRequest, xw_contracts::xiaowei::clipboard::ReadImageResponse> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.ReadImage", xw_gateway::MethodKind::Unary);
    pub const COPY: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardItemRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.Copy", xw_gateway::MethodKind::Unary);
    pub const SELECT: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardItemRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.Select", xw_gateway::MethodKind::Unary);
    pub const DELETE: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardItemRequest, xw_contracts::xiaowei::clipboard::DeleteResponse> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.Delete", xw_gateway::MethodKind::Unary);
    pub const SET_FAVORITE: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::FavoriteRequest, xw_contracts::xiaowei::clipboard::SetFavoriteResponse> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.SetFavorite", xw_gateway::MethodKind::Unary);
    pub const CLEAR_HISTORY: xw_gateway::binding::Method<xw_contracts::xiaowei::common::Empty, xw_contracts::xiaowei::clipboard::ClearHistoryResponse> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.ClearHistory", xw_gateway::MethodKind::Unary);
    pub const PURGE_ORDINARY: xw_gateway::binding::Method<xw_contracts::xiaowei::common::Empty, xw_contracts::xiaowei::clipboard::PurgeOrdinaryResponse> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.PurgeOrdinary", xw_gateway::MethodKind::Unary);
    pub const PURGE_EXPIRED: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::PurgeExpiredRequest, xw_contracts::xiaowei::clipboard::PurgeOrdinaryResponse> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.PurgeExpired", xw_gateway::MethodKind::Unary);
    pub const STORAGE_USAGE: xw_gateway::binding::Method<xw_contracts::xiaowei::common::Empty, xw_contracts::xiaowei::clipboard::ClipboardStorageUsage> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.StorageUsage", xw_gateway::MethodKind::Unary);
    pub const CATEGORIES: xw_gateway::binding::Method<xw_contracts::xiaowei::common::Empty, xw_contracts::xiaowei::clipboard::ClipboardCategories> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.Categories", xw_gateway::MethodKind::Unary);
    pub const SAVE_CATEGORY: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::SaveCategoryRequest, xw_contracts::xiaowei::clipboard::ClipboardCategory> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.SaveCategory", xw_gateway::MethodKind::Unary);
    pub const DELETE_CATEGORY: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardCategoryRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.DeleteCategory", xw_gateway::MethodKind::Unary);
    pub const SET_REMARK: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::SetRemarkRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.SetRemark", xw_gateway::MethodKind::Unary);
    pub const EDIT_TEXT: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::EditTextRequest, xw_contracts::xiaowei::clipboard::ClipboardItem> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.EditText", xw_gateway::MethodKind::Unary);
    pub const SET_CATEGORY: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::SetCategoryRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.SetCategory", xw_gateway::MethodKind::Unary);
    pub const OPEN_RESOURCE: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardResourceRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.OpenResource", xw_gateway::MethodKind::Unary);
    pub const REVEAL_RESOURCE: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardResourceRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.RevealResource", xw_gateway::MethodKind::Unary);
    pub const COPY_RESOURCE_PATH: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::CopyResourcePathRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.ClipboardBiz.CopyResourcePath", xw_gateway::MethodKind::Unary);
}
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
pub mod xiaowei_storage_storage_service {
    pub const DATABASE_USAGE: xw_gateway::binding::Method<xw_contracts::xiaowei::common::Empty, xw_contracts::xiaowei::storage::DatabaseUsageResponse> =
        xw_gateway::binding::Method::new("xiaowei.storage.Storage.DatabaseUsage", xw_gateway::MethodKind::Unary);
}
#[rustfmt::skip]
pub mod xiaowei_system_system_service {
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
