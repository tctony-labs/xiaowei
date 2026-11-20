# npm 依赖补丁

补丁由根 `pnpm-workspace.yaml` 的 `patchedDependencies` 按精确版本登记，`pnpm-lock.yaml` 保存补丁 hash 和依赖解析。补丁、配置与锁文件一起提交；安装时由 pnpm 自动应用，不手改 `node_modules` 或 lockfile。

## 修改与升级

1. 在仓库根执行 `pnpm patch <包名>@<版本>`，在 pnpm 输出的目录修改文件。编辑已有补丁时，默认以已应用补丁的内容为起点。
2. 执行 `pnpm patch-commit <编辑目录>`，让 pnpm 生成补丁并更新登记和锁文件。这里不执行 Git commit。
3. 运行 `pnpm install --frozen-lockfile`、对应补丁的回归测试和 `just check`；检查 diff 后一起提交补丁、workspace 配置、锁文件及相关清单／测试／说明。

升级依赖时先核对上游是否已解决补丁针对的问题，以及相关接口和行为是否改变。仍需补丁时，对新版本用上述流程重新生成，移除旧版本登记及不再使用的补丁。若上游已解决问题，移除补丁登记及文件，用 pnpm 更新锁文件，保留行为回归。不要只改补丁文件名或手工替换 lockfile 的 hash。

补丁测试放在 `patches/tests/`，通过 `pnpm test:patches` 运行，并纳入根 `pnpm test`。测试从实际消费方的包位置解析依赖；Pi 从 desktop 解析，根目录不重复声明依赖。测试命令启用 `--experimental-import-meta-resolve`，以消费方 URL 解析 ESM 公共入口。

## 补丁索引

- [`@earendil-works/pi-ai@1.5.2`](./@earendil-works__pi-ai@1.5.2.patch) 为通用 Responses 保留可复用的 API Key WebSocket。流式参数解析已由上游的增量解析器处理，回归仍检查原始 deltas、逐步解析结果和最终参数。[解析回归](./tests/pi-patch.test.mjs)
- [`@earendil-works/pi-schema@1.5.2`](./@earendil-works__pi-schema@1.5.2.patch) 和 [`@earendil-works/pi-telemetry@1.5.2`](./@earendil-works__pi-telemetry@1.5.2.patch) 的 npm 包只包含 `dist/`。移除指向未发布源码的 `source` 导出条件后，桌面 worker 和测试可继续使用 `source` 加载工作区内部包。

## Pi Responses WebSocket 补丁

`openai-responses.js` 保留通用请求构造、API Key 认证、消息来源和计价规则，按 transport 调用 `openai-codex-responses.js` 内的共享 WebSocket 传输入口。默认 SSE；auto 握手失败可回退 SSE，websocket／websocket-cached 不回退。sessionId 控制连接复用，auto／websocket-cached 在参数及历史前缀匹配时发送增量。URL 始终由既有 base URL 追加 `/responses` 得到，不要求 Codex 后端地址或登录 Token。

复用 Codex 传输时同时修复共享连接池的握手身份隔离、并发初次连接覆盖、显式清理后的连接归还，以及续接基线消费和成功终态校验。Codex 登录调用的已有请求／URL 规则保持；其 previous_response_not_found 重试增加开流前限制。新增入口为包内部运行时协作，应用仍只调用公开 Responses API，不直接依赖该 helper。

回归入口仍为 `pnpm test:patches`；[WebSocket 回归](./tests/pi-responses-websocket.test.mjs) 使用本地真实 HTTP upgrade 与 WebSocket 帧，覆盖复用、增量、工具／thinking、身份变化、并发、取消和回退边界。升级时除原工具 JSON 补丁外，还需逐项核对这些上游连接池及传输行为，不能只验证补丁能否应用。当前约束见 [LLM provider](../docs/llm-provider.md#responses-websocket)，真实代理验收见 [归档建设记录](../.agent/records/archived/2026-09-24-llm-provider.md#outcome)。
