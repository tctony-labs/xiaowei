# 02h：Bash、后台进程与隔离

前置：第一阶段接 [第一批文件读写](../../records/active/2026-09-28-agent-chat/implementation-results.md#工具循环与文件工具2026-10-18)完成，第二阶段接 [02i WebFetch](02i-webfetch.md)完成。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与 [总实施顺序](00-implementation-order.md#内置工具接入批次)。

本片分两阶段交付：第 2 批仅前台 Bash；第 7 批后台工具 BgRun／BgOutput／BgStop，停止、删除和退出能结算对应进程组。不再使用 BashOutput／KillBash 作为工具名称。

范围边界：不声称跨平台 Bash 已交付，不修改用户沙箱或系统配置。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 新增 | `crates/xw-sandboxed-exec/Cargo.toml、README.md` | 迁移旧 sandboxed-exec 的实际依赖和 MIT 许可证说明，登记平台边界 |
| 新增 | `crates/xw-sandboxed-exec/src/lib.rs、error.rs、policy.rs、sandbox.rs、seatbelt.rs、seatbelt.sbpl、seatbelt_network.sbpl` | 迁移完整策略／Seatbelt 依赖闭包，不替换为裸 Command |
| 新增 | `crates/xw-sandboxed-exec/tests/sandbox.rs` | macOS 实际隔离和平台不可用测试 |
| 新增 | `crates/xw-agent-runtime/src/tools/bash/mod.rs、sandbox.rs` | 第一阶段前台 Bash 与隔离执行，不包含后台启动参数或自动转后台行为 |
| 新增（第二阶段） | `crates/xw-agent-runtime/src/tools/bash/session.rs、output.rs、kill.rs` | BgRun／BgOutput／BgStop 的任务管理、输出游标／限额、进程组终止和最多 5 个后台 shell |
| 修改 | `crates/xw-agent-runtime/Cargo.toml、src/tools/mod.rs`、`crates/xw-agent/src/context.rs` | 声明隔离模块和实际工具，不暗中开放未验证平台 |
| 修改 | `crates/xw-agent/src/tool_registry.rs、execution.rs、session.rs、service.rs` | Stop 清当前 run 创建的任务，删除／退出清会话全部 shell；等待后释放 writer |
| 新增 | `crates/xw-agent-runtime/tests/bash.rs` | 实际子进程、输出、并发上限、取消与进程组清理 |
| 修改 | `crates/xw-agent/tests/shutdown.rs、Cargo.lock、crates/README.md` | 覆盖 task 关闭顺序，登记包与真实依赖 |

## 实施顺序

1. 第一阶段为第 2 批：仅实现并注册前台 Bash，等待命令结束后返回结果；保留旧超时／输出上限及进程组取消，不提前提供后台执行参数、任务注册或后台工具。
2. macOS 真正验证 Seatbelt，其他平台返回明确不可用，不退回裸 shell。复用第 1 批已有权限检查，不因权限申请工具尚未接入而放宽权限。
3. 第一阶段验收完成后回填 record，删除已完成的实施步骤，后续依次推进第 3 至第 6 批；第二阶段为第 7 批，BgRun／BgOutput／BgStop 一起实现与验收。
4. 第二阶段核对旧后台任务的存储、输出、停止和退出清理语义，工具名称按用户要求调整；BgRun 启动成功不等于任务结束，BgStop 等待进程退出。历史 PID 重启后不能重新连接或重跑。

## 独立验收

- cargo test -p xw-sandboxed-exec／xw-agent-runtime／xw-agent --locked；正式 Agent addon build:debug。
- 第一阶段用专用临时目录验证前台命令、沙箱边界、输出上限、超时与 Stop／delete／close 的进程组清理，确认无后台执行入口；第二阶段验证后台三工具闭环、5 个后台上限、增量输出和无自有残留进程。

本片只创建实际需要的文件；生成产物走既有 just gen／napi 构建，不手改。实施完成即回填 record 的实际行为、差异和验证结果，再删除本 Plan，并将后继引用改为 record 中已交付说明。
