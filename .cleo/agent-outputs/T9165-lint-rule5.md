# T9165 — lint-migrations.mjs RULE-5 Implementation

## Summary

Added RULE-5 (ERROR level) to `scripts/lint-migrations.mjs` to detect multi-statement migration.sql files missing `--> statement-breakpoint` separators.

## What Was Done

- Added `RULE_5_ENABLED` flag gated behind `--enable-rule-5` CLI argument (default-off)
- Implemented `countSqlStatements(sql)`: single-pass state-machine parser that skips semicolons inside string literals (`'...'`), double-quoted identifiers (`"..."`), backtick-quoted identifiers, line comments (`-- ...`), and block comments (`/* ... */`)
- Implemented `countBreakpoints(content)`: counts `--> statement-breakpoint` markers
- Implemented `rule5MissingBreakpoints()`: emits ERROR when `stmtCount > 1 && breakpointCount < stmtCount - 1`
- Wired RULE-5 into main scan loop alongside RULE-1
- Added `RULE-5 enabled: yes/no` line to scan summary output
- Updated file-level docstring to document RULE-5 and `--enable-rule-5` flag
- GitHub Actions `::error` annotation emitted (via existing annotation infrastructure)
- Version bumped to T1153 R3

## Gating Decision

T9166 is `status=pending` at implementation time. RULE-5 finds 12 violations across three DB sets:
- 7 in drizzle-brain (the T9166 targets)
- 3 in drizzle-tasks (t877, t1408, t1609, t1718)
- 1 in drizzle-nexus (t1839)

Since T9166 only covers the 7 brain files, and 5 additional files in tasks/nexus also need fixes, `--enable-rule-5` (default-off) is the correct staging approach. The orchestrator can enable it unconditionally after all 12 are fixed.

## Self-Test Results

Fixture `/tmp/lint-test-fixture/drizzle-test/`:
- `bad_migration_*/migration.sql` (2 statements, 0 breakpoints): RULE-5 ERROR fired, exit 1
- `good_migration_*/migration.sql` (2 statements, 1 breakpoint): no RULE-5, only RULE-4 (folder naming), exit 0

## Quality Gates

- `pnpm biome ci scripts/lint-migrations.mjs`: PASS
- `pnpm biome ci .`: PASS (1 file error was pre-existing in different file, confirmed by stash test)
- `pnpm run build`: pre-existing failure (`@a2a-js/sdk` not found in packages/lafs) — not caused by this change, confirmed by stash/restore test
- Tests: pre-existing studio failure, all non-studio packages pass (57+32 tests unchanged)
- Pre-commit hook: PASS (migration linter ran, only WARN violations, exit 0)

## Commit

`3f4cb2afd7496564edebe6f98ff3e51f1ed45215` on branch `task/T9165`
