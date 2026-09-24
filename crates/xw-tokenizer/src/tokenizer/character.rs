use unicode_segmentation::UnicodeSegmentation;

use super::traits::{Token, TokenStream, Tokenizer};

/// Character-level tokenizer for CJK text
#[derive(Clone, Default)]
pub struct CharacterTokenizer;

impl Tokenizer for CharacterTokenizer {
    type TokenStream<'a> = CharacterTokenStream<'a>;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> Self::TokenStream<'a> {
        CharacterTokenStream::new(text)
    }
}

pub struct CharacterTokenStream<'a> {
    src: &'a str,
    index: usize,
    stream: unicode_segmentation::Graphemes<'a>,
    token: Token,
}

impl<'a> CharacterTokenStream<'a> {
    pub fn new(src: &'a str) -> Self {
        Self {
            src,
            index: 0,
            stream: src.graphemes(true),
            token: Default::default(),
        }
    }
}

impl<'a> TokenStream for CharacterTokenStream<'a> {
    fn advance(&mut self) -> bool {
        loop {
            if let Some(text) = self.stream.next() {
                let offset_from = text.as_ptr() as usize - self.src.as_ptr() as usize;
                let offset_to = offset_from + text.len();

                // ignore ascii chars
                if text.len() == 1 {
                    continue;
                }

                self.token = Token {
                    offset_from,
                    offset_to,
                    position: self.index,
                    text: text.to_string(),
                    position_length: 1,
                };

                self.index += 1;
                break true;
            } else {
                break false;
            }
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
    use super::*;

    #[test]
    fn test_character_tokenizer() {
        let mut tokenizer = CharacterTokenizer;
        let mut token_stream = tokenizer.token_stream("hello你好");

        let token = token_stream.next().unwrap();
        assert_eq!(token.text, "你");
        assert_eq!(token.offset_from, 5);
        assert_eq!(token.offset_to, 8);
        assert_eq!(token.position, 0);
        assert_eq!(token.position_length, 1);

        let token = token_stream.next().unwrap();
        assert_eq!(token.text, "好");
        assert_eq!(token.offset_from, 8);
        assert_eq!(token.offset_to, 11);
        assert_eq!(token.position, 1);
        assert_eq!(token.position_length, 1);
    }
}
