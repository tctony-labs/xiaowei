use prost::Message;
use std::{
    collections::{HashMap, HashSet},
    error::Error,
    fs,
    path::PathBuf,
};

#[path = "../business_binding_config.rs"]
pub mod config;

fn binding_path(module: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../crates")
        .join(module)
        .join("src/gateway_binding.rs")
}

fn main() -> Result<(), Box<dyn Error>> {
    let mode = std::env::args().nth(1).ok_or("expected --write or --check")?;
    if mode != "--write" && mode != "--check" {
        return Err("expected --write or --check".into());
    }

    for module in config::MODULES {
        let generated = generate(module.services)?;
        let path = binding_path(module.name);
        if mode == "--write" {
            fs::write(path, generated)?;
        } else if fs::read_to_string(&path)? != generated {
            return Err(format!("stale Gateway binding: {}", path.display()).into());
        }
    }

    Ok(())
}

pub fn generate(services: &[&str]) -> Result<String, Box<dyn Error>> {
    let mut descriptor = prost_types::FileDescriptorSet::decode(xw_contracts::FILE_DESCRIPTOR_SET)?;
    let mut types = HashMap::new();
    let selected: HashSet<&str> = services.iter().copied().collect();
    if selected.len() != services.len() {
        return Err("duplicate Gateway service in configuration".into());
    }

    for file in &descriptor.file {
        let package = file.package.as_deref().unwrap_or_default();
        if package.starts_with("xiaowei.") {
            for message in &file.message_type {
                let name = message.name.as_deref().ok_or("message has no name")?;
                types.insert(
                    format!("{package}.{name}"),
                    format!("xw_contracts::{}::{name}", package.replace('.', "::")),
                );
            }
        }
    }

    let mut found = HashSet::new();
    for file in &mut descriptor.file {
        let package = file.package.as_deref().unwrap_or_default();
        file.service.retain(|service| {
            let name = format!("{package}.{}", service.name.as_deref().unwrap_or_default());
            if selected.contains(name.as_str()) {
                found.insert(name);
                true
            } else {
                false
            }
        });
    }
    let mut missing: Vec<&str> = services.iter().copied().filter(|name| !found.contains(*name)).collect();
    if !missing.is_empty() {
        missing.sort();
        return Err(format!("unknown Gateway services: {}", missing.join(", ")).into());
    }

    descriptor.file.retain(|file| !file.service.is_empty());
    Ok(xw_gateway::binding::generate_methods(
        &descriptor.encode_to_vec(),
        &types,
    )?)
}
