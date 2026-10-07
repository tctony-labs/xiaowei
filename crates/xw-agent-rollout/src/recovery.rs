use std::{
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use xw_agent_types::{FormatError, JournalEntry, SessionId, decode_entry, validate_history};

use crate::{Result, RolloutError};

#[derive(Debug, Clone, Default)]
pub struct Repair {
    pub discarded_bytes: u64,
    pub diagnostic_path: Option<PathBuf>,
}

fn decode(line: &[u8], history: &[JournalEntry]) -> Result<JournalEntry> {
    let text = std::str::from_utf8(line).map_err(|_| RolloutError::InvalidHistory)?;
    decode_entry(text, history).map_err(|error| match error {
        FormatError::UnsupportedVersion { .. } => RolloutError::UnsupportedVersion,
        _ => RolloutError::InvalidHistory,
    })
}

pub(crate) fn read_and_repair(
    file: &mut File,
    path: &Path,
    session_id: SessionId,
) -> Result<(Vec<JournalEntry>, Repair)> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let committed = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    let mut entries = Vec::new();
    for line in bytes[..committed]
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let entry = decode(line, &entries)?;
        if entry.session_id != session_id {
            return Err(RolloutError::InvalidHistory);
        }
        entries.push(entry);
    }
    // Empty complete lines are corruption too, not padding to skip.
    if bytes[..committed].iter().filter(|byte| **byte == b'\n').count() != entries.len() {
        return Err(RolloutError::InvalidHistory);
    }
    validate_history(&entries)?;
    let tail = &bytes[committed..];
    if tail.is_empty() {
        return Ok((entries, Repair::default()));
    }
    // Complete JSON with unknown fields/version/invalid semantics is never silently discarded.
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(tail) {
        if value.is_object() {
            let entry = decode(tail, &entries)?;
            let mut candidate = entries.clone();
            candidate.push(entry);
            validate_history(&candidate)?;
        } else {
            return Err(RolloutError::InvalidHistory);
        }
    } else if serde_json::from_slice::<serde_json::Value>(tail).is_err_and(|error| !error.is_eof()) {
        return Err(RolloutError::InvalidHistory);
    }
    let diagnostic_path = path.with_extension(format!("jsonl.tail-{}", xw_agent_types::EntryId::new()));
    let mut diagnostic = OpenOptions::new().write(true).create_new(true).open(&diagnostic_path)?;
    diagnostic.write_all(tail)?;
    diagnostic.sync_all()?;
    file.set_len(committed as u64)?;
    file.sync_data()?;
    file.seek(SeekFrom::End(0))?;
    Ok((
        entries,
        Repair {
            discarded_bytes: tail.len() as u64,
            diagnostic_path: Some(diagnostic_path),
        },
    ))
}
