# 协议

跨端 HTTP API 的协议定义放在此目录，目前只提供服务端健康检查 `GET /healthz`，返回 `{"status":"ok"}`。

Electron 与 Rust 的本地 stdio JSON-RPC 属于桌面内部协议，当前仅支持 `runtime.info`，不作为远程业务 API。
