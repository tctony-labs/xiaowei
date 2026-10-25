# Inspect 本地协议

协议名称为 `xiaowei-inspect`，当前版本 `1`。首版提供 macOS 开发／正式包及 Linux 开发实例的 Unix socket 入口；Windows 不启用。CLI 是短生命周期客户端，listener 归 Electron main；窗口隐藏不影响查询。

## 配对与路径

来源 `source` 包含 `kind` 和 `path`：

- `workspace`：开发 App 所在工作区根目录；`just inspect` 传入同一个工作区。
- `app`：正式 App bundle 根目录；App 从主可执行文件位置计算，CLI 从自身真实路径找到所属 `.app` 和 `Contents/Info.plist`。

来源路径通过文件系统 realpath 解析为规范绝对路径，保留实际大小写与 Unicode 编码，不从共享数据目录或任意 cwd 猜测。对 UTF-8 字节 `kind + NUL + path` 计算 SHA-256，使用 64 位小写十六进制名称：

```text
/tmp/xiaowei-<getuid()>/<sha256>.sock
```

两端通过同一组 [测试样例](../tests/fixtures/targets.json) 验证哈希。请求和响应继续比较完整 `source`，不只信任文件名。工作区或 App 移动后会形成新 endpoint，数据目录保持原样。PID、启动时间与随机 `instanceId` 描述这次运行，不参与数据隔离。

runtime 目录必须是当前用户拥有的真实目录，权限不向组或其他用户开放；App 创建时使用 `0700`，socket 使用 `0600`。CLI 也核对目录、socket 的所有权、类型与权限，拒绝符号链接和不安全的文件。App 启动时保护活 socket；仅在明确拒绝连接或文件消失、且 inode 未变化时恢复陈旧 owned socket，不覆盖普通文件。

## 帧与校验

一个连接发送一条 UTF-8 JSON 行请求并收到一条响应，单帧最多 1 MiB。请求示例：

```json
{
  "protocol": "xiaowei-inspect",
  "version": 1,
  "id": "unique-request-id",
  "source": { "kind": "workspace", "path": "/absolute/workspace" },
  "method": "launcher.show",
  "params": { "mode": "quick-chat" }
}
```

服务端拒绝未知请求字段、不匹配的协议或完整来源、未知方法及非法参数，然后才调用 owner。响应回传 `protocol`、`version`、`id`、`source` 与 `ok`；成功带 `result`，失败带 `error: { code, message }`。CLI 校验版本、请求 ID、完整来源和结果／错误结构，再将其呈现给调用者。

客户端连接、写入和读取共用五秒期限。服务端有完整请求接收和 handler 期限；写操作串行进入 owner，排队期间已过期的动作不会执行，读取不排在写操作后面。已开始的系统动作可能在超时或断开后完成，超时不意味着回滚；应重新查询实际状态，不盲目重放动作。

关闭时停止接入、丢弃尚未开始的动作并断开连接，重复关闭等待同一次完成。Node listener 关闭后移除 socket。检查入口初始化失败记录错误，App 的原启动流程继续。

## 首版方法

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `system.identify` | 无 | 代码来源、实例 ID、PID、App 版本、启动时间、App 路径、可执行文件、cwd、数据根目录 |
| `system.capabilities` | 无 | 运行实例的方法说明、参数、枚举与 `mutates` 标记 |
| `app.status` | 无 | 观测时间、实例、App／Launcher／焦点／Dock 状态、窗口和快捷键 |
| `window.list` | 无 | 包括隐藏窗口在内的 Electron 窗口快照 |
| `shortcut.list` | 无 | 配置绑定、系统实际注册与菜单暂停状态 |
| `launcher.show` | 必需的 `mode`：`search`、`clipboard`、`quick-chat` | owner 完成唤起并确认窗口可见、聚焦且模式匹配后的状态 |
| `launcher.hide` | 无 | 当前隐藏状态及独立的 `focusRestored` 结果 |

仅最后两项会修改窗口状态。`startedAtMs` 为基于主进程 uptime 推算的 Unix 毫秒启动时间；`observedAtMs` 为宿主开始采样的时间，快照不承诺跨 renderer／系统组件原子一致。窗口 ID 只在当前进程有效，坐标使用 Electron DIP。原生 Sparkle UI 不属于 Electron 窗口列表，其显隐通过 Dock owner 的原生窗口标记反映。

Dock 快照同时提供 `visible`、`desiredVisible`、`hideDeferred`、`updatePending` 和 `retryPending`，保留已有弹层和系统延迟规则。焦点快照只读取已有会话与当前前台 PID，不触发 capture。快捷键 `state` 为 `disabled`、`registered`、`suspended` 或 `unavailable`，不推断注册失败时由哪个应用占用。

`hide` 的 `focusRestored` 为 `true`、`false` 或 `null`；隐藏完成不代表焦点一定归还，现有防止抢走其他应用焦点的策略继续生效。

## 错误

| code | 含义 |
| --- | --- |
| `APP_NOT_RUNNING` | 对应 endpoint 不存在或拒绝连接 |
| `INVALID_SOURCE`、`UNSAFE_SOCKET` | 来源无效，或本地入口类型／所有权／权限不符合约定 |
| `VERSION_MISMATCH`、`SOURCE_MISMATCH` | 协议或代码来源不匹配 |
| `INVALID_REQUEST`、`INVALID_JSON`、`INVALID_PARAMS`、`UNKNOWN_METHOD` | 请求、帧或命令不合法 |
| `FRAME_TOO_LARGE` | 请求或响应超过大小上限 |
| `HANDLER_ERROR`、`APP_CLOSING` | owner 执行失败或应用正在退出 |
| `TIMEOUT`、`NO_RESPONSE`、`INVALID_RESPONSE`、`CONNECTION_FAILED` | 结果未在期限内确认、帧不完整或连接／响应无效 |

该接口不读取聊天、剪贴板正文或配置凭据，不执行任意 JS／SQL，也不开放通用业务 RPC。业务接口继续使用所属 owner 的 typed Gateway。
