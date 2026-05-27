# T9020: CAAMP writer-bypass — temp-path injection fix

**Status**: complete
**Epic**: T1929 (Phase 1: Agent System Canonicalization v2)
**Depends on**: T1939 (dedup-by-path)

## Root Cause Analysis

`ensureInjection()` (injection.ts line 219) and `injectAgentsHub()` (bootstrap.ts line 329)
called `getCleoTemplatesTildePath()` to build the template reference injected into the global
`~/.agents/AGENTS.md` hub. `getCleoTemplatesTildePath()` reads the `CLEO_HOME` env var.

Tests set `CLEO_HOME` to unique temp directories like
`~/.temp/cleo-injection-chain-XXXXXX/.cleo-home` for isolation. However, `getAgentsHome()`
is NOT overridden in tests (it defaults to the REAL `~/.agents`). This caused each test
run to write the temp path reference into the REAL `~/.agents/AGENTS.md`.

Since T1939's dedup-by-path only deduplicates blocks with IDENTICAL content, each unique
temp path evaded deduplication — producing 37+ stale blocks observed on 2026-05-06.

## Fix Applied (Option A — Prevention)

Added `getCanonicalTemplatesTildePath()` to `@cleocode/paths` that always returns
`"~/.cleo/templates"` — the stable `~/.cleo` symlink path, immune to `CLEO_HOME` overrides.

Changed `ensureInjection()` and `injectAgentsHub()` to use this function for the hub write.
`getCleoTemplatesTildePath()` (CLEO_HOME-aware) is preserved for all other callers where
dynamic path resolution is correct (template content refresh, provider adapter installs).

## Files Changed

- `packages/paths/src/cleo-paths.ts` — added `getCanonicalTemplatesTildePath()`
- `packages/paths/src/index.ts` — exported new function
- `packages/core/src/paths.ts` — re-exported + thin wrapper
- `packages/core/src/index.ts` — added to public exports
- `packages/core/src/injection.ts` — use canonical path for hub write
- `packages/core/src/bootstrap.ts` — use canonical path for hub write
- `packages/core/src/__tests__/temp-path-no-pollution.test.ts` — 7 new tests
- `packages/paths/src/__tests__/cleo-paths.test.ts` — 5 new tests
- `packages/caamp/tests/unit/injector-dedup.test.ts` — 2 new tests

## Test Coverage

- 5 sequential sessions with different CLEO_HOME temp dirs → AGENTS.md has exactly 1 block
- Canonical reference is always `@~/.cleo/templates/CLEO-INJECTION.md`
- Pre-existing stale temp block is replaced on next call
- T1939 dedup-by-path contract preserved (same-path upserts unchanged)
- All 26 original caamp/injector-dedup tests still pass

## Live State

`~/.agents/AGENTS.md` confirmed clean: 1 canonical block, 0 stale blocks.
`cleo caamp dedupe` reports: removed=0, kept=1, modified=false.

## Commit SHA

`97ef87dad` (changes in commit labeled feat(T1936) due to concurrent main branch activity)
