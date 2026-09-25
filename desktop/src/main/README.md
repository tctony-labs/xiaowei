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
│   ├── llm/               # worker 内的 Pi provider 与宿主接线
│   ├── launcher/gateway.ts
│   ├── shortcuts/         # 全局快捷键注册与 Gateway owner
│   └── system/gateway.ts  # Electron 系统与调用方窗口能力
└── resources/app-icons/  # 图标缓存与协议
```

## Host 与 worker 的代码组织

service 使用 worker 执行业务时，按执行位置划分目录，让路径直接表达运行边界。位于 `src/main/` 下只表示由 main 装配，不表示全部在主线程执行。

```text
services/<service>/
├── host.ts              # main：创建、挂载、关闭 worker，提供宿主调用入口
├── <host-module>.ts     # 按需保留宿主专属的输入读取或系统接线
├── shared/              # 两侧实际共用的类型、纯校验与编解码
└── worker/
    ├── index.ts         # worker 启动入口，初始化并暴露 endpoint
    ├── gateway.ts       # 业务 handler 注册与接入
    └── <business>.ts    # 业务实现、状态及依赖适配
```

- **host 负责装配，worker 负责业务执行。** host 持有 worker 生命周期和 Gateway 接入；业务状态、执行配额、超时、流状态与取消清理由 worker 内的 service／endpoint 持有，不在 host 重复维护。宿主输入读取与业务处理分开，文件按职责命名。
- **通过通信边界调用。** host 不导入 `worker/` 的实现，只创建构建后的 worker 入口并通过 Gateway 调用；worker 不导入宿主实现或 Electron，需要宿主能力时通过 Gateway 调用对应 owner。线程传输机制复用 Gateway，不在 service 内另建业务消息通道。
- **shared 只放两侧真正共用的代码。** 两侧都可依赖 `shared/`，它不反向依赖 host／worker，不加载业务 SDK，不读取文件、环境变量或调用 Electron。类型、纯数据校验和编解码可放入其中；只被一侧使用的实现留在该侧，不为对称而抽取共享层。
- **共用代码不等于共享状态。** shared 模块在两侧各自执行；跨线程传递可序列化数据，不依赖可变对象引用或模块单例在两侧共享。状态归属和更新语义由所属 service 明确。
- **入口与构建保持一致。** worker 的 `index.ts` 只做启动接线，构建配置显式指定独立产物，host 使用该产物路径。移动源码时同步更新构建、调用方、测试和验收工具，验证构建后的 worker 能实际加载并完成 Gateway 调用。

该结构只用于实际使用 worker 的 service；按需创建目录，不为普通 service 预建 host／worker／shared 空层。各 service 的具体文件职责、协议和业务行为维护在所属模块文档或 record。

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
