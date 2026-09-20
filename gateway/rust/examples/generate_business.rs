use prost::Message;

fn main() {
    let package = std::env::args().nth(1).expect("package suffix");
    print!("{}", generate(&package));
}

pub fn generate(package: &str) -> String {
    let mut descriptor = prost_types::FileDescriptorSet::decode(xw_contracts::FILE_DESCRIPTOR_SET).unwrap();
    let mut types = std::collections::HashMap::new();

    for file in &descriptor.file {
        let package = file.package.as_deref().unwrap_or_default();
        if package.starts_with("xiaowei.") {
            for message in &file.message_type {
                let name = message.name.as_deref().unwrap();
                types.insert(
                    format!("{package}.{name}"),
                    format!("xw_contracts::{}::{name}", package.replace('.', "::")),
                );
            }
        }
    }

    descriptor.file.retain(|file| {
        file.package.as_deref() == Some(&format!("xiaowei.{package}"))
            || (package == "search" && matches!(file.package.as_deref(), Some("xiaowei.app" | "xiaowei.system")))
    });

    xw_gateway::binding::generate_methods(&descriptor.encode_to_vec(), &types).unwrap()
}
