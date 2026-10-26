# XiaoWei iOS

Swift + SwiftUI 原生客户端。当前提供连接检查与前后台生命周期基线，经生成的 `XiaoweiMobile` Swift 模块调用 [xiaowei-mobile](../crates/xiaowei-mobile/README.md)；业务 HTTP／WS、账号规则及运行资源由共享 Rust 实现。

最低 iOS 17，当前构建 arm64 真机与 Apple Silicon 模拟器。需要 Xcode、仓库锁定的 Rust 工具链和 Node；运行隔离测试还需要 Go。账号 UI、Keychain、设备授权和同步尚未接入。

在仓库根准备原生产物后打开工程：

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
node ios/scripts/prepare.mjs --configuration Debug
open ios/XiaoWei.xcodeproj
```

选择共享 `XiaoWei` scheme。真机签名通过忽略的 `Config/Local.xcconfig` 或命令参数指定自己的 Team。

模拟器与真机测试统一使用 `node ios/scripts/verify-runtime.mjs --destination '<目标>'`。手机无法访问 Mac 的测试服务时，可加 `--public-only` 验证公开 HTTPS 与 App 生命周期。具体工具链、签名、测试范围和报告位置见[开发与验证](docs/development.md)。
