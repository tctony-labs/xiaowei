use std::{
    collections::HashSet,
    fs::File,
    io::{self, Read},
    path::Path,
    time::SystemTime,
};

use globset::Glob;
use grep_regex::RegexMatcher;
use grep_searcher::{Searcher, sinks::UTF8};
use ignore::WalkBuilder;
use serde::Deserialize;
use serde_json::json;
use tokio_util::sync::CancellationToken;
use walkdir::WalkDir;
use xw_agent_types::ToolDeclaration;

use super::{FileTools, MAX_OUTPUT_BYTES, ToolOutput, parse};

const MAX_GLOB_MATCHES: usize = 500;
const MAX_GREP_MATCHES: usize = 5000;
// Leave room for the count and truncation notice within the file-tool output budget.
const LISTING_BYTES: usize = MAX_OUTPUT_BYTES - 256;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GlobArgs {
    pattern: String,
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrepArgs {
    pattern: String,
    path: Option<String>,
    include: Option<String>,
}

pub fn declarations() -> Vec<ToolDeclaration> {
    [
        (
            "Glob",
            concat!(
                "Find files matching a glob pattern, newest modification time first. ",
                "Returns up to 500 files. Relative paths use cwd. ",
                "Skips hidden entries unless named literally, node_modules and target; ",
                "does not apply gitignore. Refine the pattern if results are truncated.",
            ),
            json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern, e.g. **/*.rs. A missing **/ is prepended."
                    },
                    "path": {
                        "type": "string",
                        "description": "Directory to search; defaults to cwd."
                    }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
        ),
        (
            "Grep",
            concat!(
                "Search file contents with ripgrep-style regex. Returns paths, line numbers ",
                "and matching lines, up to 5000 matches. Relative paths use cwd. ",
                "Directory searches apply ignore rules; hidden files are skipped unless ",
                "selected by include. ",
                "Refine the pattern or path if results are truncated.",
            ),
            json!({
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regex to search for."},
                    "path": {
                        "type": "string",
                        "description": "File or directory to search; defaults to cwd."
                    },
                    "include": {
                        "type": "string",
                        "description": "File-type glob filter, e.g. *.rs or *.{ts,tsx}."
                    }
                },
                "required": ["pattern"],
                "additionalProperties": false
            }),
        ),
    ]
    .into_iter()
    .map(|(name, description, parameters)| ToolDeclaration {
        name: name.into(),
        description: description.into(),
        parameters_json: parameters.to_string(),
        constrained_sampling_json: None,
    })
    .collect()
}

pub(super) fn execute(
    tools: &FileTools,
    name: &str,
    arguments: &str,
    cancellation: &CancellationToken,
) -> Result<ToolOutput, String> {
    check_cancelled(cancellation)?;
    if name == "Glob" {
        let args: GlobArgs = parse(arguments)?;
        let root = tools.path(args.path.as_deref().unwrap_or("."))?;
        glob(&root, &args.pattern, cancellation)
    } else {
        let args: GrepArgs = parse(arguments)?;
        let root = tools.path(args.path.as_deref().unwrap_or("."))?;
        grep(&root, args, cancellation)
    }
}

fn glob(
    root: &Path,
    pattern: &str,
    cancellation: &CancellationToken,
) -> Result<ToolOutput, String> {
    let pattern = if pattern.starts_with("**/") {
        pattern.to_owned()
    } else {
        format!("**/{pattern}")
    };
    let matcher = Glob::new(&pattern)
        .map_err(|error| format!("Invalid glob pattern: {error}"))?
        .compile_matcher();
    let allowed_hidden: HashSet<_> = pattern
        .split('/')
        .filter(|part| part.starts_with('.') && !part.contains(['*', '?', '[', '{']))
        .collect();
    let mut matches = Vec::new();
    let mut total = 0;
    let mut skipped_errors = 0;

    for entry in WalkDir::new(root).into_iter().filter_entry(|entry| {
        if entry.depth() == 0 {
            return true;
        }
        let name = entry.file_name().to_string_lossy();
        (!name.starts_with('.') || allowed_hidden.contains(name.as_ref()))
            && name != "node_modules"
            && name != "target"
    }) {
        check_cancelled(cancellation)?;
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                skipped_errors += 1;
                continue;
            }
        };
        let path = entry.path();
        if !path.is_file() || !matcher.is_match(path.strip_prefix(root).unwrap_or(path)) {
            continue;
        }
        total += 1;
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        if matches.len() < MAX_GLOB_MATCHES {
            matches.push((path.to_path_buf(), mtime));
        } else if let Some((oldest, _)) = matches.iter().enumerate().min_by_key(|(_, (_, t))| *t)
            && mtime > matches[oldest].1
        {
            matches[oldest] = (path.to_path_buf(), mtime);
        }
    }
    check_cancelled(cancellation)?;
    matches.sort_by_key(|entry| std::cmp::Reverse(entry.1));

    let mut listing = String::new();
    let mut shown = 0;
    for (path, _) in matches {
        let path = path.to_string_lossy();
        if listing.len() + path.len() + 1 > LISTING_BYTES {
            break;
        }
        listing.push_str(&path);
        listing.push('\n');
        shown += 1;
    }
    let truncated = shown < total;
    let text = if total == 0 {
        "No files found matching the pattern.".into()
    } else if truncated {
        format!(
            "{shown} file(s) shown (newest by mtime) out of {total} total matches \
             (truncated) — refine the pattern for fewer results.\n{listing}"
        )
    } else {
        format!("{total} file(s) found:\n{listing}")
    };
    Ok(output(
        "Glob",
        text,
        total,
        shown,
        truncated,
        skipped_errors,
    ))
}

fn grep(
    root: &Path,
    args: GrepArgs,
    cancellation: &CancellationToken,
) -> Result<ToolOutput, String> {
    let matcher =
        RegexMatcher::new(&args.pattern).map_err(|error| format!("Invalid regex: {error}"))?;
    let mut results = GrepResults::default();

    if root.is_file() {
        results.search_file(&matcher, root, cancellation)?;
    } else {
        let mut walker = WalkBuilder::new(root);
        walker.hidden(true).git_ignore(true);
        if let Some(include) = args.include {
            let mut types = ignore::types::TypesBuilder::new();
            // Preserve the legacy extension-filter interpretation, including brace alternatives.
            types
                .add(
                    "custom",
                    &format!("*.{{{}}}", include.trim_start_matches("*.")),
                )
                .map_err(|error| format!("Invalid include pattern: {error}"))?;
            types.select("custom");
            walker.types(types.build().map_err(|error| error.to_string())?);
        }
        for entry in walker.build() {
            check_cancelled(cancellation)?;
            if results.truncated {
                break;
            }
            match entry {
                Ok(entry) if entry.path().is_file() => {
                    results.search_file(&matcher, entry.path(), cancellation)?;
                }
                Err(_) => results.skipped_errors += 1,
                _ => {}
            }
        }
    }
    check_cancelled(cancellation)?;
    let shown = results.lines.len();
    let text = if shown == 0 {
        "No matches found.".into()
    } else if results.truncated {
        format!(
            "at least {shown} matches (truncated) — refine pattern or path.\n{}",
            results.lines.join("\n")
        )
    } else {
        format!("{shown} match(es):\n{}", results.lines.join("\n"))
    };
    Ok(output(
        "Grep",
        text,
        shown,
        shown,
        results.truncated,
        results.skipped_errors,
    ))
}

#[derive(Default)]
struct GrepResults {
    lines: Vec<String>,
    bytes: usize,
    truncated: bool,
    skipped_errors: usize,
}

impl GrepResults {
    fn search_file(
        &mut self,
        matcher: &RegexMatcher,
        path: &Path,
        cancellation: &CancellationToken,
    ) -> Result<(), String> {
        check_cancelled(cancellation)?;
        let reader = match File::open(path) {
            Ok(file) if file.metadata().is_ok_and(|metadata| metadata.is_file()) => {
                SearchReader { file, cancellation }
            }
            _ => {
                self.skipped_errors += 1;
                return Ok(());
            }
        };
        let result = Searcher::new().search_reader(
            matcher,
            reader,
            UTF8(|line_number, line| {
                if cancellation.is_cancelled() {
                    return Ok(false);
                }
                let prefix = format!("{}:{line_number}:", path.display());
                let remaining = LISTING_BYTES.saturating_sub(self.bytes + prefix.len() + 1);
                if remaining == 0 {
                    self.truncated = true;
                    return Ok(false);
                }
                let line = line.trim_end();
                let mut end = line.len().min(remaining);
                while !line.is_char_boundary(end) {
                    end -= 1;
                }
                let matched = format!("{prefix}{}", &line[..end]);
                self.bytes += matched.len() + 1;
                self.lines.push(matched);
                self.truncated = end < line.len() || self.lines.len() >= MAX_GREP_MATCHES;
                Ok(!self.truncated)
            }),
        );
        check_cancelled(cancellation)?;
        if result.is_err() {
            // Legacy searches skip unreadable/non-UTF-8 files, retaining any earlier matches.
            self.skipped_errors += 1;
        }
        Ok(())
    }
}

struct SearchReader<'a> {
    file: File,
    cancellation: &'a CancellationToken,
}

impl Read for SearchReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.cancellation.is_cancelled() {
            return Err(io::Error::other("Cancelled"));
        }
        self.file.read(buffer)
    }
}

fn check_cancelled(cancellation: &CancellationToken) -> Result<(), String> {
    if cancellation.is_cancelled() {
        Err("Cancelled".into())
    } else {
        Ok(())
    }
}

fn output(
    kind: &str,
    mut text: String,
    matches: usize,
    shown: usize,
    truncated: bool,
    skipped_errors: usize,
) -> ToolOutput {
    log::debug!(
        "Agent {kind} searched matches={matches} shown={shown} \
         truncated={truncated} skipped_errors={skipped_errors}"
    );
    if skipped_errors > 0 {
        text.push_str(&format!(
            "\nSkipped {skipped_errors} unreadable entries; results may be incomplete."
        ));
    }
    ToolOutput {
        text,
        metadata_json: Some(
            json!({"search": {
                "matches": matches, "shown": shown, "truncated": truncated,
                "skipped_errors": skipped_errors
            }})
            .to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_stops_reads_even_without_regex_matches() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), "no matching lines\n").unwrap();
        let cancellation = CancellationToken::new();
        let mut reader = SearchReader {
            file: File::open(file.path()).unwrap(),
            cancellation: &cancellation,
        };
        let mut buffer = [0; 4];
        assert_eq!(reader.read(&mut buffer).unwrap(), 4);
        cancellation.cancel();
        assert_eq!(
            reader.read(&mut buffer).unwrap_err().to_string(),
            "Cancelled"
        );
    }
}
