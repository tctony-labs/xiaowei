//! macOS 系统主题切换，迁自旧版 platform/macos/appearance.rs。
#[cfg(target_os = "macos")]
const TOGGLE_MODE_SCRIPT: &str = r#"tell application "System Events" to tell appearance preferences
set dark mode to not dark mode
return dark mode
end tell"#;

pub fn toggle_dark_mode() -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/osascript")
            .args(["-e", TOGGLE_MODE_SCRIPT])
            .output()
            .map_err(|e| e.to_string())?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                format!("osascript exited with {}", output.status)
            } else {
                stderr
            });
        }
        parse_mode(&String::from_utf8_lossy(&output.stdout))
    }
    #[cfg(not(target_os = "macos"))]
    Err("当前平台不支持切换系统主题".into())
}

#[cfg(any(target_os = "macos", test))]
fn parse_mode(output: &str) -> Result<bool, String> {
    match output.trim() {
        "true" => Ok(true),
        "false" => Ok(false),
        value => Err(format!("无法解析切换后的系统主题: {value}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_system_response_without_changing_appearance() {
        assert_eq!(parse_mode("true\n"), Ok(true));
        assert_eq!(parse_mode("false"), Ok(false));
        assert!(parse_mode("").is_err());
    }
}
