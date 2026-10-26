# 移动端 Rust 功能模块：接口决策与前置交付

关联 [iOS 客户端与设备授权](../2026-10-25-ios-client.md)；共享核心与桌面迁移见[客户端 Rust 迁移](client-rust-migration.md)。

## Why

共享 xw-api 已完成，但 iOS 与 Android 还需要自己的功能入口，以组合业务能力并持有运行资源。用户于 2026-10-26 明确要求类似桌面 xiaowei-rust 的移动 Rust 模块，不能仅建立 FFI 包；随后确认名称 xiaowei-mobile 并要求继续实施。

## What

独立前置切片覆盖移动 Rust 功能模块、Swift／Kotlin 薄绑定、真实请求与资源生命周期验证，以及 iOS 库编译。完整移动 App、平台存储、设备配对、内容加密和收藏同步不属于该切片；实施时 iOS 主事项为 proposed，独立实施采用 Plan 路径，不为此新建 record。用户随后于 2026-10-26 要求主事项进入 active，完整 iOS 接入按主 record 的任务拆分继续。

## How

已建立 `crates/xiaowei-mobile/` 功能 crate，组合 xw-api 并承担统一 API、独立 Tokio 运行环境、账号操作、检查点、普通调用、连接订阅及清理。`ffi/` 的 xiaowei-mobile-ffi 只适配同一组功能对象，生成 Swift／Kotlin 绑定；共享业务算法仍属于 xw-*，平台继续维护持久化与产品登录态。

命名采用 xiaowei-mobile 表达完整功能模块，ffi 子包采用 xiaowei-mobile-ffi；crates 目录已说明 Rust 归属。独立功能 crate 有可直接测试的资源 owner 和业务接入，绑定层不创建第二套网络／账号实例。

当前接口与行为只在包内维护：

- [模块入口与验证](../../../../crates/xiaowei-mobile/README.md)
- [统一接口、账号检查点与生命周期](../../../../crates/xiaowei-mobile/docs/interfaces.md)
- [语言适配、工具链与 iOS 库验证](../../../../crates/xiaowei-mobile/ffi/README.md)

### 实施中核对的适配边界

- xw-api 的 HTTP 业务失败以结构化 Error 返回；移动入口复用桌面适配的 BaseResponse 还原方式，保持普通 API 的 PB 业务失败契约，网络错误仍保留结构化分类。没有修改共享核心或在线协议。
- Kotlin 生成对象自带 AutoCloseable.close。跨语言显式资源清理命名 shutdown，pause 对应客户端 suspend，stop 对应订阅 close；Rust 功能接口仍使用 close／suspend。
- 操作结果与清理工作由功能 owner 保留；外部等待取消或对象丢弃时仍能取消并结算。账号刷新后先由宿主保存，再确认相同版本的检查点；取消后仍能收取新凭据。
- 首次交付上下文会区分确认同一账号操作的凭据与切换目标：同一会话保留检查点，另一目标则取消并等待旧工作。两类回归分别在修正前实际失败，修正后通过，覆盖尚未设置当前会话的恢复与切换。
- 会话切换改为异步，先等待旧范围工作结算再应用连接目标；切换、暂停和关闭共用生命周期锁，已启动的清理不依赖外部等待者寿命，防止旧恢复阶段覆盖新连接。
- iOS 原生 C／汇编依赖与 Swift 必须使用相同 SDK 和 deployment target；重复验收入口分别设置 SDKROOT 与测试目标，并将 linker warnings 作为失败，不以仅生成静态库代替实际链接。

## Outcome

功能模块、UniFFI 0.32.2 绑定和包内说明已实现。Swift 6 严格并发编译及 Kotlin/JVM 均已通过真实 HTTP／Go WS fixture 验证：请求成功、PB 业务失败、不重放、超时、执行前与执行中取消、检查点取消后的凭据保留、用户信息更新、登录退出、订阅及整体关闭；fixture 请求计数与 socket 关闭信号均通过。

iOS arm64 真机与模拟器目标的 Rust 库交叉编译、Swift SDK 模块及实际链接均通过，最终入口使用统一 SDK／测试版本，并将 linker warnings 视为失败。Swift 绑定以 Swift 6 严格并发和 warnings-as-errors 编译；Kotlin 使用独立缓存中的固定 JDK／编译器／JNA／coroutines。最新接口的双语言与两个 iOS 目标均已复验通过。跨语言运行测试在 macOS 命令行程序中执行；没有在 iPhone 或 iOS 模拟器中安装、启动或运行 App。

最终验证通过：12 项 Rust 集成测试，两个新包的全 target／feature Clippy（使用 `--no-deps`）、双语言真实链路、iOS 双目标编译／链接，以及完整 `just check`。未修改共享核心源码；首次扩展 Clippy 到依赖时遇到 xw-api 已有的 collapsible_if 和 let_and_return 两项告警，后续限定检查新包，不顺带改动原核心。Cargo.lock 保持原有包版本与校验值，新增包与 feature 依赖由 Cargo 解析；移动运行依赖不包含绑定生成 CLI 或 cargo metadata。手写代码显示宽度和本地文档链接已检查。

当前接口、接入和工具命令已沉淀到包内文档，独立实施 Plan 收尾删除。此前的 proposed 主事项已由用户明确要求转入 active，后续进展以主 record 为准；此前前置切片没有启动或重启桌面／移动 App。

尚未交付完整 iOS／Android App、Android ABI／JNA 平台验收、Keychain／Keystore、系统前后台产品行为或生成的移动业务消息包。宿主验证不代替上述平台验收；iOS 授权与同步的安全边界继续按主提案讨论。
