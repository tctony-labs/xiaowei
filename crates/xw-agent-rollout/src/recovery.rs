use std::{
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use xw_agent_types::{FormatError, JournalEntry, SessionId, decode_entry_fields, validate_history};

use crate::{Result, RolloutError};

#[derive(Debug, Clone, Default)]
pub struct Repair {
    pub discarded_bytes: u64,
    pub diagnostic_path: Option<PathBuf>,
}

fn decode(line: &[u8], history: &[JournalEntry]) -> Result<JournalEntry> {
    let text = std::str::from_utf8(line).map_err(|_| RolloutError::InvalidHistory)?;
    decode_entry_fields(text, history).map_err(|error| match error {
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
    let mut reader = BufReader::new(&mut *file);
    let mut committed = 0;
    let mut line = Vec::new();
    let mut entries = Vec::new();
    loop {
        line.clear();
        let len = reader.read_until(b'\n', &mut line)?;
        if line.last() != Some(&b'\n') {
            break;
        }
        let entry = decode(&line[..len - 1], &entries)?;
        if entry.session_id != session_id {
            return Err(RolloutError::InvalidHistory);
        }
        entries.push(entry);
        committed += len as u64;
    }
    validate_history(&entries).map_err(|_| RolloutError::InvalidHistory)?;
    let tail = line.as_slice();
    if tail.is_empty() {
        return Ok((entries, Repair::default()));
    }
    // Complete JSON with unknown fields/version/invalid semantics is never silently discarded.
    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(tail) {
        if value.is_object() {
            let entry = decode(tail, &entries)?;
            entries.push(entry);
            validate_history(&entries).map_err(|_| RolloutError::InvalidHistory)?;
            entries.pop();
        } else {
            return Err(RolloutError::InvalidHistory);
        }
    } else if serde_json::from_slice::<serde_json::Value>(tail).is_err_and(|error| !error.is_eof())
    {
        return Err(RolloutError::InvalidHistory);
    }
    let diagnostic_path =
        path.with_extension(format!("jsonl.tail-{}", xw_agent_types::EntryId::new()));
    let mut diagnostic = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&diagnostic_path)?;
    diagnostic.write_all(tail)?;
    diagnostic.sync_all()?;
    file.set_len(committed)?;
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
