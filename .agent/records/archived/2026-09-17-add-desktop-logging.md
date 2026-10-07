# 桌面日志模块

## Why

事项启动时，桌面日志只输出 console，退出后无法排查；Rust 依赖中的 `log` 调用尚未接入接收器。

## What

main、renderer、Node worker 和 Rust 同时输出 console 与同一日志文件，保留来源标记。暂不上传日志，不做日志查看界面；Go 服务端日志不属于本轮范围。

## How

采用 electron-log 的 Node 接口，由 main 统一写文件和终端。renderer 复用窗口的 `console-message`，Node worker 复用 stdout／stderr 采集；避免新增业务日志 IPC 或开放 renderer 文件权限。Rust 保留 log facade，由各 napi 动态库分别安装接收器，不能依赖跨动态库的全局 logger。

通过构建插件注入原始源码位置，避免运行时抓栈；位置注入和通用 worker 采集沉淀为共享包，避免各业务重复转接。文件按天写入、轮转保留备份；终端写入失败不回流到异常日志链路，避免退出时 EIO 造成递归记录。

当前链路、存储、等级、源码位置和接入约定已沉淀到 [桌面日志](../../../docs/desktop-logging.md)，由长期文档持续维护；查询与实例操作保留在 [manage-dev-instances](../../skills/manage-dev-instances/SKILL.md)。本 record 仅保留建设理由、取舍与历史验证结果。

## Outcome

2026-10-07 按用户要求以 completed 归档：本次桌面日志建设已交付，后续不再基于该 record 进行重大改动。持续有效的说明已按当前代码整理到 `docs/desktop-logging.md`，包括后来已接入的 agent napi 日志；这次仅整理文档，未修改日志实现或重新执行运行验收。归档前无对应实施 Plan，相关查阅入口已更新。以下历史验证记录及其未验证边界保留原样，归档不将待观察场景或未来移动端验收改记为已通过；日志上传仍为独立后续工作。

2026-09-26 接入通用 Node worker 日志：source-log 增加独立 worker 入口，LLM 使用公共创建／初始化函数，业务继续使用 console 与既有源码位置注入；未新增业务 IPC，未修改 Pi 补丁。通过共享包 10 项测试、桌面日志 11 项测试、LLM 55 项测试、桌面构建及 just check。覆盖真实 worker 的原始行号、等级、多行／Error 输出、直接 stdout/stderr、尾行、业务消息隔离及统一文件中的生产等级过滤。确认当前工作区实例后执行 just rs；按用户要求将来源统一为 `worker.<name>`，不重复输出 main；21 项日志／共享包测试及桌面类型检查再次通过。重启后 19:11:13.240 的实际文件日志为 `[debug] [worker.llm] [desktop/src/main/services/llm/worker/index.ts:10] LLM worker ready`，启动段正常。该改动与此前 Responses WebSocket 提交独立维护。

2026-09-22 补齐剪贴板页面读取和事件订阅的失败日志，保留原始异常及请求上下文，供“复制文件夹后打开页面报错、重载后恢复”的后续观察使用；本次未确认该偶发异常的根因。桌面类型检查、修改文件的 Biome 检查和 Gateway 异常序列化验证通过，实际故障日志待再次发生时验证。

2026-09-21 终端染色覆盖整条日志，在最终格式化后按 level 包裹颜色并在末尾重置。10 项日志测试、桌面类型检查和修改文件的 Biome 检查通过，覆盖正文、对象、错误堆栈、颜色开关及文件纯文本输出。

2026-09-20 范围修正与 RN 适配：取消 desktop 源码目录限制，共享包覆盖工作区源码；renderer 位置识别同步支持跨包路径。新增 Vite 实际跨包构建开关测试，以及 Babel TSX、作用域过滤、路径排除、嵌套调用与运行输出测试。`just check`、24 项桌面测试、3 项共享包 Babel 测试和桌面正式构建通过。React Native/Metro 尚无项目，未声称已完成真机或 Fast Refresh 验收。

2026-09-20 源码定位：`just check`、`just test`（包含 22 项桌面测试和 8 项 napi 测试）及桌面正式构建通过，两个 native debug 包已重建，回调验证得到工作区相对路径与有效行号。插件开关均通过实际 Vite production/dev 转换验证，测试覆盖 TSX、行号更新、局部 console、指令保留、嵌套调用、格式参数和 renderer 单次写入／不追加产物位置。尚未完成当前工作区 Electron 的端到端验收：现有运行实例属于主工作区，未重启或冷启动。

同进程交替三轮测量：全量构建中位数关闭 417ms、开启 434ms；开发模块失效重转换各轮均值关闭 5.8–7.8ms、开启 5.6–6.5ms。首次冷转换受缓存影响明显（首轮 42ms，后续约 4–5ms），不足以据此判断完整冷启动差异；未观察到稳定的重转换退化，不代表更大项目或实际浏览器 HMR 零成本。

修复退出时 console 写入 `EIO` 经未捕获异常监测反复记录、导致日志持续轮转的问题。新增独立 Node 子进程测试覆盖正常终端、同步 `EPIPE` 和异步 `EIO`，验证异常仍尝试输出 console、无派生未捕获异常及重复日志、后续文件写入继续；14 项桌面测试、桌面类型检查和修改文件的 Biome 检查通过。未启动桌面实例，实际终端关闭时的 Electron 退出行为待运行验证。

初始化日志已增加搜索与剪贴板业务模块名称；两个 napi debug 包重建成功，8 项 napi 测试通过（包含模块名称与独立回调验证），确认当前工作区实例归属后已执行 `just rs`。

查询日志的可复用流程已登记为 [manage-dev-instances](../../skills/manage-dev-instances/SKILL.md)，覆盖文件定位、备份查询、按来源和错误筛选，以及缺失日志的排查边界。

已实现按天统一文件与 console 输出、20 MiB 时间命名轮转和 15 天清理、级别过滤、renderer 采集及 Rust napi 回调。`just check`、`just test`（63 项 Rust、4 项 napi、3 项桌面日志测试及 Go 测试）通过，napi debug 与桌面生产构建通过。日志测试验证了来源标记与统一写入、console 输出、错误记录、轮转时间命名及同毫秒防覆盖、跨天切换、15 天清理边界与生产级别过滤；napi 测试验证了回调投递和重复初始化。

确认当前工作区 Electron 与开发监听进程的 cwd、绝对路径和父子关系后执行 `just rs`，初版验证了 main 和 renderer 各自落盘；统一文件后进一步验证共同写入及交替触发轮转；按天方案测试确认保留各次轮转备份，不再覆盖上一份。未冷启动新的开发实例，未添加日志上传。

## 后续工作

- 日志上传：后续单独设计和实现，本轮仅提供本地 console 与文件输出。

测试目录整理：原 desktop 的 source-location 测试迁入共享包，拆为 test/vite.test.mjs 和 test/runtime.test.mjs，与既有 Babel 测试统一；应用日志测试位于 desktop/tests/logging.test.mjs。8 项共享包测试及应用日志回归通过，根 scripts/benchmark-log-source.mjs 完整执行通过。
