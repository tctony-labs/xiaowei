fn main() {
    let sqlite_include =
        std::env::var("DEP_SQLITE3_INCLUDE").expect("bundled libsqlite3-sys must provide its SQLite headers");

    cc::Build::new()
        .file("csrc/tokenizer.c")
        .include(sqlite_include)
        .define("SQLITE_CORE", None)
        .compile("tokenizer_capi");

    println!("cargo:rerun-if-changed=csrc/tokenizer.c");
}
