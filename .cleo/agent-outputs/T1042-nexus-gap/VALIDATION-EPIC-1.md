# VALIDATION REPORT: Epic 1 (Nexus P0 Core Query Power)

**Validator**: VALIDATOR subagent (claude-sonnet-4-6)
**Date**: 2026-04-20
**Spec**: `.cleo/agent-outputs/T1042-nexus-gap/RECOMMENDATION-v2.md` §5 (P0-A through P0-E)
**Claim**: Epic 1 shipped across 17 commits, 2026-04-20T18:00–20:14 (actual window: 11:51–12:26 local)
**Tasks validated**: T1057, T1058, T1059, T1060, T1061

---

## Summary

| Task | Title | Verdict |
|------|-------|---------|
| T1057 | SQLite Recursive CTE Query DSL | **PARTIAL** |
| T1058 | Semantic Code Symbol Search | **PARTIAL** |
| T1059 | Source Content Retrieval (--content flag) | **PARTIAL** |
| T1060 | Wiki Generator | **FAIL** |
| T1061 | PreToolUse Hook Augmenter | **PARTIAL** |

**Score: 0/5 PASS, 4/5 PARTIAL, 1/5 FAIL, 0/5 THEATER**

---

## T1057 — EP1-T1 SQLite Recursive CTE Query DSL

**Verdict: PARTIAL**

**Commit**: `02bd4565758` `feat(T1057): SQLite recursive CTE query DSL with 6 template aliases`

### Evidence: What Exists

- `packages/core/src/nexus/query-dsl.ts`: FILE EXISTS (327 lines). Exports `runNexusCte`, `compileCteAlias`, `formatCteResultAsMarkdown`.
- All 6 aliases present: `callers-of`, `callees-of`, `co-changed`, `co-cited`, `path-between`, `community-members`.
- `packages/core/src/nexus/__tests__/query-dsl.test.ts`: EXISTS (248 lines, 20 tests declared).
- `packages/contracts/src/nexus-query-ops.ts`: EXISTS (type contracts).
- CLI verb `query` IS registered as a subcommand in `nexusCommand.subCommands` in compiled `nexus.js`.

### Evidence: Failures

**CLI runtime failure — double-.js extension bug:**
```
[nexus] Error: Cannot find module '.../@cleocode/core/dist/nexus/query-dsl.js.js'
```
The import path in `nexus.ts` is `'@cleocode/core/nexus/query-dsl.js'`. The `packages/core/package.json` exports wildcard is `"./nexus/*"` → `"./dist/nexus/*.js"`. Appending `.js` to `query-dsl.js` produces `query-dsl.js.js`. The fix exists uncommitted (working tree): use `'@cleocode/core/nexus/query-dsl'` without the `.js` suffix.

**`cleo nexus query` not in OPERATIONS registry (`registry.ts`):**
The `Dispatcher` calls `resolve()` against the OPERATIONS array before routing to `NexusHandler`. The operation `query:nexus.query` is absent from `registry.ts`. However, the `queryCommand` in `nexus.ts` bypasses `dispatchFromCli` entirely — it directly imports `runNexusCte` and calls it. So the registry gap does not block this verb (it bypasses dispatch). The actual blocker is the import path bug above.

**Tests: 13/20 FAIL in shipped state** (git HEAD, no uncommitted changes):
```
Test Files  1 failed (1)
Tests  13 failed | 7 passed (20)
```
The shipped tests call `runNexusCte(cte, [])` without injecting a test DB. Because there is no live `nexus.db` in the test environment, `getNexusNativeDb()` returns `null` → tests fail with "nexus.db not initialized". The uncommitted working-tree fix (optional `db?` parameter) resolves this, but it has NOT been committed.

**New verbs absent from `cleo nexus --help` USAGE line:**
The installed `cleo` binary (`~/.npm-global/bin/cleo` → `@cleocode/cleo-os` bundled copy) predates these commits. The project's compiled `dist/cli/commands/nexus.js` has the new verbs registered but the globally installed binary does not. Running `cleo nexus query` resolves to the stale binary and outputs the parent help (exit 1).

### Blockers for PASS
1. Fix the `'@cleocode/core/nexus/query-dsl.js'` import path (remove `.js` suffix per wildcard exports pattern).
2. Commit the `runNexusCte(cte, params, db?)` optional-parameter fix so all 20 tests pass.
3. Rebuild and reinstall cleo-os package so the global binary includes new verbs.
4. Register `query:nexus.query` in `registry.ts` OPERATIONS array (or verify bypass intent is acceptable).

---

## T1058 — EP1-T2 Semantic Code Symbol Search

**Verdict: PARTIAL**

**Commits**: `e467c1a6d` `feat(T1058)`, `95818f979` `fix(T1058)`

### Evidence: What Exists

- `packages/core/src/nexus/embeddings.ts`: EXISTS (207 lines). Exports `CodeEmbeddingProvider` interface, `TransformersCodeEmbeddingProvider` class, `getCodeEmbeddingProvider()`, `embedCode()`.
- `packages/core/src/memory/brain-search.ts`: `includeCode?: boolean` added to `HybridSearchOptions`. When `includeCode: true`, calls `smartSearch()` from `@cleocode/nexus` and fuses results via RRF. Code symbol hits typed as `type: 'code-symbol'`.
- Graceful degradation exists: `isAvailable()` returns false if `@xenova/transformers` unavailable, and `hybridSearch` skips code results silently.

### Evidence: Failures

**CLI verb `cleo nexus search-code` is ABSENT:**
The spec (RECOMMENDATION-v2.md §5 P0-B) explicitly requires `cleo nexus search-code <query>` CLI verb with `--limit`, `--kinds`, `--file-glob` options. Zero evidence this verb was implemented. No entry in `nexus.ts` subcommands, no dispatch handler, no registry entry.

**`@xenova/transformers` not installed:**
The fix commit claimed to add `@xenova/transformers@^2.16.0` as an optional dependency, but it is absent from all `package.json` files in the monorepo. Only `@huggingface/transformers@^4.0.1` is declared (a different package in a different scope). The embedding functionality is inoperative. The graceful degradation path (BM25-only fallback) works, but the semantic embeddings claim is false.

**Commit message / content mismatch (T1058 "fix" commit):**
`95818f979` is labeled `fix(T1058): add @xenova/transformers optional dep + fix type inference in brain-search` but its actual diff contains `augment.ts` (165 lines, tagged `@task T1061`) and `hooks-augment.ts` (92 lines, tagged `@task T1061`). Neither file belongs to T1058. This is T1061 code committed under a T1058 fix label — evidence of rushed, disorganized work in the 3-hour window.

### Blockers for PASS
1. Implement `cleo nexus search-code <query>` CLI verb in `nexus.ts` and dispatch layer.
2. Add `@xenova/transformers` to `packages/core/package.json` as optional dep (or adopt `@huggingface/transformers` and update embeddings.ts accordingly).
3. Add a `query:nexus.search-code` entry to `registry.ts`.

---

## T1059 — EP1-T3 Source Content Retrieval (--content flag)

**Verdict: PARTIAL**

**Commit**: `6d43d6ee3` `test(T1059): add --content flag test on cleo nexus context`

### Evidence: What Exists

- `--content` flag IS registered in `contextCommand.args` in `nexus.ts` (line 1267–1270).
- `smartUnfold` IS called when `showContent === true` (lines 1434–1457).
- The test at `packages/cleo/src/cli/commands/__tests__/nexus.test.ts` (lines 305–319) verifies the flag is defined with `type: 'boolean'` and a description containing 'source'. This test PASSES (1/1).
- The context command partially executes: it does return callers/callees data correctly, and attempts source retrieval.

### Evidence: Failures

**Package export path error at runtime:**
```
[warning] Could not retrieve source: Package subpath './dist/src/code/unfold.js'
is not defined by "exports" in ...@cleocode/nexus/package.json
```
The import path used is `'@cleocode/nexus/dist/src/code/unfold.js'`. The `@cleocode/nexus` package exports only three subpaths: `.`, `./internal`, `./pipeline`. The deep dist path is not exported. This is a package boundary violation — the implementation bypasses the official export map.

**Test is structural only, not runtime:**
The single test (`should define context command with content flag`) checks that `contextCommand.args['content']` exists and has `type: 'boolean'`. It does NOT invoke the command or verify that source code is retrieved. The runtime behavior (broken) is not tested.

**Commit is test-only (no implementation commit):**
The commit `6d43d6ee3` adds only 16 lines to a test file. No separate commit added the `--content` implementation to `nexus.ts`. Searching git log confirms no feat(T1059) commit exists — only the test commit. The implementation was added in a prior session (visible in current `nexus.ts`) but was not formally committed as part of this epic.

### Blockers for PASS
1. Fix the import path: either add `"./code/unfold"` to `@cleocode/nexus` package.json exports map, OR import via the existing `"."` export (`import { smartUnfold } from '@cleocode/nexus'`).
2. Add an integration test that actually invokes `cleo nexus context <symbol> --content` and verifies source is present in output.

---

## T1060 — EP1-T4 Wiki Generator

**Verdict: FAIL**

**Commit**: NO COMMIT FOUND

### Evidence

Exhaustive search across all sources:

- `grep -rn "wiki" packages/cleo/src/` → 0 results
- `grep -rn "wiki" packages/core/src/nexus/` → 0 results
- `grep -rn "nexusWiki\|wikiCommand\|nexus.*wiki\|wiki.*generator" packages/` → 0 results
- `git log --oneline | grep -i "wiki"` → 0 results
- No `cleo nexus wiki` subcommand in `nexusCommand.subCommands` object (verified in compiled `nexus.js` line 3445+ block)
- The `packages/core/src/docs/docs-generator.ts` exists but is the `llms.txt` generator (unrelated to nexus wiki)
- No wiki generator module, no tests, no CLI verb, no dispatch handler, no registry entry.

The spec (RECOMMENDATION-v2.md §5 P0-D) required: a `cleo nexus wiki [--output <dir>] [--community <id>]` verb that groups symbols by community, generates per-community module documentation via LOOM, and assembles an overview. None of this exists.

### Blockers for PASS
This task needs to be built from scratch. All 5 acceptance criteria are unmet.

---

## T1061 — EP1-T5 PreToolUse Hook Augmenter

**Verdict: PARTIAL**

**Commits**: `ee2d4a774` `feat(T1061)` (primary); `95818f979` `fix(T1058)` (contains T1061 code — see T1058)

### Evidence: What Exists

- `packages/core/src/nexus/augment.ts`: EXISTS (165 lines). Exports `augmentSymbol(pattern, limit)`, `formatAugmentResults(results)`. BM25-only LIKE search against `nexus_nodes`, callable kinds filter, graceful no-op when `nexus.db` absent.
- `packages/core/src/nexus/hooks-augment.ts`: EXISTS (92 lines). Exports `installNexusAugmentHook(homedir)`. Writes `~/.cleo/hooks/nexus-augment.sh` shell script (intercepts Grep/Glob/Read PreToolUse events).
- `cleo nexus setup` command: WORKS. Running it writes the shell hook:
  ```
  [nexus] Installed PreToolUse hook at /home/keatonhoskins/.cleo/hooks/nexus-augment.sh
  ```
  Shell script verified at `/home/keatonhoskins/.cleo/hooks/nexus-augment.sh` (1061 bytes, executable).
- `packages/core/src/nexus/__tests__/augment.test.ts`: EXISTS, **8/8 PASS** (tests empty-DB handling and `formatAugmentResults` text formatting).
- CLI verb `augment` IS registered in `nexusCommand.subCommands` (compiled `dist/cli/commands/nexus.js` line 474 + `dist/cli/index.js` line 178111).

### Evidence: Failures

**`cleo nexus augment <pattern>` fails at runtime with "Unknown operation":**
```json
{"success":false,"error":{"code":2,"message":"Unknown operation: query:nexus.augment",
"codeName":"E_INVALID_OPERATION"}}
```
Root cause: The `Dispatcher` validates operations against the OPERATIONS registry in `registry.ts` BEFORE delegating to `NexusHandler.query()`. The operation `query:nexus.augment` is not registered. The `NexusHandler` switch DOES have a `case 'augment':` block (verified at bundle line 153696), but it is never reached because the `resolve()` check rejects the request first.

This means the acceptance criterion "`cleo nexus augment <pattern>` CLI verb, BM25-only, <500ms target" is **not met** despite the SDK implementation being complete.

**Package boundary deviation:**
The spec placed the hook installer at `packages/cleo-os/src/hooks/nexus-augment.ts` (harness concern per AGENTS.md). The actual implementation landed in `packages/core/src/nexus/hooks-augment.ts`. The commit justifies this: "Hook installer in packages/core/nexus (not cleo-os), since it's a CLI-invoked utility." Whether this violates AGENTS.md boundary rules is arguable (the AGENTS.md table says `packages/cleo-os/` = "Harness — Pi/Claude-Code adapters, CleoOS runtime"), but it is a deviation from the spec's stated location.

**`augment` and `setup` absent from `cleo nexus --help` USAGE line:**
The global `cleo` binary predates these commits. The USAGE line still lists 26 old verbs only. Users see no indication these verbs exist until the global binary is rebuilt.

### Blockers for PASS
1. Add `query:nexus.augment` entry to the OPERATIONS registry in `registry.ts`. Minimal entry:
   ```typescript
   { gateway: 'query', domain: 'nexus', operation: 'augment',
     description: 'nexus.augment (query) — BM25 symbol context for PreToolUse hooks',
     tier: 0, idempotent: true, sessionRequired: false,
     requiredParams: ['pattern'], params: [
       { name: 'pattern', type: 'string', required: true, description: 'Symbol name or file pattern' },
       { name: 'limit', type: 'number', required: false, description: 'Max results (default 5)' }
     ] }
   ```
2. Rebuild and reinstall global binary.

---

## Cross-Cutting Findings

### Global Binary Not Rebuilt
The globally installed `cleo` binary (`/home/keatonhoskins/.npm-global/bin/cleo` → `@cleocode/cleo-os` bundle) does not include ANY of the new verbs (query, augment, setup, search-code, wiki). All 5 new verbs are invisible to the standard `cleo` invocation. The project local build at `packages/cleo/dist/cli/index.js` has them, but the binary that `cleo` resolves to does not. This is a deployment gap — the feature exists in source but was never published/installed.

### OPERATIONS Registry Gap (T1057, T1061)
Two of the five tasks require new dispatch operations that were never added to `registry.ts`. The `Dispatcher.dispatch()` method explicitly rejects unregistered operations with `E_INVALID_OPERATION` before reaching the domain handler. Both T1057 (uses direct import bypass, so not a blocker for T1057 per se) and T1061 (uses `dispatchFromCli` which does go through the registry, so this IS a hard blocker) are affected.

### Commit Message / Content Mismatch (T1058 fix commit)
Commit `95818f979` is labeled `fix(T1058)` but its diff contains 257 lines of T1061 code (`augment.ts`, `hooks-augment.ts`). The actual T1058 type-fix changes are 3 lines in `embeddings.ts`. This suggests the author was working on multiple tasks simultaneously and committed under the wrong task ID. It does not affect the final state of the code but does confuse the audit trail.

### Query-DSL Tests Were Failing at Ship Time
Running tests at git HEAD (before uncommitted working-tree changes) shows 13/20 failures in `query-dsl.test.ts`. The tests fail because `runNexusCte` depends on the global `getNexusNativeDb()` which returns `null` without a live `nexus.db`. The fix (inject optional `db?` parameter) exists in the working tree but was not committed before the orchestrator claimed these tasks complete.

---

## Blocker List for Rework

| Task | Blocker | Severity |
|------|---------|----------|
| T1057 | Fix `'@cleocode/core/nexus/query-dsl.js'` import path (`.js` suffix + wildcard = double `.js`) | P0 |
| T1057 | Commit `runNexusCte(cte, params, db?)` optional db parameter (13/20 tests fail without it) | P0 |
| T1057 | Rebuild + reinstall global cleo binary | P1 |
| T1058 | Implement `cleo nexus search-code <query>` CLI verb (entirely missing) | P0 |
| T1058 | Add `@xenova/transformers` OR `@huggingface/transformers` as actual dependency | P1 |
| T1059 | Fix `@cleocode/nexus/dist/src/code/unfold.js` import (not in package exports map) | P0 |
| T1059 | Add runtime integration test (current test is structural only) | P1 |
| T1060 | Implement wiki generator from scratch (0% complete) | P0 |
| T1061 | Register `query:nexus.augment` in `registry.ts` OPERATIONS array | P0 |
| T1061 | Rebuild + reinstall global cleo binary | P1 |
| ALL | `cleo nexus --help` USAGE line does not show new verbs (global binary stale) | P1 |
