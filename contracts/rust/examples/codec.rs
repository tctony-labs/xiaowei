//! Independent consumer of the public contract crate; stdin/stdout are PB bytes.
use prost::{Message, Name};
use std::io::{Read, Write};
use xw_contracts::{
    FILE_DESCRIPTOR_SET,
    testing::{Changed, Envelope},
};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let descriptors = prost_types::FileDescriptorSet::decode(FILE_DESCRIPTOR_SET)?;
    let file = descriptors.file.iter().find(|f| f.package() == "testing").unwrap();
    let service = &file.service[0];
    assert_eq!(service.name(), "Fixture");
    assert_eq!(service.method[0].name(), "Echo");
    assert_eq!(service.method[0].input_type(), ".testing.Envelope");
    assert_eq!(service.method[0].output_type(), ".testing.Envelope");
    assert!(!service.method[0].server_streaming());
    assert_eq!(service.method[1].name(), "Watch");
    assert_eq!(service.method[1].output_type(), ".testing.Changed");
    assert!(service.method[1].server_streaming());
    assert_eq!(Changed::full_name(), "testing.Changed");
    let envelope = file.message_type.iter().find(|m| m.name() == "Envelope").unwrap();
    assert_eq!(envelope.reserved_name, ["removed_value"]);
    assert_eq!(
        envelope
            .reserved_range
            .iter()
            .map(|r| (r.start(), r.end()))
            .collect::<Vec<_>>(),
        [(9, 10), (10, 11)]
    );
    assert_eq!(
        envelope.field.iter().map(|f| f.number()).collect::<Vec<_>>(),
        [1, 2, 3, 4, 5, 6]
    );
    let mut input = Vec::new();
    std::io::stdin().read_to_end(&mut input)?;
    let value = Envelope::decode(input.as_slice())?;
    std::io::stdout().write_all(&value.encode_to_vec())?;
    Ok(())
}
