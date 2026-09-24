# Electron main 模块组织

本文规定 main 的模块职责、Gateway 接入与生命周期。业务实现和迁移取舍维护在所属模块或 record，不在这里维护各业务的进度与测试流水。

## 职责规则

- `index.ts` 只计算构建产物目录并调用应用启动流程。
- `app/` 负责应用身份、单实例、启动／退出、菜单、路径、日志和 Gateway 装配；不承载业务规则。
- `windows/` 负责 BrowserWindow、布局、焦点、显隐、导航限制和窗口生命周期。
- `services/` 按能力归属组织 TS owner。Electron 系统能力归 `system/`，全局快捷键归 `shortcuts/`，窗口关联的搜索呈现归 `launcher/`。“由设置变更触发”不构成单独的 settings 模块。
- Rust 模块持有其业务状态、后台任务和设置订阅。TS 不代管原生模块的业务调度，也不为其读取数据库、处理记录或统计文件。
- 前端及跨模块业务调用统一通过 proto service／Gateway；preload 只承载 Gateway bridge，不新增 raw 业务 IPC 或专用跨语言副作用回调。
- `resources/` 负责渲染资源协议和缓存；资源 URL 不作为绕过 Gateway 的业务命令入口。
- 每个 owner 提供显式接入与关闭入口。导入模块不自动注册服务或启动后台任务；不预建空目录、通用 utils 或多层转发包装。

## 目录

```text
desktop/src/main/
├── index.ts
├── app/
│   ├── bootstrap.ts       # 应用启动、退出、单实例
│   ├── gateway.ts         # host、owner、Rust napi endpoint 装配
│   ├── paths.ts           # 应用路径
│   ├── logging.ts         # 日志接线
│   └── menu.ts            # 应用菜单
├── windows/
│   ├── launcher.ts
│   ├── launcher-shortcuts.ts # 唤起、焦点与定位
│   ├── navigation.ts      # 导航限制
│   └── settings.ts
├── services/
│   ├── launcher/gateway.ts
│   ├── shortcuts/         # 全局快捷键注册与 Gateway owner
│   └── system/gateway.ts  # Electron 系统与调用方窗口能力
└── resources/app-icons/  # 图标缓存与协议
```

需要接入 Pi 时，将 TS provider 放在 `services/llm/`，由 `app/gateway.ts` 装配和关闭；目录本身不是独立 npm package，不提前创建占位模块。

## Gateway 装配与生命周期

- 业务 handler 模块的命名与边界遵循 [Gateway 接入约定](../../../gateway/README.md#接入约定)。
- main 只创建一个 host。业务 endpoint 复用其模块持有的实例，不能因接入 Gateway 再建一份业务状态。
- 先接入依赖，再初始化业务模块、启动模块的后台服务；退出时先关闭 Electron 请求入口，再关闭消费者，最后关闭 Storage 等依赖。初始化失败也要关闭尚未完全接入的实例。
- `app/gateway.ts` 仅调用原生实例的初始化／启动／关闭入口，不判断设置值或编排业务动作。剪贴板的 settings 订阅和 Select 全部在 Rust，main 不再设置剪贴板专属 TS owner。
- Settings 的校验、持久化和变更协调由 Rust SettingsService 负责；需要立即执行的宿主能力通过 Gateway 调用对应 owner，失败后恢复旧值。owner 不读写设置存储。
- handler 的嵌套调用保留原 client 的权限与调用上下文，不能换成高权限宿主 client。窗口目标通过 `electron.target(context)` 取得，不接受请求传入窗口 ID；无有效窗口的调用必须失败。
- 清理支持重复调用并等待同一次关闭完成。模块后台任务和订阅先停止，再释放 endpoint 与临时资源，避免访问已关闭依赖。
- preload／renderer 的构建路径从入口传入窗口模块，不能按窗口源码目录推导。

## 开发重载与导航

Launcher 与设置窗口统一使用 `windows/navigation.ts`：开发态只允许当前完整 URL（含 query）的原地址重载，供 Vite fallback reload 使用；其他目标仍拒绝。生产态继续拒绝页面发起的导航；新窗口与 webview 始终禁用。

导航尝试可能被取消，不能在 `did-start-navigation` 销毁当前 document 的 Gateway 会话。主 frame 实际提交导航后清理旧会话，再由新 preload 连接；renderer 退出和窗口销毁也清理。前端不能自动重连复活过期会话。组件热更新边界见 [renderer README](../renderer/README.md#react-热更新边界)。
