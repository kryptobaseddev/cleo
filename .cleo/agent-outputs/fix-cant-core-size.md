# Fix: ferrous-forge size violations in cant-core

**Status**: complete
**Date**: 2026-04-13

## Summary

Three ferrous-forge size violations in `crates/cant-core/` were resolved without breaking the public API or any existing tests.

## Violations Resolved

| Violation | Before | After | Limit |
|-----------|--------|-------|-------|
| FUNCTIONTOOLARGE: `dsl/mod.rs` `parse_document` | 228 lines | 54 lines | 200 |
| FILETOOLARGE: `dsl/ast.rs` | 846 lines | 657 lines | 800 |
| FILETOOLARGE: `validate/hierarchy.rs` | 820 lines | 415 lines | 800 |

## Changes Made

### 1. `crates/cant-core/src/dsl/mod.rs` — FUNCTIONTOOLARGE fix

`parse_document` was a 228-line monolithic function. Extracted three private helpers:

- `parse_sections(lines, start_idx)` — the main section-parsing loop
- `parse_comment_line(line, sections)` — constructs and appends a `Section::Comment`
- `parse_block(lines, idx, content_str, line, sections, errors)` — dispatches to block parsers; returns `BlockResult`
- `parse_block_result(result, sections, errors, wrap)` — generic helper that converts a block parser `Result<(T, usize), ParseError>` into a `BlockResult`
- `enum BlockResult` — `Consumed(n)`, `SingleLine`, `Unknown`

Added `IndentedLine` to the `use indent::...` import. Added `pub mod ast_expressions` declaration.

`parse_document` is now 54 lines; it delegates section parsing to `parse_sections`.

### 2. `crates/cant-core/src/dsl/ast_expressions.rs` — new file (created)

Extracted the expression language types from `ast.rs` into this new module:
`Expression`, `NameExpr`, `StringExpr`, `StringSegment`, `NumberExpr`, `BooleanExpr`, `DurationExpr`, `TaskRefExpr`, `AddressExpr`, `ArrayExpr`, `PropertyAccessExpr`, `ComparisonExpr`, `ComparisonOp`, `LogicalExpr`, `LogicalOp`, `NegationExpr`, `InterpolationExpr`.

The module imports `DurationUnit` from `super::ast` to avoid duplication.

### 3. `crates/cant-core/src/dsl/ast.rs` — FILETOOLARGE fix

Replaced the ~220-line expression section (lines 557–775) with a re-export block:

```rust
pub use super::ast_expressions::{
    AddressExpr, ArrayExpr, BooleanExpr, ComparisonExpr, ComparisonOp, DurationExpr, Expression,
    InterpolationExpr, LogicalExpr, LogicalOp, NameExpr, NegationExpr, NumberExpr,
    PropertyAccessExpr, StringExpr, StringSegment, TaskRefExpr,
};
```

All public paths are preserved — downstream code that imports from `cant_core::dsl::ast` sees no change.

### 4. `crates/cant-core/src/validate/hierarchy_tests.rs` — new file (created)

Moved the 408-line `#[cfg(test)] mod tests { ... }` block out of `hierarchy.rs` into this sibling file.

### 5. `crates/cant-core/src/validate/hierarchy.rs` — FILETOOLARGE fix

Replaced the inline test module with:

```rust
#[cfg(test)]
#[path = "hierarchy_tests.rs"]
mod tests;
```

All 35 test cases are still in the module and pass.

## Quality Gate Results

```
FERROUS_FORGE_ENABLED=0 cargo check -p cant-core     → 0 errors
FERROUS_FORGE_ENABLED=0 cargo check --workspace      → 0 errors
FERROUS_FORGE_ENABLED=0 cargo test -p cant-core --lib → 574 passed, 0 failed
```

The pre-existing integration test failure `team_platform_fixture_parses_clean` (in `tests/parse_new_sections.rs`) was already failing before these changes and is unrelated.

## Files Modified

- `crates/cant-core/src/dsl/mod.rs` — refactored `parse_document`, added imports
- `crates/cant-core/src/dsl/ast.rs` — replaced expression defs with re-export
- `crates/cant-core/src/validate/hierarchy.rs` — replaced inline tests with `#[path]` include

## Files Created

- `crates/cant-core/src/dsl/ast_expressions.rs`
- `crates/cant-core/src/validate/hierarchy_tests.rs`
