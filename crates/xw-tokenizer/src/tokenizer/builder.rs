use super::traits::{BoxTokenStream, TokenFilter, Tokenizer};

pub struct TokenizerBuilder<T: Tokenizer> {
    tokenizer: T,
}

impl<T: Tokenizer> TokenizerBuilder<T> {
    pub fn from(tokenizer: T) -> Self {
        TokenizerBuilder { tokenizer }
    }

    pub fn filter<F: TokenFilter>(self, filter: F) -> TokenizerBuilder<F::Tokenizer<T>> {
        TokenizerBuilder {
            tokenizer: filter.transform(self.tokenizer),
        }
    }

    pub fn build(self) -> Box<dyn BoxableTokenizer> {
        Box::new(self.tokenizer)
    }
}

pub trait BoxableTokenizer: 'static + Send + Sync {
    fn box_token_stream<'a>(&'a mut self, text: &'a str) -> BoxTokenStream<'a>;
    fn box_clone(&self) -> Box<dyn BoxableTokenizer>;
}

impl Tokenizer for Box<dyn BoxableTokenizer> {
    type TokenStream<'a> = BoxTokenStream<'a>;

    fn token_stream<'a>(&'a mut self, text: &'a str) -> Self::TokenStream<'a> {
        (**self).box_token_stream(text)
    }
}

impl Clone for Box<dyn BoxableTokenizer> {
    fn clone(&self) -> Self {
        (**self).box_clone()
    }
}

impl<T: Tokenizer> BoxableTokenizer for T {
    fn box_token_stream<'a>(&'a mut self, text: &'a str) -> BoxTokenStream<'a> {
        BoxTokenStream::new(self.token_stream(text))
    }

    fn box_clone(&self) -> Box<dyn BoxableTokenizer> {
        Box::new(self.clone())
    }
}
