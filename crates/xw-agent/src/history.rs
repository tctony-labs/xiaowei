use std::{
    fs::File,
    io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::Mutex,
};

use prost::{Message, encoding::encoded_len_varint};
use uuid::Uuid;
use xw_agent_types::{InputId, RunId, SessionId};

use crate::{AgentError, protocol::*, session::Session};

pub(crate) const PAGE_BYTES: usize = 1024 * 1024;
const PAGE_RUNS: usize = 20;
const PAGE_ITEMS: usize = 20;
const PREVIEW_BYTES: usize = 64 * 1024;
const CHUNK_BYTES: usize = 256 * 1024;
const ITEM_SLOT_BYTES: u64 = 8 + 16;

/// Derived display index. A Run slot is the only resident per-Run index entry.
/// The per-Item offsets and independently decodable display projection are on disk.
#[derive(Default)]
pub(crate) struct DisplayHistory {
    file: Mutex<Option<File>>,
    runs: Vec<RunSlot>,
    pub(crate) todo_metadata: Option<String>,
}

struct RunSlot {
    id: RunId,
    input_id: Option<InputId>,
    header_offset: u64,
    items_offset: u64,
    item_count: usize,
    final_items: Option<(usize, usize)>,
    title_round: bool,
}

fn io_error(error: std::io::Error) -> AgentError {
    log::error!("Agent display index I/O failed: {error}");
    AgentError::Persistence
}

impl DisplayHistory {
    pub(crate) fn append(&mut self, run: &AgentRun, directory: &Path) -> Result<(), AgentError> {
        let file = self.file.get_mut().unwrap();
        let file = match file {
            Some(file) => file,
            None => file.insert(tempfile::tempfile_in(directory).map_err(io_error)?),
        };

        let header_offset = file.seek(SeekFrom::End(0)).map_err(io_error)?;
        let header = run_header(run);
        let mut writer = BufWriter::new(file);
        let mut items_offset =
            header_offset + write_frame(&mut writer, &header).map_err(io_error)?;
        let mut index = Vec::with_capacity(run.items.len());
        for item in &run.items {
            let item_id = Uuid::parse_str(&item.item_id).map_err(|_| AgentError::Internal)?;
            index.push((items_offset, item_id));
            items_offset += write_frame(&mut writer, item).map_err(io_error)?;
        }
        for (offset, item_id) in index {
            writer.write_all(&offset.to_le_bytes()).map_err(io_error)?;
            writer.write_all(item_id.as_bytes()).map_err(io_error)?;
        }
        writer.flush().map_err(io_error)?;

        self.runs.push(RunSlot {
            id: run.run_id.parse().map_err(|_| AgentError::Internal)?,
            input_id: if run.input_id.is_empty() {
                None
            } else {
                Some(run.input_id.parse().map_err(|_| AgentError::Internal)?)
            },
            header_offset,
            items_offset,
            item_count: run.items.len(),
            final_items: final_items(run),
            title_round: crate::title::is_title_round(run),
        });
        if let Some(metadata) = latest_todo(std::slice::from_ref(run)) {
            self.todo_metadata = metadata;
        }
        Ok(())
    }

    pub(crate) fn len(&self) -> usize {
        self.runs.len()
    }

    pub(crate) fn title_rounds(&self) -> impl DoubleEndedIterator<Item = (usize, RunId)> + '_ {
        self.runs
            .iter()
            .enumerate()
            .filter(|(_, run)| run.title_round)
            .map(|(index, run)| (index, run.id))
    }

    fn read<M: Message + Default>(&self, offset: u64) -> Result<M, AgentError> {
        let mut guard = self.file.lock().unwrap();
        read_frame(guard.as_mut().ok_or(AgentError::Internal)?, offset).map_err(io_error)
    }

    fn read_item(&self, slot: &RunSlot, index: usize) -> Result<AgentItem, AgentError> {
        let mut guard = self.file.lock().unwrap();
        let file = guard.as_mut().ok_or(AgentError::Internal)?;
        file.seek(SeekFrom::Start(
            slot.items_offset + index as u64 * ITEM_SLOT_BYTES,
        ))
        .map_err(io_error)?;
        let mut offset = [0; 8];
        file.read_exact(&mut offset).map_err(io_error)?;
        read_frame(file, u64::from_le_bytes(offset)).map_err(io_error)
    }

    fn read_item_by_id(&self, slot: &RunSlot, id: Uuid) -> Result<AgentItem, AgentError> {
        let mut guard = self.file.lock().unwrap();
        let file = guard.as_mut().ok_or(AgentError::Internal)?;
        file.seek(SeekFrom::Start(slot.items_offset))
            .map_err(io_error)?;
        let mut reader = BufReader::new(file);
        for _ in 0..slot.item_count {
            let mut offset = [0; 8];
            let mut item_id = [0; 16];
            reader.read_exact(&mut offset).map_err(io_error)?;
            reader.read_exact(&mut item_id).map_err(io_error)?;
            if id.as_bytes() == &item_id {
                return read_frame(reader.into_inner(), u64::from_le_bytes(offset))
                    .map_err(io_error);
            }
        }
        Err(AgentError::NotFound("item"))
    }
}

pub(crate) fn latest_todo(runs: &[AgentRun]) -> Option<Option<String>> {
    runs.iter()
        .rev()
        .flat_map(|run| run.items.iter().rev())
        .find_map(|item| match &item.content {
            Some(agent_item::Content::ToolCall(tool))
                if tool.name == "TodoWrite" && tool.status == AgentToolStatus::Completed as i32 =>
            {
                Some(tool.metadata_json.clone())
            }
            _ => None,
        })
}

fn write_frame(writer: &mut impl Write, frame: &impl Message) -> std::io::Result<u64> {
    let bytes = frame.encode_to_vec();
    let len = u32::try_from(bytes.len()).map_err(std::io::Error::other)?;
    writer.write_all(&len.to_le_bytes())?;
    writer.write_all(&bytes)?;
    Ok(4 + u64::from(len))
}

fn read_frame<M: Message + Default>(file: &mut File, offset: u64) -> std::io::Result<M> {
    file.seek(SeekFrom::Start(offset))?;
    let mut len = [0; 4];
    file.read_exact(&mut len)?;
    let mut bytes = vec![0; u32::from_le_bytes(len) as usize];
    file.read_exact(&mut bytes)?;
    M::decode(bytes.as_slice()).map_err(std::io::Error::other)
}

fn run_header(run: &AgentRun) -> AgentRun {
    AgentRun {
        run_id: run.run_id.clone(),
        input_id: run.input_id.clone(),
        status: run.status,
        config: run.config.clone(),
        started_at_ms: run.started_at_ms,
        completed_at_ms: run.completed_at_ms,
        error: run.error.clone(),
        provider_name: run.provider_name.clone(),
        model_name: run.model_name.clone(),
        generation: run.generation.clone(),
        final_gen_id: run.final_gen_id.clone(),
        continued_from_run_id: run.continued_from_run_id.clone(),
        ..Default::default()
    }
}

fn final_items(run: &AgentRun) -> Option<(usize, usize)> {
    let final_gen = run.final_gen_id.as_ref()?;
    let mut indices = run.items.iter().enumerate().filter_map(|(index, item)| {
        (item.gen_id.as_ref() == Some(final_gen)
            && matches!(&item.content, Some(agent_item::Content::AgentMessage(text)) if !text.text.is_empty()))
            .then_some(index)
    });
    let first = indices.next()?;
    Some((first, indices.next_back().unwrap_or(first)))
}

enum RunSource<'a> {
    Live(&'a AgentRun),
    Disk(&'a DisplayHistory, &'a RunSlot),
}

impl RunSource<'_> {
    fn id(&self) -> Result<RunId, AgentError> {
        match self {
            Self::Live(run) => run.run_id.parse().map_err(|_| AgentError::Internal),
            Self::Disk(_, slot) => Ok(slot.id),
        }
    }

    fn header(&self) -> Result<AgentRun, AgentError> {
        match self {
            Self::Live(run) => Ok(run_header(run)),
            Self::Disk(history, slot) => history.read(slot.header_offset),
        }
    }

    fn len(&self) -> usize {
        match self {
            Self::Live(run) => run.items.len(),
            Self::Disk(_, slot) => slot.item_count,
        }
    }

    fn final_items(&self) -> Option<(usize, usize)> {
        match self {
            Self::Live(run) => final_items(run),
            Self::Disk(_, slot) => slot.final_items,
        }
    }

    fn active_item(&self) -> Option<usize> {
        let Self::Live(run) = self else { return None };
        let id = run.generation.as_ref()?.active_item_id.as_ref()?;
        run.items.iter().position(|item| &item.item_id == id)
    }

    fn item(&self, index: usize) -> Result<AgentItem, AgentError> {
        match self {
            Self::Live(run) => run.items.get(index).cloned().ok_or(AgentError::Persistence),
            Self::Disk(history, slot) if index < slot.item_count => history.read_item(slot, index),
            _ => Err(AgentError::Persistence),
        }
    }

    fn item_by_id(&self, id: &str) -> Result<AgentItem, AgentError> {
        let _: xw_agent_types::BlockId = crate::session::parse_id(id, "item_id")?;
        match self {
            Self::Live(run) => run
                .items
                .iter()
                .find(|item| item.item_id == id)
                .cloned()
                .ok_or(AgentError::NotFound("item")),
            Self::Disk(history, slot) => {
                let id = Uuid::parse_str(id).map_err(|_| AgentError::InvalidArgument("item_id"))?;
                history.read_item_by_id(slot, id)
            }
        }
    }
}

impl Session {
    fn source(&self, index: usize) -> Option<RunSource<'_>> {
        if let Some(history) = &self.display_history {
            if let Some(run) = history.runs.get(index) {
                return Some(RunSource::Disk(history, run));
            }
            return self
                .view
                .runs
                .get(index - history.len())
                .map(RunSource::Live);
        }
        self.view.runs.get(index).map(RunSource::Live)
    }

    pub(crate) fn run_count(&self) -> usize {
        self.display_history.as_ref().map_or(0, DisplayHistory::len) + self.view.runs.len()
    }

    fn run_index(&self, id: RunId) -> Option<usize> {
        if let Some(history) = &self.display_history
            && let Some(index) = history.runs.iter().position(|run| run.id == id)
        {
            return Some(index);
        }
        self.view
            .runs
            .iter()
            .position(|run| run.run_id.parse::<RunId>().ok() == Some(id))
            .map(|index| self.run_count() - self.view.runs.len() + index)
    }

    pub(crate) fn previously_accepted_run(
        &self,
        input_id: InputId,
    ) -> Result<AgentRun, AgentError> {
        if let Some(run) = self
            .view
            .runs
            .iter()
            .rev()
            .find(|run| run.input_id.parse::<InputId>().ok() == Some(input_id))
        {
            return first_items(&RunSource::Live(run), false, fits_run_response)
                .map(|(run, _)| run);
        }
        if let Some(history) = &self.display_history
            && let Some(run) = history
                .runs
                .iter()
                .rev()
                .find(|run| run.input_id == Some(input_id))
        {
            return first_items(&RunSource::Disk(history, run), false, fits_run_response)
                .map(|(run, _)| run);
        }
        Err(AgentError::Conflict("input accepted without a run"))
    }

    pub(crate) fn has_run_for_input(&self, input_id: InputId) -> bool {
        self.view
            .runs
            .iter()
            .any(|run| run.input_id.parse::<InputId>().ok() == Some(input_id))
            || self.display_history.as_ref().is_some_and(|history| {
                history
                    .runs
                    .iter()
                    .any(|run| run.input_id == Some(input_id))
            })
    }

    pub(crate) fn run_page(&self, run_id: &str) -> Result<AgentRun, AgentError> {
        first_items(&self.find_run(run_id)?, false, fits_run_response).map(|(run, _)| run)
    }

    pub(crate) fn archive_display(&mut self) -> Result<(), AgentError> {
        let Some(journal) = &self.journal else {
            return Ok(());
        };
        let history = self
            .display_history
            .get_or_insert_with(DisplayHistory::default);
        while let Some(run) = self.view.runs.first() {
            if run.status == AgentRunStatus::InProgress as i32 {
                break;
            }
            if self.view.runs.len() == 1 && run.status != AgentRunStatus::Completed as i32 {
                // Continue may settle tool calls on the latest unsuccessful Run.
                break;
            }
            history.append(run, journal.path().parent().ok_or(AgentError::Internal)?)?;
            self.view.runs.remove(0);
        }
        Ok(())
    }

    pub(crate) fn display_run(&self, index: usize) -> Result<AgentRun, AgentError> {
        let source = self.source(index).ok_or(AgentError::NotFound("run"))?;
        let mut run = source.header()?;
        for index in 0..source.len() {
            run.items.push(source.item(index)?);
        }
        Ok(run)
    }

    pub(crate) fn title_run_indices(&self) -> impl DoubleEndedIterator<Item = (usize, RunId)> + '_ {
        let archived = self.display_history.as_ref().map_or(0, DisplayHistory::len);
        let live = self
            .view
            .runs
            .iter()
            .enumerate()
            .filter_map(move |(index, run)| {
                if crate::title::is_title_round(run) {
                    Some((archived + index, run.run_id.parse().ok()?))
                } else {
                    None
                }
            });
        self.display_history
            .iter()
            .flat_map(DisplayHistory::title_rounds)
            .chain(live)
    }

    pub(crate) fn run_id_at(&self, index: usize) -> Option<RunId> {
        self.source(index)?.id().ok()
    }

    pub(crate) fn recent_run_index(&self, id: RunId, count: usize) -> bool {
        self.run_index(id)
            .is_some_and(|index| index >= self.run_count().saturating_sub(count))
    }

    pub(crate) fn read_run_items(
        &self,
        request: ReadRunItemsRequest,
    ) -> Result<ReadRunItemsResponse, AgentError> {
        let source = self.find_run(&request.run_id)?;
        let mut cursor = ItemCursor::parse(&request.continuation, &request.run_id, source.len())?;
        let mut page = ReadRunItemsResponse::default();
        while let Some(index) = cursor.take(source.len()) {
            let item = paged_item(&source, index)?;
            page.items.push(item);
            page.continuation = cursor.token(&request.run_id, source.len());
            if page.encoded_len() > PAGE_BYTES {
                page.items.pop();
                cursor.next = index;
                break;
            }
            if page.items.len() == PAGE_ITEMS {
                break;
            }
        }
        if page.items.is_empty() && cursor.has_more(source.len()) {
            return Err(AgentError::ResourceExhausted("run item page"));
        }
        page.continuation = cursor.token(&request.run_id, source.len());
        if cursor.backwards {
            page.items.reverse();
        }
        Ok(page)
    }

    pub(crate) fn read_item_content(
        &self,
        request: ReadItemContentRequest,
    ) -> Result<ReadItemContentResponse, AgentError> {
        let source = self.find_run(&request.run_id)?;
        let field = AgentItemField::try_from(request.field)
            .ok()
            .filter(|field| *field != AgentItemField::Unspecified)
            .ok_or(AgentError::InvalidArgument("field"))?;
        let item = source.item_by_id(&request.item_id)?;
        let text = item_field(&item, field).ok_or(AgentError::NotFound("item field"))?;
        let start = usize::try_from(request.offset)
            .ok()
            .filter(|offset| text.is_char_boundary(*offset))
            .ok_or(AgentError::InvalidArgument("offset"))?;
        let end = start + boundary(&text[start..], CHUNK_BYTES);
        Ok(ReadItemContentResponse {
            text: text[start..end].to_owned(),
            next_offset: (end < text.len()).then_some(end as u64),
        })
    }

    fn find_run(&self, id: &str) -> Result<RunSource<'_>, AgentError> {
        let id = crate::session::parse_id(id, "run_id")?;
        self.run_index(id)
            .and_then(|index| self.source(index))
            .ok_or(AgentError::NotFound("run"))
    }

    pub(crate) fn history_page(
        &self,
        include_runs: bool,
        continuation: &str,
        frame: SessionFrame,
    ) -> Result<AgentSession, AgentError> {
        let mut view = session_header(&self.view);
        if !include_runs {
            if !continuation.is_empty() {
                return Err(AgentError::InvalidArgument("runs_continuation"));
            }
            return Ok(view);
        }

        let end = if continuation.is_empty() {
            self.run_count()
        } else {
            let (session_id, run_id) = continuation
                .split_once('/')
                .filter(|(session, _)| *session == self.view.session_id)
                .ok_or(AgentError::InvalidArgument("runs_continuation"))?;
            // Parse both values as canonical session/run identities.
            let _: SessionId = crate::session::parse_id(session_id, "runs_continuation")?;
            self.run_index(crate::session::parse_id(run_id, "runs_continuation")?)
                .ok_or(AgentError::InvalidArgument("runs_continuation"))?
        };
        for index in (0..end).rev().take(PAGE_RUNS) {
            let source = self.source(index).ok_or(AgentError::Internal)?;
            let next = if index > 0 {
                format!("{}/{}", view.session_id, source.id()?)
            } else {
                String::new()
            };
            let previous = std::mem::replace(&mut view.runs_continuation, next);
            let base = view.encoded_len();
            let fits = |run: &AgentRun| frame.fits(base + embedded_len(run.encoded_len()));
            let (run, byte_limited) = if view.runs.is_empty() {
                first_items(&source, false, fits)?
            } else {
                let (candidate, byte_limited) = first_items(&source, false, fits_run_response)?;
                if !fits(&candidate) {
                    view.runs_continuation = previous;
                    break;
                }
                (candidate, byte_limited)
            };
            view.runs.push(run);
            if byte_limited {
                break;
            }
        }
        view.runs.reverse();
        Ok(view)
    }
}

fn session_header(view: &AgentSession) -> AgentSession {
    AgentSession {
        session_id: view.session_id.clone(),
        config: view.config.clone(),
        status: view.status,
        created_at_ms: view.created_at_ms,
        metadata_revision: view.metadata_revision,
        title: view.title.clone(),
        title_model_ref: view.title_model_ref.clone(),
        auto_title_enabled: view.auto_title_enabled,
        provider_name: view.provider_name.clone(),
        model_name: view.model_name.clone(),
        model_info_warning: view.model_info_warning.clone(),
        archived: view.archived,
        archive_revision: view.archive_revision,
        updated_at_ms: view.updated_at_ms,
        cwd: view.cwd.clone(),
        queued_inputs: view.queued_inputs.clone(),
        queue_error: view.queue_error.clone(),
        ..Default::default()
    }
}

#[derive(Clone, Copy)]
struct ItemCursor {
    backwards: bool,
    next: usize,
    pinned_from: usize,
    pinned_through: usize,
}

impl ItemCursor {
    fn parse(token: &str, run_id: &str, len: usize) -> Result<Self, AgentError> {
        let invalid = AgentError::InvalidArgument("continuation");
        let mut fields = token.split('/');
        if fields.next() != Some(run_id) {
            return Err(invalid);
        }
        let backwards = match fields.next() {
            Some("older") => true,
            Some("newer") => false,
            _ => return Err(invalid),
        };
        let next = fields
            .next()
            .and_then(|value| value.parse().ok())
            .ok_or(invalid.clone())?;
        let pinned_from = fields
            .next()
            .and_then(|value| value.parse().ok())
            .ok_or(invalid.clone())?;
        let pinned_through = fields
            .next()
            .and_then(|value| value.parse().ok())
            .ok_or(invalid.clone())?;
        if fields.next().is_some()
            || next == 0
            || next >= len
            || pinned_from > pinned_through
            || pinned_through >= len
        {
            return Err(invalid);
        }
        Ok(Self {
            backwards,
            next,
            pinned_from,
            pinned_through,
        })
    }

    fn take(&mut self, len: usize) -> Option<usize> {
        while self.next > 0 && self.next < len {
            let index = self.next;
            if self.backwards {
                self.next -= 1;
            } else {
                self.next += 1;
            }
            if !(self.pinned_from..=self.pinned_through).contains(&index) {
                return Some(index);
            }
        }
        None
    }

    fn has_more(mut self, len: usize) -> bool {
        self.take(len).is_some()
    }

    fn token(mut self, run_id: &str, len: usize) -> String {
        let Some(next) = self.take(len) else {
            return String::new();
        };
        let direction = if self.backwards { "older" } else { "newer" };
        format!(
            "{run_id}/{direction}/{next}/{}/{}",
            self.pinned_from, self.pinned_through
        )
    }
}

fn first_items(
    source: &RunSource<'_>,
    prefer_latest: bool,
    fits: impl Fn(&AgentRun) -> bool,
) -> Result<(AgentRun, bool), AgentError> {
    let mut run = source.header()?;
    let len = source.len();
    if len == 0 {
        return Ok((run, false));
    }
    let active = run.status == AgentRunStatus::InProgress as i32;
    let backwards = active || prefer_latest;
    let (first_pin, last_pin) = if active {
        let active_item = source.active_item().unwrap_or(0);
        (active_item, active_item)
    } else {
        source.final_items().unwrap_or_default()
    };
    let mut cursor = ItemCursor {
        backwards,
        next: if backwards { len - 1 } else { 1 },
        pinned_from: last_pin,
        pinned_through: last_pin,
    };

    // Preserve framing when folding execution details. Pinned Items count against
    // the page and never reappear in its continuation.
    run.items.push(paged_item(source, 0)?);
    if last_pin != 0 {
        run.items.push(paged_item(source, last_pin)?);
    }
    run.items_continuation = cursor.token(&run.run_id, len);
    run.items_continuation_is_older = backwards && !run.items_continuation.is_empty();
    if !fits(&run) {
        return Err(AgentError::ResourceExhausted("run display frame"));
    }

    let mut byte_limited = false;
    for index in (first_pin..last_pin).rev() {
        if run.items.len() == PAGE_ITEMS {
            break;
        }
        run.items.push(paged_item(source, index)?);
        cursor.pinned_from = index;
        run.items_continuation = cursor.token(&run.run_id, len);
        run.items_continuation_is_older = backwards && !run.items_continuation.is_empty();
        if !fits(&run) {
            run.items.pop();
            cursor.pinned_from = index + 1;
            byte_limited = true;
            break;
        }
    }
    while run.items.len() < PAGE_ITEMS {
        let Some(index) = cursor.take(len) else {
            break;
        };
        let item = paged_item(source, index)?;
        run.items.push(item);
        run.items_continuation = cursor.token(&run.run_id, len);
        run.items_continuation_is_older = backwards && !run.items_continuation.is_empty();
        if !fits(&run) {
            run.items.pop();
            cursor.next = index;
            byte_limited = true;
            break;
        }
    }
    run.items_continuation = cursor.token(&run.run_id, len);
    run.items_continuation_is_older = backwards && !run.items_continuation.is_empty();
    run.items.sort_by_key(|item| item.history_index);
    Ok((run, byte_limited))
}

fn embedded_len(len: usize) -> usize {
    1 + encoded_len_varint(len as u64) + len
}

pub(crate) enum SessionFrame {
    Read,
    Ready(i64),
}

impl SessionFrame {
    fn fits(&self, session_len: usize) -> bool {
        // ReadSessionResponse.found and its session, or AgentEvent.emitted_at_ms
        // and SubscriptionReady.session. These message fields have one-byte tags.
        let size = match self {
            Self::Read => 2 + embedded_len(session_len),
            Self::Ready(at) => {
                let timestamp = AgentEvent {
                    emitted_at_ms: *at,
                    ..Default::default()
                };
                timestamp.encoded_len() + embedded_len(embedded_len(session_len))
            }
        };
        size <= PAGE_BYTES
    }
}

fn fits_run_response(run: &AgentRun) -> bool {
    let session_id_size = embedded_len(36);
    embedded_len(session_id_size + embedded_len(run.encoded_len())) + 11 <= PAGE_BYTES
}

pub(crate) fn completed_run(run: &AgentRun) -> AgentRun {
    first_items(&RunSource::Live(run), true, fits_run_response)
        .map(|(run, _)| run)
        .unwrap_or_else(|_| run_header(run))
}

fn boundary(text: &str, limit: usize) -> usize {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}

pub(crate) fn preview(mut item: AgentItem) -> AgentItem {
    let mut shorten = |text: &mut String, field: AgentItemField| {
        if text.len() > PREVIEW_BYTES {
            text.truncate(boundary(text, PREVIEW_BYTES));
            text.shrink_to_fit();
            item.shortened_fields.push(field.into());
        }
    };
    match &mut item.content {
        Some(agent_item::Content::AgentMessage(message)) => {
            shorten(&mut message.text, AgentItemField::Text);
        }
        Some(agent_item::Content::Reasoning(message)) => {
            shorten(&mut message.text, AgentItemField::Text);
        }
        Some(agent_item::Content::ToolCall(tool)) => {
            shorten(&mut tool.arguments_json, AgentItemField::ToolArguments);
            shorten(&mut tool.output, AgentItemField::ToolOutput);
            if let Some(metadata) = &mut tool.metadata_json {
                shorten(metadata, AgentItemField::ToolMetadata);
            }
        }
        _ => {}
    }
    item
}

fn paged_item(source: &RunSource<'_>, index: usize) -> Result<AgentItem, AgentError> {
    let mut item = preview(source.item(index)?);
    item.history_index = Some(u32::try_from(index).map_err(|_| AgentError::Internal)?);
    Ok(item)
}

fn item_field(item: &AgentItem, field: AgentItemField) -> Option<&str> {
    match (&item.content, field) {
        (Some(agent_item::Content::AgentMessage(message)), AgentItemField::Text) => {
            Some(&message.text)
        }
        (Some(agent_item::Content::Reasoning(reasoning)), AgentItemField::Text) => {
            Some(&reasoning.text)
        }
        (Some(agent_item::Content::ToolCall(tool)), AgentItemField::ToolArguments) => {
            Some(&tool.arguments_json)
        }
        (Some(agent_item::Content::ToolCall(tool)), AgentItemField::ToolOutput) => {
            Some(&tool.output)
        }
        (Some(agent_item::Content::ToolCall(tool)), AgentItemField::ToolMetadata) => {
            tool.metadata_json.as_deref()
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use xw_agent_types::BlockId;

    fn run(count: usize, text: &str, status: AgentRunStatus) -> AgentRun {
        let gen_id = xw_agent_types::GenId::new().to_string();
        let mut items = vec![AgentItem {
            item_id: BlockId::new().to_string(),
            content: Some(agent_item::Content::UserMessage(AgentUserMessage::default())),
            ..Default::default()
        }];
        items.extend((1..count).map(|index| AgentItem {
            item_id: BlockId::new().to_string(),
            gen_id: (index + 1 == count).then(|| gen_id.clone()),
            content: Some(agent_item::Content::AgentMessage(AgentMessage {
                text: text.into(),
            })),
            ..Default::default()
        }));
        AgentRun {
            status: status.into(),
            run_id: RunId::new().to_string(),
            input_id: InputId::new().to_string(),
            final_gen_id: Some(gen_id).filter(|_| status == AgentRunStatus::Completed),
            items,
            ..Default::default()
        }
    }

    #[test]
    fn runs_and_items_page_by_count_and_budget_from_disk() {
        let directory = tempfile::tempdir().unwrap();
        let mut session = Session::new(SessionId::new(), 1, AgentModelConfig::default());
        let mut history = DisplayHistory::default();
        for _ in 0..21 {
            history
                .append(
                    &run(3, "small", AgentRunStatus::Completed),
                    directory.path(),
                )
                .unwrap();
        }
        let tail = run(46, &"中".repeat(19_000), AgentRunStatus::Completed);
        history.append(&tail, directory.path()).unwrap();
        session.display_history = Some(history);
        assert!(session.view.runs.is_empty());

        let at = 12345678;
        let newest = session
            .history_page(true, "", SessionFrame::Ready(at))
            .unwrap();
        assert_eq!(newest.runs.len(), 1);
        let first = newest.runs.last().unwrap();
        assert_eq!(first.run_id, tail.run_id);
        assert_eq!(first.items[0].item_id, tail.items[0].item_id);
        assert_eq!(
            first.items.last().unwrap().item_id,
            tail.items.last().unwrap().item_id
        );
        assert!(first.items.len() < PAGE_ITEMS);
        let mut seen: Vec<_> = first
            .items
            .iter()
            .map(|item| item.history_index.unwrap())
            .collect();
        let mut continuation = first.items_continuation.clone();
        while !continuation.is_empty() {
            let page = session
                .read_run_items(ReadRunItemsRequest {
                    run_id: tail.run_id.clone(),
                    continuation,
                    ..Default::default()
                })
                .unwrap();
            assert!(page.items.len() <= PAGE_ITEMS);
            assert!(page.encoded_len() <= PAGE_BYTES);
            seen.extend(page.items.iter().map(|item| item.history_index.unwrap()));
            continuation = page.continuation;
        }
        seen.sort_unstable();
        assert_eq!(seen, (0..46).collect::<Vec<u32>>());

        let next = newest.runs_continuation.clone();
        let ready = AgentEvent {
            emitted_at_ms: at,
            payload: Some(agent_event::Payload::SubscriptionReady(SubscriptionReady {
                session: Some(newest),
            })),
        };
        assert!(ready.encoded_len() <= PAGE_BYTES);
        let earlier = session
            .history_page(true, &next, SessionFrame::Read)
            .unwrap();
        assert_eq!(earlier.runs.len(), 20);
        assert_eq!(
            earlier.runs[0].run_id,
            session.run_id_at(1).unwrap().to_string()
        );
        let oldest = session
            .history_page(true, &earlier.runs_continuation, SessionFrame::Read)
            .unwrap();
        assert_eq!(oldest.runs.len(), 1);
        assert!(oldest.runs_continuation.is_empty());

        let other = Session::new(SessionId::new(), 1, AgentModelConfig::default());
        assert!(matches!(
            other.history_page(true, &next, SessionFrame::Read),
            Err(AgentError::InvalidArgument(_))
        ));
    }

    #[test]
    fn active_cursor_reads_backward_after_completion_and_long_text_reads_on_character_boundaries() {
        let directory = tempfile::tempdir().unwrap();
        let text = "中🙂".repeat(50_001);
        let mut session = Session::new(SessionId::new(), 1, AgentModelConfig::default());
        let active = run(31, &text, AgentRunStatus::InProgress);
        session.view.runs.push(active);
        let first = session
            .history_page(true, "", SessionFrame::Read)
            .unwrap()
            .runs
            .remove(0);
        assert!(first.items_continuation_is_older);
        assert_eq!(first.items.last().unwrap().history_index, Some(30));
        let mut completed = session.view.runs.remove(0);
        completed.status = AgentRunStatus::Completed.into();
        let mut display = DisplayHistory::default();
        display.append(&completed, directory.path()).unwrap();
        session.display_history = Some(display);

        let page = session
            .read_run_items(ReadRunItemsRequest {
                run_id: first.run_id.clone(),
                continuation: first.items_continuation,
                ..Default::default()
            })
            .unwrap();
        assert!(page.items.last().unwrap().history_index < first.items[1].history_index);
        assert!(
            page.items
                .iter()
                .all(|item| item.shortened_fields == [AgentItemField::Text as i32])
        );

        let mut request = ReadItemContentRequest {
            run_id: first.run_id,
            item_id: page.items[0].item_id.clone(),
            field: AgentItemField::Text.into(),
            ..Default::default()
        };
        request.offset = 1;
        assert_eq!(
            session.read_item_content(request.clone()),
            Err(AgentError::InvalidArgument("offset"))
        );
        request.offset = 0;
        let mut reconstructed = String::new();
        loop {
            let chunk = session.read_item_content(request.clone()).unwrap();
            reconstructed.push_str(&chunk.text);
            assert!(chunk.text.len() <= CHUNK_BYTES);
            let Some(next) = chunk.next_offset else { break };
            request.offset = next;
        }
        assert_eq!(reconstructed, text);
    }
}
