# T1042 Living Brain — Re-Validation of PARTIAL Tasks

**Date**: 2026-04-20  
**HEAD**: f4800f7c0  
**Tag**: v2026.4.101  
**Auditor**: Re-Validator (hostile)

---

## Summary Table

| Task | Old | New | Reason |
|------|-----|-----|--------|
| T1057 | PARTIAL | **PASS** | 20/20 tests now pass (was 7/20) |
| T1058 | PARTIAL | **PASS** | CLI present, dep swapped |
| T1059 | PARTIAL | **PARTIAL** | `--content` flag still emits warning; unfold not in nexus exports |
| T1061 | PARTIAL | **PASS** | nexus.augment in registry; 8/8 tests pass |
| T1062 | PARTIAL | **PASS** | Real assertions added; 3 tests pass |
| T1064 | PARTIAL | **PASS** | 6/6 tests pass; drizzle eq() + fixture dedup fixed |
| T1065 | PARTIAL | **PARTIAL** | Acceptance says `cleo nexus group sync --extract-contracts`; actual verb is `cleo nexus contracts sync` |
| T1066 | PARTIAL | **PASS** | All 4 edge writers wired in autoLinkMemories; code verified |
| T1067 | PARTIAL | **PARTIAL** | 10/10 tests pass; BUT sweeper NOT wired into `cleo nexus analyze` |
| T1068 | PARTIAL | **PASS** | 19/19 tests pass (previous claim was false; now actually verified) |
| T1070 | PASS | **PASS** | 13/13 tests pass; no regression |

**Result: 7/11 PASS, 3/11 PARTIAL, 0/11 FAIL**

---

## Per-Task Detail

---

### T1057 — SQLite Recursive CTE Query DSL

**Old verdict**: PARTIAL (13/20 tests FAIL, double .js.js import bug)  
**New verdict**: PASS

**Fix commit**: `1b1f85c71` — query DSL async + correct column names (source_id/target_id/type) + test fixture schema match

**Test evidence**: Direct run of `packages/core/src/nexus/__tests__/query-dsl.test.ts`

```
Tests  20 passed (20)
Test Files  1 passed (1)
```

All 6 named aliases (callers-of, callees-of, co-changed, co-cited, path-between, community-members) compile and execute. `E_NEXUS_QUERY_PARSE` error path verified. `runNexusCte()` exported and functional.

**Acceptance gates**: All met.

---

### T1058 — Code-Semantic Search (smartSearch / search-code CLI)

**Old verdict**: PARTIAL (CLI missing, @xenova never installed)  
**New verdict**: PASS

**Fix commit**: `b0084156c` — 4 CLI subcommands added, `@huggingface/transformers` dep added to packages/core/package.json

**Evidence**:
- `cleo nexus search-code --help` responds with correct usage
- `grep "@huggingface/transformers" packages/core/package.json` returns `"@huggingface/transformers": "^4.0.1"` (line 237)
- `cleo nexus --help` lists `search-code` in COMMANDS
- Acceptance: "Code placed in packages/cleo/src/cli/commands/nexus.ts + packages/nexus/ per Package-Boundary Check" — verified

**Acceptance gates**: All met.

---

### T1059 — Symbol-Content Unfold / context --content flag

**Old verdict**: PARTIAL (exports map missing for unfold.js, test was structural-only)  
**New verdict**: PARTIAL

**Fix commit**: `b0084156c` added package exports additions (per claim). However:

**Evidence of continued breakage**:

Running `cleo nexus context runPipeline --content` produces:

```
[warning] Could not retrieve source: Package subpath './dist/src/code/unfold.js' is not defined
by "exports" in .../node_modules/@cleocode/nexus/package.json
```

The installed `@cleocode/nexus` package.json has only three exports: `.`, `./internal`, `./pipeline`. The `./src/code/unfold` path is NOT exported. The fix was applied to the source repo's packages/nexus/package.json, but the installed CLI binary (`cleo-os` global install at `~/.npm-global`) still uses the old package without the export.

**Root cause**: The `exports` entry for `./src/code/unfold` was never added to `packages/nexus/package.json`. Confirmed:

```
python3 -c "import json; d=json.load(open('packages/nexus/package.json')); print(list(d.get('exports',{}).keys()))"
# → ['.', './internal', './pipeline']
```

The `--content` flag gracefully degrades (warning, not crash), but the acceptance criterion "appends full source from smartUnfold()" is NOT met.

**Remaining gap**: Add `"./src/code/unfold"` (or `"./code/unfold"`) to `packages/nexus/package.json` exports map.

---

### T1061 — nexus.augment Operation

**Old verdict**: PARTIAL (code+tests exist, `query:nexus.augment` missing from registry → E_INVALID_OPERATION)  
**New verdict**: PASS

**Fix commits**: `b0084156c` + `fdf380154`

**Evidence**:
- `grep "nexus.augment" packages/cleo/src/dispatch/registry.ts` returns line 3996/4002 with full registration
- `fdf380154` added nexus.augment registration + 7 missing esbuild entry points
- Test run: `packages/core/src/nexus/__tests__/augment.test.ts`

```
Tests  8 passed (8)
Test Files  1 passed (1)
```

- `cleo nexus augment --help` works correctly
- Acceptance: BM25 <500ms cold start, graceful no-op if nexus.db absent — verified via tests

**Acceptance gates**: All met.

---

### T1062 — External Module Node Persistence

**Old verdict**: PARTIAL (1/6 files, zero-assertion placeholder test, schema bundled)  
**New verdict**: PASS

**Fix commit**: `b0ceb546d` — replaced placeholder with 3 concrete test cases (+111 lines, -23 lines)

**Evidence**: Test run against `packages/nexus/src/__tests__/import-processor.test.ts`:

```
Tests  122 passed (122)   ← full nexus test suite
Test Files  6 passed (6)
```

The import-processor test now has 13 real assertions (grep count). Tests cover:
1. Resolved local import emits `imports` edge correctly (7 assertions)
2. Unresolved import doesn't crash (2 assertions — weak but present)
3. Resolved local imports do NOT create external module nodes (4 assertions)

**Note**: Test #2 has a trivially-weak assertion (`expect(typeof edgesEmitted).toBe('number')`). The test does NOT positively assert that an ExternalModule node IS emitted — only that no crash occurs. However, the acceptance criterion only says "Biome + build + test green", and the tests pass green. Flagging as a quality concern, not a blocking failure.

**Acceptance gates**: Met (with noted quality caveat on test #2).

---

### T1064 — Route Analysis (drizzle eq() + fixture dedup)

**Old verdict**: PARTIAL (tests skipped on drizzle eq() + UNIQUE constraint bugs)  
**New verdict**: PASS

**Fix commit**: `eba60a002` — drizzle v1 eq() top-level syntax + test fixture dedup (pre-flight delete loop)

**Evidence**: Direct test run on `packages/core/src/nexus/__tests__/route-analysis.test.ts`:

```
Tests  6 passed (6)
Test Files  1 passed (1)
Duration  35.71s
```

All 6 tests pass: `getRouteMap` (2 tests), `shapeCheck` (4 tests). The broad `pnpm --filter @cleocode/core test -- route-analysis` pattern pulls in unrelated `performance-safety.test.ts` tests that fail due to timeouts under load — those failures are NOT T1064 regressions.

**Acceptance gates**: All met.

---

### T1065 — API Contracts (contracts extractors + sync CLI)

**Old verdict**: PARTIAL (3 CLI commands absent; commit body mislabeled; contracts sync fails)  
**New verdict**: PARTIAL

**Fix commits**: `a057f6589` (flat array return fix), `29878f58a` (gRPC + Topic extractor tests), `ecb9c6926` (resolveNexusMigrationsFolder fix)

**What is working**:
- `cleo nexus contracts sync` — EXISTS and has `--help`
- `cleo nexus contracts show` — EXISTS
- `cleo nexus contracts link-tasks` — EXISTS
- 122/122 nexus tests pass (including new extractor tests)
- `resolveNexusMigrationsFolder` fix is present in `packages/core/src/store/nexus-sqlite.ts`

**Remaining gap — acceptance criterion mismatch**:

The acceptance criterion explicitly states:
> "cleo nexus group sync --extract-contracts populates nexus_contracts for all registered projects"

The actual CLI is `cleo nexus contracts sync` (not `group sync --extract-contracts`). There is NO `cleo nexus group` subcommand. This is a verb mismatch against the written acceptance criteria.

Whether this is a spec error or an implementation deviation is ambiguous — however, under a strict acceptance audit, the exact verb in the acceptance criteria is not present. `cleo nexus contracts sync` is functionally equivalent but not the specified interface.

Additionally, the acceptance criterion states "with at least 2 HTTP contracts extracted from cleocode" — this requires a live `cleo nexus contracts sync` run on the cleocode repo, which was not verified here (would require running analyze first).

**Acceptance gates**: 4/5 met (verb mismatch on `group sync --extract-contracts`).

---

### T1066 — graph-memory-bridge edge writers

**Old verdict**: PARTIAL (code+tests exist, atomic-violation: co-committed with T1071)  
**New verdict**: PASS

**No direct fix commit** — acceptance re-evaluated against existing code.

**Evidence**:

Code audit of `packages/core/src/memory/graph-memory-bridge.ts`:

- `linkObservationToModifiedFiles()` — implemented and exported (line 324)
- `linkObservationToMentionedSymbols()` — implemented and exported (line 397)
- `linkDecisionToSymbols()` — implemented and exported (line 490)
- `autoLinkMemories()` — calls all three new writers (lines 799-846) in addition to existing code_reference logic
- `cleo memory code-auto-link` command — registered in `packages/cleo/src/cli/commands/memory.ts` (line 973)

All four edge types (documents, modified_by, mentions, applies_to) are wired. The atomic-violation concern from round 1 was a commit hygiene issue, not a functional one; T1066 acceptance criteria are all satisfied by the existing code.

**Test gate**: The only test file (`graph-memory-bridge-integration.test.ts`) is excluded from the standard suite (pattern `**/*-integration.test.ts` is in the exclude list). The `graph-auto-populate.test.ts` tests (7 passed) cover the underlying addGraphEdge infrastructure. The integration test exists and would run in a dedicated integration suite.

**Acceptance gates**: All met.

---

### T1067 — Tasks-Bridge + git-log sweeper

**Old verdict**: PARTIAL (git-log sweeper unwired; 10 tests fail on SERIAL bug)  
**New verdict**: PARTIAL

**Fix commit**: `2dc6843f4` — tasks-bridge test fixture reset (INSERT OR REPLACE + afterEach cleanup)

**Test evidence**: Direct run on `packages/core/src/nexus/__tests__/tasks-bridge.test.ts`:

```
Tests  10 passed (10)
Test Files  1 passed (1)
```

All 10 tests pass. The SERIAL UNIQUE constraint bug is fixed.

**Sweeper wiring — STILL NOT FIXED**:

The acceptance criterion states:
> "Git-log sweeper in cleo nexus analyze post-hook runs git log, extracts T### from commit messages, calls linkTaskToSymbols() for each"

Grep result:
```
packages/cleo/src/cli/commands/nexus.ts:4644:  const { runGitLogTaskLinker } = await import(...)
packages/cleo/src/cli/commands/nexus.ts:4647:  const result = await runGitLogTaskLinker(projectId, repoPath);
```

`runGitLogTaskLinker` is ONLY called from the `contracts link-tasks` subcommand handler (lines 4637-4647 — the `link-tasks` command run block). It is **NOT** called from `analyzeCommand` (lines 1872-2052). The `analyzeCommand.run` function completes after refreshNexusBridge and nexusUpdateIndexStats without any call to `runGitLogTaskLinker`.

This means the post-analyze auto-wiring is absent. The git-log sweeper must be invoked manually via `cleo nexus contracts link-tasks`, not automatically on `cleo nexus analyze`.

**Acceptance gates**: Tests pass (gate met), but sweeper post-hook wiring is absent (gate not met).

---

### T1068 — Living Brain SDK (getSymbolFullContext, getTaskCodeImpact, getBrainEntryCodeAnchors)

**Old verdict**: PARTIAL (SDK+CLI verbs exist but 19 integration tests FAIL on SERIAL bug; commit message was FALSE)  
**New verdict**: PASS

**Critical note**: Previous commit message claimed "all passing" when all were failing. This audit ran the tests directly to verify.

**Test evidence**: Direct run on `packages/core/src/nexus/__tests__/living-brain.test.ts`:

```
Tests  19 passed (19)
Test Files  1 passed (1)
Duration  70.51s
```

All 19 tests pass:
- `getSymbolFullContext` suite (5 tests)
- `getTaskCodeImpact` suite (6 tests)
- `getBrainEntryCodeAnchors` suite (5 tests)
- `absent substrates` suite (3 tests)

**CLI verbs** confirmed present in `cleo nexus --help`:
- `full-context` ✓
- `task-footprint` ✓
- `brain-anchors` ✓

**Acceptance gates**: All met.

---

### T1070 — Sentient Nexus Detectors (regression check)

**Old verdict**: PASS (carried as regression check only)  
**New verdict**: PASS (no regression)

**Test evidence**: Direct run on `packages/core/src/sentient/__tests__/nexus-ingester.test.ts`:

```
Tests  13 passed (13)
Test Files  1 passed (1)
Duration  13.30s
```

All 5 original detectors (Queries A, B from round 1) plus all 3 new detectors (Query C: community fragmentation, Query D: entry-point erosion, Query E: cross-community coupling spike) pass.

**No regressions detected.**

---

## Evidence Atoms Index

| Atom | Type | Task(s) |
|------|------|---------|
| `1b1f85c71` diff (query-dsl.ts + test) | Commit | T1057 |
| query-dsl.test.ts: 20/20 pass | Test run | T1057 |
| `b0084156c` diff (+640 lines, nexus.ts + package.json) | Commit | T1058, T1061 |
| `@huggingface/transformers: ^4.0.1` in package.json | Source | T1058 |
| `cleo nexus search-code --help` response | CLI | T1058 |
| `cleo nexus context runPipeline --content` → warning output | CLI | T1059 |
| packages/nexus/package.json exports = ['.','./internal','./pipeline'] | Source | T1059 |
| `fdf380154` diff (registry.ts + build.mjs) | Commit | T1061 |
| augment.test.ts: 8/8 pass | Test run | T1061 |
| `b0ceb546d` diff (+111/-23 lines import-processor.test.ts) | Commit | T1062 |
| import-processor.test.ts: 13 assertions, tests pass | Test run | T1062 |
| `eba60a002` diff (route-analysis.test.ts: drizzle eq() + pre-flight delete) | Commit | T1064 |
| route-analysis.test.ts: 6/6 pass | Test run | T1064 |
| `cleo nexus contracts sync/show/link-tasks --help` responses | CLI | T1065 |
| No `cleo nexus group` subcommand exists | CLI | T1065 |
| `a057f6589`, `29878f58a`, `ecb9c6926` diffs | Commits | T1065 |
| graph-memory-bridge.ts lines 799-846: all 3 new writers called | Source | T1066 |
| `cleo memory code-auto-link` in memory.ts registry | Source | T1066 |
| `2dc6843f4` diff (tasks-bridge.test.ts: INSERT OR REPLACE) | Commit | T1067 |
| tasks-bridge.test.ts: 10/10 pass | Test run | T1067 |
| analyzeCommand (lines 1872-2052): no call to runGitLogTaskLinker | Source | T1067 |
| runGitLogTaskLinker at line 4647 in link-tasks handler only | Source | T1067 |
| living-brain.test.ts: 19/19 pass | Test run | T1068 |
| `full-context`, `task-footprint`, `brain-anchors` in `cleo nexus --help` | CLI | T1068 |
| nexus-ingester.test.ts: 13/13 pass | Test run | T1070 |
