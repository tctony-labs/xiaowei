# xw-platform

通用原生系统能力的 Rust 实现，不依赖 Electron、Gateway、napi、项目配置或业务模块，可由本项目及其他 Rust 项目直接依赖。

当前提供应用名称、应用图标、系统主题、macOS 焦点快照和 Sparkle 原生框架桥接能力。`focus` 公开平台分派与快照类型，`macos/focus.rs` 承载应用激活和 AX 窗口操作；调用不申请辅助功能权限。

## 调用与复用

Rust 调用方直接依赖本 crate，使用其公开接口。TS 通过 [xiaowei-rust](../xiaowei-rust/README.md) 的 napi 入口调用；两者的职责和依赖关系统一见 [模块边界](../xiaowei-rust/docs/platform.md#模块边界)。

## 无状态接口

- 方法只依据显式参数及当前系统状态执行，不在模块内记住“上一次窗口”、焦点历史、业务窗口列表或轮换游标。
- 捕获结果由调用方持有，后续操作显式传入目标；恢复时机、目标选择、取消与降级策略归调用方。
- 需要保留原生引用时，以具有明确所有权和释放行为的快照或句柄表达，不通过全局句柄表代管业务会话。资源生命周期管理不等于维护业务状态。
- 返回能力、目标有效性及操作结果，不隐藏权限不足、目标失效等情况，不替调用方决定业务动作。

平台实现按目标系统隔离，通用内存管理约定见 [Rust 原生模块开发](../README.md#实现易错点)。

## Sparkle 桥接

`sparkle::SparkleUpdater` 动态加载调用方提供的 `Sparkle.framework`，持有标准原生 UI controller 和 delegate；从主应用 `Info.plist` 读取 feed、公钥及周期设置。它不决定发布地址、版本、更新策略或应用退出流程，这些由宿主配置与调用方负责。

创建、检查、恢复安装和释放均在 macOS 主线程执行。安装 delegate 返回延期，并持有 Sparkle 的 continuation；调用方处理 `prepare-install` 通知、关闭自身资源后，再调用 `resume_install()`。其他通知用于记录可用版本、无更新和错误。非 macOS 返回不支持，不提供替代更新实现。

同一 delegate 也接入标准 user driver：更新 UI 即将显示、模态提示显示时发送 `ui-visible`，模态提示关闭、更新会话／检查周期结束时发送 `ui-hidden`。这些通知供宿主管理可见窗口状态；窗口创建、内容和关闭仍由 Sparkle 管理。交互式检查的“正在检查”窗口没有对应的显示回调，由宿主在发起检查时登记可见状态，并在会话结束时清除。

手动检查遇到正在执行的后台检查时，复用标准 user driver 展示前台 loading，继续等待同一检查；重复手动调用只聚焦已有 UI。找到更新后将结果窗口带到前台，无更新或失败时展示 Sparkle 原生结果提示，不把正常忙碌当作调用错误。取消前台等待会关闭 loading，原后台检查仍按 Sparkle 的流程继续；释放 controller 时清理尚未结束的前台等待窗口。`manual-check-waiting`、`manual-check-focused`、`manual-check-cancelled` 和结果事件记录交接过程。
