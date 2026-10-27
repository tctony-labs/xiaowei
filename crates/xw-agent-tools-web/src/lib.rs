//! Independently assembled web tools. No settings, persistence or credential lookup.
mod fetch;
mod search;

pub use fetch::WebFetch;
pub use search::{
    BingSearch, BraveSearch, SearchError, SearchFuture, SearchRequest, SearchResult, SearchTool,
    SerperSearch, TavilySearch, WebSearch,
};

#[cfg(test)]
mod tests;
