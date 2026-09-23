#[allow(dead_code)]
#[path = "../examples/generate_business.rs"]
mod generator;

#[test]
fn business_bindings_match_descriptors() {
    for module in generator::config::MODULES {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../crates")
            .join(module.name)
            .join("src/gateway_binding.rs");
        let actual = std::fs::read_to_string(path).unwrap();
        assert_eq!(generator::generate(module.services).unwrap(), actual, "{}", module.name);
    }
}
