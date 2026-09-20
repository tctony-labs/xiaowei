// Generated Gateway bindings. Do not edit.
#[rustfmt::skip]
pub mod xiaowei_clipboard_clipboard_service {
    pub const LIST: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardListOptions, xw_contracts::xiaowei::clipboard::ClipboardItems> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.List", xw_gateway::MethodKind::Unary);
    pub const GET: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardItemRequest, xw_contracts::xiaowei::clipboard::OptionalItem> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.Get", xw_gateway::MethodKind::Unary);
    pub const READ_TEXT: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardItemRequest, xw_contracts::xiaowei::clipboard::ReadTextResponse> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.ReadText", xw_gateway::MethodKind::Unary);
    pub const READ_IMAGE: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardItemRequest, xw_contracts::xiaowei::clipboard::ReadImageResponse> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.ReadImage", xw_gateway::MethodKind::Unary);
    pub const COPY: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardItemRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.Copy", xw_gateway::MethodKind::Unary);
    pub const DELETE: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardItemRequest, xw_contracts::xiaowei::clipboard::DeleteResponse> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.Delete", xw_gateway::MethodKind::Unary);
    pub const SET_FAVORITE: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::FavoriteRequest, xw_contracts::xiaowei::clipboard::SetFavoriteResponse> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.SetFavorite", xw_gateway::MethodKind::Unary);
    pub const CLEAR_HISTORY: xw_gateway::binding::Method<xw_contracts::xiaowei::common::Empty, xw_contracts::xiaowei::clipboard::ClearHistoryResponse> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.ClearHistory", xw_gateway::MethodKind::Unary);
    pub const CATEGORIES: xw_gateway::binding::Method<xw_contracts::xiaowei::common::Empty, xw_contracts::xiaowei::clipboard::ClipboardCategories> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.Categories", xw_gateway::MethodKind::Unary);
    pub const SAVE_CATEGORY: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::SaveCategoryRequest, xw_contracts::xiaowei::clipboard::ClipboardCategory> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.SaveCategory", xw_gateway::MethodKind::Unary);
    pub const DELETE_CATEGORY: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardCategoryRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.DeleteCategory", xw_gateway::MethodKind::Unary);
    pub const SET_REMARK: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::SetRemarkRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.SetRemark", xw_gateway::MethodKind::Unary);
    pub const EDIT_TEXT: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::EditTextRequest, xw_contracts::xiaowei::clipboard::ClipboardItem> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.EditText", xw_gateway::MethodKind::Unary);
    pub const SET_CATEGORY: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::SetCategoryRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.SetCategory", xw_gateway::MethodKind::Unary);
    pub const OPEN_RESOURCE: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardResourceRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.OpenResource", xw_gateway::MethodKind::Unary);
    pub const REVEAL_RESOURCE: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::ClipboardResourceRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.RevealResource", xw_gateway::MethodKind::Unary);
    pub const COPY_RESOURCE_PATH: xw_gateway::binding::Method<xw_contracts::xiaowei::clipboard::CopyResourcePathRequest, xw_contracts::xiaowei::common::Empty> =
        xw_gateway::binding::Method::new("xiaowei.clipboard.Clipboard.CopyResourcePath", xw_gateway::MethodKind::Unary);
}
