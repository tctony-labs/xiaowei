// Application-owned compatibility schema, aligned with Pi 0.85.1 field semantics.
import type { ModelCost } from "./models";

export type ChatTemplateKwargValue =
  | string
  | number
  | boolean
  | null
  | {
      $var: "thinking.enabled" | "thinking.effort" | "thinking.budget";
      omitWhenOff?: boolean;
    };

export type ThinkingTokenBudgetField = "thinking_token_budget" | "thinking_budget" | "thinking_budget_tokens";

export type SessionAffinityFormat = "openai" | "openai-nosession" | "openrouter";

export interface AnthropicAllowedFallbackModel {
  provider: string;
  model: string;
  cost: ModelCost;
}

export interface OpenAICompletionsCompat {
  supportsStore?: boolean;

  supportsDeveloperRole?: boolean;

  supportsReasoningEffort?: boolean;

  supportsUsageInStreaming?: boolean;

  supportsFinishReason?: boolean;

  maxTokensField?: "max_completion_tokens" | "max_tokens";

  requiresToolResultName?: boolean;

  requiresAssistantAfterToolResult?: boolean;

  requiresThinkingAsText?: boolean;

  requiresReasoningContentOnAssistantMessages?: boolean;

  thinkingFormat?:
    | "openai"
    | "openrouter"
    | "deepseek"
    | "together"
    | "baseten"
    | "zai"
    | "qwen"
    | "chat-template"
    | "qwen-chat-template"
    | "string-thinking"
    | "ant-ling";

  chatTemplateKwargs?: Record<string, ChatTemplateKwargValue>;

  chatTemplateArgs?: Record<string, ChatTemplateKwargValue>;

  openRouterRouting?: OpenRouterRouting;

  vercelGatewayRouting?: VercelGatewayRouting;

  zaiToolStream?: boolean;

  thinkingTokenBudgetField?: ThinkingTokenBudgetField;

  supportsThinkingTokenBudget?: boolean;

  supportsOpenAIGrammarTools?: boolean;

  supportsStrictMode?: boolean;

  cacheControlFormat?: "anthropic";

  sendSessionAffinityHeaders?: boolean;

  deferredToolsMode?: "kimi";

  sessionAffinityFormat?: SessionAffinityFormat;

  supportsLongCacheRetention?: boolean;

  vllmPriority?: number;
}

export interface OpenAIResponsesCompat {
  supportsDeveloperRole?: boolean;

  sessionAffinityFormat?: SessionAffinityFormat;

  supportsLongCacheRetention?: boolean;

  supportsStrictMode?: boolean;

  supportsOpenAIGrammarTools?: boolean;

  supportsAdditionalTools?: boolean;

  supportsToolSearch?: boolean;

  supportsExplicitPromptCacheMode?: boolean;

  supportsMaxOutputTokens?: boolean;
}

export interface AnthropicMessagesCompat {
  supportsEagerToolInputStreaming?: boolean;

  supportsLongCacheRetention?: boolean;

  sendSessionAffinityHeaders?: boolean;

  supportsCacheControlOnTools?: boolean;

  supportsTemperature?: boolean;

  forceAdaptiveThinking?: boolean;

  allowEmptySignature?: boolean;

  supportsStrictTools?: boolean;

  supportsMidConvoEffort?: boolean;

  allowedFallbackModels?: AnthropicAllowedFallbackModel[];

  supportsToolReferences?: boolean;
}

export interface BedrockCompat {
  supportsStrictMode?: boolean;
}

export interface OpenRouterRouting {
  allow_fallbacks?: boolean;

  require_parameters?: boolean;

  data_collection?: "deny" | "allow";

  zdr?: boolean;

  enforce_distillable_text?: boolean;

  order?: string[];

  only?: string[];

  ignore?: string[];

  quantizations?: string[];

  sort?:
    | string
    | {
        by?: string;

        partition?: string | null;
      };

  max_price?: {
    prompt?: number | string;

    completion?: number | string;

    image?: number | string;

    audio?: number | string;

    request?: number | string;
  };

  preferred_min_throughput?:
    | number
    | {
        p50?: number;

        p75?: number;

        p90?: number;

        p99?: number;
      };

  preferred_max_latency?:
    | number
    | {
        p50?: number;

        p75?: number;

        p90?: number;

        p99?: number;
      };
}

export interface VercelGatewayRouting {
  only?: string[];

  order?: string[];
}

export type ModelCompat = OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat | BedrockCompat;

export const compatibilityFields: Record<string, string | readonly string[]> = {
  supportsStore: "boolean",
  supportsDeveloperRole: "boolean",
  supportsReasoningEffort: "boolean",
  supportsUsageInStreaming: "boolean",
  supportsFinishReason: "boolean",
  maxTokensField: ["max_completion_tokens", "max_tokens"],
  requiresToolResultName: "boolean",
  requiresAssistantAfterToolResult: "boolean",
  requiresThinkingAsText: "boolean",
  requiresReasoningContentOnAssistantMessages: "boolean",
  thinkingFormat: [
    "openai",
    "openrouter",
    "deepseek",
    "together",
    "baseten",
    "zai",
    "qwen",
    "chat-template",
    "qwen-chat-template",
    "string-thinking",
    "ant-ling",
  ],
  chatTemplateKwargs: "object",
  chatTemplateArgs: "object",
  openRouterRouting: "object",
  vercelGatewayRouting: "object",
  zaiToolStream: "boolean",
  thinkingTokenBudgetField: ["thinking_token_budget", "thinking_budget", "thinking_budget_tokens"],
  supportsThinkingTokenBudget: "boolean",
  supportsOpenAIGrammarTools: "boolean",
  supportsStrictMode: "boolean",
  cacheControlFormat: ["anthropic"],
  sendSessionAffinityHeaders: "boolean",
  deferredToolsMode: ["kimi"],
  sessionAffinityFormat: ["openai", "openai-nosession", "openrouter"],
  supportsLongCacheRetention: "boolean",
  vllmPriority: "number",
  supportsAdditionalTools: "boolean",
  supportsToolSearch: "boolean",
  supportsExplicitPromptCacheMode: "boolean",
  supportsMaxOutputTokens: "boolean",
  supportsEagerToolInputStreaming: "boolean",
  supportsCacheControlOnTools: "boolean",
  supportsTemperature: "boolean",
  forceAdaptiveThinking: "boolean",
  allowEmptySignature: "boolean",
  supportsStrictTools: "boolean",
  supportsMidConvoEffort: "boolean",
  allowedFallbackModels: "array",
  supportsToolReferences: "boolean",
};
