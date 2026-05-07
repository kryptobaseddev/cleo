//! Generated SQLite pragma SSoT module.
//!
//! Sources `specs/sqlite-pragmas.json` at compile time via `build.rs`
//! and exposes the canonical pragma SQL string as `SQLITE_PRAGMA_SQL`
//! (plus `SQLITE_PRAGMA_SQL_BATCH` and `SQLITE_PRAGMAS`). Both consumers
//! of the SSoT — this crate and `packages/core/src/store/sqlite-pragmas.ts`
//! — render byte-identical SQL because they share the same JSON file
//! and the same `PRAGMA name = value` template.
//!
//! See T9053 for the policy rationale.

include!(concat!(env!("OUT_DIR"), "/sqlite_pragmas_generated.rs"));
