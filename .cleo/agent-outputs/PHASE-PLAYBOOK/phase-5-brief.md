# PHASE 5 BRIEF — Reliability Tail

**Phase tracker:** T9236 (parent: T9232 MASTER)
**Team name:** `phase-5-cleanup-pass`
**You are:** `phase5-lead`
**Goal:** Close remaining Phase 1 deferrals + disk hygiene + Studio prod build.

## Why this phase

Phase 1 closed 7/9 bugs. The 4 deferred items need real fixes that didn't fit the stabilization sprint:

1. **T9092 + T9193** — Worker spawn worktrees STILL create rogue `.cleo/` subdirs despite T1864 + T1873 + T1466. ARCHITECTURAL: needs `getCleoProjectRoot()` walking gitlink back to main repo + `assertProjectInitialized` in `getDb()`. ALS-dependent test fixtures need migration. **See remediation doc:** `.cleo/agent-outputs/CLEANUP-2026-05-11/T9175-T9092-T9193-remediation.md` (29KB, written by prior agent).
2. **T9173** — `cleo init` pollutes global agent registry with project-tier rows pinned to absolute paths that vanish.
3. **T1693** — Studio Vite build fails: `Unexpected character (1:0)` on loro-crdt's loro_wasm_bg.wasm (transitive from llmtxt CRDT). Without fix, published `@cleocode/studio` has empty build/ dir. **Unblocks Phase 8.**
4. **T1461 + T1466 + T9194** — Disk hygiene: 184 brain.db snapshots (1.5GB) with zero rotation, 17 stale worktrees consuming 32GB, undrained quarantine. **Collapse into one pass.**

## Sequence (parallel-safe — different code areas)

**Wave A (parallel × 4):**
- T9092 + T9193 (architectural worktree pollution fix) — `phase5-worktree` worker. Use the remediation doc as starting point.
- T9173 (cleo init global registry pollution) — `phase5-init` worker
- T1693 (Studio vite wasm) — `phase5-studio` worker. Use vite-plugin-wasm or externalize loro-crdt.
- T1461 + T1466 + T9194 (collapsed disk hygiene) — `phase5-disk` worker.

**Wave B (validation):**
- Run new ALS-fixtures tests
- Verify cleo init doesn't pollute global registry
- Verify Studio prod build produces `build/index.js`
- Verify backup rotation works (limit 10 snapshots per DB)
- Verify worktree cleanup CLI verbs are wired

## Done criteria

- 0 rogue `.cleo/` directories created when worker spawns into worktree
- `cleo init` global agent rows have proper scope; on rm of source project, rows are pruned
- `pnpm --filter @cleocode/studio run build` produces `build/index.js` (Studio prod artifact)
- `.cleo/backups/snapshot/` enforces 10-snapshot rotation per DB
- `cleo orchestrate worktree.cleanup` (or equivalent) CLI verb works
- Phase tracker T9236 complete (all 7 deps done)
- `cleo deps validate VALID`, `cleo check coherence passed`
- BRAIN observation + `phase-5-completion-report.md`
- SendMessage Orchestrator `[Lead] complete: phase-5`

## Critical rules

- T9092/T9193 are HIGH RISK: ALS-bridged code can break worker spawn entirely. Test in isolated worktree before merging.
- T1693 may require pnpm-lockfile changes. Verify lockfile check CI passes.
- Disk hygiene worker should NOT delete any worktree currently locked by a running agent — check the lock file first.
