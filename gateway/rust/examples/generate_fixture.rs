//! Test-only adapter generation; production consumers supply their own descriptor/type map.
fn main() {
    let types = [
        ("testing.Envelope".into(), "xw_contracts::testing::Envelope".into()),
        ("testing.Changed".into(), "xw_contracts::testing::Changed".into()),
    ]
    .into_iter()
    .collect();
    print!(
        "{}",
        xw_gateway::binding::generate_methods(xw_contracts::FILE_DESCRIPTOR_SET, &types).unwrap()
    );
}
