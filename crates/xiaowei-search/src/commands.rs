use crate::{pinyin, scoring::FuzzyScorer, Action, SearchHit};

pub fn search(query: &str, development: bool) -> Vec<SearchHit> {
    let entries = [
        ("clipboard", "剪贴板", &["clipboard", "粘贴板", "剪贴板历史"][..], true),
        (
            "toggle-system-theme",
            "切换系统主题",
            &[
                "浅色",
                "亮色",
                "深色",
                "暗色",
                "黑暗",
                "主题",
                "系统主题",
                "light",
                "dark",
                "theme",
            ][..],
            cfg!(target_os = "macos"),
        ),
        ("rs", "rs", &["reload", "rebuild"][..], development),
    ];
    let mut scorer = FuzzyScorer::new(query);
    entries
        .into_iter()
        .filter(|entry| entry.3)
        .filter_map(|(id, title, aliases, _)| {
            let variants = pinyin::haystacks(title);
            let score = scorer.best(
                std::iter::once(title).chain(aliases.iter().copied()),
                variants.iter().map(String::as_str),
            )?;
            let key = format!("command:{id}");
            Some(SearchHit {
                id: key.clone(),
                recency_key: key,
                title: title.into(),
                provider: "command".into(),
                label: "命令".into(),
                score,
                ranges: Vec::new(),
                action: Action::RunCommand(id.into()),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_matches_aliases() {
        for query in ["剪贴板", "clipboard", "jiantieban", "jtb"] {
            assert!(search(query, false).iter().any(|hit| hit.id == "command:clipboard"));
        }
    }

    #[test]
    fn rs_requires_development_host() {
        for query in ["rs", "reload", "rebuild"] {
            assert!(!search(query, false).iter().any(|hit| hit.id == "command:rs"));
            assert!(search(query, true).iter().any(|hit| hit.id == "command:rs"));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn theme_matches_chinese_english_and_pinyin() {
        for query in ["主题", "深色", "dark", "theme", "qiehuanxitongzhuti", "qhxtzt"] {
            assert!(search(query, false)
                .iter()
                .any(|hit| hit.id == "command:toggle-system-theme"));
        }
    }
}
