# 桌面测试

本目录只放自动回归门禁测试及其运行器、初始化和 fixture；需要真实应用或外部凭据的手动验收工具放在 [`../scripts/`](../scripts/README.md)。

自动回归必须能在准备好项目依赖后独立运行，使用可控的本地服务、临时数据和测试凭据；不依赖个人环境变量中的 Key、真实外部服务、已运行的应用实例或人工操作。测试需要的环境变量由 fixture 显式提供，不能继承个人凭据。单元测试和本地集成测试都可作为门禁，目录边界不按测试层级划分。

手动工具自身的自动测试仍留在这里，以本地 fixture 驱动工具；工具连接真实服务的执行入口放在 `desktop/scripts/`，不因文件包含断言就归入本目录。

统一入口为 `pnpm --dir desktop test`，由 `run.mjs` 安排构建和执行顺序，不为每个实现模块另增 package script。该入口不启动 Electron，不访问真实远端模型，不触碰用户数据库或剪贴板。

| 位置 | 归属与依赖 |
| --- | --- |
| `*.test.mjs` | 缓存、日志、窗口等模块测试 |
| `main/` | 启动生命周期和 System service；mock Electron／宿主模块，不加载真实 Rust addon |
| `llm/` | 构建后的 Pi worker 与本地 SSE，验证请求映射、事件和取消 |
| `rust-napi/` | 真实 Rust napi 业务联调：Storage、搜索、剪贴板、资源、占用统计、运行时和 LLM 调用链 |
| `fixtures/` | 桌面测试共享辅助代码 |
| `src/renderer/src/**/*.test.tsx`（相对 desktop） | Vitest 组件测试 |

`run.mjs` 通过 `tsx --conditions=source` 加载 Gateway 源码，构建 desktop 自身 worker，再按需要构建正式 Agent／Storage／剪贴板 addon。Storage、LLM、xwapi 的 Rust 测试调用方使用 search 的 `gateway-fixtures`；其他业务回归只加载正式 addon。迁入的 TS 测试纳入 desktop 的 Node 类型检查。

测试 addon 的准备及正式导出检查复用 `scripts/tests/rust-napi-fixtures.mjs`。正式 debug 产物留在各包的 `napi/`，fixture 的 `.node`、`index.js` 和 `index.d.ts` 输出到 `target/rust-napi-tests/<name>/`，并补充 `type: commonjs` 的 `package.json`，使 napi 生成的加载器不受根工作区 ESM 设置影响。测试显式加载该目录或其中的 `.node`。fixture 不覆盖正式包，测试结束后无需重建恢复；即使构建或测试失败，仍检查正式包不含测试导出。

根 `pnpm test` 由 `scripts/tests/run.mjs` 先构建全部正式 debug addon，再构建 search／clipboard fixture，随后串行执行 workspace 测试。只有两套产物均准备成功后，才为 workspace 测试子进程设置内部标记 `XIAOWEI_TEST_NAPI_PREPARED=1`，使 Gateway 和 desktop 复用本轮产物。单独运行测试入口时不设置该标记，仍构建所需正式包与 fixture，不凭文件存在跳过构建。不要手动设置标记，也不要与相同 addon 的构建并行运行。

Gateway 的协议、权限、transport 与通用 worker 测试由 `pnpm gateway:test` 负责；不由该入口运行桌面业务测试。

## LLM 配置与真实模型验收

`llm/*.test.mjs` 自动覆盖配置解析、PB／Pi 转换、Completions／Responses／Anthropic Messages 本地 SSE、配置替换及在途隔离，不使用真实 Key。定向测试先构建 desktop：`pnpm --dir desktop build`，再执行 `pnpm --dir desktop exec tsx --conditions=source --test 'tests/llm/*.test.mjs'`。纯配置测试可直接运行 `pnpm --dir desktop exec tsx --conditions=source --test tests/llm/config.test.mjs`。

`llm/verify-provider.test.mjs` 用临时配置、假 Key 和本地 SSE 验证手动验收工具的执行与退出，不继承真实模型凭据。真实模型的手动入口见 [验收脚本](../scripts/README.md)。
