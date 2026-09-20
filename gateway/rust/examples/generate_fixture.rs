//! Test-only adapter generation; production consumers supply their own descriptor/type map.
use prost::Message;
fn main() {
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
    print!(
        "{}",
        xw_gateway::binding::generate_methods(&descriptor.encode_to_vec(), &types).unwrap()
    );
}
