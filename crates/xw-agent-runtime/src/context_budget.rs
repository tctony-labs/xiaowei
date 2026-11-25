use xw_agent_types::{AgentMessage, ModelBudget, TokenUsage};

const AUTO_COMPACT_PERCENT: u64 = 80;
const MAX_SAFE_TOKENS: u64 = (1 << 53) - 1;

pub const SUMMARY_MAX_TOKENS: u32 = 4_096;

pub fn estimate_text(text: &str) -> u64 {
    text.len().div_ceil(4) as u64
}

pub fn estimate_tokens(messages: &[AgentMessage]) -> u64 {
    messages
        .iter()
        .map(|message| {
            // Include the system baseline and deltas, tool schemas and structured message content.
            let bytes = serde_json::to_vec(message)
                .expect("validated model message")
                .len();
            bytes.div_ceil(4) as u64 + 4
        })
        .sum()
}

pub fn context_tokens(usage: &TokenUsage) -> Option<u64> {
    // Pi reports uncached input, cache reads and cache writes as separate input categories.
    let tokens = usage
        .input
        .saturating_add(usage.cache_read)
        .saturating_add(usage.cache_write);
    (tokens <= MAX_SAFE_TOKENS).then_some(tokens)
}

#[derive(Clone, Copy)]
pub struct ContextSample {
    pub tokens: u64,
    /// First message absent from the sampled request.
    pub offset: usize,
}

pub struct ContextBudget {
    pub projected: u64,
    pub estimated: u64,
    pub measured: Option<u64>,
    pub window: u64,
    pub hard_limit: u64,
}

impl ContextBudget {
    pub fn new(
        model: &ModelBudget,
        sample: Option<ContextSample>,
        history: &[AgentMessage],
        upcoming: &[AgentMessage],
    ) -> Self {
        let additional = estimate_tokens(upcoming);
        let estimated = estimate_tokens(history).saturating_add(additional);
        let measured = sample.map(|sample| sample.tokens);
        let extrapolated = sample.and_then(|sample| {
            history.get(sample.offset..).map(|suffix| {
                sample
                    .tokens
                    .saturating_add(estimate_tokens(suffix))
                    .saturating_add(additional)
            })
        });
        Self {
            projected: estimated.max(extrapolated.unwrap_or_default()),
            estimated,
            measured,
            window: model.context_window,
            hard_limit: model.context_window.saturating_sub(model.max_output_tokens),
        }
    }

    pub fn should_compact(&self) -> bool {
        self.projected >= (self.window * AUTO_COMPACT_PERCENT).div_ceil(100)
            || self.projected > self.hard_limit
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use xw_agent_types::{BudgetSource, ContentBlock, UserMessage};

    #[test]
    fn budget_uses_the_larger_of_full_estimate_and_sample_plus_new_messages() {
        let user = AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: "new message".into(),
                signature: None,
            }],
            timestamp_ms: 0,
        });
        let additional = estimate_tokens(std::slice::from_ref(&user));
        let model = ModelBudget {
            context_window: 1000,
            max_output_tokens: 150,
            source: BudgetSource::Host,
        };
        for (projected, should_compact) in [(799, false), (800, true), (850, true), (851, true)] {
            let sample = ContextSample {
                tokens: projected - additional,
                offset: 0,
            };
            let budget = ContextBudget::new(&model, Some(sample), &[], std::slice::from_ref(&user));
            assert_eq!(budget.projected, projected);
            assert_eq!(budget.hard_limit, 850);
            assert_eq!(budget.should_compact(), should_compact);
        }
        let sample = ContextSample {
            tokens: 0,
            offset: 1,
        };
        let budget = ContextBudget::new(&model, Some(sample), &[user], &[]);
        assert_eq!(budget.projected, additional);
    }

    #[test]
    fn the_hard_limit_can_fall_below_the_soft_threshold() {
        let model = ModelBudget {
            context_window: 1000,
            max_output_tokens: 350,
            source: BudgetSource::Host,
        };
        for (tokens, should_compact) in [(650, false), (651, true)] {
            let sample = ContextSample { tokens, offset: 0 };
            let budget = ContextBudget::new(&model, Some(sample), &[], &[]);
            assert_eq!(budget.should_compact(), should_compact);
        }
    }
}
