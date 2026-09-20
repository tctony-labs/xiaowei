#[allow(dead_code)]
#[path = "../examples/generate_business.rs"]
mod generator;

#[test]
fn business_bindings_match_descriptors() {
    assert_eq!(
        generator::generate("search"),
        include_str!("../../../crates/xiaowei-search/src/gateway_bindings.rs")
    );
    assert_eq!(
        generator::generate("clipboard"),
        include_str!("../../../crates/xiaowei-clipboard/src/gateway_bindings.rs")
    );
    assert_eq!(
        generator::generate("storage"),
        include_str!("../../../crates/xiaowei-storage/src/gateway_bindings.rs")
    );
}
