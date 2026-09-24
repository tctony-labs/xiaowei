//! Tokenizer traits, borrowed from tantivy tokenizer-api.

use std::borrow::{Borrow, BorrowMut};
use std::ops::{Deref, DerefMut};

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct Token {
    pub offset_from: usize,
    pub offset_to: usize,
    pub position: usize,
    pub text: String,
    pub position_length: usize,
}

impl Default for Token {
    fn default() -> Token {
        Token {
            offset_from: 0,
            offset_to: 0,
            position: usize::MAX,
            text: String::new(),
            position_length: 1,
        }
    }
}

impl Token {
    pub fn reset(&mut self) {
        self.offset_from = 0;
        self.offset_to = 0;
        self.position = usize::MAX;
        self.text.clear();
        self.position_length = 1;
    }
}

pub trait Tokenizer: 'static + Clone + Send + Sync {
    type TokenStream<'a>: TokenStream;
    fn token_stream<'a>(&'a mut self, text: &'a str) -> Self::TokenStream<'a>;
}

pub struct BoxTokenStream<'a>(Box<dyn TokenStream + 'a>);

impl TokenStream for BoxTokenStream<'_> {
    fn advance(&mut self) -> bool {
        self.0.advance()
    }

    fn token(&self) -> &Token {
        self.0.token()
    }

    fn token_mut(&mut self) -> &mut Token {
        self.0.token_mut()
    }
}

impl<'a> BoxTokenStream<'a> {
    pub fn new<T: TokenStream + 'a>(token_stream: T) -> BoxTokenStream<'a> {
        BoxTokenStream(Box::new(token_stream))
    }
}

impl<'a> Deref for BoxTokenStream<'a> {
    type Target = dyn TokenStream + 'a;

    fn deref(&self) -> &Self::Target {
        &*self.0
    }
}
impl DerefMut for BoxTokenStream<'_> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut *self.0
    }
}

impl<'a> TokenStream for Box<dyn TokenStream + 'a> {
    fn advance(&mut self) -> bool {
        let token_stream: &mut dyn TokenStream = self.borrow_mut();
        token_stream.advance()
    }

    fn token<'b>(&'b self) -> &'b Token {
        let token_stream: &'b (dyn TokenStream + 'a) = self.borrow();
        token_stream.token()
    }

    fn token_mut<'b>(&'b mut self) -> &'b mut Token {
        let token_stream: &'b mut (dyn TokenStream + 'a) = self.borrow_mut();
        token_stream.token_mut()
    }
}

pub trait TokenStream {
    fn advance(&mut self) -> bool;
    fn token(&self) -> &Token;
    fn token_mut(&mut self) -> &mut Token;

    fn next(&mut self) -> Option<&Token> {
        if self.advance() { Some(self.token()) } else { None }
    }

    fn process(&mut self, sink: &mut dyn FnMut(&Token)) {
        while self.advance() {
            sink(self.token());
        }
    }
}

pub trait TokenFilter: 'static + Send + Sync {
    type Tokenizer<T: Tokenizer>: Tokenizer;
    fn transform<T: Tokenizer>(self, tokenizer: T) -> Self::Tokenizer<T>;
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn clone() {
        let t1 = Token {
            position: 1,
            offset_from: 2,
            offset_to: 3,
            text: "abc".to_string(),
            position_length: 1,
        };
        let t2 = t1.clone();

        assert_eq!(t1.position, t2.position);
        assert_eq!(t1.offset_from, t2.offset_from);
        assert_eq!(t1.offset_to, t2.offset_to);
        assert_eq!(t1.text, t2.text);
    }
}
