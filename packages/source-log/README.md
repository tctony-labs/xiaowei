# 工作区日志源码定位

业务源码保持 `console.log/info/warn/error/debug/trace(...)`，构建时自动注入工作区相对路径和原始行号。运行时只调用平台原有的 console，不依赖 Electron、Node 文件系统或抓栈。

## Vite

构建宿主添加 `@xiaowei/source-log: workspace:*` 开发依赖，在每个需要转换的 Vite 配置中接入：

```ts
import { sourceLocationPlugin } from "@xiaowei/source-log/vite";

export default { plugins: [sourceLocationPlugin()] };
```

main、preload、renderer 已接入。插件默认开启，`XIAOWEI_LOG_SOURCE=0` 关闭；修改开关后重启 dev server。Vite 入口使用 Babel parser/traverse 识别原始调用，以 magic-string 改写并生成 source map。

## React Native / Metro

Metro 使用 Babel，不加载 Vite 插件。后续移动端添加该工作区开发依赖，在现有 `babel.config.js` / `.cjs` 的 `plugins` 中加入以下配置，保留项目原有 RN 或 Expo preset：

```js
plugins: [
  [require.resolve("@xiaowei/source-log/babel"), {
    enabled: process.env.XIAOWEI_LOG_SOURCE !== "0",
  }],
]
```

该入口是 CommonJS，使用宿主 Babel 的 AST 和代码生成，不额外解析源码。默认以共享包所在工作区为根目录，也可通过 `workspaceRoot` 传入绝对路径。源码位置在 TS/JSX 被移除之前读取。切换开关后重启 Metro 并清理缓存；React Native 可使用其启动命令的 `--reset-cache`，Expo 使用 `--clear`。

Metro 必须能访问工作区共享包和被引用的源码；按未来 RN/Expo 项目的 monorepo 配置确保 `projectRoot` / `watchFolders` 覆盖它们。此处未创建移动端项目或配置 Metro。已验证 Babel 转换和生成代码的执行，实际 Metro、Fast Refresh 和设备日志需在移动端接入时验证。日志收集、等级过滤与落盘由宿主负责。

## 范围与输出

所有进入已接入构建链的工作区 JS/TS/JSX/TSX 源码均可转换，例如 `packages/utils/src/index.ts`、`contracts/ts/src/index.ts` 和未来移动端源码。不自动处理绕过构建链的 Node 脚本、仅 tsc 编译的包、external 包或预打包依赖。排除工作区外文件、node_modules、dist/out/target/coverage/storybook-static/.git/.vite 目录以及日志包装器本身。

只转换全局 console 的直接方法调用，跳过局部声明／导入的 console、解构和别名调用、计算属性、可选调用及 `globalThis.console`。关闭后保留原始调用，不自动抓栈。

输出前缀示例：`[packages/utils/src/index.ts:12] 搜索完成`。首参数为字符串时保留格式占位符及后续参数；对象与 Error 仍交给原 console。各平台对复杂对象的最终呈现由其 console 决定。DevTools 的原生链接可能指向包装器，但日志文本包含原始源码位置。桌面收到已有位置前缀时不再追加打包产物位置。

## 测试

`pnpm --filter @xiaowei/source-log test` 执行 `test/vite.test.mjs`、`test/babel.test.mjs` 和 `test/runtime.test.mjs`，分别覆盖适配器转换及运行时参数保留。桌面实际构建配置的包入口解析由根目录 `scripts/dev/desktop-source-resolution.test.mjs` 验证；性能对比单独运行 `node scripts/benchmark-log-source.mjs`，不启动 Electron。
