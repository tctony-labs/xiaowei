use jieba_rs::Jieba;
use lazy_static::lazy_static;

lazy_static! {
    static ref JIEBA: Jieba = Jieba::new();
}
lazy_static! {
    pub static ref CH_SEGMENTER: Box<dyn Segmenter> = Box::new(ChineseSegmenter::new());
}

#[allow(dead_code)]
#[derive(Clone)]
pub enum SegmentationMode {
    Index,
    Search,
}

pub trait Segmenter: Send + Sync {
    fn new() -> Self
    where
        Self: Default,
    {
        Self::default()
    }

    fn cut<'a>(&self, sentence: &'a str, mode: &SegmentationMode) -> Vec<&'a str>;
}

#[derive(Default)]
pub struct ChineseSegmenter {}

impl Segmenter for ChineseSegmenter {
    fn cut<'a>(&self, sentence: &'a str, mode: &SegmentationMode) -> Vec<&'a str> {
        match mode {
            // when indexing content, create more tokens as much as possible
            SegmentationMode::Index => JIEBA.cut_for_search(sentence, true),
            // when searching, search term should be precise and simple
            SegmentationMode::Search => JIEBA.cut(sentence, true),
        }
    }
}
