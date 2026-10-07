# 04d：工具边界、打包与产品验收

前置：[当前文本聊天基线](../../records/active/2026-09-28-agent-chat/implementation-results.md#持久文本聊天里程碑)、[02i](02i-webfetch.md)、[02k](02k-continue-recovery.md)、[02l](02l-titles.md)、[03d](03d-composed-preview.md)。关联 [record](../../records/active/2026-09-28-agent-chat.md) 与 [总实施顺序](00-implementation-order.md)。

本片结果：首期全部真实工具／恢复／标题功能通过生产边界与 Quick Chat 产品验收，回填结果后结束计划。

范围边界：不把 mock、编译或 Node 集成当实际模型／Electron验收；全部通过才填写完成 Outcome。

本片在已交付持久文本链路上接入真实工具／审批、压缩和显式继续；会话管理、标题和模型控件保留回归，不重新列为开发任务。实施前根据实际源码复核文件，不拆新计划。

## 文件与改动

| 类型 | 路径 | 具体改动 |
| --- | --- | --- |
| 修改（实施前复核） | `desktop/src/main/app/gateway.ts`、`desktop/src/renderer/src/components/agent-chat/`、`desktop/src/renderer/src/components/quick-chat/` 及相邻测试 | 在当前实现上接入工具／交互、压缩／继续和 03d 新 UI，保留同一服务与状态适配器 |
| 修改 | `crates/xiaowei-agent/napi/test/runtime.test.cjs`、`sessions.test.cjs` | 正式 addons + 真实 worker + 本地协议服务的全工具／恢复／多 caller 集成 |
| 修改 | `desktop/tests/run.mjs` | 串行正式 Agent addon 构建和生产集成，保留 fixture 恢复约定 |
| 修改 | `desktop/tests/main/launcher-layout.test.ts` | 仅补产品接线影响的尺寸／布局回归 |
| 修改（按产物检查结果） | `desktop/electron-builder.json` | 只有真实打包检查发现缺项才补 native／worker 资源，不重写打包策略 |
| 修改 | `.agent/records/active/2026-09-28-agent-chat.md` 及同名附属目录 | 主文档回填进展与 Outcome；架构、schema、协议和测试证据更新对应专题，避免重新堆回单篇 |

## 实施顺序

1. 自动 fixture 不用用户凭据或真实文件；故障注入按 Rust journal、worker 通信和本片自有进程分层。
2. 全链路覆盖文本多轮、思考／工具、真实文件→结果→生成、Bash Stop、Run 模型引用／思考强度固定、WebFetch 提取、压缩、标题、重建后 Continue 和删除不复活。
3. 两个 caller 共享输入／run／item，响应丢失用 ReadSession(include_runs=true) 按 input ID 查询，不能换新 ID 自动重发；交互各端 ack 与决定独立，单端断连不 Stop。不宣称手机网络已验收。
4. 打包检查 public native loader／ASAR 外 .node／worker 路径；只有检查发现缺项才调整资源。
5. 先确认当前工作区活实例，再允许 just rs；无实例由用户启动。真实模型／副作用验收使用已授权的专用测试任务和目录，不改凭据／默认。

## 独立验收

- 受影响 crates cargo test、contracts:test／contracts:check／gateway:check、just check、desktop test、storybook:build、desktop build／package。只改 Gateway 核心才额外 gateway:test。
- Electron：普通多轮、文件／Bash／问答权限、各阶段停止、隐藏切换、renderer 重载、应用重启、继续不重复副作用、压缩／标题／模型。
- 平台：快捷键、Esc／空输入 ↑、菜单优先级、真实 IME、焦点与搜索末项滚动。未完成的必要人工验收不能当完成；不运行冷启动冒烟脚本。

本片只创建实际需要的文件；生成产物走既有 just gen／napi 构建，不手改。实施完成即回填 record 的实际行为、差异和验证结果，再删除本 Plan，并将后继引用改为 record 中已交付说明。
