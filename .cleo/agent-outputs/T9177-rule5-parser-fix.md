# T9177 — RULE-5 Parser Fix: CREATE TRIGGER BEGIN...END Body Handling

## Summary

Fixed `countSqlStatements()` in `scripts/lint-migrations.mjs` to correctly handle
SQLite CREATE TRIGGER bodies. The previous parser counted semicolons inside `BEGIN...END`
blocks as statement terminators, causing 5 false-positive RULE-5 violations on migrations
that contain triggers.

## Root Cause

T9165 added a single-pass state machine to `countSqlStatements()` that tracked string
literals and SQL comments, but did not handle `CREATE TRIGGER ... BEGIN ... END;` blocks.
SQLite trigger bodies contain internal semicolons that terminate body statements, not
top-level migration statements. These were being counted, causing the statement count
to exceed the breakpoint count, triggering false RULE-5 ERRORs.

## Fix

Replaced the single-pass scanner with a four-state machine:

- `IDLE` — normal scanning, count top-level semicolons
- `SAW_CREATE` — saw `CREATE`, watching for `TRIGGER`/`TEMP`/`TEMPORARY`
- `SAW_TRIGGER` — confirmed trigger, scanning all header tokens until `BEGIN`
- `IN_BODY` — inside trigger body, skip semicolons until `END;`

The `END;` semicolon is counted as the single statement terminator for the entire
`CREATE TRIGGER` statement.

## Trigger Variants Handled

- `CREATE TRIGGER`
- `CREATE TEMP TRIGGER`
- `CREATE TEMPORARY TRIGGER`
- `CREATE TRIGGER IF NOT EXISTS`
- `CREATE TEMP TRIGGER IF NOT EXISTS`
- `CREATE TEMPORARY TRIGGER IF NOT EXISTS`

## Default-On Flip

RULE-5 is now default-on. The `--enable-rule-5` flag is a no-op (emits a note to
stderr). Added `--disable-rule-5` as an emergency bypass (emits deprecation warning).

## False Positives Eliminated

- `drizzle-tasks/20260417000000_t877-pipeline-stage-invariants/migration.sql`
- `drizzle-tasks/20260424000000_t1408-archive-reason-enum/migration.sql`
- `drizzle-tasks/20260429000000_t1609-handoff-append-only/migration.sql`
- `drizzle-tasks/20260503000000_t1718-handoff-trigger-syntax-fix/migration.sql`
- `drizzle-nexus/20260504000001_t1839-fts5-nexus-symbols/migration.sql`

## Anti-Phantom Evidence

- Commit: `c0338cd7f` on branch `task/T9177`
- File grew from 593 lines (T9165) to 746 lines (+153 lines for parser logic)
- `grep -c "BEGIN" scripts/lint-migrations.mjs` = 15 (> 0)
- `grep -c "TRIGGER" scripts/lint-migrations.mjs` = 24 (> 0)
- `grep -c "IN_BODY|SAW_TRIGGER|SAW_CREATE" scripts/lint-migrations.mjs` = 19 (> 0)
- `grep -c "disable-rule-5" scripts/lint-migrations.mjs` = 8 (> 0)
- `node scripts/lint-migrations.mjs --fail-on=error` exits 0 with 0 ERROR violations
- Pre-commit hook confirmed: `Migration linter passed`

## Quality Gates

- biome ci: PASS (Checked 2164 files, no fixes applied)
- tsc: PASS (build clean)
- pnpm run build: PASS (218613ms)
- Migration linter: 0 ERRORs, 48 WARNs (all RULE-3 snapshot chain warnings, pre-existing)
