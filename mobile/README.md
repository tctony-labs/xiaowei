# XiaoWei Mobile

小微的 iOS／Android Flutter 客户端。`lib/main.dart` 是共享入口，`lib/app.dart` 定义共享界面，`ios/` 和 `android/` 分别承载两端的构建与平台接入。

双平台应用标识均为 `com.tctony.xiaowei`，迁移期间可与现有 [SwiftUI App](../ios/README.md) 共存。

## 登录和连接

使用小微账号的邮箱和密码登录。账号页显示当前邮箱及认证 WebSocket 的状态，并提供重试与退出登录。App 在后台暂停连接，回到前台后恢复。会话凭据由 iOS Keychain 或 Android Keystore 支撑的加密存储保管，用于下次启动恢复；App 不保存密码。

Flutter 通过 [Dart／Rust 绑定](../crates/xiaowei-mobile/ffi/README.md#flutter-绑定) 调用已有移动网络和会话模块，沿用当前单服务器 `https://xiaowei.tctony.com`。

## 开发与构建

使用 `.fvmrc` 固定的 Flutter 3.50.1（Dart 3.14.0）。在 `mobile/` 下执行：

```sh
fvm install
fvm flutter pub get
fvm flutter analyze
```

iOS 需要 Xcode 和 iOS SDK；运行模拟器还需安装对应系统。最低支持 iOS 17。真机签名在本机的 `ios/Flutter/Local.xcconfig` 设置 `DEVELOPMENT_TEAM`，不提交个人签名信息。

Android 使用项目的 Gradle Wrapper，需要 JDK 17 或更高版本、Android SDK API 35 和 36、Build Tools 36.0.0、NDK 28.2.13676358 和 CMake 3.22.1，最低支持 API 24。macOS 上可用 Android Studio 把 SDK 安装到用户共享目录 `~/Library/Android/sdk`。可用 `fvm flutter doctor -v` 检查工具链，首次安装时按 `fvm flutter doctor --android-licenses` 的提示确认 SDK 许可证。

构建会调用仓库锁定的 Rust 工具链。按目标平台安装 Rust targets：

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
```

Intel Mac 的 iOS 模拟器使用 `x86_64-apple-ios`。普通构建直接使用仓库中的 Dart 与 Rust 绑定。

### 日常运行

在仓库根目录运行：

| iOS | Android | 行为 |
| --- | --- | --- |
| `just ios <uuid>` | `just android <设备 ID 或 AVD 名称>` | 保存指定设备并运行 |
| `just ios` | `just android` | 运行上次保存的设备。首次运行时从列表中选择 |
| `just ios -s` | `just android -s` | 打开设备列表，保存重新选中的设备并运行 |

设备选择分别保存在本机的 `mobile/.ios-device-id` 和 `mobile/.android-device-id`。选择列表需要交互终端。Android 可以用 AVD 名称启动模拟器，也可以用 `emulator-5554` 这样的设备 ID 指定已运行的模拟器。

启动后使用 Flutter 的交互命令，`r` 热重载、`R` 热重启、`h` 或 `?` 查看帮助、`q` 退出。

### 构建产物

在 `mobile/` 下执行：

```sh
fvm flutter build ios --simulator --debug
fvm flutter build apk --debug
fvm dart run tool/build_release.dart ios --no-codesign
fvm dart run tool/build_release.dart apk
```

Release 入口会在编译前注入 [日志源码位置](docs/console-logging.md)，尚未配置分发签名。可用 `fvm flutter run -d <device-id>` 在可用设备或模拟器上运行。

## 登录链路验证

在仓库根运行 `node mobile/tool/verify-account.mjs`。当前验证脚本需要 macOS、FVM、Node、Rust、Go 和 curl。它使用隔离服务和内存存储，从 Flutter 表单验证密码登录、真实认证连接、断线重连、会话恢复和退出。平台安全存储和 App 进程重启需分别在 iOS／Android 上验证。
