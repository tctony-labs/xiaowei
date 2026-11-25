# Flutter 控制台日志

Dart 应用代码通过 [MobileLog](../lib/src/mobile_log.dart) 输出 `info`、`warn` 和 `error` 日志。消息记录用户可观察的状态和错误类别，避免输出邮箱、密码和会话凭据。

```dart
MobileLog.info('Connection changed status=${status.name}');
```

Release 构建会注入工作区相对路径和原始行号。日志使用本地时间，级别占五字符宽。

```text
2026-11-22 22:27:20.977 [ info] [mobile/lib/src/account/account_session.dart:374] Connection changed status=connected
```

日常用 `fvm flutter run` 调试时，来源列显示 `[mobile]`。该格式也适用于直接运行 Flutter 构建命令时产生的 App。源码注入覆盖 `mobile/lib/` 内直接调用 `MobileLog.info/warn/error` 的 Dart 日志。显式传入的 `source` 优先使用，方法引用和经变量间接发起的调用沿用默认来源。Rust、Flutter 引擎和系统日志使用各自的输出机制。

## 构建 Release

在 `mobile/` 下执行。依赖安装和原生工具链见 [移动端开发入口](../README.md#开发与构建)。

```sh
fvm flutter pub get
fvm dart run tool/build_release.dart ios --no-codesign
fvm dart run tool/build_release.dart apk
```

[构建脚本](../tool/build_release.dart) 用 Dart analyzer 解析调用所属的方法，复制源码到 `.dart_tool/` 下的临时目录，并写入来源参数。Flutter 前端使用一份临时包配置读取这份 Dart 源码，Xcode 和 Gradle 继续从原项目构建。原始源码和项目包配置保持原样，临时目录在构建退出后清理。额外 Flutter 参数例如 `--obfuscate --split-debug-info=<目录>` 可以随构建命令传入。

产物路径沿用 Flutter 的默认位置。iOS App 位于 `build/ios/iphoneos/Runner.app`，Android APK 位于 `build/app/outputs/flutter-apk/app-release.apk`。

## 验证

```sh
fvm flutter analyze --no-pub
fvm flutter test --no-pub test/log_source_test.dart
```

转换测试覆盖原始行号、跨行调用、同名无关方法、显式来源和原文件保留。Release 构建后可取出 AOT 二进制，对照当前源码的调用行号。升级 Flutter 后，对 iOS 和 APK 的各个 ABI 重复这一检查。

```sh
strings build/ios/iphoneos/Runner.app/Frameworks/App.framework/App |
  rg 'mobile/lib/.*\.dart:[0-9]+'
unzip -p build/app/outputs/flutter-apk/app-release.apk lib/arm64-v8a/libapp.so |
  strings | rg 'mobile/lib/.*\.dart:[0-9]+'
```
