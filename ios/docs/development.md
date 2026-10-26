# iOS 开发与验证

## 工程与构建基线

App 的最低系统版本由 `Config/Base.xcconfig` 中的 iOS 17.0 定义；Swift 6 模式启用严格并发，编译与链接警告作为失败。当前仅包含 arm64 真机和 arm64 模拟器，不包含 Intel 模拟器。

已使用 Xcode 26.3（17C529）、Swift 6.2.4、iOS／Simulator SDK 26.2 构建。现有模拟器 runtime 显示名称为 iOS 26.3／18.3，实际 destination 版本为 26.3.1／18.3.1；选择目标时以 `xcodebuild -showdestinations` 为准。iOS 17 runtime 当前未安装，最低版本未完成运行验证。

工程维护四个原生 targets：

| Target | 职责 |
| --- | --- |
| XiaoWei | SwiftUI App、系统生命周期和展示状态 |
| XiaoweiMobile | 同次生成的 Swift 绑定，静态 framework；链接 Rust XCFramework |
| XiaoWeiTests | 在 App 宿主中实际调用生成绑定的网络与资源测试 |
| XiaoWeiUITests | 安装后启动 App，操作页面、系统权限和前后台切换 |

```mermaid
flowchart LR
    App[SwiftUI App] --> Swift[生成的 XiaoweiMobile Swift 模块]
    Swift --> FFI[XiaoweiMobileFFI XCFramework]
    FFI --> Mobile[xiaowei-mobile]
    Mobile --> API[xw-api / account]
    API --> Server[服务器 HTTP / WebSocket]
```

Swift 不维护第二套业务路由或消息 codec。当前 Health.Check 通过正式 Rust API 发出，页面的“服务已响应”只表示收到非空响应，不表示已解码健康消息或完成产品账号验收。默认服务器为 `https://xiaowei.tctony.com`，当前没有持久登录态或产品多服务器入口。

## 准备原生产物

所有命令在仓库根执行：

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
node ios/scripts/prepare.mjs --configuration Debug
```

prepare 读取最低版本并调用 [FFI 打包入口](../../crates/xiaowei-mobile/ffi/README.md#ios-app-打包)。Cargo 的 target_directory 决定二进制归属，支持 `CARGO_TARGET_DIR`；产物位于其中的 `mobile-ios/debug/` 或 `mobile-ios/release/`。同一目录中的 Swift 绑定、C 头和 `XiaoweiMobileFFI.xcframework` 必须一起使用，不手改生成文件。

prepare 同时写入忽略的 `target/ios/Native.xcconfig`，把原生目录交给 Xcode。打开工程前或切换原生构建配置后先执行对应准备命令；工程不依赖稍后的 Build Phase 来创建尚不存在的 XCFramework。不需要 Ruby、工程生成器、SwiftPM 或额外 npm 包。

```sh
open ios/XiaoWei.xcodeproj
xcodebuild -project ios/XiaoWei.xcodeproj -scheme XiaoWei -showdestinations
xcodebuild -project ios/XiaoWei.xcodeproj -scheme XiaoWei \
  -configuration Debug -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath target/ios/DerivedData CODE_SIGNING_ALLOWED=NO build
```

Release 使用独立原生产物：

```sh
node ios/scripts/prepare.mjs --configuration Release
xcodebuild -project ios/XiaoWei.xcodeproj -scheme XiaoWei \
  -configuration Release -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath target/ios/ReleaseDerivedData CODE_SIGNING_ALLOWED=NO build
```

Release 不编译 Debug 的 fixture 启动参数处理，也不使用测试用本地网络 Info.plist；正常 HTTPS 的证书校验始终由 Rust 客户端保留。

## 真机签名与网络

复制 `ios/Config/Local.xcconfig.example` 为 `ios/Config/Local.xcconfig`，只在本机填写自己的 `DEVELOPMENT_TEAM`；或向验证脚本传 `--team '<个人Team>'`。工程使用自动开发签名，真机构建允许 Xcode 更新 provisioning profile。不要把 Team、证书、profile 或设备 UDID 写入共享配置。

手机需连接、解锁、信任 Mac，并开启 Developer Mode。配对记录不等于当前可用：先用 `xcrun devicectl list devices` 和 Xcode destinations 核对实际设备，再进行签名、安装与运行。

隔离测试在 Mac 创建临时 Node HTTP／Go WS fixture。手机必须能访问显式指定的 Mac 地址；USB 调试连接本身不提供手机到 Mac 的 HTTP 转发。使用手机可达的局域网地址，保留 VPN／防火墙设置，由实际请求确认连通性，不把 `127.0.0.1` 发给真机。

Debug 的本地网络用途说明与 `NSAllowsLocalNetworking` 只服务开发验收，不全局允许任意 HTTP，也不关闭 TLS 校验。UI 测试通过系统弹窗处理本地网络及部分地区设备的无线数据授权。完整真机 fixture 测试会重置这份开发 App 的本地网络权限，先拒绝并检查失败状态，再重置、允许并恢复；不修改其他 App 或全局隐私设置。模拟器回环访问不经过真机本地网络隐私路径。

首轮真机验收按用户要求跳过局域网 fixture，使用 `--public-only`；真机本地网络权限允许／拒绝、隔离 WS 与取消尚未验收。该模式不访问 Mac fixture，也不重置本地网络权限，不用它宣称完整真机网络场景已通过。

## 运行验证

```sh
node ios/scripts/verify-runtime.mjs \
  --destination 'platform=iOS Simulator,name=iPhone 16 Plus,OS=26.3.1'
node ios/scripts/verify-runtime.mjs \
  --destination 'platform=iOS,id=<实际设备UDID>,arch=arm64' \
  --listen-host 0.0.0.0 --fixture-host '<手机可达的Mac地址>' --team '<个人Team>'
node ios/scripts/verify-runtime.mjs \
  --destination 'platform=iOS,id=<实际设备UDID>,arch=arm64' \
  --team '<个人Team>' --public-only
```

完整模式依次准备原生库、build-for-testing、创建独立 fixture，然后分别执行 UI 与宿主 XCTest。模拟器先等待 bootstatus；只关闭脚本启动的模拟器，保留原来已启动的实例。UI 和宿主场景串行运行，互不共用合成会话及请求计数。`--public-only` 使用相同构建入口，只执行无凭据公开 HTTPS 的 UI／宿主测试，不创建 fixture，也不要求 Go 或 Mac 局域网地址。

| 验证层 | 实际覆盖 |
| --- | --- |
| UI App | 原生加载、页面状态、健康请求、后台断开、前台重连、再次请求、显式停止和 owner 重建；完整真机模式另包含本地网络拒绝与恢复 |
| 宿主 XCTest | 合成 WS 鉴权／调用、公开 HTTP 无凭据、PB 业务失败、重复读取不重放、发送前／发送后取消、超时、账号检查点继续／取消后收取、登录退出、订阅 stop、pause／恢复与幂等 shutdown |
| 公开 HTTPS | 从目标 iOS 的 Rust 客户端请求默认服务器，执行实际 DNS／TLS；不使用真实账号 |
| fixture 断言 | 核对业务请求数量、取消请求已到达及 socket 实际关闭、前后台与 owner 重建分别建立 WS、最终无打开的 WS |
| public-only | 真实 App 的公开 HTTPS、前后台、停止／重建，以及宿主 XCTest 通过正式绑定执行 Rust HTTPS；不覆盖认证 WS 或账号 |

测试所需业务 PB 来自既有 Rust fixture；Swift 只传递或比较 Data。Foundation 仅访问测试控制路径，不代替产品 Rust 网络调用。测试不退出用户账号，不启动桌面 App 或生产服务。

日志、每个场景的 `.xcresult` 和 `report.json` 位于 `target/ios/runs/<时间>/`；模拟器和真机的 DerivedData 分别位于 `target/ios/DerivedData/` 与 `target/ios/DeviceDerivedData/`。报告记录源码基线与未提交内容哈希、Xcode／SDK、destination、明确 scope、安全计数及结果；不保存认证 PB 或 token。各模式均核对实际通过的 XCTest 数量；完整模式还要求 fixture 完成断言，零测试或仅构建成功不能通过。

原有独立检查仍保留：

```sh
cargo test --locked -p xiaowei-mobile
node crates/xiaowei-mobile/ffi/scripts/verify-bindings.mjs
node crates/xiaowei-mobile/ffi/scripts/verify-ios.mjs
```

macOS 上的 Swift／Kotlin 命令行测试、iOS SDK 编译／链接、模拟器运行和真机运行属于四种独立证据。库检查的 iOS 15.0 仅用于库层兼容性，不改变 App 的最低版本。Kotlin/JVM 通过也不代表 Android App／ABI 已验收。

## 生命周期与日志

`AppModel` 在 MainActor 上持有一个 MobileClient、当前请求和连接订阅，串行交接 active、background 与 shutdown。inactive 的短暂系统交互不会暂停连接。进入后台取消当前请求、停止订阅并等待 Rust pause；回到前台重新提交会话，已 shutdown 的 owner 需要新建。修订号使旧任务结果不能覆盖新场景。

iOS 提供的有限后台时间只用于清理，不承诺后台常驻或杀进程前一定收到回调。持久凭据、检查点落盘和进程重启恢复属于后续账号接入。App 使用系统 Logger，subsystem 为 `com.tctony.xiaowei.ios`，记录生命周期、错误分类与清理结果，不记录消息体或凭据。
