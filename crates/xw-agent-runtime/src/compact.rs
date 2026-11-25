use xw_agent_types::{
    AgentMessage, AssistantMessage, COMPACTION_SUMMARY_PREFIX, ContentBlock, FinishReason,
    UserMessage,
};

const RETAIN_USER_TOKENS: u64 = 20_000;
const TRUNCATION_MARKER: &str = "\n…[truncated]…\n";

const PROMPT: &str = concat!(
    "Summarize the conversation history for another assistant that will continue the work.\n\n",
    "Preserve the user's current goal, confirmed decisions, important paths and identifiers, ",
    "completed work, key tool\n",
    "results and errors, and every unfinished item. Be factual and concise. ",
    "Do not claim that work was completed unless\n",
    "the history shows it was completed. Distinguish observed and unknown outcomes.",
);

pub fn summary_input(history: &[AgentMessage], at: i64) -> Vec<AgentMessage> {
    let mut messages = history
        .iter()
        .filter(|message| !matches!(message, AgentMessage::SystemContext { .. }))
        .cloned()
        .collect::<Vec<_>>();
    messages.push(user(PROMPT.into(), at));
    messages
}

pub fn summary_text(response: &AssistantMessage) -> Option<String> {
    if !matches!(
        response.stop_reason,
        FinishReason::Stop | FinishReason::Length
    ) || response
        .content
        .iter()
        .any(|block| matches!(block, ContentBlock::ToolCall { .. }))
    {
        return None;
    }
    let text = text_blocks(&response.content).collect::<String>();
    let summary = text.trim();
    (!summary.is_empty()).then(|| summary.to_owned())
}

pub fn replacement_history(
    history: &[AgentMessage],
    summary: &str,
    at: i64,
    previous_summary_index: Option<usize>,
    retain_tokens: u64,
) -> Vec<AgentMessage> {
    let mut bytes_left = (RETAIN_USER_TOKENS.min(retain_tokens) * 4) as usize;
    let mut retained = Vec::new();
    for (index, message) in history.iter().enumerate().rev() {
        if Some(index) == previous_summary_index {
            continue;
        }
        let AgentMessage::User(message) = message else {
            continue;
        };
        let text = text_blocks(&message.content).collect::<Vec<_>>().join("\n");
        if text.is_empty() {
            continue;
        }
        if bytes_left == 0 {
            break;
        }
        let text = if text.len() > bytes_left {
            if bytes_left <= TRUNCATION_MARKER.len() {
                break;
            }
            let keep = bytes_left - TRUNCATION_MARKER.len();
            let head = text.floor_char_boundary(keep / 2);
            let tail = text.ceil_char_boundary(text.len() - (keep - keep / 2));
            bytes_left = 0;
            format!("{}{TRUNCATION_MARKER}{}", &text[..head], &text[tail..])
        } else {
            bytes_left -= text.len();
            text
        };
        retained.push(user(text, message.timestamp_ms));
    }
    retained.reverse();
    retained.push(user(format!("{COMPACTION_SUMMARY_PREFIX}{summary}"), at));
    retained
}

fn text_blocks(content: &[ContentBlock]) -> impl Iterator<Item = &str> {
    content.iter().filter_map(|block| match block {
        ContentBlock::Text { text, .. } => Some(text.as_str()),
        _ => None,
    })
}

fn user(text: String, timestamp_ms: i64) -> AgentMessage {
    AgentMessage::User(UserMessage {
        content: vec![ContentBlock::Text {
            text,
            signature: None,
        }],
        timestamp_ms,
    })
}
