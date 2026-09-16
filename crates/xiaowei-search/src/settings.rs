//! 内置「系统设置」面板清单。
//!
//! 现代 macOS（Ventura+）的系统设置页是 `ExtensionKit` 扩展，磁盘上拿不到本地化中文名，
//! 旧的 `/System/Library/PreferencePanes/*.prefPane` 又已是空壳。故这里用一份**内置清单**
//! （中文名 / 英文名 / 扩展 bundle id）覆盖常用面板，另附一份常见搜索别名表：
//!
//! - 打开：`x-apple.systempreferences:<bundle_id>`（`AppProvider::launch_action` 据 kind 生成），
//!   跨新旧 macOS 兼容；
//! - 搜索：中文名与常见别名走原文匹配，英文名 + 中文名/别名拼音（含首字母）走 haystack，
//!   故「显示器 / 屏幕 / pingmu / display / xianshiqi / xsq」都能命中。
//!
//! bundle id 取自 `/System/Library/ExtensionKit/Extensions/*.appex`
//! （`EXExtensionPointIdentifier == com.apple.Settings.extension.ui`）。

use std::path::PathBuf;

use crate::pinyin;
use xw_app::{AppEntry, AppKind};

use crate::IndexedApp;

/// (中文名, 英文名, 设置扩展 bundle id)。
const SETTINGS_PANES: &[(&str, &str, &str)] = &[
    ("显示器", "Displays", "com.apple.Displays-Settings.extension"),
    ("声音", "Sound", "com.apple.Sound-Settings.extension"),
    ("蓝牙", "Bluetooth", "com.apple.BluetoothSettings"),
    ("网络", "Network", "com.apple.Network-Settings.extension"),
    ("Wi-Fi", "Wi-Fi", "com.apple.wifi-settings-extension"),
    ("电池", "Battery", "com.apple.Battery-Settings.extension"),
    ("通知", "Notifications", "com.apple.Notifications-Settings.extension"),
    ("聚焦", "Spotlight", "com.apple.Spotlight-Settings.extension"),
    ("键盘", "Keyboard", "com.apple.Keyboard-Settings.extension"),
    ("触控板", "Trackpad", "com.apple.Trackpad-Settings.extension"),
    ("鼠标", "Mouse", "com.apple.Mouse-Settings.extension"),
    (
        "打印机与扫描仪",
        "Printers & Scanners",
        "com.apple.Print-Scan-Settings.extension",
    ),
    ("墙纸", "Wallpaper", "com.apple.Wallpaper-Settings.extension"),
    ("桌面与程序坞", "Desktop & Dock", "com.apple.Desktop-Settings.extension"),
    ("外观", "Appearance", "com.apple.Appearance-Settings.extension"),
    (
        "屏幕保护程序",
        "Screen Saver",
        "com.apple.ScreenSaver-Settings.extension",
    ),
    (
        "控制中心",
        "Control Center",
        "com.apple.ControlCenter-Settings.extension",
    ),
    (
        "辅助功能",
        "Accessibility",
        "com.apple.Accessibility-Settings.extension",
    ),
    (
        "隐私与安全性",
        "Privacy & Security",
        "com.apple.settings.PrivacySecurity.extension",
    ),
    (
        "触控 ID 与密码",
        "Touch ID & Password",
        "com.apple.Touch-ID-Settings.extension",
    ),
    ("锁定屏幕", "Lock Screen", "com.apple.Lock-Screen-Settings.extension"),
    (
        "用户与群组",
        "Users & Groups",
        "com.apple.Users-Groups-Settings.extension",
    ),
    (
        "屏幕使用时间",
        "Screen Time",
        "com.apple.Screen-Time-Settings.extension",
    ),
    ("关于本机", "About", "com.apple.SystemProfiler.AboutExtension"),
    (
        "软件更新",
        "Software Update",
        "com.apple.Software-Update-Settings.extension",
    ),
    ("储存空间", "Storage", "com.apple.settings.Storage"),
    (
        "语言与地区",
        "Language & Region",
        "com.apple.Localization-Settings.extension",
    ),
    ("日期与时间", "Date & Time", "com.apple.Date-Time-Settings.extension"),
    ("共享", "Sharing", "com.apple.Sharing-Settings.extension"),
    ("时间机器", "Time Machine", "com.apple.Time-Machine-Settings.extension"),
    ("启动磁盘", "Startup Disk", "com.apple.Startup-Disk-Settings.extension"),
    (
        "互联网账户",
        "Internet Accounts",
        "com.apple.Internet-Accounts-Settings.extension",
    ),
    ("Siri", "Siri", "com.apple.Siri-Settings.extension"),
    (
        "钱包与 Apple Pay",
        "Wallet & Apple Pay",
        "com.apple.WalletSettingsExtension",
    ),
    (
        "Apple 账户",
        "Apple Account",
        "com.apple.systempreferences.AppleIDSettings",
    ),
    ("家人", "Family", "com.apple.Family-Settings.extension"),
    ("游戏中心", "Game Center", "com.apple.Game-Center-Settings.extension"),
    ("登录项", "Login Items", "com.apple.LoginItems-Settings.extension"),
    (
        "VPN",
        "VPN",
        "com.apple.NetworkExtensionSettingsUI.NESettingsUIExtension",
    ),
    (
        "传输或还原",
        "Transfer or Reset",
        "com.apple.Transfer-Reset-Settings.extension",
    ),
];

/// 面板中文名 → 常见搜索别名。只收录含义明确、不会误导到其他面板的说法。
const SETTINGS_ALIAS_MAP: &[(&str, &[&str])] = &[
    ("显示器", &["屏幕"]),
    ("声音", &["音量"]),
    ("Wi-Fi", &["无线网络", "无线网"]),
    ("电池", &["电源"]),
    ("聚焦", &["搜索"]),
    ("触控板", &["触摸板"]),
    ("打印机与扫描仪", &["打印机", "扫描仪"]),
    ("墙纸", &["壁纸", "桌面背景"]),
    ("桌面与程序坞", &["程序坞"]),
    ("屏幕保护程序", &["屏保"]),
    ("辅助功能", &["无障碍"]),
    ("隐私与安全性", &["隐私", "安全"]),
    ("触控 ID 与密码", &["指纹"]),
    ("锁定屏幕", &["锁屏"]),
    ("关于本机", &["系统信息"]),
    ("软件更新", &["系统更新"]),
    ("储存空间", &["存储空间", "磁盘空间"]),
    ("时间机器", &["备份"]),
    ("Siri", &["语音助手"]),
    ("Apple 账户", &["Apple ID", "iCloud"]),
    ("家人", &["家庭共享"]),
    ("登录项", &["开机启动", "自启动"]),
    ("传输或还原", &["重置", "恢复出厂设置"]),
];

fn aliases_for(name: &str) -> Vec<String> {
    SETTINGS_ALIAS_MAP
        .iter()
        .find_map(|(pane, aliases)| (*pane == name).then_some(*aliases))
        .unwrap_or_default()
        .iter()
        .map(|alias| (*alias).to_string())
        .collect()
}

/// 把内置清单转成索引项：kind = `PreferencePane`，`path` 留空（靠 bundle id 走 URL 打开），
/// aliases = 常见搜索别名；haystack = 中文名/别名拼音（含首字母）+ 英文名小写别名。
pub(super) fn catalog_items() -> Vec<IndexedApp> {
    SETTINGS_PANES
        .iter()
        .map(|(zh, en, bundle_id)| {
            let aliases = aliases_for(zh);
            let mut haystacks: Vec<String> = std::iter::once(*zh)
                .chain(aliases.iter().map(String::as_str))
                .flat_map(pinyin::haystacks)
                .collect();
            haystacks.push(en.to_lowercase());
            haystacks.sort();
            haystacks.dedup();

            let entry = AppEntry {
                name: (*zh).to_string(),
                path: PathBuf::new(),
                bundle_id: (*bundle_id).to_string(),
                aliases,
                kind: AppKind::PreferencePane,
            };
            IndexedApp {
                stable_key: entry.stable_key(),
                entry,
                pinyin_haystacks: haystacks,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_panes_are_apple_extensions() {
        // launch_action 只对 com.apple.* 走 URL scheme；清单里必须都满足，否则打不开。
        for (_, _, id) in SETTINGS_PANES {
            assert!(id.starts_with("com.apple."), "非 apple id: {id}");
        }
    }

    #[test]
    fn displays_has_pinyin_and_english_alias() {
        let items = catalog_items();
        let displays = items.iter().find(|i| i.entry.name == "显示器").expect("应含显示器");
        assert!(displays.pinyin_haystacks.iter().any(|h| h == "xianshiqi"), "缺全拼");
        assert!(displays.pinyin_haystacks.iter().any(|h| h == "xsq"), "缺首字母");
        assert!(displays.pinyin_haystacks.iter().any(|h| h == "displays"), "缺英文别名");
        assert!(displays.entry.aliases.iter().any(|alias| alias == "屏幕"), "缺中文别名");
        assert!(displays.pinyin_haystacks.iter().any(|h| h == "pingmu"), "缺别名全拼");
        assert!(displays.pinyin_haystacks.iter().any(|h| h == "pm"), "缺别名首字母");
        assert_eq!(displays.entry.kind, AppKind::PreferencePane);
    }

    #[test]
    fn battery_has_power_alias_and_pinyin() {
        let items = catalog_items();
        let battery = items.iter().find(|i| i.entry.name == "电池").expect("应含电池");
        assert!(battery.entry.aliases.iter().any(|alias| alias == "电源"), "缺中文别名");
        assert!(battery.pinyin_haystacks.iter().any(|h| h == "dianyuan"), "缺别名全拼");
        assert!(battery.pinyin_haystacks.iter().any(|h| h == "dy"), "缺别名首字母");
    }
}
