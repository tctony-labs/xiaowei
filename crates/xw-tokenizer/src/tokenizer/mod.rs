#![allow(unused)]

mod builder;
mod character;
mod filter;
mod segmentation;
mod standard;
pub mod traits;
mod utils;

use builder::TokenizerBuilder;
use character::CharacterTokenizer;
use filter::{LowerCaser, TextOnly};
use standard::StandardTokenizer;

pub use builder::BoxableTokenizer;
pub use traits::Tokenizer;

pub fn get_standard_index_tokenizer() -> Box<dyn BoxableTokenizer> {
    TokenizerBuilder::from(StandardTokenizer::new_indexing())
        .filter(LowerCaser)
        .build()
}

pub fn get_standard_search_tokenizer() -> Box<dyn BoxableTokenizer> {
    TokenizerBuilder::from(StandardTokenizer::new_searching())
        .filter(LowerCaser)
        .build()
}

pub fn get_character_tokenizer() -> Box<dyn BoxableTokenizer> {
    TokenizerBuilder::from(CharacterTokenizer)
        .filter(TextOnly)
        .filter(LowerCaser)
        .build()
}
