# Go 服务端

独立 HTTP 服务，目前只提供健康检查。Go 版本见 [go.mod](go.mod)。

安装 Go 和 just 后，在仓库根目录运行：

```sh
just server
```

默认监听 `127.0.0.1:8080`，可通过环境变量 `XIAOWEI_LISTEN_ADDR` 修改；不自动加载 `.env`。按 `Ctrl+C` 停止。

另开终端验证：

```sh
curl http://127.0.0.1:8080/healthz
```

返回 `{"status":"ok"}` 表示服务可用。
