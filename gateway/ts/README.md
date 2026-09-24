# Gateway TypeScript

本模块提供 TS host／client、typed 绑定及 TS ↔ Rust napi／Worker MessagePort／Electron IPC 通信适配层。共同调用语义与线协议见 [Gateway](../README.md)，产品装配见 [main README](../../desktop/src/main/README.md#gateway-装配与生命周期)，页面调用见 [renderer README](../../desktop/src/renderer/README.md#gateway-业务调用)。

## 调用与绑定

TS 使用契约包的 service descriptor：`bindHandlers(service, handlers)` 创建完整服务注册项；同一服务跨 owner 时显式使用第三个参数 `{ partial: true }`，只注册所提供的方法，默认模式仍要求所有 unary handler。`bindClient(service, client)` 推导 unary 方法的请求和返回类型。每个 handler 收到保留原调用权限的 client，嵌套调用应使用它。

## 响应流

TS 原始 client 使用 `await client.stream(route, requestBytes, { signal })`；PB client 使用 `bindStreamClient(service, client)`，按方法调用后返回 typed `ResponseStream`。`bindStreamHandlers` 只生成 streaming 注册项，`bindHandlers` 只生成 unary 注册项，两者可合并后一次注册。handler 收到原权限 client 和 AbortSignal。

TS 编码前限制对象节点数、深度及字符串／bytes 预算，防止编码阶段无界分配；具体限制见 [typed binding](src/binding/index.ts)。字符串预算按每 UTF-16 单元最多 3 字节计。

`boundedByteQueue` 要求 await send；并发 send 显式失败。不合作的 pending factory／next／return 保留 admission 到真实退出，不能靠取消绕过配额。

## 事件与上下文

本地事件使用 `bindEvent`，远端使用含 `attach` 回调的 event export；host 负责远端 owner 重新出现时重新 attach persistent 订阅。

上下文使用私有 WeakMap 校验，反序列化对象或复制 trusted 字段无效；client transport 不接受 caller 元数据。

## TS ↔ Rust napi 通信适配层

宿主通过 `xiaowei-gateway/native` 的 `attachNative(host, name, endpoint, permissions?)` 接入。顺序为读取并校验 manifest → 预留全局 route／event 名称 → 绑定回调与来源上下文 → 激活 native → 原子发布。预留期间不暴露 route 或 event；失败会撤销预留并关闭新 endpoint，保留同名旧实例。返回的 handle 提供显式异步 `close()`；旧 handle 的关闭不会影响替换后的实例。

host 侧 handle.close 同时清理路由、caller token 和订阅。线协议与固定 manifest 要求见 [共同协议](../README.md#ts-与-rust-的-napi-通信协议)。

## Worker MessagePort 通信适配层

main 从 `xiaowei-gateway/worker-host` 导入 `attachWorker(host, name, worker)`，传入一个新建的专用 Node Worker；worker 从 `xiaowei-gateway/worker` 导入 `exposeWorkerEndpoint(parentPort, registrations)`。registration 可直接合并 `bindHandlers` 与 `bindStreamHandlers` 的返回值。main 是唯一全局 GatewayHost；worker 仅保存固定 manifest 和本地执行 endpoint，嵌套 unary／stream 一律经 main 路由并保留原 caller 权限。默认、renderer、preload 入口不引入 Node worker 代码。当前不支持事件导出、订阅或后台自主 client；订阅与事件 manifest 均明确拒绝。

worker 的 `ExecutionScope` 负责 unary 执行并发、超时、owner／caller 流配额与实际清理，复用 core 的 `openStream` 状态机。main 的远端 stream dispatcher 只保存连接关联和读取终态，不重复包 producer 状态机或计算 service 配额。流配额按所在 worker 计算，不是跨所有 worker 的全局配额。本地 main handler 共用另一执行 scope，保持跨本地 owner 的 caller 统计。

线程传控制对象和 PB Uint8Array，使用 structured clone，不转移 Buffer 底层内存。每条连接带随机 generation，回调上下文 token 由 main 随机创建并保存；worker 不能自行声明 trusted。子流在 main 保存自己的授权上下文，父 unary 返回后仍可继续 next／cancel。远端流逐条 pull，不预读；服务端终态主动通知 reader 并删除句柄，不积累 tombstone。

双向业务请求关联表上限 256，清理操作额外预留 32 个槽位，传输 payload 上限 64 MiB。握手／激活和请求接收确认等待 5 秒；接收端在授权及 route 契约校验后，通过一次 `accepted` 帧公布本次 unary timeout 或 openTimeout，通信等待随之调整为该预算加 1 秒，不用固定默认值覆盖 service 策略。main 为嵌套调用从已授权的路由查询只读执行策略；查询与发起执行之间不异步让出。每个请求只接受一次预算通知，仍有有限失联期限。next 等待 producer idle 加 1 秒；取消／关闭等待 1.5 秒。通信超时只代表等待已结束，不代表实际执行停止。service 自身的执行限制仍以 worker 为准；不合作的 factory／next／return 真实退出前继续占用 worker 执行许可。

接入顺序为 manifest → 名称预留 → endpoint 激活 → 原子发布。失败回收新 worker，不替换旧 owner。返回 handle 的 `close()` 幂等并复用同一 Promise：先停止新请求、结束调用等待，再请求 worker 清理；清理失败或超时明确报错，最终 terminate 专用 worker 并移除监听器。异常退出、损坏帧和 owner 替换会终结所有关联；旧 handle 不影响新 owner。不自动重启或重放。

源码 worker 回归运行 `pnpm --filter xiaowei-gateway test`；plain Node 构建验证运行 `pnpm --filter xiaowei-gateway test:worker-built`。LLM service 的产品 worker 入口与 Electron 构建已接线，业务范围和验收见 [LLM provider record](../../.agent/records/active/2026-09-24-llm-provider.md)。

## Electron 接入

`xiaowei-gateway/electron` 的 `attachElectron(host, ipcMain)` 管理 main 侧会话；创建窗口后、加载页面前调用 `register(webContents)`。只有已注册窗口的主 frame 可连接，信任与权限由宿主提供；请求不能指定权限或目标窗口。`target(context)` 从 handler 第三个参数取得窗口，缺失或过期上下文明确失败。

preload 使用 `xiaowei-gateway/preload` 的 `createPreloadBridge(ipcRenderer)`，通过 contextBridge 暴露 `request`／`listen` 两个普通方法；renderer 使用 `xiaowei-gateway/renderer` 的 `createRendererClient(window.gateway)`。单一请求通道 `xiaowei:gateway` 承载 invoke、subscribe／unsubscribe、stream open／next／cancel；事件走私有通道并定向到所属 frame。AsyncIterator 只在 renderer 内创建，不跨 contextBridge。默认入口及 renderer 运行依赖不包含 Node、Electron 或原生包。

宿主分配 session／generation，主 frame 实际提交导航（`did-navigate`）、renderer 退出、窗口销毁时清理订阅和流。不能在 `did-start-navigation` 清理：导航可能随后被窗口策略取消，旧 document 仍需继续使用原会话。提交导航后、新 preload 连接前清理旧会话；新连接分配新 generation，旧 bridge 仍被拒绝。每会话的订阅和流句柄均有上限，具体限制见 [Electron adapter](src/main/electron.ts)；取消尚未 ready 的订阅后，初始化槽位保留到 attach 结束，迟到成功立即关闭。订阅先安装本地 listener，再等待远端 ready。流 open 不预取，cancel 和窗口销毁会取消实际 native producer；typed handler 返回的源在首次 next 前取消也会被释放。
