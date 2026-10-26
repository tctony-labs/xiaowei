use crate::{Client, Error, RequestContext, Result, contract::Method};
use futures_util::StreamExt;

// Drop also records cancellation when the embedding runtime discards an RPC future.
struct RequestLog {
    path: String,
    origin: String,
    timeout_ms: u32,
    started: std::time::Instant,
    status: Option<u16>,
    code: Option<i32>,
    message: Option<String>,
    failure: Option<Error>,
    source: Option<String>,
    outcome: &'static str,
}

impl Drop for RequestLog {
    fn drop(&mut self) {
        let mut metadata = format!(
            "HTTP request completed method=POST path={} timeout_ms={} server={} duration_ms={}",
            self.path,
            self.timeout_ms,
            self.origin,
            self.started.elapsed().as_millis(),
        );
        if let Some(status) = self.status {
            metadata.push_str(&format!(" http_status={status}"));
        }
        if let Some(code) = self.code {
            metadata.push_str(&format!(" code={code}"));
        }
        if let Some(message) = &self.message {
            metadata.push_str(&format!(" msg={message:?}"));
        }
        if let Some(error) = &self.failure {
            metadata.push_str(&format!(
                " error_code={} error_msg={:?}",
                error.code, error.message
            ));
        }
        if let Some(source) = &self.source {
            metadata.push_str(&format!(" error={source:?}"));
        }
        match self.outcome {
            "success" | "cancelled" => log::debug!("{metadata}"),
            "business" if !matches!(self.code, Some(10008 | 10009)) => log::warn!("{metadata}"),
            "http"
                if self
                    .status
                    .is_some_and(|status| (400..500).contains(&status)) =>
            {
                log::warn!("{metadata}");
            }
            _ => log::error!("{metadata}"),
        }
    }
}

impl Client {
    pub(crate) async fn http_request(
        &self,
        method: &Method,
        payload: &[u8],
        context: &RequestContext,
        server: &str,
        token: Option<&str>,
    ) -> Result<Vec<u8>> {
        let body = method.encode_json(payload)?;
        let timeout_ms = context.options.timeout_ms.unwrap_or(15_000);
        let origin = url::Url::parse(server)
            .map(|url| url.origin().ascii_serialization())
            .unwrap_or_default();
        let mut log = RequestLog {
            path: method.path.clone(),
            origin,
            timeout_ms,
            started: std::time::Instant::now(),
            status: None,
            code: None,
            message: None,
            failure: None,
            source: None,
            outcome: "cancelled",
        };
        log::debug!(
            "HTTP request started method=POST path={} timeout_ms={} server={}",
            log.path,
            log.timeout_ms,
            log.origin
        );
        let mut request = self
            .http
            .post(format!("{server}{}", method.path))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body);
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        let work = async {
            let response = request.send().await.map_err(|error| {
                log.source = Some(format!("{:?}", error.without_url()));
                Error::unavailable("无法连接服务器，请稍后重试")
            })?;
            log.status = Some(response.status().as_u16());
            if response.status() != reqwest::StatusCode::OK {
                return Err(Error {
                    category: "http",
                    ..Error::unavailable("无法连接服务器，请稍后重试")
                });
            }
            let too_large = || Error {
                category: "response_too_large",
                ..Error::unavailable("无法连接服务器，请稍后重试")
            };
            if response.content_length().is_some_and(|size| size > 65_536) {
                return Err(too_large());
            }
            let mut stream = response.bytes_stream();
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| {
                    log.source = Some(format!("{:?}", error.without_url()));
                    Error::unavailable("无法连接服务器，请稍后重试")
                })?;
                if bytes.len() + chunk.len() > 65_536 {
                    return Err(too_large());
                }
                bytes.extend_from_slice(&chunk);
            }
            if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                log.code = value
                    .get("code")
                    .and_then(|value| value.as_i64())
                    .and_then(|v| i32::try_from(v).ok());
                log.message = value
                    .get("msg")
                    .and_then(|value| value.as_str())
                    .map(String::from);
            }
            method.decode_json(&bytes)
        };
        let result = tokio::select! {
            biased;
            _ = self.closed.cancelled() => Err(Error::cancelled()),
            _ = context.cancellation.cancelled() => Err(Error::cancelled()),
            result = async {
                if timeout_ms == 0 {
                    work.await
                } else {
                    tokio::time::timeout(std::time::Duration::from_millis(timeout_ms.into()), work)
                        .await.map_err(|_| Error {
                            category: "timeout",
                            ..Error::unavailable("无法连接服务器，请稍后重试")
                        })?
                }
            } => result,
        };
        log.outcome = result
            .as_ref()
            .map(|_| "success")
            .unwrap_or_else(|error| error.category);
        log.failure = result.as_ref().err().cloned();
        result
    }
}
