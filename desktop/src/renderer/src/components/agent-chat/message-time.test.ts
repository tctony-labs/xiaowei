import { expect, test } from "vitest";
import { formatMessageTime } from "./message-time";

const now = 1_800_000_000_000;

test.each([
  [0, "刚刚"],
  [59_999, "刚刚"],
  [60_000, "1 分钟前"],
  [59 * 60_000, "59 分钟前"],
  [60 * 60_000, "1 小时前"],
  [24 * 60 * 60_000, "1 天前"],
  [30 * 24 * 60 * 60_000, "1 个月前"],
  [12 * 30 * 24 * 60 * 60_000, "1 年前"],
])("message age %s follows the old chat format %s", (age, expected) => {
  expect(formatMessageTime(BigInt(now - age), now)).toBe(expected);
});

test("missing or unsupported recorded timestamps do not invent a time", () => {
  expect(formatMessageTime(0n, now)).toBeUndefined();
  expect(formatMessageTime(9_007_199_254_740_992n, now)).toBeUndefined();
});
