//! Test-only adapter generation; production consumers supply their own descriptor/type map.
use prost::Message;
fn main() {
    let mut descriptor =
        prost_types::FileDescriptorSet::decode(proto_testing_rs::FILE_DESCRIPTOR_SET).unwrap();
    descriptor
        .file
        .retain(|file| file.package.as_deref() == Some("testing"));
    let types = [
        (
            "testing.Envelope".into(),
            "proto_testing_rs::testing::Envelope".into(),
        ),
        (
            "testing.Changed".into(),
            "proto_testing_rs::testing::Changed".into(),
        ),
    ]
    .into_iter()
    .collect();
    print!(
        "{}",
        xw_gateway::binding::generate_methods(&descriptor.encode_to_vec(), &types).unwrap()
    );
}
