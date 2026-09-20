use prost::Message;
#[allow(dead_code)]
mod fixture_bindings;

#[test]
fn gateway_bindings_match_contract_descriptor() {
    let mut descriptor = prost_types::FileDescriptorSet::decode(xw_contracts::FILE_DESCRIPTOR_SET).unwrap();
    descriptor
        .file
        .retain(|file| file.package.as_deref() == Some("testing"));
    let types = [
        ("testing.Envelope".into(), "xw_contracts::testing::Envelope".into()),
        ("testing.Changed".into(), "xw_contracts::testing::Changed".into()),
    ]
    .into_iter()
    .collect();
    let expected = xw_gateway::binding::generate_methods(&descriptor.encode_to_vec(), &types).unwrap();
    assert_eq!(expected, include_str!("fixture_bindings.rs"));
    assert_eq!(
        fixture_bindings::testing_fixture_service::ECHO.route().input,
        "testing.Envelope"
    );
    assert_eq!(
        fixture_bindings::testing_fixture_service::WATCH.route().kind,
        xw_gateway::MethodKind::ServerStreaming
    );
}
