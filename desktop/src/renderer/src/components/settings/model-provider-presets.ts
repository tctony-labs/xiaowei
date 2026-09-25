import { deepseekFlashThinkingLevelMap, deepseekProThinkingLevelMap } from "./thinking-level-presets";

// Preview catalog checked against Pi 0.85.1 bundled provider data. No SDK import in renderer.
// Custom connections currently expose API-key authentication only.
export const modelProtocols = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

// DSH llm-deepseek/src/models.ts and defaults.ts: output is its default budget, not a published limit.
export const deepseekPresetModels = [
  {
    id: "deepseek-flash",
    name: "DeepSeek-V4.1-Flash",
    contextWindow: 1_000_000,
    maxOutput: 256_000,
    supportsImage: true,
    reasoning: true,
    thinkingLevelMap: deepseekFlashThinkingLevelMap,
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek-V4-Pro",
    contextWindow: 1_000_000,
    maxOutput: 256_000,
    supportsImage: false,
    reasoning: true,
    thinkingLevelMap: deepseekProThinkingLevelMap,
  },
];

export const providerPresets = [
  {
    id: "deepseek",
    name: "DeepSeek",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://api.deepseek.com",
      },
      {
        protocol: "anthropic-messages",
        baseUrl: "https://api.deepseek.com/anthropic",
      },
      {
        protocol: "openai-responses",
        baseUrl: "https://api.deepseek.com",
      },
    ],
    supportsWebSocket: false,
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: deepseekPresetModels,
  },
  {
    id: "openai",
    name: "OpenAI",
    connections: [
      {
        protocol: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    ],
    apiKeyEnv: "OPENAI_API_KEY",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    connections: [
      {
        protocol: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
      },
    ],
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  {
    id: "ant-ling",
    name: "Ant Ling",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://api.ant-ling.com/v1",
      },
    ],
    apiKeyEnv: "ANT_LING_API_KEY",
  },
  {
    id: "baseten",
    name: "Baseten",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://inference.baseten.co/v1",
      },
    ],
    apiKeyEnv: "BASETEN_API_KEY",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://api.cerebras.ai/v1",
      },
    ],
    apiKeyEnv: "CEREBRAS_API_KEY",
  },
  {
    id: "fireworks",
    name: "Fireworks",
    connections: [
      {
        protocol: "anthropic-messages",
        baseUrl: "https://api.fireworks.ai/inference",
      },
      {
        protocol: "openai-completions",
        baseUrl: "https://api.fireworks.ai/inference/v1",
      },
    ],
    apiKeyEnv: "FIREWORKS_API_KEY",
  },
  {
    id: "google",
    name: "Google",
    connections: [
      {
        protocol: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      },
    ],
    apiKeyEnv: "GEMINI_API_KEY",
  },
  {
    id: "groq",
    name: "Groq",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://api.groq.com/openai/v1",
      },
    ],
    apiKeyEnv: "GROQ_API_KEY",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://router.huggingface.co/v1",
      },
    ],
    apiKeyEnv: "HF_TOKEN",
  },
  {
    id: "kimi-coding",
    name: "Kimi For Coding",
    connections: [
      {
        protocol: "anthropic-messages",
        baseUrl: "https://api.kimi.com/coding",
      },
    ],
    apiKeyEnv: "KIMI_API_KEY",
  },
  {
    id: "minimax",
    name: "MiniMax",
    connections: [
      {
        protocol: "anthropic-messages",
        baseUrl: "https://api.minimax.io/anthropic",
      },
    ],
    apiKeyEnv: "MINIMAX_API_KEY",
  },
  {
    id: "minimax-cn",
    name: "MiniMax CN",
    connections: [
      {
        protocol: "anthropic-messages",
        baseUrl: "https://api.minimaxi.com/anthropic",
      },
    ],
    apiKeyEnv: "MINIMAX_CN_API_KEY",
  },
  {
    id: "mistral",
    name: "Mistral",
    connections: [
      {
        protocol: "mistral-conversations",
        baseUrl: "https://api.mistral.ai",
      },
    ],
    apiKeyEnv: "MISTRAL_API_KEY",
  },
  {
    id: "moonshotai",
    name: "Moonshot AI",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://api.moonshot.ai/v1",
      },
    ],
    apiKeyEnv: "MOONSHOT_API_KEY",
  },
  {
    id: "moonshotai-cn",
    name: "Moonshot AI CN",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://api.moonshot.cn/v1",
      },
    ],
    apiKeyEnv: "MOONSHOT_API_KEY",
  },
  {
    id: "nvidia",
    name: "NVIDIA",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://integrate.api.nvidia.com/v1",
      },
    ],
    apiKeyEnv: "NVIDIA_API_KEY",
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    connections: [
      {
        protocol: "anthropic-messages",
        baseUrl: "https://opencode.ai/zen/go",
      },
      {
        protocol: "openai-completions",
        baseUrl: "https://opencode.ai/zen/go/v1",
      },
      {
        protocol: "openai-responses",
        baseUrl: "https://opencode.ai/zen/go/v1",
      },
    ],
    apiKeyEnv: "OPENCODE_API_KEY",
  },
  {
    id: "opencode",
    name: "OpenCode Zen",
    connections: [
      {
        protocol: "anthropic-messages",
        baseUrl: "https://opencode.ai/zen",
      },
      {
        protocol: "google-generative-ai",
        baseUrl: "https://opencode.ai/zen/v1",
      },
      {
        protocol: "openai-completions",
        baseUrl: "https://opencode.ai/zen/v1",
      },
      {
        protocol: "openai-responses",
        baseUrl: "https://opencode.ai/zen/v1",
      },
    ],
    apiKeyEnv: "OPENCODE_API_KEY",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    connections: [
      {
        protocol: "anthropic-messages",
        baseUrl: "https://openrouter.ai/api",
      },
      {
        protocol: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1",
      },
    ],
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
  {
    id: "qwen-token-plan",
    name: "Qwen Token Plan",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      },
    ],
    apiKeyEnv: "QWEN_TOKEN_PLAN_API_KEY",
  },
  {
    id: "qwen-token-plan-cn",
    name: "Qwen Token Plan CN",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      },
    ],
    apiKeyEnv: "QWEN_TOKEN_PLAN_CN_API_KEY",
  },
  {
    id: "qwen-token-plan-individual",
    name: "Qwen Token Plan Individual",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      },
    ],
    apiKeyEnv: "QWEN_TOKEN_PLAN_API_KEY",
  },
  {
    id: "together",
    name: "Together",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://api.together.ai/v1",
      },
    ],
    apiKeyEnv: "TOGETHER_API_KEY",
  },
  {
    id: "vercel-ai-gateway",
    name: "Vercel AI Gateway",
    connections: [
      {
        protocol: "anthropic-messages",
        baseUrl: "https://ai-gateway.vercel.sh",
      },
    ],
    apiKeyEnv: "AI_GATEWAY_API_KEY",
  },
  {
    id: "xiaomi",
    name: "Xiaomi",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://api.xiaomimimo.com/v1",
      },
    ],
    apiKeyEnv: "XIAOMI_API_KEY",
  },
  {
    id: "xiaomi-token-plan-ams",
    name: "Xiaomi Token Plan AMS",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
      },
    ],
    apiKeyEnv: "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  },
  {
    id: "xiaomi-token-plan-cn",
    name: "Xiaomi Token Plan CN",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      },
    ],
    apiKeyEnv: "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  },
  {
    id: "xiaomi-token-plan-sgp",
    name: "Xiaomi Token Plan SGP",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
      },
    ],
    apiKeyEnv: "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  },
  {
    id: "zai",
    name: "Z.AI",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
      },
    ],
    apiKeyEnv: "ZAI_API_KEY",
  },
  {
    id: "zai-coding-cn",
    name: "Z.AI Coding CN",
    connections: [
      {
        protocol: "openai-completions",
        baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      },
    ],
    apiKeyEnv: "ZAI_CODING_CN_API_KEY",
  },
  {
    id: "xai",
    name: "xAI",
    connections: [
      {
        protocol: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
      },
    ],
    apiKeyEnv: "XAI_API_KEY",
  },
  {
    id: "radius",
    name: "Radius",
    connections: [
      {
        protocol: "pi-messages",
        baseUrl: "https://radius.pi.dev",
      },
    ],
    apiKeyEnv: "RADIUS_API_KEY",
  },
];
