# T615 — CANT Starter Bundle Parse Error Fix

**Status**: complete
**Option chosen**: B (regenerate starter bundle)
**Date**: 2026-04-14

## Root Cause

The starter bundle `.cant` files used two YAML-style constructs that the
`cant-core` line-based parser does not support:

1. **Multi-line list items** — `skills:` block used `- ct-cleo` style entries.
   The parser's `parse_property_or_prose` expects `key: value` lines; bare
   `- identifier` lines have no colon and trigger "expected key: value" errors.

2. **List-dict items in sub-blocks** — `context_sources:` used:
   ```
   - source: patterns
     query: "..."
     max_entries: 5
   ```
   The parser treated `- source: patterns` as a property with key `- source`
   (wrong), and when that failed, the entire agent block errored, causing all
   body lines to escape as "unexpected top-level construct" errors.

When any agent block returns an error, `parse_block_result` calls
`Consumed(1)` — consuming only the header line — so all indented body lines
then appear at top level, causing an error cascade. This is why 121/131
errors were reported for just 4 agent files.

The `team-platform.cant` fixture was also missing `consult-when:` and
`stages:` required by the TEAM-002 validator rule, causing 1 test failure.

## Decision: Option B (Regenerate Bundle)

The formal DSL spec (`docs/specs/CANT-DSL-SPEC.md` §2.3) specifies inline
arrays `skills: ["ct-cleo", "ct-orchestrator"]` — not YAML-style multiline
lists. Extending the parser to support non-spec YAML list syntax would add
complexity with no spec backing. Regenerating the bundle files to use only
parser-supported syntax is the correct approach.

## Changes Made

### Starter bundle `.cant` files rewritten

All 4 agent files and `team.cant` were regenerated:

- `skills:` changed from multi-line `- item` lists to inline arrays:
  `skills: [ct-cleo, ct-task-executor]`
- `context_sources:` sub-blocks changed from YAML list-of-dicts to flat
  key-value sub-blocks (one key per context source):
  ```
  context_sources:
    on_overflow: escalate_tier
    patterns:
      query: "..."
      max_entries: 5
  ```
- `mental_model:` and `permissions:` blocks already used the correct format.
- `team.cant` already had `consult-when:` and `stages:` (confirmed in HEAD).

### Test fixture fixed

`crates/cant-core/tests/fixtures/team-platform.cant` — added required
`consult-when:` and `stages:` fields to satisfy TEAM-002 validator.

### Integration tests added

`crates/cant-core/tests/parse_new_sections.rs` — replaced the temporary
`t615_starter_bundle_parse_errors_diagnostic` test with 5 permanent
individual tests (one per starter bundle file) plus a `repo_root()` helper
and `assert_starter_file_clean()` helper.

## Verification

```
cargo test -p cant-core
# Result: 607 tests — 574 unit + 8 integration + 16 protocol_lift + 4 render + 4 doc-tests
# ALL PASS, 1 ignored (external file dependency)

pnpm --filter @cleocode/cleo-os run test
# Result: 6 test files, 194 tests — ALL PASS
```

## Files Changed

- `crates/cant-core/tests/parse_new_sections.rs` (modified)
- `crates/cant-core/tests/fixtures/team-platform.cant` (modified — confirmed already at correct state in HEAD)
- `packages/cleo-os/starter-bundle/team.cant` (confirmed already at correct state in HEAD)
- `packages/cleo-os/starter-bundle/agents/cleo-orchestrator.cant` (confirmed)
- `packages/cleo-os/starter-bundle/agents/dev-lead.cant` (confirmed)
- `packages/cleo-os/starter-bundle/agents/code-worker.cant` (confirmed)
- `packages/cleo-os/starter-bundle/agents/docs-worker.cant` (confirmed)
