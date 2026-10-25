# 桌面手动验收脚本

此目录存放需要显式执行的验收工具，不纳入 `pnpm --dir desktop test`。自动回归门禁及其辅助代码放在 [`../tests/`](../tests/README.md)，工具自身的自动测试同样使用本地 fixture，不依赖真实凭据。

需要真实 API Key、外部服务、应用实例或人工操作的验收入口放在这里，即使脚本内部包含自动断言，也不作为自动回归门禁。每个工具应说明前置条件、调用方式和副作用，由使用者显式运行；不要由安装、构建或自动测试入口间接触发。

可用本地 fixture 稳定验证的行为应加入 `desktop/tests/`，包括这些工具自身的参数、退出码和清理行为。工作区共用的开发／构建／测试编排工具继续放在根目录 `scripts/`。

## 当前开发实例

配套 Rust CLI 位于 [`desktop/inspect/`](../inspect/README.md)，通过当前工作区的 Unix socket 查询宿主状态或执行明确的显示／收起操作。统一入口为 `just inspect`，不会启动应用；本目录不再维护一份 Node CLI。

## 真实 LLM 调用

先构建 desktop 自身 worker；Gateway 通过源码条件加载：

```sh
pnpm --dir desktop build
```

配置格式和唯一加载器定义在 [`src/main/services/llm/config.ts`](../src/main/services/llm/config.ts)。应用默认保存到 `~/.xiaowei/models.json`，设置绝对路径 XIAOWEI_AGENT_HOME 后保存到该目录的 models.json；XIAOWEI_LLM_CONFIG 仍可指定绝对路径单独覆盖；脚本使用 --config 指定同一文件，或读取该环境变量，不自行寻找 Electron 数据目录。只接受 version: 1 的 providers／models／defaults 格式，旧 models 数组格式已移除，不维护独立测试格式。

先列出 UI 保存的模型引用，再选择调用：

```sh
pnpm --dir desktop exec tsx --conditions=source scripts/verify-llm.mjs --config /absolute/path/models.json --list
pnpm --dir desktop exec tsx --conditions=source scripts/verify-llm.mjs --config /absolute/path/models.json --model <本地模型ID> --mode complete
```

--list 显示提供方名称、模型显示名称、稳定模型 ID 和当前可用性，不输出凭据。apiKeyEnv 对应非空环境变量优先，否则回退文件 apiKey；两者没有值时不会发送请求。修改 UI 配置后再次运行脚本即可验证保存结果；脚本加载文件不写回、不更改应用正在使用的 worker。

脚本通过 Gateway 调用构建后的 LLM worker 与真实 API，不启动 Electron，只输出脱敏验证结果。

| 模式 | 验证内容 |
| --- | --- |
| `complete` | 文本、用量与唯一成功终态 |
| `cancel` | 首个文本增量后取消 |
| `thinking` | 推理增量、最终推理块及答案 |
| `cancel-thinking` | 首个推理增量后取消 |
| `tools` | echo 工具参数、历史回放及结果回传后的第二轮生成 |
| `image` | 发送内置有效 PNG，配置的 input 须包含 image |
| `catalog` | 通过 Gateway 拉取远端模型列表 |

工具结果由脚本固定提供，service 不执行工具。取消确认不等于上游停止计费；真实 Node worker 验证不能替代 Electron 应用包验收。

WebSocket 验收继续使用原有 `openai-responses` 配置与 base URL。提供方已开启 supportsWebSocket 且 transport 为 auto 时，脚本自动使用该默认值；无需修改文件。每次脚本执行生成独立 sessionId，工具两轮共用该 ID，以验证连接复用和增量续接。可用 `--transport websocket-cached` 强制 WebSocket 与增量续接，排除握手失败后 SSE 回退影响；`--transport sse` 则验证 HTTP。覆盖仅作用于本次脚本，不写回配置。缺少 sessionId 的产品调用不会跨请求复用连接，后续 agent 必须提供稳定的会话 ID。

## 上下文变化的最小适配验证

`verify-context-updates.mjs` 验证 Responses provider 中的有序变化通知，属于 02e 的接入实验。当前 PB 尚不支持系统更新，因此直接复用 worker 的模型转换和 provider 选择，不经过 Gateway／构建后的 worker，不启动应用。无需构建；通过源码条件运行：

```sh
pnpm --dir desktop exec tsx --conditions=source scripts/verify-context-updates.mjs --config /absolute/path/models.json
```

使用同一配置加载器；省略 `--model` 时选择配置的 defaults.modelRef，也可显式提供本地模型 ID。只接受 openai-responses。凭据仅用于选中模型的已配置接口，不输出、不写回。脚本固定使用 SSE、low reasoning（推理模型），请求输出上限为 2048 tokens、45 秒客户端超时且不重试，合计六次真实调用，会产生模型费用。代理可能移除请求的 token 上限或缓存参数；当前 sol 对应 CLIProxyAPI 就会移除这些字段，不能把客户端值当作上游保证，超时也不保证上游立即停止计费。

调用依次验证初始工具、新增、同名 schema 替换、移除与指令更新、无变化继续及新基线。仅发送合成内容，工具由脚本返回固定结果，无文件／进程工具副作用。失败以非零退出，输出脱敏状态；不会保存实验会话，也不会修改应用设置。基线重建是实验构造，不等于产品压缩已实现。

实验在内存模型上开启 supportsMidConvoSystemMessages，并关闭原生工具新增／搜索路径：变化通知放在消息中，tools 仍由 Pi 生成当前完整集合。它不证明原生工具声明增量、缓存收益或其他接口的兼容性。自动回归见 `tests/llm/context-adaptation.test.mjs`；结果与适用边界维护在 [Agent 同步设计](../../.agent/records/active/2026-09-28-agent-chat/model-types.md#最小适配实验2026-10-11)。
