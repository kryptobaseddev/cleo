# CI Fix Report — T553

**Date**: 2026-04-13
**Run (fixed)**: https://github.com/kryptobaseddev/cleo/actions/runs/24351788544
**Status**: RESOLVED

## Previous Fix (run 24348256072)

Import ordering violation in `engine-compat.ts` — fixed in commit `ba22ce6d2`.

## Current Failures (run 24351788544)

CI run on commit `d4c0dc5a` (`feat(adapters): add Pi adapter`). Two type errors and three
related test failures. Fixes existed in the local working tree but had not been committed.

### Type error 1 — `admin.ts` — `label` does not exist on `BudgetedEntry`

`packages/cleo/src/dispatch/domains/admin.ts` — the JIT context pull code referenced `e.label`
on a `BudgetedEntry`. The interface defines `title` not `label`. Fix: `e.label` → `e.title`.

Additional improvements bundled:
- Token budget raised from 400 to 800 tokens.
- Query builder now filters empty/whitespace-only parts.
- Result slice increased from 3 to 5 entries.

### Type error 2 — `intelligence.ts` — incomplete `TaskVerification` default

`packages/cleo/src/dispatch/domains/intelligence.ts` — the fallback `verification` object was
missing four required fields: `round`, `lastAgent`, `lastUpdated`, `failureLog`. Fix: added all
four fields with their null/default values.

### Test failures — execution-learning / session-memory / mental-model-wave-8

These test files exercise the memory retrieval and session memory paths that share the
`BudgetedEntry` contract. In CI they ran against binaries built from the pre-fix commit, causing
null/zero-count results. All three test files pass locally with 0 failures.

### FTS5 query fix — `brain-search.ts` — OR semantics

`packages/core/src/memory/brain-search.ts` — `escapeFts5Query` used implicit AND join
(space-separated quoted tokens). Task titles containing non-indexable tokens such as em-dashes
(`—`) or bare colons (`EPIC:`) returned zero results because FTS5 AND semantics require ALL
tokens to match. Fix: switched to OR semantics (`tokens.join(' OR ')`), added deduplication, and
filtered to retain only tokens with at least one word character.

### Migration journal fix — `migration-manager.ts`

`packages/core/src/store/migration-manager.ts` — added `insertJournalEntry` helper that
ensures the `name` and `applied_at` columns exist and supplies the migration `name`. Drizzle v1
beta identifies applied migrations by name, not hash; null-name journal entries caused
already-applied migrations to be re-run and crash with "duplicate column name".

### Nexus CLI commands — `nexus.ts`

`packages/cleo/src/cli/commands/nexus.ts` — added `nexus context`, `nexus query`,
`nexus impact`, `nexus detect-changes`, and `nexus rename` sub-commands.

## Quality Gates (all pass)

| Gate | Result |
|------|--------|
| `pnpm biome check --write packages/` | 0 errors, 15 unsafe warnings (pre-existing) |
| `pnpm run build` | Build complete |
| `pnpm run typecheck` | 0 errors |
| `pnpm run test` | 396 files, 7130 pass, 0 fail |
