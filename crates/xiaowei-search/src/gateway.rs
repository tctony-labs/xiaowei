//! One lazily initialized engine shared by lifecycle calls and Gateway handlers.

use crate::{Action, SearchEngine};
use std::sync::{Arc, Mutex, OnceLock};
use xw_contracts::xiaowei::{app, common as c, search as pb, system};
use xw_gateway::{ErrorCode, GatewayError, InvokeRegistration};

#[allow(dead_code)]
#[path = "gateway_bindings.rs"]
mod bindings;
use bindings::{
    xiaowei_app_app_service as app_methods, xiaowei_search_search_service as methods,
    xiaowei_system_system_service as system_methods,
};

#[derive(Default)]
pub struct SearchService {
    engine: OnceLock<Mutex<SearchEngine>>,
}

impl SearchService {
    pub fn engine(&self) -> &Mutex<SearchEngine> {
        self.engine.get_or_init(|| {
            let start = std::time::Instant::now();
            log::info!("Search index initialization started");
            let engine = SearchEngine::open_default();
            log::info!("Search index initialized in {} ms", start.elapsed().as_millis());
            Mutex::new(engine)
        })
    }

    pub fn record_usage(&self, id: &str) -> Result<(), GatewayError> {
        if let Some(engine) = self.engine.get() {
            engine
                .lock()
                .map_err(|_| error("Search engine unavailable"))?
                .record_usage(id);
        }

        Ok(())
    }
}

fn error(message: &str) -> GatewayError {
    GatewayError::new(ErrorCode::HandlerError, message)
}

pub fn registrations(service: Arc<SearchService>, development: bool) -> Vec<InvokeRegistration> {
    let query = service.clone();

    vec![
        methods::QUERY.handler(move |r, _| {
            let service = query.clone();
            async move {
                if r.query.len() > 4096 {
                    return Err(GatewayError::new(ErrorCode::InvalidArgument, "Search query too long"));
                }

                if r.query.trim().is_empty() {
                    return Ok(pb::SearchResults { hits: vec![] });
                }

                tokio::task::spawn_blocking(move || {
                    let engine = service
                        .engine()
                        .lock()
                        .map_err(|_| error("Search engine unavailable"))?;
                    Ok(pb::SearchResults {
                        hits: engine
                            .search_with_development(&r.query, development)
                            .into_iter()
                            .map(|hit| {
                                use pb::search_action::Action as WireAction;
                                let action = match hit.action {
                                    Action::CopyText(value) => WireAction::CopyText(value),
                                    Action::OpenUrl(value) => WireAction::OpenUrl(value),
                                    Action::LaunchApp(value) => WireAction::LaunchApp(value),
                                    Action::RunCommand(value) => WireAction::Command(match value.as_str() {
                                        "clipboard" => pb::SearchCommand::OpenClipboard,
                                        "toggle-system-theme" => pb::SearchCommand::ToggleTheme,
                                        "rs" => pb::SearchCommand::RestartDevelopment,
                                        _ => pb::SearchCommand::Unspecified,
                                    }
                                        as i32),
                                };
                                pb::SearchHit {
                                    id: hit.id,
                                    recency_key: hit.recency_key,
                                    title: hit.title,
                                    provider: hit.provider,
                                    label: hit.label,
                                    score: hit.score as f64,
                                    ranges: hit
                                        .ranges
                                        .into_iter()
                                        .map(|[start, end]| pb::HighlightRange { start, end })
                                        .collect(),
                                    action: Some(pb::SearchAction { action: Some(action) }),
                                }
                            })
                            .collect(),
                    })
                })
                .await
                .map_err(|_| error("Search task failed"))?
            }
        }),
        methods::RECORD_USAGE.handler(move |r, _| {
            let service = service.clone();
            async move {
                tokio::task::spawn_blocking(move || {
                    service.record_usage(&r.recency_key)?;
                    Ok(c::Empty {})
                })
                .await
                .map_err(|_| error("Usage task failed"))?
            }
        }),
        app_methods::READ_ICON.handler(|r, _| async move {
            tokio::task::spawn_blocking(move || app::AppIcon {
                png: crate::read_app_icon(std::path::Path::new(&r.path)),
            })
            .await
            .map_err(|_| error("Icon task failed"))
        }),
        system_methods::TOGGLE_THEME.handler(|_, _| async {
            tokio::task::spawn_blocking(crate::toggle_dark_mode)
                .await
                .map_err(|_| error("Theme task failed"))?
                .map(|dark| system::ToggleThemeResponse {
                    theme: if dark {
                        system::Theme::Dark
                    } else {
                        system::Theme::Light
                    } as i32,
                })
                .map_err(|message| error(&message))
        }),
    ]
}
