# 桌面手动验收脚本

此目录存放需要显式执行的验收工具，不纳入 `pnpm --dir desktop test`。自动回归门禁及其辅助代码放在 [`../tests/`](../tests/README.md)，工具自身的自动测试同样使用本地 fixture，不依赖真实凭据。

需要真实 API Key、外部服务、应用实例或人工操作的验收入口放在这里，即使脚本内部包含自动断言，也不作为自动回归门禁。每个工具应说明前置条件、调用方式和副作用，由使用者显式运行；不要由安装、构建或自动测试入口间接触发。

可用本地 fixture 稳定验证的行为应加入 `desktop/tests/`，包括这些工具自身的参数、退出码和清理行为。工作区共用的开发／构建／测试编排工具继续放在根目录 `scripts/`。

## 真实 LLM 调用

先构建 Gateway 和 desktop：

```sh
pnpm --filter xiaowei-gateway build
pnpm --dir desktop build
```

设置 `XIAOWEI_LLM_CONFIG` 为模型配置 JSON 文件的绝对路径，Key 由条目的 `apiKeyEnv` 引用。配置格式和更新语义见 [LLM record](../../.agent/records/active/2026-09-24-llm-provider.md)。例如：

```sh
XIAOWEI_LLM_CONFIG=/absolute/path/models.json \
  pnpm --dir desktop exec tsx scripts/verify-llm.mjs --model <本地配置ID> --mode complete
```

脚本通过 Gateway 调用构建后的 LLM worker 与真实 API，不启动 Electron，只输出脱敏验证结果。

| 模式 | 验证内容 |
| --- | --- |
| `complete` | 文本、用量与唯一成功终态 |
| `cancel` | 首个文本增量后取消 |
| `thinking` | 推理增量、最终推理块及答案 |
| `cancel-thinking` | 首个推理增量后取消 |
| `tools` | echo 工具参数、历史回放及结果回传后的第二轮生成 |
| `image` | 发送内置有效 PNG，配置的 input 须包含 image |
| `catalog` | 通过 Gateway 拉取远端模型列表 |

工具结果由脚本固定提供，service 不执行工具。取消确认不等于上游停止计费；真实 Node worker 验证不能替代 Electron 应用包验收。
