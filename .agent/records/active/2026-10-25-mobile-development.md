# Flutter 移动客户端与设备授权

## Why

剪贴板收藏同步需要端到端加密，服务器无法直接读取同步内容。首台客户端需要生成内容密钥，后续客户端需要通过可信授权获得密钥；登录服务器与取得解密能力是两个独立步骤。

用户无法让两台桌面设备同时在场，但可以携带手机。因此引入 iOS 客户端作为随身授权设备，不要求旧电脑同时参与。2026-10-27 用户提出手机创建密钥作为候选想法，并明确要求评估；初始化端尚未定案，不将该想法记作已确认需求。设备配对不能只按“两台桌面同时在线”设计。

用户于 2026-10-25 明确要求启动本 record，随后确认采用 SwiftUI，并要求评估将 TS 的 xwapi 和 WebSocket 迁往 Rust，以便桌面与 iOS 共用。共享核心与移动 Rust 模块已按独立前置任务实施；2026-10-26 用户明确要求本事项进入 active 并拆分任务，开始按 record + Plans 推进完整 iOS 接入。iOS 工程与运行基线的结果见 Outcome。

2026-11-16 用户明确排除 RN，并以长期共享 iOS／Android UI 为目标，最终确认采用 Flutter。现有 SwiftUI 工程改作迁移验收基线；后续移动产品界面统一使用 Flutter，共享 Rust 业务核心继续复用。2026-11-20 按用户要求将本 record 与关联计划统一改名为 `mobile-development`，保留原记录日期和实施进度。

## What

首期目标是一个 iOS／Android 共享 Flutter UI 的最小移动客户端，覆盖账号登录与恢复、密钥保管、首次配对和手机授权新电脑。先完成 Flutter 接入及现有能力迁移，再推进授权与通用加密同步。2026-10-27 确定的单服务器范围继续生效，沿用现有服务器地址，不将多服务器作为前置要求。通用加密同步与设备授权先于剪贴板业务接入；首期不要求手机提供收藏列表。

已确认的整体顺序与边界：

1. 先完成单服务器的密钥初始化与手机授权闭环，再建立与业务内容无关的客户端／服务端加密同步机制。
2. 再在该机制之上实现剪贴板收藏同步；普通剪贴板历史留在本机。
3. 首期按同一服务器、同一账号、一个同步库及多台可信设备设计；多服务器库归属、密钥共享、数据转发和逐服务器续传不在当前范围，也不预建扩展层。
4. 同步内容在客户端加密和解密，服务器不持有明文内容密钥；手机是可信客户端，不是服务端解密代理。

本事项承载 Flutter 双平台工程、既有能力迁移与授权接入，以及完成该链路所必需的桌面／服务端集成。通用同步协议保持跨平台、与业务无关；收藏数据模型和完整收藏同步实现属于后续范围。

首期完成标准：

- Flutter iOS／Android 工程可重复构建；分别通过目标平台实际运行验证登录、安全存储、重启恢复、会话失效与前后台行为，不能用已有 SwiftUI 或 macOS/JVM 结果替代。现有桌面账号管理行为保持，本事项仅验收同一服务器下的新同步能力。
- 完成选定的首台初始化流程，手机安全取得并保管同步库密钥；之后授权另一台电脑时不要求旧电脑参与。手机创建与电脑创建密钥是待评估的两个入口候选。
- 使用无业务含义的测试数据验证获授权客户端的加密与解密互通，服务端只保存和转送密文及必要协议元数据。
- 申请过期、拒绝、取消、重复领取、配对身份或公钥被替换、断线及账号上下文变更的失败路径有明确结果，旧请求不污染新上下文。
- 手机挂起、退出或网络中断后可在前台恢复；不以 iOS 或 Android 后台长连接常驻作为授权或同步正确性的前提。

首期不包括多服务器同步、完整剪贴板界面、系统剪贴板后台采集、分享扩展、远程桌面控制、微信登录、应用商店上架或生产部署。后续按实际需求分别决定，不预建无消费者的跨平台层。

## How

共享 Rust 核心及桌面接入已完成，验证结果见下述迁移方案。移动 Rust 功能模块与 Swift／Kotlin 绑定也已作为独立前置切片实现，当前行为见[模块文档](../../../crates/xiaowei-mobile/README.md)，决策与验证见[移动接入结果](2026-10-25-mobile-development/mobile-module-interface.md)。[现有 iOS App](../../../ios/README.md) 提供迁移行为基线。[Flutter 工程](../../../mobile/README.md) 的共享登录和账号页已接入 Dart／Rust 绑定、认证连接及平台会话存储。设备配对、内容密钥保管及加密同步见[单服务器总体方案](2026-10-25-mobile-development/pairing-and-sync-protocol.md)。

### 现有基础

- [服务器建设事项](2026-10-11-server-development.md) 已交付统一 HTTP／WS API、设备会话、桌面服务器切换和连接恢复；收藏上传与同步不在该事项范围。
- [xwapi](../../../docs/xwapi.md)、[服务端契约](../../../contracts/proto/xiaowei/server/README.md) 和 [WebSocket 接入](../../../server/docs/websocket.md) 是客户端接入的现有依据。
- [契约工程](../../../contracts/README.md) 已生成 TS、Rust、Go 和 Swift 服务器业务消息；移动函数绑定由 UniFFI 生成。移动端调用 xwapi 不要求先接入 Gateway。
- [source-log](../../../packages/source-log/README.md#react-native--metro) 的 RN／Metro 准备不作为 Flutter 技术基础；RN 已由用户明确排除。

### Flutter 移动技术栈（2026-11-16 已确认）

用户确认 iOS／Android 使用 Flutter 共享页面、组件、导航及大部分状态编排。Rust 继续承担网络、账号及后续配对、加密与同步；Flutter 经薄 Dart／Rust 绑定消费 xiaowei-mobile，不在 Dart 重写这些业务。系统安全存储、相机及生命周期通过经过验证的插件或必要的 Swift／Kotlin 适配接入。

| 能力 | 确定的分工 | 接入边界 |
| --- | --- | --- |
| UI 与状态展示 | Flutter／Dart | iOS／Android 共用产品页面；按需处理系统交互差异 |
| HTTPS 与认证 WS | xiaowei-mobile 组合已有 Rust xw-api | 复用现有账号与运行资源语义，不另建 Dart 网络或会话状态机 |
| Dart／Rust 调用 | flutter_rust_bridge 2.13.0 | 使用既有 FFI crate 的 `flutter` feature，适配异步操作、取消、订阅和关闭 |
| 消息与 API | 现有 proto 为唯一来源 | Dart 如需消费 PB，接入统一生成与漂移流程，不手抄消息或另维护 API 清单 |
| 安全存储 | iOS Keychain；Android Keystore 支撑的加密存储 | Android 不直接把任意凭据当作 Keystore 条目；分别验收读写、访问条件、备份与失效行为 |
| 扫码与生命周期 | Flutter 平台适配 | 相机权限、取消、后台结算和前台恢复分别在两个系统实际验证 |
| 加密与配对 | 成熟协议与共享 Rust 实现 | 初始化端仍待评估；选择 Flutter 不改变协议与密钥安全边界 |

Flutter App 位于根 `mobile/`，内含 iOS／Android 宿主。Dart 绑定由 `crates/xiaowei-mobile/ffi/` 提供，直接调用同一 Rust 功能模块。UniFFI Swift／Kotlin 与 Flutter 的构建和生成方式见[绑定说明](../../../crates/xiaowei-mobile/ffi/README.md)。

现有根 `ios/` SwiftUI App 保留为迁移对照，已通过的登录、Keychain、凭据检查点和前后台行为均需经 Flutter 入口重新验证。两个 App 使用各自的会话存储。双平台工具链和最低版本见 [Flutter 工程](../../../mobile/README.md#开发与构建)。

### xwapi 与 Account 的 Rust 迁移

已明确的职责是：Gateway 负责同一个 App 内的跨进程和跨模块代理，xwapi 负责客户端／服务端契约与 HTTP／WS 通道，Account 负责账号与会话生命周期。桌面 UI／TS 业务通过 Gateway 使用 Rust 提供方；共享 Rust 内部的 account 直接调用 api，无需绕行桌面 Gateway，也不需要认证调用接口注入。

用户明确要求梳理 AccountService：多端共同需要的认证操作与会话维护下沉 Rust，桌面继续自行维护登录态，要求与迁移前行为 100% 兼容。共享 account 只处理当前账号的登录、退出、传入会话的校验与连接维护，不提供存储或存储接口；各端自行加载、保存和提交登录态。桌面的服务器集合、选择、退出全部、UI 聚合快照与 Gateway 注册不进入共享核心，既有 AccountService／AccountStore 保留上述职责。移动端仍可按自身需要接入本地 Gateway，但 xwapi 和共享会话核心均不依赖它。

共享实现放在 `xw-api` crate，网络客户端与 `account` 会话模块在内部按职责组织。桌面现有 `xiaowei-rust/napi` 依赖该 crate 并提供 Gateway handlers 与 endpoint，由 main 通过既有 napi 接入 Gateway；移动端由独立功能模块组合网络与会话能力。职责拆分与桌面验证维护在 [客户端 Rust 迁移方案](2026-10-25-mobile-development/client-rust-migration.md)，移动模块当前说明维护在包内文档。网络迁移、会话提取及移动模块的前置成果直接复用；Flutter 接入、配对及通用同步按剩余切片推进。

### 已交付的 Swift／Kotlin 绑定基线

Rust 业务核心可由 Swift 和 Android 共用，但需要显式的外部接口和各平台构建产物。现有 napi 只服务桌面 Node，不能用于移动端；Protobuf 解决消息编码，也不会自动提供 Swift／JVM 到 Rust 的函数调用绑定。

独立前置切片已采用 UniFFI 0.32.2，从同一移动模块接口生成 Swift 和 Kotlin 绑定，并完成 macOS 上的双语言真实链路验证。其[官方支持范围](https://mozilla.github.io/uniffi-rs/latest/#supported-languages)包含两种语言；实际接入和验证边界见[绑定说明](../../../crates/xiaowei-mobile/ffi/README.md)。以下为现有基线的接入和证据，不代表 Flutter 或 Android App 已通过验收；新的 Dart 绑定及 Android ABI 接入需单独实施。

| 调用端 | 候选接入方式 | 需要承担的接入工作 |
| --- | --- | --- |
| Swift | UniFFI 生成 Swift／C FFI 绑定，链接 Rust 静态库 | 已接入 iOS App 的静态 framework／XCFramework、最小 UI 与生命周期；运行范围及未验证边界见 Outcome |
| Kotlin | UniFFI 生成 Kotlin 绑定，加载 Android Rust `.so` | 当前官方后端依赖 JNA；集成 NDK、目标 ABI、Gradle、协程和资源关闭 |
| Java | 优先通过薄 Kotlin facade 调用相同绑定 | 对外提供 Java 易用的 callback／future，避免直接暴露 suspend；若要求纯 Java 则另外评估 JNI，不把 Java 视为官方 Kotlin 后端的同等直接支持 |
| 桌面 TS | 既有 napi 薄适配 | 继续调用同一纯 Rust 核心，不为统一绑定而替换桌面本地通信 |

移动功能模块组合 xw-api 网络与 account 会话模块的操作、结果和必要通知，管理自己的运行时与资源；FFI 仅适配该模块的公开 API。Rust 的泛型、借用、锁和内部 Tokio future 不原样暴露给 Swift／JVM；边界转换为受支持的数据类型和拥有明确生命周期的句柄。移动绑定不暴露 App 内部 Gateway 的 registry、owner 或调用上下文，业务消息仍以 proto 为唯一声明来源；具体接口与资源语义见[统一接口](../../../crates/xiaowei-mobile/docs/interfaces.md)，未来移动端自身的 Gateway 接入另按内部通信需求设计。

绑定前置已验证下列库层语义，App 的平台验证结果与边界另见 Outcome：

- **异步与取消**：[UniFFI async 文档](https://mozilla.github.io/uniffi-rs/latest/futures.html)支持 Rust async 到 Swift async／Kotlin suspend 的映射，但明确要求库自行提供取消通道。将 Swift Task／Kotlin coroutine 取消桥接到 xwapi 自己的请求生命周期，并区分取消等待与已提交的远端副作用；网络核心所需 Tokio runtime 要独立管理，不能依赖 napi、桌面 Gateway 或仅依靠生成的异步语法。
- **线程与事件流**：Rust 后台通知不直接更新 UI，由 Swift actor／Kotlin dispatcher 切回正确上下文；明确订阅关闭、队列上限及迟到回调处理。事件接口不会因使用绑定生成器就自动具有 AsyncStream／Flow 的完整语义。
- **内存与资源所有权**：Swift ARC、JVM GC 和 Rust Arc 不共享同一种回收机制。请求、订阅、核心实例都提供显式关闭和幂等清理，避免跨端互相持有回调造成资源遗留；[Kotlin 生命周期说明](https://mozilla.github.io/uniffi-rs/latest/kotlin/lifetimes.html)要求显式 close 以保证 Rust 资源及时释放。
- **Swift 并发兼容**：[Swift 绑定说明](https://mozilla.github.io/uniffi-rs/latest/swift/overview.html)仍标注 Swift 6 支持存在边界，尤其涉及 Sendable 与 async；选定版本后用实际 Xcode／Swift 语言模式验证，不能仅凭支持 Swift 就认定已通过当前严格并发检查。
- **错误与拷贝成本**：预期错误使用结构化结果，panic 不作为业务错误跨语言传播；区分业务非零 code、传输失败与取消。字符串和字节缓冲可能经过复制，优先在 Rust 内完成网络收发与协议处理，外部传操作及批量结果，附件使用有界分块，避免每个 WS 帧跨 FFI 往返。
- **交付与升级**：UniFFI 不代替跨平台编译和打包。固定生成器与运行库版本，绑定和 Rust 二进制同步交付；分别验证 iOS 架构／平台与 Android ABI 的加载、TLS、取消和关闭行为，不能以桌面构建通过推定移动端可用。

最小跨端验证已按独立前置执行，Swift／Kotlin 均通过真实 fixture 请求、取消、状态与关闭，并覆盖账号检查点和凭据收取。UniFFI 是现有原生基线的实际绑定方案；Flutter 的 Dart 接入、两个平台的系统存储和生命周期另行验收，不能用 macOS 宿主验证替代。

### 手机授权的目标流程

电脑展示二维码、手机扫码的方向已确认。手机创建第一份密钥只是用户提出的候选，不是已确认决定；初始化端与日常授权端分开评估。两种首用路径、完整用户流程与交付里程碑统一维护在[单服务器总体方案](2026-10-25-mobile-development/pairing-and-sync-protocol.md)。

设备身份、服务器登录会话和同步库身份分别管理。首台可信设备在本地生成内容密钥；各设备持有自己的设备私钥，授权只向目标设备分发所需内容密钥。服务器转送申请和密钥包，不生成或接收明文内容密钥。首期不做恢复码或云端密钥备份，全部密钥副本遗失后无法恢复旧密文；利用仍可信设备恢复新手机属于总体方案中的恢复路径。

配对应绑定申请、目标设备公钥、同步库、协议版本和有效期，并使用成熟的认证密钥交换或密钥封装方案。二维码可用于建立带外信任，但不能只依赖服务端自报设备名称或替换后的公钥；日志不记录配对秘密或明文密钥。手工配对码、PAKE 和具体算法仍是候选，未确定为首期必选实现。

手机只在初始化及设备授权等交互时参与。电脑获授权后独立执行加密同步，不要求手机持续在线或逐条审批收藏变化。服务器仍可见账号、必要路由标识、密文大小与时序；“无法查看内容”不表示隐藏全部元数据。

### 单服务器范围与同步机制

首期仅实现当前服务器账号下同步库的本地待上传队列与拉取游标；登录 token 轮换不重置进度。退出、挂起或账号上下文变化取消旧任务和配对上下文，迟到响应不得越界写入。

内容同步、幂等操作、删除记录和本地事务由通用同步机制设计，iOS 接入该机制，不为手机另建一套收藏同步协议。业务数据应在进入服务端存储前完成加密；服务端不依赖明文正文、备注或分类来执行通用同步。

此前讨论中，用户说明服务器不通信、按本机对应服务器进度续传，并选择由客户端将本地数据同步给切换后的服务器；随后明确收窄为先做单服务器，多服务器可以不做。这些讨论不再构成本事项的实施或验收前置；不继续追问跨服务器密钥与数据归属，也不据此设计额外同步层。

### 待对齐的安全与生命周期决策

- 初始化端按完整首用流程评估，手机创建只是候选；电脑展示二维码而手机扫码已确认。其余默认行为作为统一总体方案提出，不拆成零散产品提问。
- 内容密钥、设备密钥和授权记录的层级与版本；扫码绑定与加密密钥包的具体协议及可信库。
- 手机锁定后的密钥访问条件，是否要求设备解锁或生物识别；手机备份、换机与重装时的密钥行为。
- 用户已接受首期不做恢复码或云端密钥备份；手机遗失时通过仍可信的设备重新授权，全部设备密钥遗失后旧密文无法恢复。
- 撤销设备、退出账号和移除服务器对本地密钥及远端权限的影响；已交付给设备的密钥不能通过删除服务器记录收回，后续数据的密钥轮换策略待定。

## Alternatives considered

- **React Native**：2026-11-16 用户明确排除，不再作为候选。
- **双端原生 UI**：SwiftUI 已完成 iOS 基线，Kotlin 绑定已完成 macOS/JVM 验证；但需要分别维护两套 UI。用户优先考虑长期共享 iOS／Android 界面，已选择 Flutter；现有原生基线保留作对照。
- **Flutter**：2026-11-16 用户明确确认。共享 UI 与 Rust 业务核心组合，代价是 Dart 绑定和平台编排迁移，须先通过既有能力的对照验收。
- **各端分别实现 HTTP／WS 与账号规则**：Swift 可使用 URLSession，但会重复维护路由、鉴权、重连和恢复状态机。当前更推荐 Rust 共享核心；其代价是新增网络依赖、Swift FFI、iOS 构建和跨语言生命周期验证。
- **仅桌面配对**：不能覆盖用户无法同时拿到两台桌面的使用场景，不作为主要授权入口。
- **仅恢复码／同步密码**：可以独立解锁，但用户本轮明确希望通过手机授权电脑，不以此替代手机；是否作为手机遗失后的恢复方式另行决定。

## Current work

2026-10-26 用户明确要求本 record 从 proposed 进入 active。2026-10-27 按用户最新要求收拢为单服务器总体方案；初始化端仍需评估，手机创建密钥未被确认。状态迁移不代表候选方案自动定案。

剩余任务、依赖及各片验收统一维护在[实施顺序与任务拆分](../../plans/2026-10-25-mobile-development/00-implementation-order.md)。01、02 已完成原生基线的约定实现与验收，结果见下述 Outcome。2026-11-16 用户确认 Flutter 后，下一片调整为 F：Flutter 双平台接入与既有能力迁移，再继续 03–10。服务器沿用现有单服务器入口，原 iOS 会话 Keychain 策略和 SwiftProtobuf 1.39.0 作为基线保留，不增加 App 锁或 Face ID。

02 的实现、模拟器及真机平台自动验证已完成；用户已在 App 内确认真实密码登录、认证 WSS，以及结束进程后无需密码的自动恢复，对应 Plan 已删除。用户重新连接 iPhone 15 Plus 后，本轮 Keychain／公开 HTTPS／生命周期的 3 项测试均通过；结果独立于 01 记录。后续协议决策、密钥与配对、桌面和服务端接入、通用密文同步及整体验收依次按依赖推进；不重新实施已完成的 Rust 迁移与绑定。

F 的 Flutter 双平台登录与会话基线已验收。iPhone 真机覆盖启动、登录、认证连接、进程重启和前后台恢复，iOS 模拟器补齐轮换凭据保存和后台取消，Android 模拟器验收已通过。下一片为 03，继续评估手机与电脑的初始化流程并确定[单服务器总体方案](2026-10-25-mobile-development/pairing-and-sync-protocol.md)。

## Outcome

以下 01／02 及绑定结果是已经完成的原生基线证据，不是 Flutter／Android 产品验收；2026-11-16 确认 Flutter 后，迁移验证按新增 F 切片独立记录。

已交付的前置成果为纯 Rust xw-api 及 account 会话模块、桌面既有 Gateway／napi 接入、xiaowei-mobile 功能模块与 Swift／Kotlin 绑定。迁移与验证证据分别见[客户端 Rust 迁移](2026-10-25-mobile-development/client-rust-migration.md#outcome)和[移动接入结果](2026-10-25-mobile-development/mobile-module-interface.md#outcome)。

2026-10-26 按用户要求执行 br-merge：前置模块、record 状态迁移与初始任务计划提交为 `c0f3363`，合入含 WebSocket／账号修复的 develop，合并结果为 `1ea785d`；atlas 保留并恢复至该结果。01 随后基于该版本实施，提交与再次合并结果见下段。

随后用户要求 br-merge 并继续 02：01 提交为 `a2d45e2`，合并至包含两项桌面修复的 develop，结果为 `1a7674a`；atlas 保留并恢复至合并结果，合并后 just check 通过。02 实施期间的新增改动未提交。

### 01 iOS 工程与运行基线

已交付原生 SwiftUI App、共享 scheme、静态 Swift 绑定 framework、Rust XCFramework 打包与统一准备／运行验证入口。AppModel 按同一串行任务链交接前台、后台及 shutdown，取消请求、停止订阅、等待 Rust 清理并隔离迟到结果；关闭后的客户端可以重建。当前说明见 [iOS 开发与验证](../../../ios/docs/development.md)，本片 Plan 已删除。

用户于本轮明确允许跳过真机到 Mac 的局域网 fixture。因此本片真机范围收窄为签名／安装／启动、公开 HTTPS、前后台与停止后重建；隔离 HTTP／WS、取消、账号检查点和连接关闭仍由模拟器实际验证。真机局域网权限允许／拒绝、认证 WS 和实际请求取消没有通过验收，不能由模拟器结果替代。

| 层次 | 实际结果与证据 |
| --- | --- |
| 构建与配置 | Xcode 26.3（17C529）、Swift 6.2.4、SDK 26.2；arm64 真机／模拟器 Debug 与 Release 构建通过，Release 产物不含 fixture-control、调试加载方法或本地网络测试 plist |
| iOS 26.3.1 模拟器 | iPhone 16 Plus 实际安装／启动，1 个 UI 测试及 2 个宿主测试通过；UI 完成 3 次健康请求、3 次 WS 建连、前后台断开／重连及停止后重建，最终 0 个 WS；报告 `target/ios/runs/2026-10-26T04-25-23.824Z/` |
| iOS 18.3.1 模拟器 | 同组 3 个测试与 fixture 断言通过；报告 `target/ios/runs/2026-10-26T04-26-51.275Z/` |
| iOS 26.5 真机 | iPhone 15 Plus 经个人开发签名安装并运行；`--public-only` 的 UI 与宿主测试各 1 个通过，覆盖真实 Rust HTTPS、前后台、停止和重建；报告 `target/ios/runs/2026-10-26T04-24-56.197Z/` |
| 原入口与仓库检查 | xiaowei-mobile Rust 测试、macOS Swift／Kotlin fixture、两个 iOS 15.0 库层编译／链接和完整 `just check` 通过；fixture 启动失败能传播错误并退出，无服务残留 |

各运行报告包含源码基线与未提交内容哈希、实际工具链／destination、范围和安全断言，不保存凭据。模拟器与真机截图均已从实际 UI 测试核对。最低 iOS 17 当前没有安装 runtime，仅完成 deployment 编译基线，不宣称 17 已运行验证。

上述 01 结束时，Keychain、产品账号与重启恢复、设备授权及通用加密同步仍属后续；02 的结果见下节。当时 Android App、收藏业务同步、上架与生产部署留在首期范围之外；当前范围以 2026-11-16 的 Flutter 决定及 What 为准。


### 02 Swift 契约、账号与平台登录态

已实现唯一 Swift 服务器契约输出及 descriptor 方法常量、精确 SwiftProtobuf 1.39.0 依赖与解析锁、密码登录表单、真实 Keychain store 和 AccountSession 平台编排。产品仍用单个 MobileClient。会话采用用户确认的 AfterFirstUnlockThisDeviceOnly，不增加 App 锁或 Face ID；当前行为和持久化／取消／重连边界统一维护在 [iOS 开发说明](../../../ios/docs/development.md#账号与平台持久化)。验收完成后按用户要求进入 br-merge 提交与合并流程。

实际 UI 验收复现并修复了账号句柄关闭误断已提交连接：Rust 回归测试先证实 generation 从 1 错误重置为 2，再验证关闭只结算隔离操作、连接继续由 MobileClient 管理。Swift 侧也验证同一 generation 的断线重连会再次校验账号。另修复库验收与 App 打包共用 Cargo 产物导致 15.0 链接误用 17.0 增量对象，SDK 缓存现按 deployment 版本隔离；不改共享业务或 App 最低版本。

| 层次 | 实际结果与证据 |
| --- | --- |
| Swift 契约 | 生成／漂移、唯一提供方、manifest／解析锁缓存失效与消息／方法常量缺失、多余、陈旧产物检查通过；服务器登录／健康消息在 TS／Rust／Go／Swift 双向遍历通过，原 Envelope 三语言检查保留；日志 `/tmp/xiaowei-ios02-codec-final.log`、`/tmp/xiaowei-ios02-contracts-cache.log` |
| iOS 26.3.1 模拟器 | 6 个 XCTest 及 fixture 断言通过：真实 Keychain、10 项账号保存／取消／失效／离线／补偿场景、账号表单与进程重启、同会话重连、原生命周期 UI 与 Rust 网络宿主；账号 UI 3 次登录请求、3 次用户校验、3 次连接、1 次退出，最终 0 个 WS；最终打包入口复验报告 `target/ios/runs/2026-10-26T05-24-35.206Z/`；初轮完整报告 `target/ios/runs/2026-10-26T05-19-20.691Z/` |
| iOS 18.3.1 模拟器 | 同组 6 个测试、10 项账号场景及 fixture 断言通过；报告 `target/ios/runs/2026-10-26T05-21-38.853Z/` |
| 构建与原入口 | 两个 SDK 的 Debug／Release 构建通过，Release 不含 fixture／account-fixture／verification-public 入口或测试网络 plist；Rust 移动测试、Swift／Kotlin 原绑定验证、iOS 15.0 库编译／链接及 just check 通过；最终库日志 `/tmp/xiaowei-ios02-ios-library-final.log`，仓库检查日志 `/tmp/xiaowei-ios02-just-check-final.log`，其余日志前缀 `/tmp/xiaowei-ios02-` |
| Keychain 补充验收 | 两版模拟器以禁止认证 UI 的新 LAContext 实际读回字节；报告 `target/ios/runs/2026-10-26T05-28-52.274Z/`、`target/ios/runs/2026-10-26T05-29-05.008Z/` |
| iOS 26.5 真机 | 用户重新连接并解锁 iPhone 15 Plus 后，个人开发签名安装／运行，`--public-only` 的 3 项 XCTest 全部通过：真实 Keychain 读写、访问属性、禁止认证 UI 的实际读回，Rust 公开 HTTPS，以及 App 前后台／停止重建；报告 `target/ios/runs/2026-10-26T06-11-53.656Z/`，实际 UI 截图已核对 |
| 真实产品账号 | 已打开无测试参数的正常 App，用户自行输入账号并明确确认“已登录且已连接”；按 Rust 的连接状态语义，此状态对应认证 WSS 成功。已结束原进程并启动新进程，用户再次明确确认“已自动恢复，无需密码”，页面恢复为“已登录”“已连接”。该链路为真机产品入口的人工验收，独立于合成 fixture 与公开 HTTPS 自动测试。凭据未进入对话、参数或报告。真机到 Mac 的局域网 fixture 沿用用户已授权的跳过决定 |

02 的实现与约定验收已完成，结果回填后删除对应 Plan。验收结束时正常 App 留在真机继续使用，真实凭据由 App 自行保存在设备 Keychain，不进入对话、命令参数或报告。真机局域网 fixture 的允许／拒绝、隔离账号失败与取消仍未执行，沿用已授权的跳过边界；对应失败路径已由模拟器验证。02 完成时下一片为 03 的协议与安全决策，2026-11-16 确认 Flutter 后改为先做 F；本 record 因仍有迁移、配对和同步事项保持 active。

### F Flutter 工程与登录

2026-11-20 建立 [`mobile/`](../../../mobile/README.md) 的 Flutter 共享入口、iOS／Android 宿主及依赖锁。Flutter 3.41.3／Dart 3.11.1 下依赖锁校验、静态分析及格式检查通过。iOS 使用 Xcode 16.2 生成模拟器 Debug 和无签名设备 Release；Xcode 26.3 在本机对新旧工程均无法解析 iOS 构建目标。Android 使用 JDK 21、SDK 36、NDK 28.2.13676358 和 CMake 3.22.1 生成 Debug 和 Release APK。仅验证构建和产物，未启动 App、签发分发包或接入 Rust。

随后按用户要求固定到 Flutter 官方最新 stable 3.50.1（Dart 3.14.0），采用新版模板的 `material_ui` 导入和 Android 构建配置。重新解析并验证依赖锁，Dart 格式、静态分析、iOS 模拟器 Debug／无签名设备 Release 及 Android Debug／Release 构建均通过。当前工具链入口见 [`mobile/README.md`](../../../mobile/README.md)。

2026-11-22 将连接检查入口替换为共享登录表单；已登录的账号页显示真实认证 WebSocket 状态，支持重试和退出。会话保存和凭据检查点接入 iOS Keychain／Android 加密存储，前后台切换驱动连接暂停和恢复。绑定复用 `xiaowei-mobile`，iOS 静态链接，Android APK 包含三种 ABI 的 Rust 库。

Rust 移动模块 13 项测试、Flutter 静态分析、`just check` 通过。Flutter 表单经真实 Rust 绑定和隔离 HTTP／WebSocket 验证了错密码、登录、断线重连、后台断开、回前台恢复、凭据检查点、重新创建会话后恢复和退出。隔离测试使用内存存储。iOS 模拟器 Debug、无签名设备 Debug／Release 和 Android Debug／Release 构建通过。用户随后确认 Flutter App 可在 iPhone 真机运行并登录。

iPhone 15 Plus 的 Flutter 运行日志确认真实认证 WebSocket 已连接，热重启后读取原会话并重新连接。用户随后手动划掉 Flutter App 再重开，确认无需重新输入密码，账号页显示「已连接」。这是 iPhone 真机安全存储读写和进程重启恢复的产品入口验收；凭据轮换仍使用隔离测试证据。

2026-11-25 用户确认 iPhone 真机的 Flutter App 前后台恢复验收通过。

Flutter 控制台日志已统一格式，并通过双平台 Release 入口注入原始源码路径和行号。已在混淆后的 iOS 无签名 Release 和 Android APK 三种 ABI 中逐一核对现有 13 个日志调用点。转换测试、账号回归、Flutter 静态分析和 `just check` 均通过。构建入口、日志范围和复验方式见 [Flutter 控制台日志](../../../mobile/docs/console-logging.md)。

Android 16（API 36，AOSP arm64）模拟器运行验收通过。隔离账号服务经 Go WebSocket fixture 接入，Debug 测试入口使用正式 Flutter 页面、Rust 动态库和 Android 安全存储。实际操作覆盖错误密码、登录及认证连接、断线重连、前后台恢复、挂起时取消正在等待的登录、凭据轮换与进程重启，以及退出后重启仍显示登录页。强制结束后，新进程用已轮换的凭据完成认证，服务端计数确认未重新发起密码登录。另使用临时测试签名安装 Release APK，正式入口成功进入登录页。报告保存在 `target/mobile-toolchain/android-acceptance/`。

2026-11-25 使用 iPhone 16 Pro／iOS 18.3.1 模拟器和 XCUITest 完成 Flutter iOS 最后两项验收。隔离服务确认登录请求进入等待后，按系统 Home 键使请求关闭，回到前台仍可登录。服务发出短有效期凭据后完成一次轮换，结束 App 并重新启动，新的进程用 Keychain 中的轮换凭据认证，页面恢复「已连接」，密码登录请求计数维持不变。两项通过，XCUITest 结果与隔离服务数据保存在 `target/mobile-toolchain/ios-acceptance/acceptance-04.xcresult` 和同目录的 `result.json`。

同日用 iPhone 17 Pro／iOS 26.3 模拟器的正式入口补充验证前后台回连。用户登录后，将小微切到主屏幕再从 App 切换器打开。Flutter 控制台记录断开、重新连接与连接成功，账号页恢复「已连接」且无需重新登录。
