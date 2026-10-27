use std::{collections::BTreeMap, time::Duration, time::Instant};

use futures_util::StreamExt;
use reqwest::{Client, Url, header};
use serde::Deserialize;
use serde_json::json;
use xw_agent_runtime::tools::{
    AgentTool, RecoveryPolicy, ToolContext, ToolError, ToolFuture, ToolOutput,
};
use xw_agent_types::ToolDeclaration;

const MAX_BYTES: usize = 10 * 1024 * 1024;
const MAX_CHARACTERS: usize = 100_000;
const MAX_REDIRECTS: usize = 10;

pub struct WebFetch {
    pub(crate) client: Client,
}

impl WebFetch {
    pub fn new() -> Result<Self, ToolError> {
        let client = Client::builder()
            .timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("XiaoWei/WebFetch")
            .build()
            .map_err(|_| ToolError::Failed("无法创建网页客户端".into()))?;
        Ok(Self { client })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    url: String,
    prompt: String,
}

pub(crate) fn validate_url(raw: &str) -> Result<Url, ToolError> {
    if raw.len() > 2000 {
        return Err(ToolError::Failed("URL 最多 2000 字节".into()));
    }
    let url = Url::parse(raw).map_err(|_| ToolError::Failed("URL 无效".into()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(ToolError::Failed("URL 仅支持 http/https".into()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ToolError::Failed("URL 不得包含凭据".into()));
    }
    if !url.host_str().is_some_and(|host| host.contains('.')) {
        return Err(ToolError::Failed("URL 主机名必须包含点".into()));
    }
    Ok(url)
}

pub(crate) fn permitted_redirect(current: &Url, target: &Url) -> bool {
    let host = |url: &Url| {
        url.host_str()
            .map(|host| host.strip_prefix("www.").unwrap_or(host).to_owned())
    };
    current.scheme() == target.scheme()
        && current.port_or_known_default() == target.port_or_known_default()
        && target.username().is_empty()
        && target.password().is_none()
        && host(current).is_some()
        && host(current) == host(target)
}

#[derive(PartialEq, Eq)]
enum ContentClass {
    Html,
    Text,
    Binary,
}

fn classify(content_type: &str) -> ContentClass {
    let main = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match main.as_str() {
        "text/html" => ContentClass::Html,
        "application/json"
        | "application/xml"
        | "application/javascript"
        | "application/x-yaml"
        | "application/x-www-form-urlencoded" => ContentClass::Text,
        value if value.starts_with("text/") => ContentClass::Text,
        _ => ContentClass::Binary,
    }
}

pub(crate) fn truncate(content: &str) -> (String, bool) {
    let mut chars = content.chars();
    let head = chars.by_ref().take(MAX_CHARACTERS).collect::<String>();
    if chars.next().is_none() {
        return (head, false);
    }
    (
        format!(
            "{head}\n\n[... Content truncated due to length, original size: {} bytes]",
            content.len()
        ),
        true,
    )
}

impl AgentTool for WebFetch {
    fn declaration(&self) -> ToolDeclaration {
        ToolDeclaration {
            name: "WebFetch".into(),
            description: concat!(
                "Fetch an HTTP(S) URL and extract information using the supplied prompt. ",
                "HTML is converted to Markdown; HTTP is upgraded to HTTPS. ",
                "Redirects to another host, scheme or port require an explicit new call. ",
                "Binary content such as PDF and images is not supported.",
            )
            .into(),
            parameters_json: json!({
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Fully formed HTTP(S) URL"},
                    "prompt": {"type": "string", "description": "Information to extract"}
                },
                "required": ["url", "prompt"],
                "additionalProperties": false
            })
            .to_string(),
            constrained_sampling_json: None,
        }
    }

    fn rules(&self) -> BTreeMap<String, String> {
        BTreeMap::from([(
            "tool.WebFetch".into(),
            "已知 URL 时使用 WebFetch，prompt 明确要提取的信息。跨域跳转需用返回目标再次调用；\
             不支持的二进制内容应如实说明，不把抓取失败当作页面事实。"
                .into(),
        )])
    }

    fn recovery_policy(&self) -> RecoveryPolicy {
        RecoveryPolicy::CancelPending
    }

    fn execute<'a>(
        &'a self,
        arguments: &'a str,
        context: &'a dyn ToolContext,
    ) -> ToolFuture<'a, ToolOutput> {
        Box::pin(async move {
            let args: Arguments = serde_json::from_str(arguments)
                .map_err(|_| ToolError::Failed("WebFetch 需要 url 和 prompt 字符串".into()))?;
            let mut current = validate_url(&args.url)?;
            if current.scheme() == "http" {
                current
                    .set_scheme("https")
                    .map_err(|_| ToolError::Failed("URL 无法升级为 HTTPS".into()))?;
            }
            let cancel = context.cancellation();
            let started = Instant::now();
            for hop in 0..=MAX_REDIRECTS {
                let response = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err(ToolError::Cancelled),
                    result = self.client.get(current.clone())
                        .header(header::ACCEPT, "text/markdown, text/html, */*")
                        .send() => result.map_err(network_error)?,
                };
                let status = response.status().as_u16();
                if response.status().is_redirection() {
                    let target = response
                        .headers()
                        .get(header::LOCATION)
                        .and_then(|value| value.to_str().ok())
                        .and_then(|value| current.join(value).ok())
                        .ok_or_else(|| ToolError::Failed("重定向目标无效或缺失".into()))?;
                    if !permitted_redirect(&current, &target) {
                        log::debug!("WebFetch redirect status={status} hops={hop}");
                        return Ok(ToolOutput {
                            text: format!(
                                "REDIRECT DETECTED (HTTP {status})\nOriginal URL: {current}\n\
                                 Redirect URL: {target}\n\n请显式使用目标 URL 再次调用 WebFetch。"
                            ),
                            metadata_json: Some(
                                json!({"webfetch": {
                                    "url": args.url, "final_url": current.as_str(),
                                    "status": status, "content_type": "", "bytes": 0,
                                    "duration_ms": started.elapsed().as_millis() as u64,
                                    "truncated": false, "redirected": true, "binary": false
                                }})
                                .to_string(),
                            ),
                        });
                    }
                    if hop == MAX_REDIRECTS {
                        return Err(ToolError::Failed("网页重定向超过 10 次".into()));
                    }
                    current = target;
                    continue;
                }

                let content_type = response
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or_default()
                    .to_owned();
                if response
                    .content_length()
                    .is_some_and(|size| size > MAX_BYTES as u64)
                {
                    return Err(ToolError::Failed("网页响应超过 10 MiB".into()));
                }
                let mut stream = response.bytes_stream();
                let mut body = Vec::new();
                loop {
                    let chunk = tokio::select! {
                        biased;
                        _ = cancel.cancelled() => return Err(ToolError::Cancelled),
                        chunk = stream.next() => chunk,
                    };
                    let Some(chunk) = chunk else { break };
                    let chunk = chunk.map_err(network_error)?;
                    if body.len().saturating_add(chunk.len()) > MAX_BYTES {
                        return Err(ToolError::Failed("网页响应超过 10 MiB".into()));
                    }
                    body.extend_from_slice(&chunk);
                }
                let fetched_ms = started.elapsed().as_millis() as u64;
                let class = classify(&content_type);
                let bytes = body.len();
                log::debug!("WebFetch fetched status={status} bytes={bytes} fetch_ms={fetched_ms}");
                let (text, truncated) = if class == ContentClass::Binary {
                    (format!("Unsupported binary content: {content_type}"), false)
                } else {
                    let text = String::from_utf8_lossy(&body);
                    let markdown = if class == ContentClass::Html {
                        htmd::HtmlToMarkdown::new()
                            .convert(&text)
                            .map_err(|_| ToolError::Failed("网页 HTML 转换失败".into()))?
                    } else {
                        text.into_owned()
                    };
                    let (content, truncated) = truncate(&markdown);
                    let text = context.extract_text(content, args.prompt).await?;
                    (text, truncated)
                };
                let duration_ms = started.elapsed().as_millis() as u64;
                log::debug!(
                    "WebFetch settled status={status} bytes={bytes} duration_ms={duration_ms} \
                     extraction_ms={} binary={} truncated={truncated}",
                    duration_ms.saturating_sub(fetched_ms),
                    class == ContentClass::Binary
                );
                return Ok(ToolOutput {
                    text: format!(
                        "Fetched {current} (HTTP {status}, {content_type}, {bytes} bytes, \
                         {duration_ms} ms)\n\n{text}"
                    ),
                    metadata_json: Some(json!({"webfetch": {
                        "url": args.url, "final_url": current.as_str(), "status": status,
                        "content_type": content_type, "bytes": bytes, "duration_ms": duration_ms,
                        "truncated": truncated, "redirected": false,
                        "binary": class == ContentClass::Binary
                    }}).to_string()),
                });
            }
            unreachable!("redirect limit handled above")
        })
    }
}

fn network_error(error: reqwest::Error) -> ToolError {
    ToolError::Failed(if error.is_timeout() {
        "网页请求超时".into()
    } else {
        "网页网络请求失败".into()
    })
}
