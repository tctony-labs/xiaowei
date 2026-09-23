use crate::Result;
use xw_contracts::xiaowei::{clipboard as pb, common::Empty};
use xw_gateway::invoke::Client;

tokio::task_local! {
    pub(crate) static CALLER: Client;
}

use crate::gateway_binding::xiaowei_clipboard_clipboard_dao_service as methods;

#[derive(Clone)]
pub struct DaoClient(pub Client);

impl DaoClient {
    fn client(&self) -> Client {
        CALLER.try_with(Clone::clone).unwrap_or_else(|_| self.0.clone())
    }

    pub async fn capture(&self, request: pb::CaptureClipboardEntityRequest) -> Result<pb::ClipboardEntity> {
        Ok(methods::CAPTURE.call(&self.client(), request).await?)
    }

    pub async fn list(&self, request: pb::ClipboardListOptions) -> Result<Vec<pb::ClipboardEntity>> {
        Ok(methods::LIST.call(&self.client(), request).await?.entities)
    }

    pub async fn get(&self, id: u64) -> Result<Option<pb::ClipboardEntity>> {
        Ok(methods::GET
            .call(&self.client(), pb::ClipboardItemRequest { id })
            .await?
            .entity)
    }

    pub async fn touch(&self, id: u64, used_at_ms: i64) -> Result<()> {
        methods::TOUCH
            .call(&self.client(), pb::TouchClipboardEntityRequest { id, used_at_ms })
            .await?;
        Ok(())
    }

    pub async fn set_favorite(&self, id: u64, favorite: bool) -> Result<bool> {
        Ok(methods::SET_FAVORITE
            .call(&self.client(), pb::FavoriteRequest { id, favorite })
            .await?
            .updated)
    }

    pub async fn set_remark(&self, id: u64, remark: String) -> Result<()> {
        methods::SET_REMARK
            .call(&self.client(), pb::SetRemarkRequest { id, remark })
            .await?;
        Ok(())
    }

    pub async fn set_category(&self, id: u64, category_id: Option<u64>) -> Result<()> {
        methods::SET_CATEGORY
            .call(&self.client(), pb::SetCategoryRequest { id, category_id })
            .await?;
        Ok(())
    }

    pub async fn categories(&self) -> Result<Vec<pb::ClipboardCategory>> {
        Ok(methods::CATEGORIES.call(&self.client(), Empty {}).await?.items)
    }

    pub async fn save_category(&self, request: pb::SaveCategoryRequest) -> Result<pb::ClipboardCategory> {
        Ok(methods::SAVE_CATEGORY.call(&self.client(), request).await?)
    }

    pub async fn delete_category(&self, id: u64) -> Result<()> {
        methods::DELETE_CATEGORY
            .call(&self.client(), pb::ClipboardCategoryRequest { id })
            .await?;
        Ok(())
    }

    pub async fn edit_text(
        &self,
        request: pb::EditClipboardEntityTextRequest,
    ) -> Result<pb::EditClipboardEntityTextResponse> {
        Ok(methods::EDIT_TEXT.call(&self.client(), request).await?)
    }

    pub async fn delete(&self, id: u64) -> Result<pb::DeletedClipboardEntities> {
        Ok(methods::DELETE
            .call(&self.client(), pb::ClipboardItemRequest { id })
            .await?)
    }

    pub async fn purge_ordinary_batch(&self, cutoff_ms: i64) -> Result<pb::DeletedClipboardEntities> {
        Ok(methods::PURGE_ORDINARY_BATCH
            .call(&self.client(), pb::PurgeClipboardEntitiesRequest { cutoff_ms })
            .await?)
    }

    pub async fn clear_history_batch(&self) -> Result<pb::DeletedClipboardEntities> {
        Ok(methods::CLEAR_HISTORY_BATCH.call(&self.client(), Empty {}).await?)
    }

    pub async fn hash_referenced(&self, hash: String) -> Result<bool> {
        Ok(methods::HASH_REFERENCED
            .call(&self.client(), pb::ClipboardEntityHashRequest { hash })
            .await?
            .referenced)
    }
}
