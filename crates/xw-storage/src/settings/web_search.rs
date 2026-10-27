use std::collections::BTreeMap;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use proto_desktop_rs::xiaowei::desktop::{
    update_settings_request::Change, GetWebSearchRuntimeConfigRequest, KvEntry, KvKey,
    SettingsChanged, SettingsSnapshot, WebSearchProvider, WebSearchRuntimeConfig,
    WebSearchSettings,
};
use serde::{Deserialize, Serialize};

use super::{SettingsError, SettingsService};

const KEY: &str = "setting.webSearch";
const XOR_KEY: &[u8] = b"xwwx";

#[derive(Serialize, Deserialize)]
#[serde(default)]
pub(super) struct Stored {
    selected_provider: String,
    keys: BTreeMap<String, String>,
}

impl Default for Stored {
    fn default() -> Self {
        Self {
            selected_provider: "bing".into(),
            keys: BTreeMap::new(),
        }
    }
}

fn provider(id: i32) -> Result<&'static str, SettingsError> {
    match WebSearchProvider::try_from(id) {
        Ok(WebSearchProvider::Bing) => Ok("bing"),
        Ok(WebSearchProvider::Tavily) => Ok("tavily"),
        Ok(WebSearchProvider::Brave) => Ok("brave"),
        Ok(WebSearchProvider::Serper) => Ok("serper"),
        _ => Err(SettingsError::InvalidArgument("Invalid search provider")),
    }
}

fn id(provider: &str) -> WebSearchProvider {
    match provider {
        "tavily" => WebSearchProvider::Tavily,
        "brave" => WebSearchProvider::Brave,
        "serper" => WebSearchProvider::Serper,
        _ => WebSearchProvider::Bing,
    }
}

fn obfuscate(plain: &str) -> String {
    STANDARD.encode(
        plain
            .bytes()
            .enumerate()
            .map(|(index, byte)| byte ^ XOR_KEY[index % XOR_KEY.len()])
            .collect::<Vec<_>>(),
    )
}

fn reveal(encoded: &str) -> Result<String, SettingsError> {
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| SettingsError::Operation("Saved search key is invalid".into()))?;
    let bytes = bytes
        .into_iter()
        .enumerate()
        .map(|(index, byte)| byte ^ XOR_KEY[index % XOR_KEY.len()])
        .collect();
    String::from_utf8(bytes)
        .map_err(|_| SettingsError::Operation("Saved search key is invalid".into()))
}

impl Stored {
    pub(super) fn snapshot(&self) -> WebSearchSettings {
        let selected = id(&self.selected_provider);
        let configured_providers = [
            WebSearchProvider::Tavily,
            WebSearchProvider::Brave,
            WebSearchProvider::Serper,
        ]
        .into_iter()
        .filter(|value| {
            let name = provider(*value as i32).expect("known provider");
            self.keys.get(name).is_some_and(|value| !value.is_empty())
        })
        .map(|value| value as i32)
        .collect::<Vec<_>>();
        let effective = if selected == WebSearchProvider::Bing
            || configured_providers.contains(&(selected as i32))
        {
            selected
        } else {
            WebSearchProvider::Bing
        };
        WebSearchSettings {
            selected_provider: selected as i32,
            effective_provider: effective as i32,
            configured_providers,
        }
    }
}

impl SettingsService {
    async fn load_web_search(&self) -> Result<Stored, SettingsError> {
        let value = self
            .database
            .meta_get(KvKey { key: KEY.into() })
            .await
            .map_err(|_| SettingsError::Operation("Search settings read failed".into()))?;
        value
            .json
            .map(|json| {
                serde_json::from_str(&json)
                    .map_err(|_| SettingsError::Operation("Search settings are invalid".into()))
            })
            .unwrap_or_else(|| Ok(Stored::default()))
    }

    pub async fn web_search_runtime_config(
        &self,
        request: GetWebSearchRuntimeConfigRequest,
    ) -> Result<WebSearchRuntimeConfig, SettingsError> {
        let _guard = self.updates.lock().await;
        let stored = self.load_web_search().await?;
        let snapshot = stored.snapshot();
        if request.provider.is_none() && snapshot.selected_provider != snapshot.effective_provider {
            log::debug!(
                "Search provider fallback selected={} effective={} reason=missing_key",
                snapshot.selected_provider,
                snapshot.effective_provider
            );
        }
        let current = request.provider.unwrap_or(snapshot.effective_provider);
        let name = provider(current)?;
        let api_key = if name == "bing" {
            None
        } else {
            Some(reveal(
                stored
                    .keys
                    .get(name)
                    .filter(|value| !value.is_empty())
                    .ok_or(SettingsError::InvalidArgument(
                        "Search provider key is not configured",
                    ))?,
            )?)
        };
        Ok(WebSearchRuntimeConfig {
            provider: current,
            api_key,
        })
    }

    pub(super) async fn update_web_search(
        &self,
        mut snapshot: SettingsSnapshot,
        change: Change,
    ) -> Result<SettingsSnapshot, SettingsError> {
        let mut stored = self.load_web_search().await?;
        match change {
            Change::WebSearchProvider(value) => {
                stored.selected_provider = provider(value)?.into();
            }
            Change::WebSearchApiKey(value) => {
                let name = provider(value.provider)?;
                if name == "bing" {
                    return Err(SettingsError::InvalidArgument(
                        "Bing does not use an API key",
                    ));
                }
                let key = value.api_key.trim();
                if key.len() > 4096 || !key.bytes().all(|byte| byte.is_ascii_graphic()) {
                    return Err(SettingsError::InvalidArgument("Invalid search API key"));
                }
                if key.is_empty() {
                    stored.keys.remove(name);
                    if stored.selected_provider == name {
                        stored.selected_provider = "bing".into();
                    }
                } else {
                    stored.keys.insert(name.into(), obfuscate(key));
                }
            }
            _ => unreachable!("only search changes reach this method"),
        }
        let json = serde_json::to_string(&stored)
            .map_err(|_| SettingsError::Operation("Search settings encode failed".into()))?;
        self.database
            .meta_set(KvEntry {
                key: KEY.into(),
                json,
            })
            .await
            .map_err(|_| SettingsError::Operation("Search settings save failed".into()))?;
        snapshot.web_search = Some(stored.snapshot());
        if let Some(publish) = self.publish.lock().unwrap().as_ref() {
            publish(SettingsChanged {
                snapshot: Some(snapshot.clone()),
            });
        }
        Ok(snapshot)
    }
}
