# Gateway TypeScript

本模块提供 TS host／client、typed 绑定及 native／Electron 适配。共同调用语义与线协议见 [Gateway](../README.md)，产品装配见 [main README](../../desktop/src/main/README.md#gateway-装配与生命周期)，页面调用见 [renderer README](../../desktop/src/renderer/README.md#gateway-业务调用)。

## 调用与绑定

TS 使用契约包的 service descriptor：`bindHandlers(service, handlers)` 创建完整服务注册项；同一服务跨 owner 时显式使用第三个参数 `{ partial: true }`，只注册所提供的方法，默认模式仍要求所有 unary handler。`bindClient(service, client)` 推导 unary 方法的请求和返回类型。每个 handler 收到保留原调用权限的 client，嵌套调用应使用它。

## 响应流

TS 原始 client 使用 `await client.stream(route, requestBytes, { signal })`；PB client 使用 `bindStreamClient(service, client)`，按方法调用后返回 typed `ResponseStream`。`bindStreamHandlers` 只生成 streaming 注册项，`bindHandlers` 只生成 unary 注册项，两者可合并后一次注册。handler 收到原权限 client 和 AbortSignal。

TS 编码前限制对象节点数、深度及字符串／bytes 预算，防止编码阶段无界分配；具体限制见 [typed binding](src/binding/index.ts)。字符串预算按每 UTF-16 单元最多 3 字节计。

`boundedByteQueue` 要求 await send；并发 send 显式失败。不合作的 pending factory／next／return 保留 admission 到真实退出，不能靠取消绕过配额。

## 事件与上下文

本地事件使用 `bindEvent`，远端使用含 `attach` 回调的 event export；host 负责远端 owner 重新出现时重新 attach persistent 订阅。

上下文使用私有 WeakMap 校验，反序列化对象或复制 trusted 字段无效；client transport 不接受 caller 元数据。

## Native 适配

宿主通过 `xiaowei-gateway/native` 的 `attachNative(host, name, endpoint, permissions?)` 接入。顺序为读取并校验 manifest → 预留全局 route／event 名称 → 绑定回调与来源上下文 → 激活 native → 原子发布。预留期间不暴露 route 或 event；失败会撤销预留并关闭新 endpoint，保留同名旧实例。返回的 handle 提供显式异步 `close()`；旧 handle 的关闭不会影响替换后的实例。

host 侧 handle.close 同时清理路由、caller token 和订阅。线协议与固定 manifest 要求见 [共同协议](../README.md#原生传输协议)。

## Electron 接入

`xiaowei-gateway/electron` 的 `attachElectron(host, ipcMain)` 管理 main 侧会话；创建窗口后、加载页面前调用 `register(webContents)`。只有已注册窗口的主 frame 可连接，信任与权限由宿主提供；请求不能指定权限或目标窗口。`target(context)` 从 handler 第三个参数取得窗口，缺失或过期上下文明确失败。

preload 使用 `xiaowei-gateway/preload` 的 `createPreloadBridge(ipcRenderer)`，通过 contextBridge 暴露 `request`／`listen` 两个普通方法；renderer 使用 `xiaowei-gateway/renderer` 的 `createRendererClient(window.gateway)`。单一请求通道 `xiaowei:gateway` 承载 invoke、subscribe／unsubscribe、stream open／next／cancel；事件走私有通道并定向到所属 frame。AsyncIterator 只在 renderer 内创建，不跨 contextBridge。默认入口及 renderer 运行依赖不包含 Node、Electron 或原生包。

宿主分配 session／generation，主 frame 实际提交导航（`did-navigate`）、renderer 退出、窗口销毁时清理订阅和流。不能在 `did-start-navigation` 清理：导航可能随后被窗口策略取消，旧 document 仍需继续使用原会话。提交导航后、新 preload 连接前清理旧会话；新连接分配新 generation，旧 bridge 仍被拒绝。每会话的订阅和流句柄均有上限，具体限制见 [Electron adapter](src/main/electron.ts)；取消尚未 ready 的订阅后，初始化槽位保留到 attach 结束，迟到成功立即关闭。订阅先安装本地 listener，再等待远端 ready。流 open 不预取，cancel 和窗口销毁会取消实际 native producer；typed handler 返回的源在首次 next 前取消也会被释放。
