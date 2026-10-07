# 02h：Bash、后台进程与隔离

前置：[02g](02g-filesystem-tools.md)。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与 [总实施顺序](00-implementation-order.md)。

本片结果：macOS 上 Bash／BashOutput／KillBash 成套可用，停止、删除和退出能结算对应进程组。

范围边界：不声称跨平台 Bash 已交付，不修改用户沙箱或系统配置。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 新增 | `crates/xw-sandboxed-exec/Cargo.toml、README.md` | 迁移旧 sandboxed-exec 的实际依赖和 MIT 许可证说明，登记平台边界 |
| 新增 | `crates/xw-sandboxed-exec/src/lib.rs、error.rs、policy.rs、sandbox.rs、seatbelt.rs、seatbelt.sbpl、seatbelt_network.sbpl` | 迁移完整策略／Seatbelt 依赖闭包，不替换为裸 Command |
| 新增 | `crates/xw-sandboxed-exec/tests/sandbox.rs` | macOS 实际隔离和平台不可用测试 |
| 新增 | `crates/xw-agent-runtime/src/tools/bash/mod.rs、sandbox.rs、session.rs、output.rs、kill.rs` | 前后台执行、输出游标／限额、进程组终止和最多 5 个后台 shell |
| 修改 | `crates/xw-agent-runtime/Cargo.toml、src/tools/mod.rs`、`crates/xw-agent/src/context.rs` | 声明隔离模块和实际工具，不暗中开放未验证平台 |
| 修改 | `crates/xw-agent/src/tool_registry.rs、execution.rs、session.rs、service.rs` | Stop 清当前 run 创建的任务，删除／退出清会话全部 shell；等待后释放 writer |
| 新增 | `crates/xw-agent-runtime/tests/bash.rs` | 实际子进程、输出、并发上限、取消与进程组清理 |
| 修改 | `crates/xw-agent/tests/shutdown.rs、Cargo.lock、crates/README.md` | 覆盖 task 关闭顺序，登记包与真实依赖 |

## 实施顺序

1. 保留旧超时／输出上限与后台启动语义，后台启动成功不等于任务结束；Kill 等待进程退出。
2. 历史 PID 重启后不能重新连接或重跑；macOS 真正验证 Seatbelt，其他平台返回明确不可用，不退回裸 shell。

## 独立验收

- cargo test -p xw-sandboxed-exec／xw-agent-runtime／xw-agent --locked；正式 Agent addon build:debug。
- 专用临时目录验证沙箱内外写入、5 个后台上限、增量输出、run Stop 与 session delete／close 后无自有残留进程。

本片只创建实际需要的文件；生成产物走既有 just gen／napi 构建，不手改。实施完成即回填 record 的实际行为、差异和验证结果，再删除本 Plan，并将后继引用改为 record 中已交付说明。
