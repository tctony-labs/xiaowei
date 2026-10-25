# xw-clipboard

剪贴板业务核心，负责监听、去重、历史管理、收藏分类、复制粘贴、资源及后台任务生命周期。数据访问通过 typed Gateway client 调用 Storage owner，核心不依赖 Electron 或 napi。

架构、存储、编辑计次、时间字段、分类、搜索与清理规则见[剪贴板](../../docs/clipboard.md)。

在仓库根目录执行 `cargo test -p xw-clipboard --locked` 验证业务行为。桌面绑定与原生验证入口见 [xiaowei-rust](../xiaowei-rust/README.md)，跨模块联调见 [桌面测试](../../desktop/tests/README.md)。
