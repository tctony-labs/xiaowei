# XiaoWei 桌面客户端

本包承载 Electron main、preload 和 renderer，以及桌面构建、打包和自动更新接入。

开发环境准备与启动方式见根文档的 [一键运行](../README.md#一键运行)。

自动回归入口及校验脚本变更时的测试素材同步要求见 [桌面测试](tests/README.md)。

运行实例的状态检查和显示／收起使用 [Inspect CLI](inspect/README.md)；App 侧职责见 [运行实例检查入口](docs/inspect.md)。CLI 随 macOS 正式包交付，开发入口为 `just inspect`。

## 打包与发布

- [macOS 桌面打包与更新设计](docs/macos-packaging-and-updates.md)：产物、构建、签名公证、更新源和客户端更新机制。
- [release-desktop-app](../.agent/skills/release-desktop-app/SKILL.md)：版本与更新说明维护、合回 develop、发布前确认及推送 tag 触发 CI。
- [本地打包与验证](../.agent/skills/release-desktop-app/references/local-validation.md)：本地打包、更新联调、密钥准备和调试归档操作。
