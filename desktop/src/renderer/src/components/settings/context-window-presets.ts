/**
 * 手动覆盖的常用档位，其余走「自定义」填写 token 数。
 * 未覆盖时显示调用方提供的标签（接口值、默认值或未提供）。
 */
export const COMMON_CONTEXT_WINDOWS: Array<{ tokens: number; label: string }> = [
  { tokens: 192_000, label: "192K" },
  { tokens: 256_000, label: "256K" },
  { tokens: 1_000_000, label: "1M" },
];

export const COMMON_MAX_OUTPUT_TOKENS: Array<{ tokens: number; label: string }> = [
  { tokens: 4_096, label: "4K" },
  { tokens: 8_192, label: "8K" },
  { tokens: 16_384, label: "16K" },
  { tokens: 32_768, label: "32K" },
  { tokens: 65_536, label: "64K" },
  { tokens: 128_000, label: "128K" },
];
