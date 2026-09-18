// The part of the domain Rantai actually owns.
//
// Only the workspace. It once held sessions and messages too, and they were
// removed the day it turned out OpenCode already stores both — with the title,
// the model, the cost, the token counts, the reasoning and the tool calls, in
// the same store the model reads as context for its next turn. Keeping a second
// copy meant the screen and the model could come to disagree about what was
// said, and nothing would say which one was right.
//
// So a workspace is what is left: a folder a person chose, under a name they
// chose. OpenCode derives its own `project` from the path and has no place for
// the name, which is exactly why this row still has to exist.
//
// Every type here derives `specta::Type`, and that is where its TypeScript
// counterpart comes from. No type is ever written twice.

use serde::{Deserialize, Serialize};
use specta::Type;

/// Time is stored as Unix milliseconds. SQLite has no native time type, and an
/// integer sidesteps the whole business of timezone parsing at the boundary.
/// The engine reports its times the same way, so the two line up without
/// conversion.
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
