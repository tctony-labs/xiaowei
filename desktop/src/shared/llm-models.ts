// Common mappings checked against Pi 0.87.1. These describe capabilities, not provider-wide guarantees.
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

export const thinkingLevels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const deepseekFlashThinkingLevelMap: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};

export const deepseekProThinkingLevelMap: ThinkingLevelMap = {
  ...deepseekFlashThinkingLevelMap,
  low: null,
};

export const thinkingLevelPresets: Array<{ id: string; label: string; map: ThinkingLevelMap }> = [
  {
    id: "off-low-to-max",
    label: "关闭 / 低 / 中 / 高 / 更高 / 最高",
    map: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  },
  {
    id: "deepseek-low-high-max",
    label: "关闭 / 低 / 高 / 最高",
    map: deepseekFlashThinkingLevelMap,
  },
  {
    id: "deepseek-high-max",
    label: "关闭 / 高 / 最高",
    map: deepseekProThinkingLevelMap,
  },
  {
    id: "minimal-to-high",
    label: "最低 / 低 / 中 / 高",
    map: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null },
  },
  {
    id: "low-medium-high",
    label: "低 / 中 / 高",
    map: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
  },
  {
    id: "low-high-max",
    label: "低 / 高 / 最高",
    map: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
  },
];

export const defaultContextWindow = 131_072;
export const defaultMaxTokens = 16_384;

export function matchThinkingMap(map: ThinkingLevelMap | undefined) {
  return thinkingLevelPresets.find((preset) => thinkingLevels.every((level) => preset.map[level] === map?.[level]));
}
