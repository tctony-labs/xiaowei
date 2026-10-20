# XiaoWei 桌面客户端

本包承载 Electron main、preload 和 renderer，以及桌面构建、打包和自动更新接入。

开发环境准备与启动方式见根文档的 [一键运行](../README.md#一键运行)。

## 打包与发布

- [macOS 桌面打包与更新设计](docs/macos-packaging-and-updates.md)：产物、构建、签名公证、更新源和客户端更新机制。
- [release-desktop-app](../.agent/skills/release-desktop-app/SKILL.md)：版本与更新说明维护、合回 develop、发布前确认及推送 tag 触发 CI。
- [本地打包与验证](../.agent/skills/release-desktop-app/references/local-validation.md)：本地打包、更新联调、密钥准备和调试归档操作。
