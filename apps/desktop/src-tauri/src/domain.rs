// The core domain model — the counterparts of workspace, session, and message.
//
// This is the Release 1 backbone and no more: open a workspace, create a session
// inside it, then hold one conversation that is saved and can be reopened. MCP,
// approvals, artifacts, skills and the rest are leaves on the same trunk, and
// not one of them holds it up.
//
// Every type here derives `specta::Type`, and that is where its TypeScript
// counterpart comes from. No type is ever written twice.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Time is stored as Unix milliseconds. SQLite has no native time type, and an
/// integer sidesteps the whole business of timezone parsing at the boundary.
pub type Millis = i64;

/// Specta refuses to export i64 to TypeScript because `number` loses precision
/// above 2^53, and as a general rule that refusal is right. Unix milliseconds
/// are the exception: around 1.7 x 10^12, four thousand times under the limit,
/// and they only reach it in the year 287396. So each timestamp field declares
/// for itself that it is safe as a `number` — rather than a global switch that
/// would quietly loosen any other i64 added later.
///
/// Declared as `specta_typescript::Number`, not `f64`. Both become `number` in
/// TypeScript, but `f64` becomes `number | null` — because JSON turns NaN and
/// Infinity into `null`, and specta is right to account for it. Timestamps are
/// never NaN, so that `| null` forces every caller to handle something that
/// cannot happen. A lie in that direction costs just as much.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// A real folder on disk. This is what makes a workspace more than a row in
    /// a database.
    pub path: String,
    #[specta(type = specta_typescript::Number)]
    pub created_at: Millis,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    #[specta(type = specta_typescript::Number)]
    pub created_at: Millis,
    #[specta(type = specta_typescript::Number)]
    pub updated_at: Millis,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

impl Role {
    pub fn as_text(self) -> &'static str {
        match self {
            Role::User => "user",
            Role::Assistant => "assistant",
        }
    }

    pub fn from_text(text: &str) -> Option<Self> {
        match text {
            "user" => Some(Role::User),
            "assistant" => Some(Role::Assistant),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub session_id: String,
    pub role: Role,
    pub content: String,
    #[specta(type = specta_typescript::Number)]
    pub created_at: Millis,
}
