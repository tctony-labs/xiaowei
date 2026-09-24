use std::str::CharIndices;

use super::segmentation::{CH_SEGMENTER, SegmentationMode};
use super::traits::{Token, TokenStream, Tokenizer};
use super::utils::{StringPart, split_string};

#[derive(Clone)]
pub struct StandardTokenizer {
    mode: SegmentationMode,
}

impl StandardTokenizer {
    pub fn new_indexing() -> Self {
        Self {
            mode: SegmentationMode::Index,
        }
    }

    #[allow(dead_code)]
    pub fn new_searching() -> Self {
        Self {
            mode: SegmentationMode::Search,
        }
    }

    pub fn split_text<'a>(text: &'a str, mode: &SegmentationMode) -> Vec<&'a str> {
        split_string(text)
            .into_iter()
            .flat_map(|part| match part {
                StringPart::Chinese(s) => CH_SEGMENTER.cut(s, mode),
                StringPart::Others(s) => Self::standard_cut(s),
            })
            .collect()
    }

    fn gen_tokens<'a>(&self, text: &'a str) -> Vec<&'a str> {
        Self::split_text(text, &self.mode)
    }

    fn standard_cut(text: &str) -> Vec<&str> {
        let mut result: Vec<_> = Vec::new();

        let mut chars = text.char_indices();

        let search_token_end = |chars: &mut CharIndices| -> usize {
            chars
                .filter(|(_, c)| !c.is_alphanumeric())
                .map(|(offset, _)| offset)
                .next()
                .unwrap_or(text.len())
        };

        while let Some((offset_from, c)) = chars.next() {
            if c.is_alphanumeric() {
                let offset_to = search_token_end(&mut chars);
                result.push(&text[offset_from..offset_to]);
            }
        }

        result
    }
}

impl Tokenizer for StandardTokenizer {
    type TokenStream<'a> = StandardTokenStream<'a>;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> Self::TokenStream<'a> {
        StandardTokenStream::new(text, self.gen_tokens(text))
    }
}

pub struct StandardTokenStream<'a> {
    src: &'a str,
    result: Vec<&'a str>,
    index: usize,
    token: Token,
}

impl<'a> StandardTokenStream<'a> {
    pub fn new(src: &'a str, result: Vec<&'a str>) -> Self {
        Self {
            src,
            result,
            index: 0,
            token: Token::default(),
        }
    }

    #[allow(dead_code)]
    #[cfg(test)]
    pub fn get_all_tokens(&mut self) -> Vec<Token> {
        let mut result = Vec::new();
        while self.advance() {
            result.push(self.token.clone());
        }
        result
    }
}

impl<'a> TokenStream for StandardTokenStream<'a> {
    fn advance(&mut self) -> bool {
        if self.index < self.result.len() {
            let text = self.result[self.index];
            let offset_from = text.as_ptr() as usize - self.src.as_ptr() as usize;
            let offset_to = offset_from + text.len();

            self.token = Token {
                offset_from,
                offset_to,
                position: self.index,
                text: text.to_lowercase(),
                position_length: 1,
            };

            self.index += 1;
            true
        } else {
            false
        }
    }

    fn token(&self) -> &Token {
        &self.token
    }

    fn token_mut(&mut self) -> &mut Token {
        &mut self.token
    }
}

#[cfg(test)]
mod test {
    use super::super::traits::{Token, TokenStream, Tokenizer};

    use super::StandardTokenizer;

    #[test]
    fn test_gen_tokens_index_mode() {
        let tokenizer = StandardTokenizer::new_indexing();

        let text = "测试用例";
        let tokens = tokenizer.gen_tokens(text);
        assert_eq!(tokens.len(), 3);
        assert_eq!(tokens[0], "测试");
        assert_eq!(tokens[1], "试用");
        assert_eq!(tokens[2], "测试用例");

        let text = "企业微信截图_20210824150947";
        let tokens = tokenizer.gen_tokens(text);
        assert_eq!(tokens.len(), 4);
        assert_eq!(tokens[0], "企业");
        assert_eq!(tokens[1], "微信");
        assert_eq!(tokens[2], "截图");
        assert_eq!(tokens[3], "20210824150947");

        let text = "Office使用指南";
        let tokens = tokenizer.gen_tokens(text);
        assert_eq!(tokens.len(), 4);
        assert_eq!(tokens[0], "Office");
        assert_eq!(tokens[1], "使用");
        assert_eq!(tokens[2], "指南");
        assert_eq!(tokens[3], "使用指南");
    }

    #[test]
    fn test_gen_tokens_search_mode() {
        let tokenizer = StandardTokenizer::new_searching();

        let text = "测试用例";
        let tokens = tokenizer.gen_tokens(text);
        eprintln!("{:?}", tokens);
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0], "测试用例");

        let text = "企业微信截图_20210824150947";
        let tokens = tokenizer.gen_tokens(text);
        assert_eq!(tokens.len(), 4);
        assert_eq!(tokens[0], "企业");
        assert_eq!(tokens[1], "微信");
        assert_eq!(tokens[2], "截图");
        assert_eq!(tokens[3], "20210824150947");

        let text = "Office使用指南";
        let tokens = tokenizer.gen_tokens(text);
        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0], "Office");
        assert_eq!(tokens[1], "使用指南");
    }

    #[test]
    fn test_standard_cut() {
        let text = "Hello, happy tax payer!";
        let tokens = StandardTokenizer::standard_cut(text);
        assert_eq!(tokens.len(), 4);
        assert_eq!(tokens[0], "Hello");
        assert_eq!(tokens[1], "happy");
        assert_eq!(tokens[2], "tax");
        assert_eq!(tokens[3], "payer");

        let text = "Hello 12345, good!";
        let tokens = StandardTokenizer::standard_cut(text);
        assert_eq!(tokens.len(), 3);
        assert_eq!(tokens[0], "Hello");
        assert_eq!(tokens[1], "12345");
        assert_eq!(tokens[2], "good");
    }

    #[test]
    fn test_token_stream() {
        let text = "测试用例";
        let mut tokenizer = StandardTokenizer::new_searching();
        let mut token_stream = tokenizer.token_stream(text);
        let mut result = Vec::new();
        while token_stream.advance() {
            let token = token_stream.token().clone();
            result.push(token);
        }
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0],
            Token {
                offset_from: 0,
                offset_to: 12,
                position: 0,
                text: "测试用例".to_string(),
                position_length: 1,
            }
        );

        let text = "企业微信截图_20210824150947";
        let mut token_stream = tokenizer.token_stream(text);
        let mut result = Vec::new();
        while token_stream.advance() {
            let token = token_stream.token().clone();
            result.push(token);
        }
        assert_eq!(result.len(), 4);
        assert_eq!(
            result[0],
            Token {
                offset_from: 0,
                offset_to: 6,
                position: 0,
                text: "企业".to_string(),
                position_length: 1,
            }
        );
        assert_eq!(
            result[1],
            Token {
                offset_from: 6,
                offset_to: 12,
                position: 1,
                text: "微信".to_string(),
                position_length: 1,
            }
        );
        assert_eq!(
            result[2],
            Token {
                offset_from: 12,
                offset_to: 18,
                position: 2,
                text: "截图".to_string(),
                position_length: 1,
            }
        );
        assert_eq!(
            result[3],
            Token {
                offset_from: 19,
                offset_to: 33,
                position: 3,
                text: "20210824150947".to_string(),
                position_length: 1,
            }
        );
    }
}
