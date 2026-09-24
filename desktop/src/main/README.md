# Electron main 模块组织

本文规定 `desktop/src/main/` 的职责与目标布局。应用、窗口、资源和现有 TS service 已按目录归位；System.OpenUrl 已独立注册；文件系统能力契约、剪贴板职责迁回 Rust 与 LLM 接入仍待后续切片实施。

## 职责规则

- `index.ts` 是启动入口，负责调用应用启动流程。应用装配、窗口管理和业务实现各归自己的模块。
- 前端需要调用的能力通过 `contracts/proto/xiaowei/` 中的 service 定义，由 Gateway 提供 typed 调用。preload 只承载 Gateway bridge；业务模块不新增独立 IPC channel 或 `contextBridge` API。
- `app/` 创建唯一 GatewayHost，接入 Electron ingress、TS owner 和 Rust endpoint，处理启动失败回收与退出顺序。装配层不实现业务 handler，不判断剪贴板记录类型，不统计业务文件。
- `windows/` 管理 BrowserWindow、焦点、布局、导航限制、快捷键唤起与窗口生命周期。涉及调用方窗口的服务通过 Gateway 的调用上下文定位窗口，不能使用前端自行传入的窗口 ID。
- `services/` 按领域组织 TS 实现。通用系统能力由 `system/` 封装 Electron API；领域服务间调用走 Gateway，复用 proto 契约。模块内部的纯函数可直接调用，不为每个辅助函数创建 RPC。
- Rust 模块持有其业务数据和文件生命周期。TS 不因为方便访问 Node 文件 API 就接管 Rust 业务；缺少能力时在对应 owner 增加接口。
- `resources/` 管理渲染资源协议与缓存。资源 URL 只提供资源读取，不能作为绕过 proto service 的业务命令入口。
- 每个服务提供显式注册与清理入口。导入模块不自动注册服务、启动定时器或发起模型请求。跨模块通过入口使用能力，不导入其他模块的内部实现；按实际职责拆文件，不预建空目录、通用 `utils/` 或多层转发包装。

## Gateway 装配与生命周期

- owner 和 endpoint 由应用装配层显式接入唯一 host；业务实例由所属模块持有，通信入口复用该实例，不因注册 endpoint 重复创建业务状态。
- 后台调用使用 endpoint 激活后取得的宿主身份；处理请求时发起的嵌套调用保留原调用身份与权限，不改用高权限宿主 client 绕过调用方限制。
- 启动失败时回收已经接入的资源；正常退出时先关闭外部请求入口，再停止业务监听、注销 owner 并关闭连接。按依赖关系先关闭消费者，再关闭其依赖的服务，避免后台任务访问已关闭资源。
- 清理入口应支持重复调用并等待同一次关闭完成。具体装配和清理顺序由 [app/gateway.ts](app/gateway.ts) 维护。

## 目标目录

```text
desktop/src/main/
├── index.ts
├── app/
│   ├── bootstrap.ts       # 应用身份、启动与退出、单实例
│   ├── gateway.ts         # GatewayHost 与各 owner 的装配
│   ├── paths.ts           # 应用目录配置
│   ├── logging.ts         # main、renderer、native 日志接线
│   ├── menu.ts            # 应用菜单
│   └── shortcuts.ts       # 全局快捷键注册、替换与回滚
├── windows/
│   ├── launcher.ts        # Launcher 创建、模式、显隐、定位
│   ├── launcher-shortcuts.ts # 窗口定位与唤起算法，可独立测试
│   └── settings.ts        # 设置窗口创建、复用与关闭
├── services/
│   ├── system/            # 打开路径、定位文件、打开 URL 等系统能力
│   ├── launcher/          # Launcher proto handler、搜索结果上下文
│   ├── clipboard/         # 仅剩需要调用方窗口的桌面交互适配
│   ├── settings/          # 设置变更的 Electron 副作用接线
│   └── llm/               # Pi 调用、事件转换与 Gateway service
└── resources/
    └── app-icons/         # 图标 URL、协议响应和磁盘缓存
```

各 service 内先按需要建立 `gateway.ts`（契约绑定与注册）和实现文件；例如 LLM 的 `provider.ts` 调用 Pi。只有实现复杂度实际需要时再拆请求、事件或模型目录文件。目录不是独立 npm package，依赖仍由 desktop 管理。

## 当前实现与待迁移边界

- 根 `index.ts` 只计算构建产物目录并调用 `app/bootstrap.ts`。preload 和 renderer 路径由入口传给窗口模块，不能按窗口源码所在目录推导。
- `app/bootstrap.ts` 保留应用身份、单实例、日志安装、启动与退出接线；菜单和全局快捷键分别位于 `app/menu.ts`、`app/shortcuts.ts`。
- `windows/launcher.ts` 持有 Launcher 窗口、模式和退出状态；`windows/launcher-shortcuts.ts` 保留可独立测试的定位／唤起算法。`windows/settings.ts` 持有设置窗口并负责复用和关闭。
- `app/gateway.ts` 装配现有 owner 和资源协议，保持失败回收与关闭顺序；设置副作用由 `services/settings/effects.ts` 提供，快捷键和登录项失败处理保持原有语义。
- 原 `search.ts` 移到 `services/launcher/gateway.ts`，其注册的是 Launcher service；搜索核心仍归 Rust。HTTP(S) 打开通过原调用 client 调用 System.OpenUrl；应用打开、系统设置 URL 和写剪贴板暂保留宿主回调，待相应契约切片处理。
- 图标缓存和资源协议位于 `resources/app-icons/cache.ts`、`protocol.ts`，保留一周过期、不透明 URL 和按需读取行为。
- 剪贴板旧 TS 实现先归位到 `services/clipboard/gateway.ts`、`files.ts`、`storage.ts`。这只是目录整理，尚未达到薄桌面适配的最终边界：资源解析、文本导出、占用统计、保留期限清理及调度仍需迁入 Rust。
- `services/system/gateway.ts` 独立注册 System.OpenUrl，持有 HTTP(S) 校验和 Electron shell 调用，不依赖剪贴板初始化。app/gateway.ts 负责装配与失败／退出清理；原生搜索 endpoint 继续独立提供 System.ToggleTheme。新增路径打开／定位契约后，剪贴板 Rust owner 再通过 Gateway 调用。
- 最终 `services/clipboard/` 只保留需要调用方窗口的 Select 适配，协调 Rust Copy、隐藏窗口与粘贴；`files.ts`、`storage.ts` 随 Rust 迁移删除。
- `services/llm/` 尚未创建，不预建空目录。

当前 preload 已只暴露 Gateway；现有 `System` service 包含 Rust 的 ToggleTheme 和 TS 的 OpenUrl。扩展时沿用一个 proto service，按方法注册不同 owner，避免重复注册。打开文件、定位文件等方法尚未定义，实施时遵循业务契约维护流程。

## 跨语言调用与所有权

剪贴板资源打开链路为 renderer → ClipboardBiz（Rust）→ System（TS）→ Electron shell。嵌套调用保留原 Gateway client／调用权限；临时导出文件由剪贴板 owner 持有和清理，应用临时根路径由装配层提供。不能在打开动作刚返回时就删除外部程序还需要读取的文件。

占用统计由 ClipboardBiz.StorageUsage 汇总自身附件大小与 Storage 提供的数据库大小。Storage 负责数据库文件及 WAL／SHM 的信息，剪贴板模块不自行打开数据库或推导其路径。现有对外口径是“整个共享数据库及剪贴板附件”，迁移须保持该口径；精准分摊数据库空间属于另一个需求。

LLM 调用链路为 Rust agent → LLM proto service（TS）→ Pi。请求、响应流及取消由 Gateway 连接；凭据获取和 Pi 细节在服务端处理。main 的装配层只负责创建和关闭服务。

## 顺序与验证

1. 已整理现有 main 的应用、窗口与资源目录，保留业务行为，同步测试导入及文档路径。30 个 desktop Node 测试、3 个 Gateway 桌面测试、2 个生命周期／Select 测试、`just check` 和 desktop 构建通过。当前工作区没有运行实例，窗口唤起、设置窗口复用和退出仍待用户启动后验收。
2. 已拆出 TS System.OpenUrl；后续扩展必要 System 契约，并把剪贴板资源处理、统计与业务调度迁回对应 Rust owner。先定义缺失契约，再迁 handler；验证 TS↔Rust 调用、失败、临时文件清理和统计口径，构建受影响的 napi 包。
3. 在上述规则下逐步实现 `services/llm/`，先本地可控模型响应，再 Gateway 跨语言联调。

一次实施一个切片。涉及视觉的变化仍走 Storybook 确认；目录整理不引入视觉变化。桌面冷启动由用户执行，已有实例重启遵循工作区运行规则。
