//! 搜索类 provider 的**共享模糊打分**。
//!
//! 所有「搜索类」provider（书签 / 应用 / 未来更多）都必须走这里打分，保证跨 provider 的分数
//! **同量纲**（统一 `Config` / `CaseMatching` / `Normalization` + 多 haystack 取 max）。这样
//! SearchEngine 合并后按分数排序才有意义——某个 provider 私自换打分口径会
//! 让分数不可比、排序失真。固定顺序类 provider（如计算器，`pinned`）不参与打分，故不用本模块。

use crate::pinyin;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};

fn is_cjk(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}')
}

/// query 为纯 ASCII 且含字母时才启用拼音匹配（用户直打中文则走原文匹配）。
pub fn query_wants_pinyin(q: &str) -> bool {
    !q.chars().any(is_cjk) && q.chars().any(|c| c.is_ascii_alphabetic())
}

/// 长度修正权重：`final = nucleo原始分 + W · (query长 / haystack长)`。
///
/// query 长对同一次查询是常量，故该项 ∝ `1 / haystack长`——**命中同一子串时 haystack 越长分越低**
/// （nucleo 只在命中区间内算分，不惩罚尾部冗余，这里补上）。取小值（nucleo 单字符基准分 = 16，
/// 这里满覆盖也只 +4，约 1/4 个字符）：主要用于**破同分**，不会让强匹配的长标题被弱匹配的短标题
/// 反超。「子串起始位置越靠后分越低」交给 `Config::prefer_prefix`，不在此重复计分。
const LENGTH_TIEBREAK_WEIGHT: f32 = 4.0;

fn char_len(s: &str) -> u32 {
    s.chars().count() as u32
}

/// 单次查询的模糊匹配器：统一 nucleo 配置，逐 query 构造后对多个 haystack 打分。
pub struct FuzzyScorer {
    pattern: Pattern,
    matcher: Matcher,
    buf: Vec<char>,
    want_pinyin: bool,
    query_len: u32,
}

impl FuzzyScorer {
    /// 为一次查询构造。`query` 应为调用方 trim 后的内容。
    pub fn new(query: &str) -> Self {
        // prefer_prefix：为靠近 haystack 起始的命中加（有界的）bonus——起始越靠后 bonus 越小，
        // 等价于「子串位置越靠后分越低」。nucleo 文档明确其为「用户会打出整段匹配」的
        // autocompletion 场景设计，正是启动器的用法。
        let mut config = Config::DEFAULT;
        config.prefer_prefix = true;
        Self {
            // Ignore 而非 Smart：启动器一律大小写不敏感。Smart 会因 query 含大写而转为敏感，
            // 导致 `weixiN` 匹配不到全小写的拼音 haystack `weixin`。
            pattern: Pattern::parse(query, CaseMatching::Ignore, Normalization::Smart),
            matcher: Matcher::new(config),
            buf: Vec::new(),
            want_pinyin: query_wants_pinyin(query),
            query_len: char_len(query),
        }
    }

    /// 对单个 haystack 打 nucleo 原始分（不含长度修正）。
    pub fn score(&mut self, haystack: &str) -> Option<u32> {
        self.pattern
            .score(Utf32Str::new(haystack, &mut self.buf), &mut self.matcher)
    }

    /// 在原始分基础上叠加长度修正，得到可用于排序的最终分。
    fn rank(&self, raw: u32, hay_len: u32) -> f32 {
        let hay_len = hay_len.max(1) as f32;
        raw as f32 + LENGTH_TIEBREAK_WEIGHT * (self.query_len as f32 / hay_len)
    }

    /// 对一组 haystack 取最优并叠加长度修正：`base` 始终参与；`pinyin`（预生成的拼音变体）仅当
    /// query 为 ASCII 字母串时参与。命中优先取 nucleo 原始分最高者，**同分取更短的 haystack**
    /// （更相关），再据其长度算长度修正。全不命中返回 `None`。
    pub fn best<'a>(
        &mut self,
        base: impl IntoIterator<Item = &'a str>,
        pinyin: impl IntoIterator<Item = &'a str>,
    ) -> Option<f32> {
        let mut best: Option<(u32, u32)> = None;
        for hs in base {
            if let Some(s) = self.score(hs) {
                keep_best(&mut best, s, char_len(hs));
            }
        }
        if self.want_pinyin {
            for hs in pinyin {
                if let Some(s) = self.score(hs) {
                    keep_best(&mut best, s, char_len(hs));
                }
            }
        }
        best.map(|(raw, len)| self.rank(raw, len))
    }

    /// 计算 query 在 `title` 上的**精确高亮区间**（`title` 字符/码点下标，`[start, end)` 半开、
    /// 升序、已合并连续）。用于展示的 ≤N 条结果，成本可忽略。
    ///
    /// 候选（都**映射回 title**，故 url 之类不展示的 haystack 不参与）：
    /// 1. `title` 原文（恒等映射）——覆盖英文 / 中文原文命中；
    /// 2. `title` 的拼音变体（owner 映射回汉字）——覆盖拼音 / 首字母命中，仅 ASCII 字母 query。
    ///
    /// 取 nucleo 分最高的候选，把其**实际命中的字符下标**（`Pattern::indices`）经 owner 映射回
    /// title 字符，合并成区间。与打分同一套 `Pattern`/`Config`，命中一致；无命中返回空 `Vec`。
    pub fn highlight_ranges(&mut self, title: &str) -> Vec<(u32, u32)> {
        let mut best_score: Option<u32> = None;
        let mut best_positions: Vec<u32> = Vec::new();
        let mut idx_buf: Vec<u32> = Vec::new();

        // 候选 1：title 原文，命中下标即 title 字符下标（恒等映射）。
        idx_buf.clear();
        if let Some(score) = self
            .pattern
            .indices(Utf32Str::new(title, &mut self.buf), &mut self.matcher, &mut idx_buf)
        {
            best_score = Some(score);
            best_positions = idx_buf.clone();
        }

        // 候选 2：拼音变体，命中下标经 owners 映射回 title 字符下标。
        if self.want_pinyin {
            for hay in pinyin::haystacks_with_owners(title) {
                idx_buf.clear();
                if let Some(score) =
                    self.pattern
                        .indices(Utf32Str::new(&hay.text, &mut self.buf), &mut self.matcher, &mut idx_buf)
                {
                    // 严格大于：同分保留 title 原文候选（更直观）。
                    if best_score.is_none_or(|b| score > b) {
                        best_score = Some(score);
                        best_positions = idx_buf
                            .iter()
                            .filter_map(|&p| hay.owners.get(p as usize).copied())
                            .collect();
                    }
                }
            }
        }

        if best_positions.is_empty() {
            return Vec::new();
        }
        best_positions.sort_unstable();
        best_positions.dedup();
        merge_positions(&best_positions)
    }
}

/// 升序去重的字符下标合并成连续区间 `[start, end)`。
fn merge_positions(sorted: &[u32]) -> Vec<(u32, u32)> {
    let mut out: Vec<(u32, u32)> = Vec::new();
    for &p in sorted {
        match out.last_mut() {
            Some(last) if last.1 == p => last.1 = p + 1,
            _ => out.push((p, p + 1)),
        }
    }
    out
}

/// 保留「更优」的候选：原始分更高，或同分但 haystack 更短。
fn keep_best(best: &mut Option<(u32, u32)>, score: u32, len: u32) {
    let better = match *best {
        None => true,
        Some((bs, bl)) => score > bs || (score == bs && len < bl),
    };
    if better {
        *best = Some((score, len));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wants_pinyin_only_for_ascii_alpha() {
        assert!(query_wants_pinyin("wx"));
        assert!(query_wants_pinyin("weixin"));
        assert!(!query_wants_pinyin("微信"), "含中文时走原文匹配");
        assert!(!query_wants_pinyin("123"), "纯数字不启用拼音");
    }

    #[test]
    fn base_haystack_always_scored() {
        let mut s = FuzzyScorer::new("git");
        assert!(s.best(["GitHub"], std::iter::empty()).is_some());
    }

    #[test]
    fn pinyin_only_counts_for_ascii_query() {
        // 中文 query 不吃拼音 haystack。
        let mut s = FuzzyScorer::new("微信");
        assert!(s.best(["微信"], ["weixin"]).is_some(), "原文命中");
        let mut s2 = FuzzyScorer::new("微信");
        assert!(s2.best(["别的"], ["weixin"]).is_none(), "中文 query 不走拼音 haystack");
        // ASCII 字母 query 吃拼音 haystack。
        let mut s3 = FuzzyScorer::new("weixin");
        assert!(s3.best(["微信"], ["weixin"]).is_some());
    }

    #[test]
    fn highlight_literal_contiguous_prefix() {
        let mut s = FuzzyScorer::new("git");
        assert_eq!(s.highlight_ranges("GitHub"), vec![(0, 3)], "高亮 Git");
    }

    #[test]
    fn highlight_literal_fuzzy_subsequence() {
        // 非连续子序列命中：G..H → 两段。正则子串反而高亮不出，这里能精确高亮。
        let mut s = FuzzyScorer::new("gh");
        assert_eq!(s.highlight_ranges("GitHub"), vec![(0, 1), (3, 4)]);
    }

    #[test]
    fn highlight_literal_cjk_query() {
        let mut s = FuzzyScorer::new("微信");
        assert_eq!(s.highlight_ranges("微信读书"), vec![(0, 2)]);
    }

    #[test]
    fn highlight_pinyin_covers_only_matched_chars() {
        // 关键用例：微信读书 打 weixin 只高亮「微信」，不含「读书」。
        let mut s = FuzzyScorer::new("weixin");
        assert_eq!(s.highlight_ranges("微信读书"), vec![(0, 2)]);
    }

    #[test]
    fn highlight_pinyin_initials() {
        let mut s = FuzzyScorer::new("wx");
        assert_eq!(s.highlight_ranges("微信"), vec![(0, 2)]);
    }

    #[test]
    fn highlight_pinyin_partial_last_syllable() {
        // 正在输入：weix 覆盖 微(wei) + 信(x 为 xin 前缀) → 高亮微信。
        let mut s = FuzzyScorer::new("weix");
        assert_eq!(s.highlight_ranges("微信读书"), vec![(0, 2)]);
    }

    #[test]
    fn highlight_pinyin_non_leading_segment() {
        // 命中不在开头：官方微信 打 weixin → 只高亮微信（下标 2..4）。
        let mut s = FuzzyScorer::new("weixin");
        assert_eq!(s.highlight_ranges("官方微信"), vec![(2, 4)]);
    }

    #[test]
    fn highlight_empty_when_no_match() {
        let mut s = FuzzyScorer::new("zzz");
        assert!(s.highlight_ranges("微信").is_empty());
    }

    #[test]
    fn matching_is_case_insensitive_even_with_uppercase_query() {
        // 含大写的 query 也应命中全小写 haystack（拼音 haystack 恒为小写）。
        let mut s = FuzzyScorer::new("weixiN");
        assert!(s.best(std::iter::empty(), ["weixin"]).is_some(), "weixiN 应匹配 weixin");
    }

    #[test]
    fn longer_haystack_scores_lower_on_same_substring() {
        // 同为前缀命中「git」，nucleo 原始分相同，长度修正让更短的 haystack 分更高。
        let mut s = FuzzyScorer::new("git");
        let short = s.best(["git"], std::iter::empty()).unwrap();
        let long = s.best(["gitlab"], std::iter::empty()).unwrap();
        assert!(short > long, "更短 haystack 应更高: {short} vs {long}");
    }

    #[test]
    fn earlier_match_scores_higher_via_prefer_prefix() {
        // prefer_prefix：靠前命中（前缀）应比靠后命中分更高。
        let mut s = FuzzyScorer::new("set");
        let prefix = s.best(["settings"], std::iter::empty()).unwrap();
        let later = s.best(["offset"], std::iter::empty()).unwrap();
        assert!(prefix > later, "前缀命中应更高: {prefix} vs {later}");
    }
}
