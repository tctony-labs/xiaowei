use std::mem;

use super::super::traits::{Token, TokenFilter, TokenStream, Tokenizer};

#[derive(Clone)]
pub struct LowerCaser;

impl TokenFilter for LowerCaser {
    type Tokenizer<T: Tokenizer> = LowerCaserFilter<T>;

    fn transform<T: Tokenizer>(self, tokenizer: T) -> Self::Tokenizer<T> {
        LowerCaserFilter {
            tokenizer,
            buffer: String::new(),
        }
    }
}

#[derive(Clone)]
pub struct LowerCaserFilter<T> {
    tokenizer: T,
    buffer: String,
}

impl<T: Tokenizer> Tokenizer for LowerCaserFilter<T> {
    type TokenStream<'a> = LowerCaserTokenStream<'a, T::TokenStream<'a>>;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> Self::TokenStream<'a> {
        self.buffer.clear();
        LowerCaserTokenStream {
            tail: self.tokenizer.token_stream(text),
            buffer: &mut self.buffer,
        }
    }
}

pub struct LowerCaserTokenStream<'a, T> {
    buffer: &'a mut String,
    tail: T,
}

fn to_lowercase_unicode(text: &str, output: &mut String) {
    output.clear();
    output.reserve(50);
    for c in text.chars() {
        output.extend(c.to_lowercase());
    }
}

impl<'a, T: TokenStream> TokenStream for LowerCaserTokenStream<'a, T> {
    fn advance(&mut self) -> bool {
        if !self.tail.advance() {
            return false;
        }
        if self.token_mut().text.is_ascii() {
            self.token_mut().text.make_ascii_lowercase();
        } else {
            to_lowercase_unicode(&self.tail.token().text, self.buffer);
            mem::swap(&mut self.tail.token_mut().text, self.buffer);
        }
        true
    }

    fn token(&self) -> &Token {
        self.tail.token()
    }

    fn token_mut(&mut self) -> &mut Token {
        self.tail.token_mut()
    }
}
