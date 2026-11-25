use std::{collections::BTreeMap, ops::Index};

use serde::{Deserialize, Serialize};

use crate::{ToolDeclaration, ValidationError, validation};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Instruction {
    name: String,
    content: String,
}

/// Named instructions in prompt order. Replacing a name keeps its existing position.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SystemInstructions(Vec<Instruction>);

impl SystemInstructions {
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0
            .iter()
            .map(|entry| (entry.name.as_str(), entry.content.as_str()))
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.iter().map(|(name, _)| name)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn get(&self, name: &str) -> Option<&str> {
        self.iter()
            .find_map(|(key, content)| (key == name).then_some(content))
    }

    pub fn contains_key(&self, name: &str) -> bool {
        self.get(name).is_some()
    }

    pub fn insert(&mut self, name: String, content: String) -> Option<String> {
        if let Some(entry) = self.0.iter_mut().find(|entry| entry.name == name) {
            return Some(std::mem::replace(&mut entry.content, content));
        }
        self.0.push(Instruction { name, content });
        None
    }

    pub fn remove(&mut self, name: &str) -> Option<String> {
        let position = self.0.iter().position(|entry| entry.name == name)?;
        Some(self.0.remove(position).content)
    }

    pub fn retain(&mut self, mut keep: impl FnMut(&str) -> bool) {
        self.0.retain(|entry| keep(&entry.name));
    }
}

impl FromIterator<(String, String)> for SystemInstructions {
    fn from_iter<T: IntoIterator<Item = (String, String)>>(entries: T) -> Self {
        Self(
            entries
                .into_iter()
                .map(|(name, content)| Instruction { name, content })
                .collect(),
        )
    }
}

impl Index<&str> for SystemInstructions {
    type Output = String;

    fn index(&self, name: &str) -> &Self::Output {
        &self
            .0
            .iter()
            .find(|entry| entry.name == name)
            .expect("unknown instruction")
            .content
    }
}

/// Model-visible instructions and declarations, without tool instances or provider options.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SystemContext {
    pub instructions: SystemInstructions,
    pub tools: Vec<ToolDeclaration>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SystemContextDelta {
    #[serde(default, skip_serializing_if = "SystemInstructions::is_empty")]
    pub instructions: SystemInstructions,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub instructions_removed: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools_added: Vec<ToolDeclaration>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools_removed: Vec<String>,
}

/// A baseline is distinct from a delta, including when both instructions and tools are empty.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum SystemContextUpdate {
    Baseline(SystemContext),
    Delta(SystemContextDelta),
}

impl SystemContext {
    pub fn validate(&self) -> Result<(), ValidationError> {
        validation::system_context(self)
    }

    /// Named changes are incremental. Previously committed positions are kept until a new baseline.
    pub fn has_same_content(&self, other: &Self) -> bool {
        self.instructions.len() == other.instructions.len()
            && self
                .instructions
                .iter()
                .all(|(name, content)| other.instructions.get(name) == Some(content))
            && self.tools.len() == other.tools.len()
            && self.tools.iter().all(|tool| {
                other
                    .tools
                    .iter()
                    .any(|candidate| tool.has_same_definition(candidate))
            })
    }
}

impl ToolDeclaration {
    pub fn has_same_definition(&self, other: &Self) -> bool {
        self.name == other.name
            && self.description == other.description
            && same_json(&self.parameters_json, &other.parameters_json)
            && match (
                &self.constrained_sampling_json,
                &other.constrained_sampling_json,
            ) {
                (None, None) => true,
                (Some(left), Some(right)) => same_json(left, right),
                _ => false,
            }
    }
}

pub(crate) fn same_json(left: &str, right: &str) -> bool {
    use serde_json::value::RawValue;

    let (Ok(left), Ok(right)) = (
        serde_json::from_str::<&RawValue>(left),
        serde_json::from_str::<&RawValue>(right),
    ) else {
        return false;
    };
    let (left, right) = (left.get(), right.get());

    match (left.as_bytes()[0], right.as_bytes()[0]) {
        (b'{', b'{') => {
            let (Ok(left), Ok(right)) = (
                serde_json::from_str::<BTreeMap<String, &RawValue>>(left),
                serde_json::from_str::<BTreeMap<String, &RawValue>>(right),
            ) else {
                return false;
            };
            left.len() == right.len()
                && left.iter().all(|(name, value)| {
                    right
                        .get(name)
                        .is_some_and(|other| same_json(value.get(), other.get()))
                })
        }
        (b'[', b'[') => {
            let (Ok(left), Ok(right)) = (
                serde_json::from_str::<Vec<&RawValue>>(left),
                serde_json::from_str::<Vec<&RawValue>>(right),
            ) else {
                return false;
            };
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| same_json(left.get(), right.get()))
        }
        (b'"', b'"') => {
            serde_json::from_str::<String>(left).ok() == serde_json::from_str::<String>(right).ok()
        }
        // Preserve number spelling: parsing large schema constants through f64 could hide changes.
        _ => left == right,
    }
}

impl SystemContextUpdate {
    /// Produces a new state; the caller must commit the update before publishing that state.
    pub fn apply(
        &self,
        previous: Option<&SystemContext>,
    ) -> Result<SystemContext, ValidationError> {
        validation::system_context_update(self)?;
        if let Some(previous) = previous {
            previous.validate()?;
        }
        let mut next = match self {
            Self::Baseline(context) => {
                validation::transition(previous.is_none(), "system_context.baseline")?;
                context.clone()
            }
            Self::Delta(delta) => {
                let previous = validation::reference(previous, "system_context.baseline")?;
                let mut next = previous.clone();

                for name in &delta.instructions_removed {
                    validation::transition(
                        next.instructions.remove(name).is_some(),
                        "system_context.instructions_removed",
                    )?;
                }
                for (name, content) in delta.instructions.iter() {
                    next.instructions.insert(name.into(), content.into());
                }

                for name in &delta.tools_removed {
                    validation::transition(
                        next.tools.iter().any(|tool| tool.name == *name),
                        "system_context.tools_removed",
                    )?;
                }
                next.tools
                    .retain(|tool| !delta.tools_removed.contains(&tool.name));

                for tool in &delta.tools_added {
                    validation::transition(
                        !next.tools.iter().any(|current| current.name == tool.name),
                        "system_context.tools_added",
                    )?;
                    next.tools.push(tool.clone());
                }

                validation::transition(!next.has_same_content(previous), "system_context.delta")?;
                next
            }
        };

        next.tools.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(next)
    }
}
