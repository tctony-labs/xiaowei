//! 中文文本的拼音「可匹配串」生成，供全局搜索（书签 / 应用 …）做拼音模糊匹配复用。
//!
//! 思路：把含中文的名字预生成若干拼音变体（全拼 + 首字母，支持多音字），使用方拿这些串和
//! 原文一起丢给 nucleo 打分，即可支持 `zhoubao` / `zb` → `周报`、`yinxing` → `银行` 这类搜索。

use pinyin::ToPinyinMulti;

/// 多音字展开时单个名字保留的最大拼音变体数，避免长名 + 多音字组合爆炸。
const MAX_PINYIN_VARIANTS: usize = 32;

/// 是否为常用汉字区间（基本汉字）。
pub fn is_cjk(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}')
}

/// 一条拼音可匹配串及其**字符归属映射**。
///
/// `owners[i]` = `text` 第 `i` 个字符（码点）对应的**源文本字符（码点）下标**：全拼里一个音节的
/// 每个字母都归属同一个汉字，首字母各归属一个字符，ASCII 字符归属自身。供搜索命中后把命中的
/// 拼音下标**映射回源文本字符区间**做精确高亮用。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinyinHaystack {
    pub text: String,
    pub owners: Vec<u32>,
}

/// 生成拼音可匹配串集合（全拼 + 首字母），支持多音字；无中文则返回空 `Vec`。
///
/// 见 [`haystacks_with_owners`]（本函数即取其 `text` 字段）。
///
/// 例：`银行` → `[yh, yinhang, yinxing, yx]`、`Q3周报` → `[q3zb, q3zhoubao]`。
pub fn haystacks(text: &str) -> Vec<String> {
    haystacks_with_owners(text).into_iter().map(|h| h.text).collect()
}

/// 同 [`haystacks`]，但每条附带**字符归属映射** `owners`（见 [`PinyinHaystack`]），供精确高亮。
///
/// 逐字展开笛卡尔积：多音字（如 `行` → hang/xing）派生多个变体；ASCII 字母/数字原样保留、
/// 小写；其余字符跳过（但仍占一个源字符下标）。变体数以 [`MAX_PINYIN_VARIANTS`] 封顶（保留最先
/// 出现、即最常见读音优先的组合）。按 `text` 去重后返回。
pub fn haystacks_with_owners(text: &str) -> Vec<PinyinHaystack> {
    if !text.chars().any(is_cjk) {
        return Vec::new();
    }

    // 每个 partial 累积 (全拼, 全拼 owners, 首字母, 首字母 owners)；遇多音字按读音分支，遇 ASCII
    // 追加到所有分支。owner 用源文本的**字符（码点）下标**（含被跳过的字符也计数，与前端
    // `Array.from(title)` 的下标一致）。
    struct Branch {
        full: String,
        full_owners: Vec<u32>,
        initials: String,
        initials_owners: Vec<u32>,
    }
    let mut partials: Vec<Branch> = vec![Branch {
        full: String::new(),
        full_owners: Vec::new(),
        initials: String::new(),
        initials_owners: Vec::new(),
    }];
    for (idx, c) in text.chars().enumerate() {
        let idx = idx as u32;
        if let Some(multi) = c.to_pinyin_multi() {
            let mut readings: Vec<&str> = multi.into_iter().map(|p| p.plain()).collect();
            readings.sort_unstable();
            readings.dedup();

            let mut next = Vec::with_capacity(partials.len() * readings.len());
            for b in &partials {
                for r in &readings {
                    let mut full = b.full.clone();
                    let mut full_owners = b.full_owners.clone();
                    full.push_str(r);
                    full_owners.extend(std::iter::repeat(idx).take(r.chars().count()));

                    let mut initials = b.initials.clone();
                    let mut initials_owners = b.initials_owners.clone();
                    if let Some(first) = r.chars().next() {
                        initials.push(first);
                        initials_owners.push(idx);
                    }
                    next.push(Branch {
                        full,
                        full_owners,
                        initials,
                        initials_owners,
                    });
                }
            }
            next.truncate(MAX_PINYIN_VARIANTS);
            partials = next;
        } else if c.is_ascii_alphanumeric() {
            let lc = c.to_ascii_lowercase();
            for b in partials.iter_mut() {
                b.full.push(lc);
                b.full_owners.push(idx);
                b.initials.push(lc);
                b.initials_owners.push(idx);
            }
        }
    }

    let mut out: Vec<PinyinHaystack> = Vec::new();
    for b in partials {
        if !b.full.is_empty() {
            out.push(PinyinHaystack {
                text: b.full,
                owners: b.full_owners,
            });
        }
        if !b.initials.is_empty() {
            out.push(PinyinHaystack {
                text: b.initials,
                owners: b.initials_owners,
            });
        }
    }
    // 按 text 去重：相同 text 的 owners 布局必然一致（源字符与音节长度决定），保留其一即可。
    out.sort_by(|a, b| a.text.cmp(&b.text));
    out.dedup_by(|a, b| a.text == b.text);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_full_and_initials() {
        let hs = haystacks("周报");
        assert!(hs.contains(&"zhoubao".to_string()));
        assert!(hs.contains(&"zb".to_string()));
    }

    #[test]
    fn mixes_ascii_and_cjk() {
        let hs = haystacks("Q3周报");
        assert!(hs.contains(&"q3zhoubao".to_string()));
        assert!(hs.contains(&"q3zb".to_string()));
    }

    #[test]
    fn empty_for_pure_ascii() {
        assert!(haystacks("GitHub").is_empty());
    }

    #[test]
    fn covers_heteronyms() {
        let hs = haystacks("银行");
        assert!(hs.contains(&"yinhang".to_string()), "缺 yinhang: {hs:?}");
        assert!(hs.contains(&"yinxing".to_string()), "缺 yinxing: {hs:?}");
        assert!(hs.contains(&"yh".to_string()), "缺 yh: {hs:?}");
        assert!(hs.contains(&"yx".to_string()), "缺 yx: {hs:?}");
    }

    #[test]
    fn bounded_for_many_heteronyms() {
        let hs = haystacks("重重重重重重重重重重");
        assert!(hs.len() <= MAX_PINYIN_VARIANTS * 2, "变体数超限: {}", hs.len());
    }

    fn find<'a>(hs: &'a [PinyinHaystack], text: &str) -> &'a PinyinHaystack {
        hs.iter()
            .find(|h| h.text == text)
            .unwrap_or_else(|| panic!("缺变体 {text}: {hs:?}"))
    }

    #[test]
    fn owners_map_full_pinyin_back_to_source_chars() {
        // 微(0)信(1)：weixin → owners 全为 [0,0,0,1,1,1]。
        let hs = haystacks_with_owners("微信");
        let full = find(&hs, "weixin");
        assert_eq!(full.owners, vec![0, 0, 0, 1, 1, 1]);
        assert_eq!(full.text.chars().count(), full.owners.len(), "owners 与 text 等长");
    }

    #[test]
    fn owners_map_initials_back_to_source_chars() {
        let hs = haystacks_with_owners("微信");
        let init = find(&hs, "wx");
        assert_eq!(init.owners, vec![0, 1]);
    }

    #[test]
    fn owners_account_for_leading_ascii_offset() {
        // Q(0)3(1)周(2)报(3)：全拼 q3zhoubao，owners = [0,1, 2,2,2,2, 3,3,3]。
        let hs = haystacks_with_owners("Q3周报");
        let full = find(&hs, "q3zhoubao");
        assert_eq!(full.owners, vec![0, 1, 2, 2, 2, 2, 3, 3, 3]);
    }

    #[test]
    fn haystacks_matches_owner_variant_texts() {
        // haystacks() 应与 haystacks_with_owners() 的 text 集合一致（委托关系）。
        let plain = haystacks("银行");
        let owned: Vec<String> = haystacks_with_owners("银行").into_iter().map(|h| h.text).collect();
        assert_eq!(plain, owned);
    }
}
