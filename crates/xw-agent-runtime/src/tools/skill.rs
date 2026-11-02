use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use serde_json::json;
use xw_agent_types::ToolDeclaration;

use super::ToolOutput;

const MAX_NAME_CHARS: usize = 64;
const MAX_DESCRIPTION_CHARS: usize = 380;

pub type SkillSnapshot = BTreeMap<String, SkillEntry>;

#[derive(Clone, Debug)]
pub struct SkillEntry {
    pub name: String,
    pub description: String,
    pub directory: PathBuf,
    pub body: String,
    pub content_hash: String,
}

#[derive(Deserialize)]
struct Metadata {
    name: String,
    description: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    name: String,
}

pub fn declaration() -> ToolDeclaration {
    ToolDeclaration {
        name: "Skill".into(),
        description: "Load a skill's specialized instructions when the task matches its \
            description or the user names it. Available names are listed in the skill catalog. \
            Loading a skill does not grant permissions or execute its scripts."
            .into(),
        parameters_json: json!({
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "The skill name from the available skill catalog."
                }
            },
            "required": ["name"],
            "additionalProperties": false
        })
        .to_string(),
        constrained_sampling_json: None,
    }
}

/// Captures both metadata and bodies. Later loads never read changed files in this Run.
pub fn snapshot(user_directory: Option<&Path>, cwd: Option<&Path>) -> SkillSnapshot {
    let mut skills = SkillSnapshot::new();
    if let Some(directory) = user_directory {
        scan(directory, &mut skills);
    }
    if let Some(cwd) = cwd {
        scan(&cwd.join(".xiaowei/skills"), &mut skills);
    }
    skills
}

fn scan(directory: &Path, skills: &mut SkillSnapshot) {
    let entries = match std::path::absolute(directory).and_then(std::fs::read_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            log::warn!(
                "Agent skills scan failed directory={} error={error}",
                directory.display()
            );
            return;
        }
    };
    let mut directories = Vec::new();
    for entry in entries {
        match entry {
            Ok(entry) if entry.path().is_dir() => directories.push(entry.path()),
            Ok(_) => {}
            Err(error) => log::warn!("Agent skill directory entry failed error={error}"),
        }
    }
    directories.sort();

    for directory in directories {
        let path = directory.join("SKILL.md");
        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                log::warn!(
                    "Agent skill read failed path={} error={error}",
                    path.display()
                );
                continue;
            }
        };
        match parse(&content, &directory) {
            Ok(entry) => {
                skills.insert(entry.name.clone(), entry);
            }
            Err(error) => {
                log::warn!(
                    "Agent skill parse failed path={} reason={error}",
                    path.display()
                );
            }
        }
    }
}

fn parse(content: &str, directory: &Path) -> Result<SkillEntry, &'static str> {
    let trimmed = content.trim();
    let after_open = trimmed
        .strip_prefix("---\n")
        .or_else(|| trimmed.strip_prefix("---\r\n"))
        .ok_or("missing YAML frontmatter")?;
    let end = after_open
        .find("\n---")
        .ok_or("missing frontmatter closing delimiter")?;
    let mut metadata: Metadata =
        serde_yaml::from_str(&after_open[..end]).map_err(|_| "invalid skill metadata")?;
    if metadata.name.trim().is_empty() || metadata.description.trim().is_empty() {
        return Err("empty name or description");
    }
    if metadata.name.chars().count() > MAX_NAME_CHARS {
        return Err("name exceeds maximum length of 64 characters");
    }
    let description_chars = metadata.description.chars().count();
    if description_chars > MAX_DESCRIPTION_CHARS {
        log::warn!(
            "Agent skill description truncated directory={} \
             characters={description_chars} limit={MAX_DESCRIPTION_CHARS}",
            directory.display()
        );
        metadata.description = metadata
            .description
            .chars()
            .take(MAX_DESCRIPTION_CHARS - 1)
            .collect();
        metadata.description.push('…');
    }

    Ok(SkillEntry {
        name: metadata.name,
        description: metadata.description,
        directory: directory.to_path_buf(),
        body: after_open[end + 4..].trim().to_owned(),
        content_hash: blake3::hash(content.as_bytes()).to_hex().to_string(),
    })
}

pub fn resolve<'a>(skills: &'a SkillSnapshot, arguments: &str) -> Result<&'a SkillEntry, String> {
    let arguments: Arguments =
        serde_json::from_str(arguments).map_err(|_| "Skill 需要 name 字符串参数")?;
    skills
        .get(&arguments.name)
        .ok_or_else(|| format!("当前运行没有可用技能：{}", arguments.name))
}

impl SkillEntry {
    pub fn instruction_key(&self) -> String {
        format!("skill.body.{}", self.name)
    }

    pub fn instructions(&self) -> String {
        format!(
            "技能：{}\nBase directory for this skill: {}\n\n{}",
            self.name,
            self.directory.display(),
            self.body,
        )
    }

    pub fn output(&self, already_loaded: bool) -> ToolOutput {
        let text = if already_loaded {
            format!("技能 {} 已加载，继续遵循其指令，无需重复加载。", self.name)
        } else {
            format!("已加载技能：{}", self.name)
        };
        ToolOutput {
            text,
            metadata_json: Some(
                json!({
                    "skill": {
                        "name": self.name,
                        "directory": self.directory,
                        "content_hash": self.content_hash,
                        "already_loaded": already_loaded
                    }
                })
                .to_string(),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, name: &str, description: &str, body: &str) {
        let directory = root.join(name);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: {description}\n---\n{body}"),
        )
        .unwrap();
    }

    #[test]
    fn project_overrides_user_and_the_snapshot_survives_changes_and_removal() {
        let user = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let project_skills = project.path().join(".xiaowei/skills");
        write_skill(user.path(), "shared", "User", "user body");
        write_skill(user.path(), "user-only", "Only user", "user-only body");
        write_skill(&project_skills, "shared", "Project", "project body");
        let before = snapshot(Some(user.path()), Some(project.path()));
        assert_eq!(before["shared"].body, "project body");
        assert_eq!(before["user-only"].body, "user-only body");

        write_skill(&project_skills, "shared", "Changed", "updated body");
        std::fs::remove_file(user.path().join("user-only/SKILL.md")).unwrap();
        let after = snapshot(Some(user.path()), Some(project.path()));
        assert_eq!(after["shared"].body, "updated body");
        assert!(!after.contains_key("user-only"));
        assert_eq!(before["shared"].body, "project body");
        assert_ne!(before["shared"].content_hash, after["shared"].content_hash);

        std::fs::remove_file(project_skills.join("shared/SKILL.md")).unwrap();
        let fallback = snapshot(Some(user.path()), Some(project.path()));
        assert_eq!(fallback["shared"].body, "user body");
        assert!(snapshot(None, Some(&project.path().join("absent"))).is_empty());
    }

    #[test]
    fn relative_user_and_project_directories_are_absolute_in_the_snapshot() {
        let process_cwd = std::env::current_dir().unwrap();
        let root = tempfile::tempdir_in(&process_cwd).unwrap();
        let relative_root = root.path().strip_prefix(&process_cwd).unwrap();
        write_skill(&root.path().join("skills"), "user", "User", "user body");
        write_skill(
            &root.path().join("project/.xiaowei/skills"),
            "project",
            "Project",
            "project body",
        );

        let skills = snapshot(
            Some(&relative_root.join("skills")),
            Some(&relative_root.join("project")),
        );
        assert_eq!(skills["user"].directory, root.path().join("skills/user"));
        assert_eq!(
            skills["project"].directory,
            root.path().join("project/.xiaowei/skills/project")
        );
    }

    #[test]
    fn yaml_fields_and_multiline_descriptions_follow_the_existing_skill_format() {
        let skill = parse(
            "---\nname: example\ndescription: |\n  First line\n  Second line\n\
             allowed-tools: Read Bash\nmetadata:\n  author: example\n---\nBody",
            Path::new("/skills/example"),
        )
        .unwrap();
        assert_eq!(skill.description, "First line\nSecond line\n");
        assert_eq!(skill.body, "Body");
        assert!(
            skill
                .instructions()
                .contains("Base directory for this skill: /skills/example")
        );
        assert!(
            parse(
                "---\r\nname: x\r\ndescription: X\r\n---\r\nBody",
                Path::new("/x")
            )
            .is_ok()
        );
        for content in [
            "body",
            "---\nname: x\n---\nBody",
            "---\nname: ''\ndescription: X\n---\nBody",
            "---\nname: x\ndescription: ''\n---\nBody",
            "---\nname: [\ndescription: X\n---\nBody",
        ] {
            assert!(parse(content, Path::new("/x")).is_err());
        }
    }

    #[test]
    fn metadata_limits_count_unicode_characters_and_truncate_only_descriptions() {
        for character in ["a", "技", "💡"] {
            let name = character.repeat(64);
            let description = character.repeat(380);
            let content = format!("---\nname: {name}\ndescription: {description}\n---\nBody");
            let skill = parse(&content, Path::new("/skills/example")).unwrap();
            assert_eq!(skill.name, name);
            assert_eq!(skill.description, description);

            let long_name = format!("{name}{character}");
            let content = format!("---\nname: {long_name}\ndescription: Valid\n---\nBody");
            assert_eq!(
                parse(&content, Path::new("/skills/example")).unwrap_err(),
                "name exceeds maximum length of 64 characters"
            );

            let long_description = format!("{description}{character}");
            let content = format!("---\nname: valid\ndescription: {long_description}\n---\nBody");
            let skill = parse(&content, Path::new("/skills/example")).unwrap();
            assert_eq!(skill.description, format!("{}…", character.repeat(379)));
            assert_eq!(skill.description.chars().count(), 380);
            assert_eq!(skill.body, "Body");
            assert_eq!(
                skill.content_hash,
                blake3::hash(content.as_bytes()).to_hex().to_string()
            );
        }
    }

    #[test]
    fn long_descriptions_remain_available_and_project_definitions_override_user() {
        let user = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let project_skills = project.path().join(".xiaowei/skills");
        write_skill(user.path(), "shared", "User", "user body");
        write_skill(user.path(), &"n".repeat(65), "Too long", "invalid name");
        write_skill(
            &project_skills,
            "shared",
            &"描".repeat(381),
            "project override",
        );
        write_skill(&project_skills, "project", "Project", "project body");

        let skills = snapshot(Some(user.path()), Some(project.path()));
        assert_eq!(skills.len(), 2);
        assert_eq!(skills["shared"].body, "project override");
        assert_eq!(
            skills["shared"].description,
            format!("{}…", "描".repeat(379))
        );
        assert_eq!(skills["project"].body, "project body");
        assert!(resolve(&skills, r#"{"name":"shared"}"#).is_ok());
        let arguments = json!({ "name": "n".repeat(65) }).to_string();
        assert!(resolve(&skills, &arguments).is_err());
    }

    #[test]
    fn invalid_files_do_not_hide_other_skills_and_names_are_validated_at_execution() {
        let root = tempfile::tempdir().unwrap();
        write_skill(root.path(), "valid", "Valid", "Body");
        std::fs::create_dir_all(root.path().join("invalid")).unwrap();
        std::fs::write(root.path().join("invalid/SKILL.md"), "invalid").unwrap();
        let skills = snapshot(Some(root.path()), None);
        assert_eq!(skills.len(), 1);
        assert!(resolve(&skills, r#"{"name":"valid"}"#).is_ok());
        for arguments in ["{}", "{", r#"{"name":1}"#, r#"{"name":"missing"}"#] {
            assert!(resolve(&skills, arguments).is_err());
        }
        let schema: serde_json::Value =
            serde_json::from_str(&declaration().parameters_json).unwrap();
        assert!(schema["properties"]["name"].get("enum").is_none());
    }
}
