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

## Renderer 用例范围与交互

每个用例围绕一个可观察行为组织。已有 preview 的初始状态能直接进入目标场景时，优先使用它，减少重复打开页面、填写表单和切换菜单。合并重复用例前核对断言的去向，保留成功、失败、取消及相关边界；保存行为应检查提交后的结果，字段往返应保存后重新打开验证，不能只断言按钮可点或弹窗关闭。

表单测试只需设置最终字段值时可用 `fireEvent.change`；验证键盘、焦点、逐字输入或事件顺序时仍用 `userEvent`。使用 `within` 限定目标 dialog／group，嵌套弹窗和 portal 则从实际挂载位置查询，避免整页反复扫描或误选同名控件。同步 matcher 直接 `expect`，`await expect(...)` 不会自动等待状态变化；异步状态通过完成操作、推进虚拟时间或真实时钟下的异步查询来等待。

模型预览的交互与字段往返见 [Models.test.tsx](../src/renderer/src/components/settings/Models.test.tsx)；产品页的 Gateway 请求、revision、隐藏字段保留和流取消见 [ModelSettingsPage.test.tsx](../src/renderer/src/components/settings/ModelSettingsPage.test.tsx)。预览覆盖不能代替产品接入测试。

## Renderer 的虚拟时钟测试

组件测试中，模拟请求延迟、toast 自动消失和临时高亮等由 JavaScript 计时器驱动的行为，使用 Vitest 虚拟时钟验证，避免测试真的等待几百毫秒或几秒。只在需要的测试或阶段启用，不改变产品及 Storybook 的计时逻辑，不在全局 `setup.ts` 中启用。

优先用 `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })` 接管所需计时器。Gateway 测试的事件投递使用 `setImmediate`，应保留它的真实调度，避免只推进 timeout 时事件无法送达。

React 状态更新通过 `act` 包住 `vi.advanceTimersByTimeAsync`，推进到指定时间后直接断言。检查到期前和到期后的状态；重复操作会重新计时的行为，还要验证旧的到期时间不会提前清除新状态。例如已显示的三秒 toast：

```ts
await act(async () => vi.advanceTimersByTimeAsync(2999));
expect(toast).toBeVisible();

await act(async () => vi.advanceTimersByTimeAsync(1));
expect(screen.queryByText("已保存")).toBeNull();
```

与 Testing Library 配合时：

- 使用 `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })`，让用户事件自身的延迟也能推进。
- 当前 Testing Library 的默认 `asyncWrapper` 会等待零延迟 timeout，Vitest 不会自动推进它。全程使用虚拟时钟的组件测试可在该测试文件内将 `asyncWrapper` 配置为通过 `act` 执行回调，并在清理时恢复原配置；参考 [模型预览测试](../src/renderer/src/components/settings/Models.test.tsx)。
- 不依赖 `waitFor`／`findBy*` 替测试推进虚拟时间。先完成异步操作及时间推进，再使用 `getBy*`／`queryBy*` 断言；真实时钟阶段仍可使用异步查询。
- 在 `afterEach` 或 `finally` 中先 `cleanup()` 卸载组件，再恢复 Testing Library 配置（若有修改）并调用 `vi.useRealTimers()`，即使断言失败也应恢复。

更多示例见 [产品 toast 测试](../src/renderer/src/components/settings/ModelSettingsPage.test.tsx)、[导航高亮重置测试](../src/renderer/src/components/settings/SettingsPage.test.tsx) 和 [Quick Chat 切换测试](../src/renderer/src/components/quick-chat/QuickChatTransition.test.tsx)。切换测试分别断言动画到期前仍保留 composer、到期后卸载并恢复搜索焦点，以及快速反向操作取消旧计时器。renderer 全量测试可单独执行 `pnpm --dir desktop exec vitest run`。真实进程、网络、Rust 或其他 worker 的集成等待不能仅靠当前 JavaScript 测试上下文的虚拟时钟推进。

## LLM 配置与真实模型验收

`llm/*.test.mjs` 自动覆盖配置解析、PB／Pi 转换、Completions／Responses／Anthropic Messages 本地 SSE、配置替换及在途隔离，不使用真实 Key。定向测试先构建 desktop：`pnpm --dir desktop build`，再执行 `pnpm --dir desktop exec tsx --conditions=source --test 'tests/llm/*.test.mjs'`。纯配置测试可直接运行 `pnpm --dir desktop exec tsx --conditions=source --test tests/llm/config.test.mjs`。

`llm/verify-provider.test.mjs` 用临时配置、假 Key 和本地 SSE 验证手动验收工具的执行与退出，不继承真实模型凭据。真实模型的手动入口见 [验收脚本](../scripts/README.md)。
