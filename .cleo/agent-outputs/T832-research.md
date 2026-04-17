# T832 Research — CLI Gate Integrity

**Session**: ses_20260416230443_5f23a3
**Agent**: Opus Lead
**Date**: 2026-04-17
**Epic**: T832 (with T833, T834, T835)

---

## R — Research findings

### 1. `cleo complete --force` bypass surfaces (T833)

The `--force` flag is declared three layers deep:

1. **CLI**: `packages/cleo/src/cli/commands/complete.ts` line 38-41 — `force: { type: 'boolean', description: 'Force completion even when children are not done or dependencies unresolved' }`
2. **Dispatch**: `packages/cleo/src/dispatch/domains/tasks.ts` line 319-327 — forwards `params?.force` into `taskCompleteStrict(projectRoot, taskId, notes, force)`
3. **Engine**: `packages/cleo/src/dispatch/engines/task-engine.ts` `taskCompleteStrict(projectRoot, taskId, notes?, force?)` — line 769+

Two enforcement paths are currently bypassed by `--force`:

- **IVTR gate** (line 817-896): When `ivtr_state.currentPhase !== 'released'`, without force → `E_IVTR_INCOMPLETE` (exit 83). With force → logs `[OWNER WARNING]` + appends `VerificationFailure` with agent="owner-forced" + returns with `ivtrBypassed: true`.
- **Parent-epic lifecycle gate** (line 899-1008): When `parent.pipelineStage` is in `{research|consensus|architecture_decision|specification|decomposition}`, without force → `E_LIFECYCLE_GATE_FAILED` (exit 80). With force → logs warning + appends `VerificationFailure` + returns with `lifecycleGateBypassed: true`.

Core `completeTask` in `packages/core/src/tasks/complete.ts` does **not** accept or consult `force`. It enforces:
- Dependency completeness (line 131-146)
- Acceptance criteria (148-156)
- Verification gates via `task.verification.gates` (158-197)
- Child completeness for epics (199-214)

**Note**: The core `completeTask` verification-gate check ignores `--force` — but `taskCompleteStrict` passes `notes` only. So if you pass `--force` today, the engine wrapper bypasses IVTR + parent-epic gates, then delegates to `completeTask` which STILL checks `task.verification.passed`. BUT: the orchestrator then pre-sets `task.verification.gates` via `cleo verify --all`, so at completion time the verification check is already green. **That is the rubber-stamp path Wave B exploited.**

### 2. `cleo update --pipelineStage` not wired (T834)

Confirmed bug:

- **CLI** (`packages/cleo/src/cli/commands/update.ts` line 109-113, 145): declares `--pipeline-stage` arg, copies to `params['pipelineStage']`.
- **Dispatch** (`packages/cleo/src/dispatch/domains/tasks.ts` line 298-317): the `update` case builds an explicit object to pass to `taskUpdate()` and **does not include `pipelineStage`**.
- **Engine** (`packages/cleo/src/dispatch/engines/task-engine.ts` `taskUpdate()` line 603-653): also omits `pipelineStage` from the `updates` param type and from the core call.
- **Core** (`packages/core/src/tasks/update.ts`): the `UpdateTaskOptions.pipelineStage` field exists (line 82) AND the transition + epic enforcement is implemented (line 273-308), using `validatePipelineTransition` + `validateEpicStageAdvancement` + `validateChildStageCeiling`.

Live repro confirmed:
```
$ cleo update T833 --pipeline-stage decomposition
{"success":false,"error":{"code":102,"codeName":"E_NO_CHANGE",...}}
```

Core rejects with `E_NO_CHANGE` because dispatch drops the field before reaching core. The full plumbing works — dispatch layer just never wires it through.

### 3. Data split: `tasks.pipelineStage` vs `lifecycle_stages` (T835)

Two writeable stores exist:

| Store | Written by | Read by |
|-------|-----------|---------|
| `tasks.pipeline_stage` column (task record) | `cleo update --pipeline-stage` (broken), `cleo complete` auto-advance to 'release' | `taskCompleteStrict` parent-epic gate (line 922), `validateChildStageCeiling`, `validateEpicStageAdvancement` |
| `lifecycle_stages` + `lifecycle_pipelines.currentStageId` (SQLite) | `cleo lifecycle complete/start/skip/reset`, `cleo orchestrate start` (via `recordStageProgress`) | `getLifecycleStatus`, `cleo lifecycle show/history` |

**Critical**: `recordStageProgress` (packages/core/src/lifecycle/index.ts line 828) writes the lifecycle_stages table and `lifecycle_pipelines.currentStageId`, but does **not** update `tasks.pipelineStage`. This is the data split. The parent-epic gate reads `tasks.pipelineStage` while `cleo lifecycle complete` writes elsewhere, so running the "correct" lifecycle advancement doesn't satisfy the gate.

The simpler correct path: make `recordStageProgress` also update `tasks.pipelineStage` atomically within the same transaction (the function already uses a DB connection). This preserves backward compatibility (existing callers of `getLifecycleStatus` still work), unifies the authoritative read path (gates continue to read `tasks.pipelineStage`), and ensures both stores agree.

### 4. `cleo verify --all` rubber-stamp path

`validateGateVerify` in `packages/cleo/src/dispatch/engines/validate-engine.ts` line 854-974:

- Accepts `all: true` with no evidence (line 906-914).
- Loops every configured gate and sets `verification.gates[g] = true`.
- Computes `passed = all required gates true`.
- Persists to the task's `verification` JSON column.

No evidence required; no hash recorded; no re-check at complete time. Any agent can set all gates true in a single call with no proof.

### 5. Existing gate-runner infrastructure

`packages/core/src/tasks/gate-runner.ts` already implements programmatic gates with evidence (tests, file-exists, HTTP, command-exec, etc.). Design contract is rich and complete — acceptance gates with `kind: test | file_exists | command | ...`, evidence collected, exit codes checked.

This gives a proven template we extend to `verify` gates. But `cleo verify` (the verification-gate writer) doesn't use this pattern — it's the free-set API that `--all` rubber-stamps.

### 6. Migration concerns (existing 257 done tasks)

We must not retroactively break completed tasks. `task.completedAt` is the marker of legacy completion; evidence-based verify only applies to **new completions** after the migration. Evidence absence on legacy tasks MUST NOT reopen them. The safe pattern:

- New CLI flag `--evidence` is optional for `cleo verify <id> --gate <g>` (backward compat initial rollout) but REQUIRED when the feature flag `verification.requireEvidence: true` is set in config.
- Hard-fail rollout in a later version (tracked via ADR deprecation notice).

**Decision**: For v2026.4.78, we ship evidence-required ON for any **NEW** verification write that touches a **NON-DONE** task. Completed tasks are immutable (already done; can't re-verify). For `cleo verify --all` we REJECT without per-gate evidence regardless of task status (because `--all` is always the rubber-stamp path).

This closes the rubber-stamp surface without breaking 257 existing done tasks.

---

## Open questions — autonomous decisions

Per owner mandate: "design autonomously, owner said autonomous." The following are decided:

1. **`--force` policy**: REMOVED entirely (Option 1). No legitimate use case exists that justifies bypassing gates when evidence-based verify lets orchestrators legitimately pass gates via proof. The `--force` path was itself the hack; with evidence available, force is redundant. Any genuine emergency goes via explicit `CLEO_OWNER_OVERRIDE=1` + audit.
2. **Lifecycle unification path**: Make `recordStageProgress` ALSO update `tasks.pipelineStage` atomically. Simpler than collapsing the lifecycle_stages table. Preserves historical transitions AND unifies the gate read path.
3. **Verify evidence format**: `--evidence commit:<sha>,files:<list>,test-run:<path>,tool:<tool>[,...]`. CLI parses, validates each piece against the filesystem/git/tools, stores as a normalized JSON structure in verification.gates[gate].evidence.
4. **Verify evidence schema**: Add `evidence?: GateEvidence` to `TaskVerification.gates` (extend contract). Backward compatible — old gates with `true` instead of `{passed: true, evidence: ...}` still parse correctly because the structural shape is disjoint.

Wait — `TaskVerification.gates` is `Partial<Record<VerificationGate, boolean | null>>`. Can't naturally embed evidence there without a contract change. The path is:

- Keep existing `gates: Partial<Record<VerificationGate, boolean | null>>` (booleans, unchanged).
- Add sibling `evidence: Partial<Record<VerificationGate, GateEvidence>>` to TaskVerification.
- Old verifications load without evidence (pass-through compatibility).
- New verifications populate both.

---

## C — Consensus (autonomous)

Per owner mandate, consensus is implicit. Proceeding with the design above.

## A — Architecture Decision

Formalised in `.cleo/adrs/ADR-051-programmatic-gate-integrity.md`.

## S — Specification

Formalised in `docs/specs/T832-gate-integrity-spec.md`.

## D — Decomposition

T832 decomposes into:

- **T833** (close via this epic): Remove `cleo complete --force` silent bypass.
- **T834** (close via this epic): Wire `cleo update --pipelineStage` end-to-end.
- **T835** (close via this epic): Unify `lifecycle_stages` ↔ `task.pipelineStage` via `recordStageProgress`.
- **T832** own deliverables: evidence-based verify, audit trail, migration notes, closure of T488/T490/T491/T830.

---

## Files touched

| File | Change |
|------|--------|
| `packages/contracts/src/task.ts` | Add `evidence?: Partial<Record<VerificationGate, GateEvidence>>` to `TaskVerification`; add `GateEvidence` type. |
| `packages/cleo/src/cli/commands/complete.ts` | Remove `--force` flag + `CLEO_OWNER_OVERRIDE` env gate + append audit line. |
| `packages/cleo/src/cli/commands/verify.ts` | Add `--evidence` arg; reject `--all` without evidence. |
| `packages/cleo/src/dispatch/domains/tasks.ts` | `update` case forward `pipelineStage`; `complete` case no longer accepts force. |
| `packages/cleo/src/dispatch/domains/check.ts` | Handle `--evidence` parameter for gate.set. |
| `packages/cleo/src/dispatch/engines/task-engine.ts` | `taskUpdate` accept+pass `pipelineStage`; `taskCompleteStrict` re-check evidence staleness; remove force path. |
| `packages/cleo/src/dispatch/engines/validate-engine.ts` | `validateGateVerify` require + validate evidence; reject `--all` without evidence; write audit line. |
| `packages/core/src/lifecycle/index.ts` | `recordStageProgress` also update `tasks.pipelineStage` in same tx. |
| `packages/core/src/tasks/evidence.ts` *(new)* | `GateEvidence` validators (commit, files, test-run, tool). |
| `packages/core/src/tasks/audit.ts` *(new)* | `.cleo/audit/gates.jsonl` appender. |
| `packages/core/src/tasks/__tests__/evidence.test.ts` *(new)* | Unit tests for evidence validators. |
| `packages/core/src/tasks/__tests__/audit.test.ts` *(new)* | Audit log tests. |
| `packages/cleo/src/dispatch/engines/__tests__/verify-evidence.test.ts` *(new)* | Integration: verify without evidence rejected, with valid evidence stored, with stale evidence re-verify required. |
| `packages/cleo/src/dispatch/engines/__tests__/task-update-pipelinestage.test.ts` *(new)* | T834 regression — dispatch passes pipelineStage. |
| `packages/core/src/lifecycle/__tests__/pipelinestage-unification.test.ts` *(new)* | T835 regression — recordStageProgress writes both tables. |
| `.cleo/adrs/ADR-051-programmatic-gate-integrity.md` *(new)* | Architecture decision. |
| `docs/specs/T832-gate-integrity-spec.md` *(new)* | RFC 2119 specification. |
| `.cleo/templates/CLEO-INJECTION.md` | New verify workflow. |
| `templates/skills/ct-cleo/SKILL.md` | Update gate ritual. |
| `templates/skills/ct-orchestrator/SKILL.md` | Update evidence discipline. |

---

## Test plan

1. Unit: evidence validators (commit, files, test-run, tool). All pass/fail modes.
2. Unit: audit log appender writes single-line JSON per call.
3. Unit: pipelineStage dispatch plumbing (regression for T834).
4. Unit: recordStageProgress updates tasks.pipelineStage (regression for T835).
5. Integration: `cleo verify --all` without evidence → E_EVIDENCE_MISSING.
6. Integration: `cleo verify --gate implemented --evidence commit:<valid>,files:a,b` → gate set, evidence stored.
7. Integration: mutate files post-verify, then `cleo complete` → re-check fails → E_EVIDENCE_STALE.
8. Integration: `cleo complete` without `--force` works after proper evidence-based verify.
9. E2E: Close T488/T490/T491/T830 with the new flow. Each must pass through `cleo verify --gate` with real evidence, then `cleo complete`.

---

## Status

Research complete. Proceeding to ADR + Spec + Implementation.
