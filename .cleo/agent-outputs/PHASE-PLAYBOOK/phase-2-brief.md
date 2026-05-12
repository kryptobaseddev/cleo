# PHASE 2 BRIEF — Verifier Lockdown

**Phase tracker:** T9233 (parent: T9232 MASTER)
**Team name:** `phase-2-verifier-lockdown`
**You are:** `phase2-lead`
**Goal:** Land T9219, T9220 (7 children), T9221 (3 children). Mark T9186 done as duplicate of completed T9192.

## Why this phase

T9187 (AUDIT-RECOVERY 2026-05-08) shipped the root-cause fix (verifier-backed AC) in v2026.5.61. But the lockdown around it isn't complete:
- T9219 — boundary refactor: move `resolveVerifierScript`, `runVerifier`, `backfillSingle`, `backfillAllPending` from `packages/cleo/src/cli/commands/verify.ts` → `packages/core/src/tasks/verifier-runner.ts`. CLI becomes thin dispatch.
- T9220 — Verifier Substrate v2: 7 children (T9222-T9228). Relocate scripts to `.cleo/verifiers/<TID>.mjs`, add `tasks.verifier_path` column, acHash drift detection, GC hooks, spawn-clone-exclude filter, migrate 22 existing scripts, ephemeral exemption.
- T9221 — Forced-Iterations Systemic Enforcement: 3 children (T9229-T9231). Session-end hard gate refusing close on `delegate_task_count=0 + tasks_completed>0`. CANT validateSpawnRequest rejecting implemented gate without upstream sub-agent commit. ADR bypass-prevention substrate.
- T9186 — Same title as completed T9192. Mark done with reference, don't re-execute.

## Sequence

**Wave A (parallel):**
- T9219 (boundary refactor) — single worker
- T9222 (relocate scripts) — single worker
- T9223 (add verifier_path column + registry) — single worker

**Wave B (after Wave A):**
- T9224 (acHash drift detection) — depends on T9223
- T9225 (GC lifecycle hooks) — depends on T9223
- T9226 (worktree spawn-clone-exclude filter) — independent
- T9227 (migrate 22 existing scripts) — depends on T9222
- T9228 (ephemeral exemption) — depends on T9223
- T9229 (FISE-3 ADR substrate) — independent
- T9230 (FISE-1 session-end hard gate) — independent
- T9231 (FISE-2 CANT validateSpawnRequest) — independent

**Wave C (final):**
- Mark T9186 done as duplicate of T9192 (use cleo update + reference note)
- Verify T9220, T9221 epics complete; complete them
- Verify T9187 epic now fully closable; if so, complete it
- Verify T9233 phase tracker

## Specific acceptance hits

- `grep "resolveVerifierScript\|backfillSingle" packages/cleo/src/` → 0 results (Phase 2 success indicator)
- `.cleo/verifiers/` contains 22 migrated verifier scripts + new ones
- `tasks.verifier_path` column exists and non-null for affected tasks
- Session-end on a Lead session with `delegate_task_count=0 AND tasks_completed>0` is REJECTED with `E_LEAD_BYPASS`
- ADR document at `.cleo/adrs/ADR-071-forced-iterations.md` (or similar)

## Coordination

- Workers commit on their `task/<id>` branches with conventional commits including the task ID.
- Use the verifier strict-mode pattern T9218 established: every new epic created during this phase must have a `--verifier` path.
- If a sub-task lacks a verifier script, run `cleo verify backfill <id>` to generate from AC text.

## Done criteria

- Tasks done: T9186 (deduped), T9192 (already done), T9213-T9219, T9220, T9221, T9222-T9231
- Phase tracker T9233: all 4 deps closed (T9187 done, T9219 done, T9220 done, T9221 done)
- `cleo deps validate VALID` and `cleo check coherence passed`
- Write `phase-2-completion-report.md` with commit SHAs + manifest IDs
- BRAIN observation captured
- SendMessage Orchestrator `[Lead] complete: phase-2`

## Critical rules

- DO NOT scaffold-and-mark-done. The verifier strict-mode will reject you.
- DO NOT bypass evidence with override unless work was demonstrably shipped pre-recovery — and only with `CLEO_OWNER_OVERRIDE_REASON` documenting why.
- Run `pnpm biome check --write . && pnpm run build && pnpm run test` after every wave before completing tasks.
