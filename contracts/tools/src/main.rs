use std::{env, path::PathBuf};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let output = PathBuf::from(args.next().expect("output directory"));
    let root = PathBuf::from(args.next().expect("proto root"));
    let files: Vec<PathBuf> = args.map(PathBuf::from).collect();
    let mut config = prost_build::Config::new();
    config.out_dir(&output);
    config.file_descriptor_set_path(output.join("descriptor.bin"));
    config.enable_type_names();
    config.compile_protos(&files, &[root])?;
    Ok(())
}
