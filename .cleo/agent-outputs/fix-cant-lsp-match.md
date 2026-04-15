# Fix: cant-lsp Non-Exhaustive Match Patterns

**Date**: 2026-04-13
**Status**: complete

## Problem

`cant-lsp` failed to compile with two `E0004` non-exhaustive pattern errors:

1. `hover.rs:241` — `Value::ProseBlock(_)` not covered in `prop_value_preview`
2. `symbols.rs:20` — `Section::Team(_)` and `Section::Tool(_)` not covered in `document_symbols`

Both variants were recently added to `cant-core` (`ProseBlock` in `Value`, `Team`/`Tool` in `Section`) but the match statements in `cant-lsp` were not updated.

## Fix

### `crates/cant-lsp/src/hover.rs` — `prop_value_preview`

Added `Value::ProseBlock(p)` arm that returns the first line of the prose block as a
preview string (falls back to `"|..."` when the block is empty). This mirrors the
treatment of `Value::String` — show the raw content rather than a type label.

```rust
cant_core::dsl::ast::Value::ProseBlock(p) => {
    p.lines.first().cloned().unwrap_or_else(|| "|...".to_string())
}
```

### `crates/cant-lsp/src/symbols.rs` — `document_symbols`

Added explicit arms for `Section::Team` and `Section::Tool` following the same pattern
as `Section::Skill` (both structs carry `name`, `properties`, and `span` fields):

- `Section::Team` — emits a `SymbolKind::NAMESPACE` symbol (a team groups multiple
  agents, analogous to a namespace/module boundary)
- `Section::Tool` — emits a `SymbolKind::FUNCTION` symbol (consistent with `Pipeline`
  and `Workflow`, since tools are callable units)

No catch-all `_ =>` arms were added. Every variant is matched explicitly.

## Verification

```
FERROUS_FORGE_ENABLED=0 cargo check -p cant-lsp
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.31s
```

Zero errors, zero new warnings in `cant-lsp`.

## Files Changed

- `crates/cant-lsp/src/hover.rs` — added `ProseBlock` arm in `prop_value_preview`
- `crates/cant-lsp/src/symbols.rs` — added `Team` and `Tool` arms in `document_symbols`
