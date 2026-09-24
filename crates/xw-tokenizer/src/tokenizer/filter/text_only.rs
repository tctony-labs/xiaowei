use super::super::traits::{Token, TokenFilter, TokenStream, Tokenizer};
use super::super::utils::StrExt;

/// Removes whitespace and punctuation tokens
#[derive(Clone)]
pub struct TextOnly;

impl TokenFilter for TextOnly {
    type Tokenizer<T: Tokenizer> = TextOnlyFilter<T>;

    fn transform<T: Tokenizer>(self, tokenizer: T) -> Self::Tokenizer<T> {
        TextOnlyFilter { tokenizer }
    }
}

#[derive(Clone)]
pub struct TextOnlyFilter<T> {
    tokenizer: T,
}

impl<T: Tokenizer> Tokenizer for TextOnlyFilter<T> {
    type TokenStream<'a> = TextOnlyTokenStream<T::TokenStream<'a>>;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> Self::TokenStream<'a> {
        TextOnlyTokenStream {
            tail: self.tokenizer.token_stream(text),
        }
    }
}

pub struct TextOnlyTokenStream<T> {
    tail: T,
}

impl<T: TokenStream> TokenStream for TextOnlyTokenStream<T> {
    fn advance(&mut self) -> bool {
        while self.tail.advance() {
            let text = self.token().text.as_str();
            if !text.is_whitespace_or_punctuation() {
                return true;
            }
        }
        false
    }

    fn token(&self) -> &Token {
        self.tail.token()
    }

    fn token_mut(&mut self) -> &mut Token {
        self.tail.token_mut()
    }
}
