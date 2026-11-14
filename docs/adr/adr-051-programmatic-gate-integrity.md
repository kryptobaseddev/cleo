# ADR-051 — Programmatic Gate Integrity: Evidence-Based Verify + Removal of Silent Bypass

**Status**: ACCEPTED
**Date**: 2026-04-17
**Task**: T832
**Children**: T833 (remove --force), T834 (wire pipelineStage), T835 (unify lifecycle SSoT)
**Relates to**: ADR-014 (RCASD-IVTR), ADR-044 (canon reconciliation), ADR-049 (harness sovereignty)

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
RFC 2119.

---

## Context

On 2026-04-16 during Wave B orchestration, the orchestrator invoked `cleo complete --force` four
times (T488, T490, T491, T830). The underlying content shipped correctly, but the procedural
gate was bypassed. Root-cause investigation identified four defects:

1. **`cleo update --pipelineStage` declared but not wired (T834)**: The CLI exposes
   `--pipeline-stage`, the CLI adapter places `pipelineStage` into dispatch params, and the core
   `updateTask` accepts and enforces forward-only transitions. But the dispatch layer at
   `packages/cleo/src/dispatch/domains/tasks.ts` drops the field before forwarding. Confirmed by
   live repro: `cleo update T833 --pipeline-stage decomposition` returns `E_NO_CHANGE`.
2. **Data split (T835)**: `cleo lifecycle complete` writes to the `lifecycle_stages` table and
   `lifecycle_pipelines.currentStageId` via `recordStageProgress`, but never updates
   `tasks.pipeline_stage`. The parent-epic lifecycle gate in `taskCompleteStrict` reads
   `tasks.pipeline_stage`, so lifecycle-correct behaviour doesn't satisfy the gate.
3. **`--force` silent bypass (T833)**: `cleo complete --force` bypasses both the IVTR gate and
   the parent-epic lifecycle gate. A warning is logged and a VerificationFailure entry is
   appended, but the bypass completes the task regardless. No programmatic way exists to detect
   whether a completed task used `--force`.
4. **`cleo verify --all` rubber-stamp**: The `--all` mode sets every configured gate to `true`
   with no evidence required and no hash recorded. The gate state is self-attested by the caller
   with no proof of the underlying assertion.

The combined effect: any agent can write "all gates pass" and complete a task without the
orchestrator or CLI having any programmatic way to refute the claim. The owner mandate is explicit:

> There must be programmatic ways with TOOLS that we can build into cleo to truly make sure
> ZERO rubber stamping NEVER happens in ANY of the LOOM stages for RCASD or IVTR.

---

## Decisions

### Decision 1: `cleo verify` REQUIRES evidence for every gate write

Every write to a task's verification gates MUST be accompanied by structured evidence. The CLI
MUST validate the evidence against the filesystem / git / toolchain before persisting the gate,
and MUST store the evidence alongside the gate so the proof is recoverable later.

**Evidence grammar** (CLI surface):

```
cleo verify <taskId> --gate <gateName> --evidence <evidence-list>

evidence-list := evidence-atom ("," evidence-atom)*
evidence-atom := "commit:" <sha>
              | "files:" <comma-separated-paths>           # NB: outer separator is ; when files: is used alongside other atoms, use semicolons. See spec.
              | "test-run:" <path-to-vitest-json>
              | "tool:" <tool-name>                        # biome | tsc | eslint | pnpm-build
              | "url:" <url>                               # for research artifacts
              | "note:" <short-note>
```

For CLI simplicity, `--evidence` accepts atoms separated by `;` (semicolon). Each atom's inner
payload uses its own separator (commas for `files:`).

**Gate-by-evidence mapping** (from `TaskVerification.gates` keys):

| Gate | Required evidence atoms (at least one of the set) |
|------|--------------------------------------------------|
| `implemented` | `commit:<sha>` AND `files:<one-or-more>` |
| `testsPassed` | `test-run:<vitest-json>` or `tool:pnpm-test` with captured exit 0 |
| `qaPassed` | `tool:biome` AND `tool:tsc` with captured exit 0 |
| `documented` | `files:<docs-paths>` or `url:<published-doc-url>` |
| `securityPassed` | `tool:security-scan` or `note:<waiver-with-justification>` |
| `cleanupDone` | `note:<cleanup-summary>` |

**MUST validate evidence before persisting**:
- `commit:<sha>` — run `git cat-file -e <sha>` (via `simple-git` or spawned `git`) and verify
  it exists in the repo AND is reachable from HEAD. Record the short SHA.
- `files:<paths>` — each path MUST exist on disk. Record sha256 of each.
- `test-run:<path>` — file MUST exist, MUST parse as vitest JSON, pass count MUST equal total,
  failures array MUST be empty. Record sha256 of the JSON.
- `tool:<tool>` — the CLI MUST actually execute the tool against the repo (scoped to the task's
  files when known, else repo-wide) and the tool MUST exit 0. Record stdout tail + exit code.
- `url:<url>` — record the URL verbatim; no verification (soft evidence).
- `note:<note>` — record the note verbatim; no verification (soft evidence).

### Decision 2: `cleo verify --all` is REJECTED without per-gate evidence

`cleo verify <id> --all` alone MUST return `E_EVIDENCE_MISSING` (new exit code). Callers MUST
explicitly set each gate with its own `--evidence` or pass all required evidence atoms in a single
`--all --evidence` invocation where the CLI distributes atoms to gates per the mapping above.

### Decision 3: `cleo complete --force` is REMOVED

The `--force` flag MUST be removed from `cleo complete`. The rationale:

- The force path pre-existed evidence-based verify. With evidence available, no legitimate
  scenario requires bypassing gates — the orchestrator can always produce or waive gates via
  `note:<justification>` evidence.
- Every observed `--force` usage in the historical record was a rubber-stamp. Zero legitimate
  uses found during research.
- Emergency escape hatch is the environment variable `CLEO_OWNER_OVERRIDE=1` (see Decision 6).

The dispatch layer MUST reject `force` parameter with `E_FLAG_REMOVED` error. The CLI MUST NOT
declare the flag.

### Decision 4: `cleo update --pipelineStage` MUST work end-to-end

The dispatch layer at `tasks.ts` `update` case and the engine `taskUpdate` at `task-engine.ts`
MUST accept and forward `pipelineStage`. Core `updateTask` already enforces forward-only
transitions and epic stage-ceiling rules — the dispatch plumbing is the only gap.

### Decision 5: `lifecycle_stages` and `tasks.pipelineStage` MUST stay in sync

`recordStageProgress` in `packages/core/src/lifecycle/index.ts` MUST update `tasks.pipeline_stage`
in the same transaction that writes `lifecycle_stages` and `lifecycle_pipelines.currentStageId`.

This unifies the gate read path (all gates continue to read `tasks.pipelineStage`) without
requiring callers to change. `cleo lifecycle show/history` continues to read from
`lifecycle_stages` / `lifecycle_pipelines`.

**Migration**: Existing data is reconciled by a one-time backfill during next `cleo` startup:
for every lifecycle pipeline where `pipelines.currentStageId != tasks.pipelineStage`, set
`tasks.pipelineStage = pipelines.currentStageId` (lifecycle is authoritative when mismatched,
since explicit stage commands are rarer than lifecycle advancement).

### Decision 6: `CLEO_OWNER_OVERRIDE=1` emergency bypass with audit

An environment variable `CLEO_OWNER_OVERRIDE=1` MAY be set to bypass evidence validation in
genuine emergencies. When set:

1. The override MUST be detected and a warning MUST be emitted to stderr with the message:
   `[CLEO_OWNER_OVERRIDE] bypassing evidence validation for <gate> on <taskId> — this is logged`
2. An audit line MUST be appended to `.cleo/audit/force-bypass.jsonl` with:
   `{timestamp, taskId, gate, reason, sessionId, agent, pid}`
3. The gate MUST still be stored with `evidence: {kind: 'override', reason}`.
4. Any task that used the override at any point MUST carry a permanent marker in its
   `verification.failureLog` noting the override.

### Decision 7: Audit trail for every gate write

Every `cleo verify` write MUST append one JSON line to `.cleo/audit/gates.jsonl`:

```json
{
  "timestamp": "ISO-8601",
  "taskId": "T###",
  "gate": "implemented|testsPassed|...",
  "evidence": {...normalized evidence...},
  "agent": "...",
  "sessionId": "...",
  "passed": true|false,
  "override": true|false
}
```

The audit file MUST be append-only (the writer uses `fs.appendFile` with O_APPEND semantics).
`cleo audit gates --task <id>` MAY be added in a follow-up task (not required in this ADR).

### Decision 8: Evidence staleness check on completion

When `cleo complete <id>` is invoked, the verification evidence stored at
`task.verification.evidence` MUST be re-verified:

- For each gate, re-run the evidence validator (git reachability, file sha256 match, test-run
  file hash match, tool exit code).
- If ANY re-check fails, return `E_EVIDENCE_STALE` (new error code) and require re-verification.
- This prevents an agent from verifying, modifying files, then completing.

**Override**: Soft evidence (`note:` and `url:`) is NOT re-validated. Hard evidence (`commit:`,
`files:`, `test-run:`, `tool:`) MUST be re-validated.

### Decision 9: Contract extension — `TaskVerification.evidence`

The `TaskVerification` interface MUST be extended with an `evidence` field:

```ts
export interface TaskVerification {
  passed: boolean;
  round: number;
  gates: Partial<Record<VerificationGate, boolean | null>>;
  evidence?: Partial<Record<VerificationGate, GateEvidence>>;  // NEW
  lastAgent: VerificationAgent | null;
  lastUpdated: string | null;
  failureLog: VerificationFailure[];
  initializedAt?: string | null;
}

export interface GateEvidence {
  atoms: EvidenceAtom[];
  capturedAt: string;              // ISO timestamp
  capturedBy: string;              // agent identifier
  override?: boolean;              // true if CLEO_OWNER_OVERRIDE used
  overrideReason?: string;
}

export type EvidenceAtom =
  | { kind: 'commit'; sha: string; shortSha: string }
  | { kind: 'files'; files: Array<{ path: string; sha256: string }> }
  | { kind: 'test-run'; path: string; sha256: string; passCount: number; failCount: number; skipCount: number }
  | { kind: 'tool'; tool: string; exitCode: number; stdoutTail: string }
  | { kind: 'url'; url: string }
  | { kind: 'note'; note: string };
```

This is additive — existing persisted verifications (without `evidence`) load without errors
because `evidence` is optional.

### Decision 10: Migration — 257 existing done tasks remain verified

Tasks completed before v2026.4.78 are not retroactively invalidated. Evidence-based verify
applies only to NEW verification writes against NON-DONE tasks. Done tasks are immutable with
respect to verification (re-verifying a done task is meaningless — the task has already shipped).

This preserves history and avoids breakage.

---

## Consequences

**Positive**:
- Rubber-stamping is eliminated at the CLI layer. Every gate has a programmatic assertion.
- Audit trail is append-only and immutable in practice.
- Evidence staleness detection prevents "verify then tamper" attacks.
- The pipelineStage data split is closed — one read path, one write path.
- Lifecycle advancement via `cleo lifecycle complete` now satisfies the parent-epic gate
  automatically. No more confusing E_LIFECYCLE_GATE_FAILED when the lifecycle IS advanced.

**Negative**:
- Additional CLI calls required per task completion (one `verify` per gate vs one `--all`).
  Mitigation: the orchestrator generates evidence atoms automatically from its natural workflow
  (each wave already runs biome, tsc, tests — results captured as evidence).
- Existing BATS tests for `cleo complete --force` must be removed or refactored. Audit shows
  none exist in the codebase (the test `expect(taskCompleteStrict).toHaveBeenCalledWith(...,
  true)` verifies force forwarding; gets removed with the flag).
- Evidence validators add ~50ms per `cleo verify` call (git cat-file + sha256). Acceptable.

**Neutral**:
- Additive contract extension — no breaking type changes.
- `force` removal is a breaking CLI change (requires CHANGELOG entry + release note).

---

## Alternatives Considered

**Alternative A**: Keep `--force` behind `CLEO_OWNER_OVERRIDE=1` env gate with audit.
Rejected: equivalent safety, weaker symbolism. Removing the flag outright enforces that
evidence is the contract.

**Alternative B**: Replace `tasks.pipelineStage` with a view over `lifecycle_stages`.
Rejected: larger migration, more complex read path, harder to reason about. Decision 5's
dual-write-in-transaction is smaller and correct.

**Alternative C**: Retroactively require evidence for all 257 done tasks.
Rejected: breaks history, no value. Migration note (Decision 10) is sufficient.

**Alternative D**: Evidence as free-text note only (no programmatic validation).
Rejected: defeats the purpose. Owner mandate explicitly requires TOOLS.

---

## Implementation Notes

Sequencing for the release:

1. Contract extension (Decision 9) first — no behaviour change.
2. `recordStageProgress` dual-write (Decision 5).
3. Dispatch wiring for `cleo update --pipelineStage` (Decision 4).
4. `validateGateVerify` evidence requirement + audit (Decisions 1, 2, 7).
5. Evidence staleness re-check in `taskCompleteStrict` (Decision 8).
6. Remove `--force` from CLI + dispatch (Decision 3).
7. `CLEO_OWNER_OVERRIDE=1` emergency path (Decision 6).
8. Migration backfill (Decision 5, backfill path).
9. Tests at each step.

Test coverage MUST include:
- Unit tests for each evidence validator (positive + negative).
- Integration test for `verify --all` rejected.
- Integration test for evidence → complete → staleness re-verify.
- Regression test proving `cleo update --pipelineStage` works.
- Regression test proving `recordStageProgress` writes both tables.
- E2E closure of T488, T490, T491, T830 using the new flow.
