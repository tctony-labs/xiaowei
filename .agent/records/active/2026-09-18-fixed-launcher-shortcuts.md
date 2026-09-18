# 固定搜索与剪贴板快捷键

## Why

用户要求通过 Cmd+Space 唤起搜索框、Cmd+Shift+X 唤起剪贴板，暂不实现设置中的自定义快捷键。此前桌面只有 Cmd+Alt+Space 显示／隐藏当前窗口，没有剪贴板快捷键。

## What

为已有搜索和剪贴板界面增加固定全局入口，复用现有组件、存储和搜索逻辑，不改变 UI，不新增设置或配置存储。用户明确本次不需要 Storybook，直接接入桌面。

## How

macOS 固定注册 `Command+Space`（搜索）与 `CommandOrControl+Shift+X`（剪贴板）；其他平台保留 `Control+Alt+Space` 搜索，并使用 `Control+Shift+X` 打开剪贴板。同模式窗口可见且聚焦时再次触发隐藏；否则切到目标模式并显示、聚焦。跨模式时先调整窗口尺寸，再沿用鼠标所在屏幕定位。注册失败分别记录错误，不阻止另一个快捷键注册；退出时统一释放。

主进程通过限定的 `launcher:open` 通知目标模式；preload 暴露可取消订阅的 `launcher.onOpen`，不暴露任意 IPC。Launcher 跨模式切换时清空搜索，复用现有输入框挂载聚焦及窗口重新聚焦时全选行为。主进程通过已校验发送方、参数的 `launcher:resize` 同步当前模式，因此搜索结果进入剪贴板、Esc／Backspace 返回搜索后，快捷键仍按实际模式判断显隐。

旧版参考 `xiaowei-next/xiaowei/src-tauri/src/biz/shortcut/mod.rs` 的 `launcher_shortcut_behavior`、`dispatch_action`，以及 `biz/search/commands.rs` 的 `open_launcher`、`toggle_launcher`；前端参考 `xiaowei/src/pages/launcher/LauncherPage.tsx` 的 `launcher:open` 订阅。旧版主快捷键只切换显隐并保留当前模式；本次按“拉起搜索框”要求将 Cmd+Space 指向搜索模式，剪贴板中按下会切回搜索，不宣称这点与旧版相同。

## Outcome

已接入两个固定快捷键及模式通知，同步更新 Launcher 说明。移除了本次新增的 Storybook 预览，关闭了本工作区临时启动的 6007 服务，保留主工作区 6006 服务。

桌面类型检查、Biome、9 项 Node 测试及 Electron 构建通过；新增测试覆盖同模式显隐、隐藏／失焦唤起、跨模式调整尺寸并通知、无有效窗口时忽略。确认当前工作区 Electron、开发监听进程的绝对路径、cwd 及父子关系后执行 `just rs`；2026-09-18 16:33:55 的重启日志显示 main、renderer 与原生模块正常启动，未出现快捷键注册失败。用户随后确认功能正常，固定快捷键的桌面验收完成。自动测试使用窗口替身，原生按键行为以此次用户验收为依据。
