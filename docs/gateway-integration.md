# 桌面 Gateway 接入

本文说明 XiaoWei 的业务装配、renderer 调用与构建接入。通用传输语义见 [Gateway 运行机制](gateway-runtime.md)，维护入口见 [Gateway README](../gateway/README.md)。实现入口为 [main Gateway](../desktop/src/main/app/gateway.ts) 和 [renderer services](../desktop/src/renderer/src/services.ts)。

## 业务装配与调用

桌面 main 只创建一个 host。数据库连接池由 Storage 统一持有，`Storage.open()` 在返回前完成 meta 表自举和内部注册的迁移；随后接入 KeyValue、ClipboardDao、Settings，再接入 Search 和剪贴板业务 endpoint。`createSearchGatewayEndpoint()` 与搜索预热共享同一个懒初始化服务；`ClipboardHistory.createGatewayEndpoint()` 使用该 history 的 Service，接入后的 `initialize()` 为其设置 Gateway client。后台调用使用 endpoint 激活后取得的宿主身份，业务嵌套请求保留原始权限。

当前原生搜索 endpoint 承载 Search／App／System.ToggleTheme；main 承载 System.OpenUrl 及 ClipboardBiz 的资源方法，route 无重复注册。具体原则见 [业务契约维护](../contracts/proto/xiaowei/README.md)。

## Renderer 调用

renderer 只暴露 `window.gateway`，业务调用使用 `services.ts` 中缓存的 lazy getter：每个 renderer 共享一个按需创建的 client，每个 service 首次使用时绑定并缓存，import 不建立 Electron 连接。Storybook／测试通过 `createServices(connect)` 注入独立 client。剪贴板页面显式等待事件订阅 ready 后查询首轮快照，卸载时关闭迟到订阅；窗口布局调用按序执行并处理 Promise 错误。日志使用 console-message 链路。

业务契约位于 `contracts/proto/xiaowei/`。实际 route 使用生成的 `package.Service.Method`，事件使用 message full name：例如 `xiaowei.clipboard.ClipboardBiz.List`、`xiaowei.clipboard.ClipboardChanged`。窗口、搜索结果 token、图标缓存、系统资源动作由 main 持有；CRUD、分类、收藏、图片字节及搜索引擎由各 Rust owner 执行。ID 在页面与展示模型的边界显式转换为 bigint，Rust 校验业务有效范围。

## 关闭与构建

退出时先关闭 Electron 接入、停止监听和注销业务 owner，再关闭 native 连接。

桌面 check 直接检查 Gateway 源码类型，main/preload/renderer 的开发与正式 Vite 构建均通过 `source` 条件加载 Gateway 源码，不预构建或改写 dist；Storybook 与验收资源构建同样选择源码入口。main/preload 的 SSR 解析也显式启用该条件。桌面打包内联 TS Gateway 与契约代码，搜索、剪贴板和 Storage 三个 `.node` 保持外置并从 ASAR 解包加载。

普通 Node 消费仍使用 dist，需先执行 `pnpm --filter xiaowei-gateway build`。桌面重启不通过重写 Gateway dist 触发 renderer HMR，真实源码变化仍可触发 HMR。

验证入口与执行前提见 [Gateway 共享验收](../gateway/tests/README.md)。

## 图标资源

搜索响应返回展示用 `iconUrl`，不返回 appPath，也不等待图片读取。`xiaowei-icon://app/<opaque-key>` 在 Electron 注册为资源协议，图片请求到来后先查询 main 的一周磁盘缓存，缺失或过期时调用 App.ReadIcon。并发请求共享读取 Promise，完成后释放内存中的图片引用，失败可重试。页面使用普通 img 和默认图标回退，不调用 Launcher.Icon。路径映射随 host 生命周期释放，磁盘缓存跨启动复用。
