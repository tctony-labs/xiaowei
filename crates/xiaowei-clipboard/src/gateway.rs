//! Gateway adapters reuse the caller's Service; they never open a second database.

use crate::{ClipboardData, Service};
use prost::{Message, Name};
use std::sync::Arc;
use xw_contracts::xiaowei::{clipboard as pb, common as c};
use xw_gateway::{
    binding::Method,
    event::{EventBackpressure, EventExportRegistration},
    ErrorCode, GatewayError, InvokeRegistration,
};

#[allow(dead_code)]
#[path = "gateway_bindings.rs"]
mod bindings;
use bindings::xiaowei_clipboard_clipboard_service as methods;

fn id(value: u64) -> crate::Result<i64> {
    i64::try_from(value)
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| "Invalid clipboard item ID".into())
}

fn item(value: crate::ClipboardItem) -> crate::Result<pb::ClipboardItem> {
    Ok(pb::ClipboardItem {
        id: value.id.parse()?,
        kind: match value.kind.as_str() {
            "text" | "largeText" => pb::ClipboardKind::Text,
            "image" => pb::ClipboardKind::Image,
            "file" => pb::ClipboardKind::File,
            _ => return Err("Unknown clipboard kind".into()),
        } as i32,
        preview_truncated: value.kind == "largeText",
        preview_text: value.text,
        paths: value.paths,
        width: value.width,
        height: value.height,
        created_at_ms: value.created_at,
        last_used_at_ms: value.last_used_at,
        use_count: value.use_count,
        favorite: value.favorite,
        remark: value.remark,
        category_id: value.category_id.map(|id| id.parse()).transpose()?,
    })
}

fn category(value: crate::ClipboardCategory) -> crate::Result<pb::ClipboardCategory> {
    Ok(pb::ClipboardCategory {
        id: value.id.parse()?,
        name: value.name,
        color: value.color,
    })
}

fn handler<Req, Res>(
    service: &Arc<Service>,
    method: &Method<Req, Res>,
    work: impl Fn(&Service, Req) -> crate::Result<Res> + Send + Sync + 'static,
) -> InvokeRegistration
where
    Req: Message + Default + Name + 'static,
    Res: Message + Default + Name + 'static,
{
    let service = service.clone();
    let work = Arc::new(work);

    method.handler(move |request, _| {
        let service = service.clone();
        let work = work.clone();

        async move {
            tokio::task::spawn_blocking(move || work(&service, request))
                .await
                .map_err(|_| GatewayError::new(ErrorCode::HandlerError, "clipboard task failed"))?
                .map_err(|error| GatewayError::new(ErrorCode::HandlerError, error.to_string()))
        }
    })
}

pub fn registrations(service: &Arc<Service>) -> Vec<InvokeRegistration> {
    vec![
        handler(service, &methods::LIST, |s, r| {
            let options = crate::ListOptions {
                query: r.query.unwrap_or_default(),
                favorites_only: r.favorites_only.unwrap_or(false),
                kind: match r.kind.map(pb::ClipboardKind::try_from).transpose()? {
                    None => None,
                    Some(pb::ClipboardKind::Image) => Some("image".into()),
                    Some(pb::ClipboardKind::File) => Some("file".into()),
                    _ => return Err("Unsupported clipboard kind filter".into()),
                },
                category_id: r.category_id.map(|v| id(v).map(|v| v.to_string())).transpose()?,
                limit: r.limit.unwrap_or(50),
                offset: r.offset.unwrap_or(0),
            };

            Ok(pb::ClipboardItems {
                items: s.list(&options)?.into_iter().map(item).collect::<crate::Result<_>>()?,
            })
        }),
        handler(service, &methods::GET, |s, r| {
            Ok(pb::OptionalItem {
                item: s.get(id(r.id)?)?.map(item).transpose()?,
            })
        }),
        handler(service, &methods::READ_TEXT, |s, r| match s.data(id(r.id)?)? {
            ClipboardData::Text(value) => Ok(pb::ReadTextResponse { text: value }),
            _ => Err("Clipboard item is not text".into()),
        }),
        handler(service, &methods::READ_IMAGE, |s, r| match s.data(id(r.id)?)? {
            ClipboardData::Image { data, .. } => Ok(pb::ReadImageResponse { png: data }),
            _ => Err("Clipboard item is not an image".into()),
        }),
        handler(service, &methods::COPY, |s, r| {
            s.copy(id(r.id)?)?;
            Ok(c::Empty {})
        }),
        handler(service, &methods::DELETE, |s, r| {
            Ok(pb::DeleteResponse {
                deleted: s.delete(id(r.id)?)?,
            })
        }),
        handler(service, &methods::SET_FAVORITE, |s, r| {
            Ok(pb::SetFavoriteResponse {
                updated: s.set_favorite(id(r.id)?, r.favorite)?,
            })
        }),
        handler(service, &methods::CLEAR_HISTORY, |s, _| {
            Ok(pb::ClearHistoryResponse {
                deleted_count: s.clear_history()? as u32,
            })
        }),
        handler(service, &methods::CATEGORIES, |s, _| {
            Ok(pb::ClipboardCategories {
                items: s
                    .categories()?
                    .into_iter()
                    .map(category)
                    .collect::<crate::Result<_>>()?,
            })
        }),
        handler(service, &methods::SAVE_CATEGORY, |s, r| {
            category(s.save_category(r.id.map(id).transpose()?, &r.name, &r.color)?)
        }),
        handler(service, &methods::DELETE_CATEGORY, |s, r| {
            s.delete_category(id(r.id)?)?;
            Ok(c::Empty {})
        }),
        handler(service, &methods::SET_REMARK, |s, r| {
            s.set_remark(id(r.id)?, &r.remark)?;
            Ok(c::Empty {})
        }),
        handler(service, &methods::EDIT_TEXT, |s, r| {
            item(s.edit_text(id(r.id)?, r.text)?)
        }),
        handler(service, &methods::SET_CATEGORY, |s, r| {
            s.set_category(id(r.id)?, r.category_id.map(id).transpose()?)?;
            Ok(c::Empty {})
        }),
    ]
}

pub fn events() -> Vec<EventExportRegistration> {
    vec![EventExportRegistration::typed::<pb::ClipboardChanged, c::Empty, _>(
        EventBackpressure::Coalesce,
        |_, _| true,
    )]
}
