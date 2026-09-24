use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug)]
pub enum StringPart<'a> {
    Chinese(&'a str),
    Others(&'a str),
}

impl PartialEq for StringPart<'_> {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (StringPart::Chinese(a), StringPart::Chinese(b)) => a == b,
            (StringPart::Others(a), StringPart::Others(b)) => a == b,
            _ => false,
        }
    }
}

/// Split a string into Chinese and non-Chinese parts
pub fn split_string<'a>(s: &'a str) -> Vec<StringPart<'a>> {
    let mut result: Vec<StringPart<'a>> = Vec::new();

    let mut last_index = 0;
    let mut in_ascii = s.chars().next().map(|c| c.is_ascii()).unwrap_or(false);
    for (index, grapheme) in s.grapheme_indices(true) {
        let is_ascii = grapheme.chars().next().unwrap_or_default().is_ascii();
        if is_ascii != in_ascii {
            let part = &s[last_index..index].trim();
            if !part.is_empty() {
                result.push(if in_ascii {
                    StringPart::Others(part)
                } else {
                    StringPart::Chinese(part)
                });
            }
            last_index = index;
            in_ascii = is_ascii;
        }
    }

    if last_index != s.len() {
        let part = &s[last_index..].trim();
        if !part.is_empty() {
            result.push(if in_ascii {
                StringPart::Others(part)
            } else {
                StringPart::Chinese(part)
            });
        }
    }

    result
}

pub trait StrExt {
    fn is_whitespace_or_punctuation(&self) -> bool;
}

impl StrExt for str {
    fn is_whitespace_or_punctuation(&self) -> bool {
        let chars: Vec<_> = self.chars().collect();
        if chars.len() != 1 {
            return false;
        }
        matches!(
            chars.first().unwrap(),
            ' ' | '\t'
                | '\n'
                | '\r'
                | ','
                | '.'
                | '!'
                | '?'
                | ';'
                | ':'
                | '-'
                | '_'
                | '('
                | ')'
                | '['
                | ']'
                | '{'
                | '}'
                | '"'
                | '\''
                | ','
                | '.'
                | '!'
                | '?'
                | ';'
                | ':'
                | '('
                | ')'
                | '['
                | ']'
                | '「'
                | '」'
                | '《'
                | '》'
                | '、'
        )
    }
}
