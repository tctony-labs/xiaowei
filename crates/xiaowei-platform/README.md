# xiaowei-platform

向 TS 提供通用原生系统能力的 napi 包裹层，当前提供 macOS 前台进程查询和焦点快照。

## 模块边界

```text
TS main → xiaowei-platform（napi 包裹层）→ xw-platform
Rust 调用方 → xw-platform
```

- [xw-platform](../xw-platform/README.md) 提供通用原生系统能力的具体实现，Rust 调用方直接依赖它。
- xiaowei-platform 只负责 napi 导出、类型转换、错误转换与原生资源所有权适配，不包含业务逻辑或第二份平台实现。
- 沿用仓库入口与绑定目录约定：`src/lib.rs` 仅重导出所需的 xw-platform 能力，`napi/` 承载绑定 crate 和 npm 入口。Rust 调用方不通过该包裹层使用平台实现。
- 不提供 Gateway service、owner 或 endpoint，不生成 Gateway binding。TS main 按需直接调用公开 napi 接口；renderer 仍通过宿主的 Gateway 业务入口调用能力，不直接加载原生模块。

例如，捕获前台窗口、查询目标有效性和激活指定窗口属于平台能力；何时归还焦点、恢复哪个窗口、如何轮换 Dock 窗口属于调用方策略。已有 TS `System.HideWindow` 是宿主业务接口，不因调用平台能力而迁入本模块。

## 接口与资源所有权

接口遵循 [xw-platform 的无状态接口约定](../xw-platform/README.md#无状态接口)。napi 不额外维护会话、历史窗口或全局句柄表；状态由 TS 调用方持有。

需要持有原生引用时，向调用方返回显式拥有和释放的快照或句柄。调用方在使用完毕、取消或退出时释放资源，释放后的操作明确失败；napi GC 仅作为释放兜底。资源所有权适配不承担业务会话生命周期决策。

通用目录、workspace、构建与发布规则见 [Rust 原生模块开发](../README.md)。

## 焦点接口

- `frontmostProcess()`：读取当前前台进程 ID；不可用时返回 null。
- `captureFocus()`：异步捕获应用实例与可用的 AX 窗口引用，返回独立快照或 null；不请求辅助功能权限。
- 快照的 `processId` 标识来源进程。`restore(expectedProcess)` 仅在前台仍是预期进程或快照所属应用时请求恢复；目标应用退出返回 false，窗口引用失效时降级为应用激活。返回 true 表示系统接受请求，调用方仍需查询确认。
- `isFrontmost()`：异步查询快照目标是否位于前台。`release()` 幂等释放引用；释放后 restore 和 isFrontmost 拒绝调用。

快照的应用引用用于区分应用实例，不依赖裸 PID 查找并重新启动应用。AX 调用在线程池执行并设置消息超时。其他平台暂返回空快照和空前台进程，不承诺跨平台焦点恢复。
