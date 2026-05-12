# Stash Inventory + Validation — 2026-05-06

**Investigator**: ad-hoc subagent  
**Scope**: stashes 0-4 as listed at session start (now indexed 1-5 after a `pre-validation-snapshot` stash was auto-created during investigation)  
**Mode**: READ-ONLY — no stashes were popped, dropped, or modified  
**HEAD at investigation time**: `3bb9e5325` (fix(T9037): universal-tier path resolution)  
**Version**: v2026.5.35

---

## Important: Stash Index Shift

A new stash (`stash@{0}: pre-validation-snapshot-2026-05-06`) was created at 07:08 today, shifting all original stash indices by +1. Throughout this document, references use the **original task description numbers** (0-4) mapped to the current indices (1-5):

| Task Description | Current Index | Message |
|---|---|---|
| Original stash 0 | stash@{1} | WIP on main: 6304c86ab (T1936 + applyPerfPragmas) |
| Original stash 1 | stash@{2} | pre-release-cleanup |
| Original stash 2 | stash@{3} | 3-file config update (2026-04-29) |
| Original stash 3 | stash@{4} | 83-file multi-campaign work (2026-04-27) |
| Original stash 4 | stash@{5} | 17-file T1473 nexus exports (2026-04-27) |

---

## Stash 0 (now stash@{1}): T1936 + applyPerfPragmas WIP

**Age**: Created 2026-05-05 19:54 (-0700)  
**Message**: `WIP on main: 6304c86ab feat(T1934): add tests for installTemplatesAtProjectTier`  
**Base commit**: 6304c86ab (22 commits behind current HEAD)

### Content Summary

11 files, 367 insertions / 46 deletions.

| File | Change | Functional Intent |
|---|---|---|
| `packages/core/src/orchestration/classify.ts` | +144 -43 | T1936: `getRegisteredAgentIds(db?)` live DB path; `validateClassifierRules(db?)` startup hook; `STATIC_FALLBACK_AGENT_IDS` const; `REGISTRY_QUERY_TIERS` const |
| `packages/core/src/orchestration/__tests__/classify.test.ts` | +218 -1 | T1936: 11 new tests — live DB `getRegisteredAgentIds`, static fallback, `validateClassifierRules` drift detection, end-to-end |
| `packages/core/src/orchestration/index.ts` | +1 | Export `validateClassifierRules` |
| `packages/core/src/agents/seed-install.ts` | +1 -2 | Replace inline PRAGMA exec calls with `applyPerfPragmas(db)` |
| `packages/core/src/conduit/local-transport.ts` | +1 -3 | Same applyPerfPragmas refactor |
| `packages/core/src/init.ts` | +1 -2 | Same applyPerfPragmas refactor |
| `packages/core/src/store/conduit-sqlite.ts` | +8 -9 | applyPerfPragmas + optimizeBeforeClose; health-check path also gets pragma set |
| `.cleo/.gitignore` | -4 | Remove `!specs/` + `!specs/**` allow-rules |
| `.cleo/project-context.json` | +2 -1 | `outputDir: dist` added; `detectedAt` timestamp updated |
| `AGENTS.md` | +1 -2 | Trailing newline normalization |
| `CLAUDE.md` | +1 -2 | Trailing newline normalization |

### Provenance

Task T1936 (`feat(T1936): classifier vocabulary now sourced from live registry`). The stash was taken at 19:54 on 2026-05-05; the T1936 commit landed at 20:33 same day.

### Cross-Reference with Current Main

**T1936 changes (classify.ts + classify.test.ts + orchestration/index.ts)**: COMMITTED as `97ef87dad` on 2026-05-05 20:33. Verified identical via md5sum.

**applyPerfPragmas changes (seed-install.ts, local-transport.ts, init.ts, conduit-sqlite.ts)**: NOT committed to HEAD. However, the CURRENT WORKING TREE contains these exact same changes (confirmed: stash content == working tree content for all four files). These were re-authored in the current session.

**.gitignore + project-context.json + AGENTS.md + CLAUDE.md**: Also present in the current working tree (same as stash content).

### Conflict Check

Would NOT apply cleanly. The current working tree already contains identical or superseding changes to every file. Applying stash@{1} would produce conflicts on `classify.ts` (T1936 already committed + working tree re-adds same changes).

### Correctness Assessment

The T1936 code is high quality — proper TSDoc, optional `DatabaseSync` parameter, graceful fallback, no `any`, 11 targeted tests with proper in-memory SQLite setup and `try/finally` cleanup. The applyPerfPragmas refactoring is a clean DRY extraction (removes 10+ duplicated PRAGMA exec calls across 4 files).

### Recommendation

**DROP**

Rationale: (1) T1936 functional code is fully committed as `97ef87dad`. (2) applyPerfPragmas changes are in the current working tree — dropping the stash loses nothing; those changes will be committed when the current session completes. (3) No unique content survives that isn't already covered.

---

## Stash 1 (now stash@{2}): Pre-Release Cleanup

**Age**: Created 2026-05-05 15:08 (-0700)  
**Message**: `On main: pre-release-cleanup: unstaged changes to AGENTS.md CLAUDE.md project-context.json`  
**Base commit**: 6304c86ab (22 commits behind current HEAD)

### Content Summary

24 files, 543 insertions / 729 deletions — large because it captured an in-progress pre-release state before the v2026.5.30 bundled release.

Key areas:
- `packages/animations/src/spinner-handle.ts`: Process-wide exit-listener registry (pool, `activeRestores`, `ensureProcessExitListeners`, `__resetExitListenersForTesting`). +74 lines.
- `packages/core/src/store/sqlite-native.ts`: Vitest production-DB leak guard (`assertVitestSafePath`, `CLEO_TEST_ALLOW_PROJECT_DB`, `CLEO_TEST_ALLOWED_DB_ROOTS`). +80 lines.
- `packages/core/src/ui/flags.ts`: DELETED (SSoT cleanup — flag parsing belongs to LAFS).
- `packages/cleo/src/cli/index.ts`: 498-line diff — lazy-load CLI commands + LAFS output centralization.
- `packages/cleo/src/dispatch/adapters/cli.ts`: 50-line diff — dispatch adapter changes.
- `packages/core/src/__tests__/human-output.test.ts`: 238-line refactor.
- `package.json`: Added `lint:raw-cr` script + updated lint/lint:fix to include raw-CR check.
- `pnpm-lock.yaml`: Added `@cleocode/animations` to `packages/cleo` deps.
- `GEMINI.md`: Duplicate CAAMP block bug (added second `<!-- CAAMP:START --> @AGENTS.md <!-- CAAMP:END -->` block).
- `.cleo/metrics/GRADES.jsonl`: One new grade entry appended.

### Provenance

Manual stash before the v2026.5.30 bundled release. The label "pre-release-cleanup" matches the release workflow pattern.

### Cross-Reference with Current Main

All substantive changes verified as present in current HEAD:

| Change | Committed as |
|---|---|
| Spinner process-wide exit listeners | `5211770fb` (fix(T9011): hoist SpinnerHandle exit listeners) |
| sqlite-native vitest guard | `2de07224a` (fix(T9031): hard-block production-DB writes from vitest) |
| flags.ts deletion | `a62a42a1a` (feat(T1855): centralize LAFS output, lazy-load CLI commands) |
| cli/index.ts lazy-load | `a62a42a1a` |
| cli.ts dispatch adapter | `a62a42a1a` (md5sum confirmed identical) |
| human-output.test.ts refactor | `a62a42a1a` |
| package.json lint:raw-cr | `a62a42a1a` |
| pnpm-lock animations dep | `a62a42a1a` |
| spinner-handle.ts | Confirmed: md5sum matches current HEAD exactly |

**GEMINI.md duplicate CAAMP block**: stash@{2} had a GEMINI.md with two CAAMP blocks. Current HEAD has only one (correct). This was cleaned up in a subsequent commit.

### Correctness Assessment

All code is correct and shipped. The GEMINI.md artifact was a transient bug corrected before commit. No novel content.

### Recommendation

**DROP**

Rationale: Every functional change in this stash is already committed to main. The only unique artifact (GEMINI.md duplicate block) was an error that was correctly NOT committed.

---

## Stash 2 (now stash@{3}): 3-File Config Snapshot (2026-04-29)

**Age**: Created 2026-04-29 09:27 (-0700)  
**Message**: `On main: pre-release-cleanup: unstaged changes to AGENTS.md CLAUDE.md project-context.json`  
**Base commit**: 991508c91 (the `HONEST-HANDOFF-2026-04-28.md` commit, 585+ commits behind current HEAD)

### Content Summary

3 files, 5 insertions / 4 deletions:

| File | Change |
|---|---|
| `.cleo/project-context.json` | `detectedAt` timestamp from `2026-04-05T14:10:05` to `2026-05-05T21:26:56`; added `outputDir: dist` to build section |
| `AGENTS.md` | Trailing newline added (no-newline at EOF removed) |
| `CLAUDE.md` | Trailing newline added (no-newline at EOF removed) |

### Cross-Reference with Current Main

- **AGENTS.md**: Content from stash@{3} is IDENTICAL to current HEAD (confirmed via diff — no output). Current HEAD already has the trailing newline fix.
- **CLAUDE.md**: Content from stash@{3} is IDENTICAL to current HEAD.
- **project-context.json**: stash@{3} has `detectedAt: 2026-05-05T21:26:56.545Z`; current HEAD has `2026-05-06T02:58:41.222Z`. This is a runtime-regenerated timestamp field — purely ephemeral, no code value. The `outputDir: dist` field IS present in current HEAD (added in a later commit).

### Correctness Assessment

No code. Pure configuration/runtime data. The timestamp is stale. The AGENTS.md and CLAUDE.md changes are already in HEAD.

### Recommendation

**DROP**

Rationale: Entire content is already subsumed by current HEAD. The project-context.json timestamp is meaningless ephemeral data (auto-regenerated on `cleo init`). No unique content.

---

## Stash 3 (now stash@{4}): Post-Audit Multi-Campaign Work (2026-04-27)

**Age**: Created 2026-04-27 10:47 (-0700)  
**Message**: `WIP on main: 889cec089 feat(T1473): wire CLI nexus commands to core SDK functions`  
**Base commit**: 889cec089 (585+ commits behind current HEAD)

### Content Summary

83 files, 1901 insertions / 351 deletions. This is the largest stash — it captured the result of the 2026-04-29 audit-execution session (Teams Alpha, Bravo, Charlie) before the work was committed.

Key areas:
- `.cleo/agent-outputs/NEXT-SESSION-HANDOFF.md`: 507-line rewrite (the "HONEST-HANDOFF" correction narrative)
- 17 `packages/cleo/src/cli/commands/*.ts`: cleo→contracts layering rewrite (Alpha-3/4/5)
- Renderer + dispatch adapter files: Alpha-4/5 layering
- `packages/contracts/src/branch-lock.ts`: NEW — worktree branch-lock contract
- `packages/contracts/src/exit-codes.ts`: Extended exit codes
- `packages/core/src/spawn/branch-lock.ts`: NEW — branch-lock implementation
- `packages/core/src/scaffold.ts`: NEW — `ensureProjectGitInitialCommit` (T1244)
- `packages/core/src/agents/seed-install.ts`: `forceInstallProjectTierAgents` (T1242)
- `packages/core/src/upgrade.ts`: `agent_registry_sync` action (T1243)
- `packages/core/src/sentient/tick.ts`: NEW — sentient tick implementation
- `packages/core/src/tasks/update.ts`: NEW — tasks update ops
- Engine test files: lifecycle-scope-guard, task-complete-lifecycle-gate, task-engine tests
- `packages/cleo/src/cli/commands/update.ts`: +15 lines
- `packages/cleo/src/cli/commands/session.ts`: +58 lines

### Cross-Reference with Current Main

All key files verified as superseded:

| File | Status |
|---|---|
| `contracts/src/branch-lock.ts` | IN MAIN but evolved (ADR-062 merge path added; stash version had cherry-pick fields) |
| `core/src/spawn/branch-lock.ts` | IN MAIN and evolved beyond stash@{4} version |
| `core/src/scaffold.ts` | IN MAIN (1893+ lines vs stash's ~100 lines — massively grown) |
| `core/src/agents/seed-install.ts` | IN MAIN — T1242 changes committed as `895fd908e` |
| `core/src/upgrade.ts` | IN MAIN — T1243 changes committed as `895fd908e` |
| `core/src/sentient/tick.ts` | IN MAIN — 1454 lines vs stash's 1126 lines (grown) |
| Layering rewrites (cleo→contracts) | IN MAIN — T1565 committed as part of `895fd908e` |
| NEXT-SESSION-HANDOFF.md | IN MAIN — `991508c91` committed the HONEST-HANDOFF |

The base commit (889cec089) is a proper ancestor of current HEAD (confirmed with `git merge-base --is-ancestor`). Current HEAD is 585+ commits ahead.

### Conflict Check

Would NOT apply cleanly. Most files have diverged significantly. Branch-lock.ts alone has incompatible interface changes (cherry-pick fields removed; merge path added per ADR-062).

### Correctness Assessment

The code was correct for its time (2026-04-29) but is now stale. Applying would revert numerous post-April evolutions including ADR-062 (merge path), T1624 (cherry-pick removal), T1932 (starter-bundle deletion), and T1935 (template rename). Contains no unique content not already committed with better implementations.

### Recommendation

**DROP**

Rationale: All functional content (T1242, T1243, T1244, T1565 layering) was committed via `895fd908e` and subsequent commits. Current main has more evolved versions of every file in this stash. Applying would cause merge conflicts and revert architectural improvements.

---

## Stash 4 (now stash@{5}): T1473 Nexus SDK Exports (2026-04-27)

**Age**: Created 2026-04-27 10:41 (-0700)  
**Message**: `WIP on main: 678cddc47 feat(T1473): export clusters/flows/context/impact/gexf/symbol-ranking from nexus core index`  
**Base commit**: 678cddc47 (585+ commits behind current HEAD)

### Content Summary

17 files, 2005 insertions / 1496 deletions.

| File | Change |
|---|---|
| `packages/cleo/src/cli/commands/nexus.ts` | +503 lines of new commands (context, impact, diff, clusters, flows, scan) |
| `packages/cleo/src/dispatch/domains/pipeline.ts` | 2077 lines restructured |
| `packages/cleo/src/dispatch/domains/playbook.ts` | 481 lines restructured |
| `packages/cleo/src/dispatch/domains/tasks.ts` | 130 line changes |
| `packages/cleo/src/dispatch/domains/conduit.ts` | 63 line changes |
| `packages/contracts/src/operations/index.ts` | 1 line |
| `packages/core/src/conduit/index.ts` | 1 line |
| `packages/core/src/conduit/ops.ts` | +39 lines (new conduit ops signatures) |
| `packages/core/src/nexus/*.ts` (6 files) | Minor changes to clusters, context, diff, gexf-export, impact, projects-scan |
| `packages/core/src/nexus/index.ts` | +92 lines of exports |
| `packages/core/src/tasks/index.ts` | 2 lines |
| `packages/core/src/tasks/ops.ts` | +67 lines (task op signatures) |

### Cross-Reference with Current Main

| File | Status |
|---|---|
| `conduit/ops.ts` | IDENTICAL to current HEAD (confirmed via md5sum) |
| `tasks/ops.ts` | Near-identical (13-line diff — minor lint adjustments only) |
| `nexus.ts` (CLI) | SUPERSEDED — current main has 2969 lines vs stash's 503; T1569 waves (W1-W4) migrated all nexus ops to core |
| `dispatch/domains/pipeline.ts` | SUPERSEDED — current main 1054 lines vs stash's ~2000; T1484/T1492 thinning plus T1569 migration |
| `dispatch/domains/playbook.ts` | SUPERSEDED |
| `nexus/index.ts` | SUPERSEDED — current main 306 lines with full Wave 1-4 migrations |

The T1473 work was committed via commits `69cbf48c9`, `b0fd81495`, `34c7067be`, `1eccebc2a` (all in main). Current main has significantly more evolved versions.

### Conflict Check

Would NOT apply cleanly. `nexus.ts` CLI alone has 2466 lines more than the stash version — direct conflict. `pipeline.ts` has been restructured by multiple subsequent campaigns (T1484, T1492, T1569).

### Correctness Assessment

Code was correct for its time (April 27) but fully superseded. The `conduit/ops.ts` and `tasks/ops.ts` files are essentially identical to current HEAD, confirming the T1473 work landed cleanly in main. No unique content survives.

### Recommendation

**DROP**

Rationale: All T1473 functional content is committed to main. `conduit/ops.ts` (identical) and `tasks/ops.ts` (near-identical) are safe to verify gone. Every other file in this stash has been substantially evolved by 585+ subsequent commits.

---

## Summary Table

| Stash | Current Index | Age | Files | Lines | Task | Status | Recommendation |
|---|---|---|---|---|---|---|---|
| Original 0 | stash@{1} | 2026-05-05 19:54 | 11 | +367/-46 | T1936 + applyPerfPragmas | T1936 committed (97ef87dad); applyPerfPragmas in working tree | **DROP** |
| Original 1 | stash@{2} | 2026-05-05 15:08 | 24 | +543/-729 | Pre-v2026.5.30 cleanup | All content in main (a62a42a1a, 5211770fb, 2de07224a) | **DROP** |
| Original 2 | stash@{3} | 2026-04-29 09:27 | 3 | +5/-4 | Config snapshot | AGENTS.md + CLAUDE.md identical to HEAD; project-context.json ephemeral timestamp | **DROP** |
| Original 3 | stash@{4} | 2026-04-27 10:47 | 83 | +1901/-351 | Multi-campaign (T1242/43/44/65) | All content committed (895fd908e); current main is 585+ commits ahead with evolved versions | **DROP** |
| Original 4 | stash@{5} | 2026-04-27 10:41 | 17 | +2005/-1496 | T1473 nexus SDK exports | All T1473 content in main; conduit/ops.ts identical; other files superseded | **DROP** |

---

## HITL Flags

**No HITL required.** All 5 stashes are recommended for DROP with high confidence:

1. No stash contains content that is both (a) absent from current main AND (b) valuable for recovery.
2. The only "missing from HEAD" content (applyPerfPragmas refactor) is present in the current working tree and will be committed in the current session.
3. All stashes that contained new features (T1936, T1242, T1243, T1244, T1473 nexus ops) have those features committed in main with later, more evolved implementations.

**One note for owner**: A new stash (`stash@{0}: pre-validation-snapshot-2026-05-06`) was auto-created during this investigation session. It captures the current working tree state (applyPerfPragmas + .gitignore specs removal). This is ALSO safe to drop after the applyPerfPragmas changes are committed — it is a snapshot safety net for the current WIP.

---

## Disposition Actions (for follow-up task)

After owner sign-off, execute in order (DO NOT apply any stash first):

```bash
# Drop oldest stash first to preserve stash@{0} safety net longest
git stash drop stash@{5}   # T1473 superseded
git stash drop stash@{4}   # multi-campaign superseded  
git stash drop stash@{3}   # 3-file config ephemeral
git stash drop stash@{2}   # pre-release cleanup absorbed
git stash drop stash@{1}   # T1936 committed + applyPerfPragmas in WIP
# After applyPerfPragmas changes are committed to main:
git stash drop stash@{0}   # safety snapshot
```

---

*Generated by: ad-hoc investigation subagent, 2026-05-06*  
*Output file*: `/mnt/projects/cleocode/.cleo/agent-outputs/stash-validation-2026-05-06.md`
