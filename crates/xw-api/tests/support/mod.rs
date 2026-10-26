use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, Weak},
};

struct Binary(std::path::PathBuf);

impl Drop for Binary {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub struct Fixture {
    child: Child,
    _binary: Arc<Binary>,
    pub url: String,
}

impl Fixture {
    pub fn start() -> Self {
        static BINARY: Mutex<Weak<Binary>> = Mutex::new(Weak::new());
        let mut cached = BINARY.lock().unwrap();
        let binary = cached.upgrade().unwrap_or_else(|| {
            let path = std::env::temp_dir().join(format!("xw-api-fixture-{}", std::process::id()));
            let status = Command::new("go")
                .args(["build", "-race", "-o"])
                .arg(&path)
                .arg("./internal/httpapi/ws/testfixture")
                .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../../server"))
                .status()
                .expect("Go installed");
            assert!(status.success());
            let binary = Arc::new(Binary(path));
            *cached = Arc::downgrade(&binary);
            binary
        });
        drop(cached);
        let mut child = Command::new(&binary.0)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut url = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut url)
            .unwrap();
        assert!(url.starts_with("ws://"));
        Self {
            child,
            _binary: binary,
            url: url.trim().into(),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        drop(self.child.stdin.take());
        assert!(
            self.child.wait().unwrap().success(),
            "Go race fixture failed"
        );
    }
}
