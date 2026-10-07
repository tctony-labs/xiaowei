use std::{fmt, str::FromStr};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use uuid::{Uuid, Variant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("expected a canonical UUIDv7")]
pub struct IdError;

macro_rules! identity {
    ($($name:ident),+ $(,)?) => {
        $(
            #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
            pub struct $name(Uuid);

            impl $name {
                pub fn new() -> Self {
                    Self(Uuid::now_v7())
                }
            }

            impl Default for $name {
                fn default() -> Self {
                    Self::new()
                }
            }

            impl fmt::Display for $name {
                fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                    self.0.fmt(f)
                }
            }

            impl FromStr for $name {
                type Err = IdError;

                fn from_str(value: &str) -> Result<Self, Self::Err> {
                    let id = Uuid::parse_str(value).map_err(|_| IdError)?;
                    if id.get_version_num() != 7 || id.get_variant() != Variant::RFC4122 || id.to_string() != value {
                        return Err(IdError);
                    }

                    Ok(Self(id))
                }
            }

            impl Serialize for $name {
                fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                    serializer.collect_str(self)
                }
            }

            impl<'de> Deserialize<'de> for $name {
                fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                    let value = String::deserialize(deserializer)?;
                    value.parse().map_err(serde::de::Error::custom)
                }
            }
        )+
    };
}

identity!(
    SessionId,
    EntryId,
    InputId,
    RunId,
    TurnId,
    GenId,
    MessageId,
    BlockId,
    ToolId,
    InteractionId,
    ClientRequestId,
);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Sequence(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct MetadataRevision(pub u64);
