# T832 — CLI Gate Integrity Specification

**Version**: 1.0.0
**Task**: T832
**ADR**: ADR-051
**Status**: ACCEPTED
**Target Release**: v2026.4.78

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
RFC 2119.

---

## 1. Scope

This specification defines the programmatic gate integrity protocol for CLEO task verification
and completion. It governs:

- How `cleo verify` accepts, validates, and stores gate evidence.
- How `cleo complete` re-verifies evidence at completion time.
- The removal of `cleo complete --force` and the replacement emergency path.
- The unification of `lifecycle_stages` and `tasks.pipelineStage` data.
- The audit trail and migration rules.

This specification supersedes all prior behaviour for `cleo verify --all` and
`cleo complete --force` as documented in ADR-014 and predecessor docs.

---

## 2. Evidence Grammar

### 2.1 CLI Syntax

```
cleo verify <taskId> --gate <gateName> --evidence <evidence-list>
cleo verify <taskId> --all --evidence <evidence-list>
cleo verify <taskId>                                      # view only (no write)
cleo verify <taskId> --reset                              # reset verification (no evidence required)
```

- `<taskId>` MUST match `/^T\d{3,}$/`.
- `<gateName>` MUST be one of `implemented | testsPassed | qaPassed | cleanupDone | securityPassed | documented`.
- `<evidence-list>` is a semicolon-separated list of evidence atoms (§2.2).

### 2.2 Evidence Atoms

```
evidence-atom := "commit:" <sha>
              | "files:" <comma-separated-paths>
              | "test-run:" <path>
              | "tool:" <tool>
              | "url:" <url>
              | "note:" <note>
```

Rules:
- Atoms within `--evidence` are separated by `;` (semicolon).
- Paths in `files:` are comma-separated.
- `<sha>` MUST be a full 40-char or short (>=7 char) git SHA-1.
- `<path>` MUST be an absolute or repo-relative path.
- `<tool>` MUST be one of: `biome`, `tsc`, `eslint`, `pnpm-build`, `pnpm-test`, `security-scan`.
- `<url>` MUST begin with `https://` or `http://`.
- `<note>` MAY contain any printable ASCII; MUST NOT contain `;` (reserved).

### 2.3 Gate-to-Evidence Mapping

| Gate | Minimum required evidence |
|------|---------------------------|
| `implemented` | `commit:<sha>` AND at least one `files:<path>` |
| `testsPassed` | `test-run:<path>` OR `tool:pnpm-test` |
| `qaPassed` | Either (a) `tool:biome` AND `tool:tsc`, OR (b) `tool:pnpm-build` (which runs both) |
| `documented` | At least one `files:<path>` OR `url:<url>` |
| `securityPassed` | `tool:security-scan` OR `note:<waiver>` |
| `cleanupDone` | At least one `note:<summary>` |

If the provided atoms do not satisfy the minimum, the CLI MUST reject with
`E_EVIDENCE_INSUFFICIENT` (exit 84).

---

## 3. Evidence Validation

For each atom, the CLI MUST perform the following validation before persisting the gate:

### 3.1 `commit:<sha>`
1. Normalise to repo-relative context (`git rev-parse --show-toplevel`).
2. Run `git cat-file -e <sha>^{commit}`. Non-zero exit → `E_EVIDENCE_INVALID`.
3. Run `git merge-base --is-ancestor <sha> HEAD`. Non-zero exit (SHA not reachable from HEAD) →
   `E_EVIDENCE_INVALID`.
4. Record both full SHA and short SHA (`git rev-parse --short`).

### 3.2 `files:<paths>`
For each path:
1. Resolve against `cwd`. Path MUST exist (`fs.stat`).
2. Compute sha256 of file content.
3. Record `{path, sha256}`.

Non-existent path → `E_EVIDENCE_INVALID`.

### 3.3 `test-run:<path>`
1. Path MUST exist.
2. File MUST parse as JSON.
3. The parsed object MUST conform to vitest JSON reporter output. Minimum fields:
   `{testResults: [...], numTotalTests: N, numPassedTests: M, numFailedTests: F}`.
4. If `numFailedTests > 0` OR `testResults.some(tr => tr.status !== 'passed')`, the evidence
   MUST be rejected with `E_EVIDENCE_TESTS_FAILED` (exit 85).
5. Record `{path, sha256, passCount, failCount, skipCount}`.

### 3.4 `tool:<tool>`
1. Resolve the tool invocation per §3.4.1.
2. Execute the tool with stdio captured.
3. Record `{tool, exitCode, stdoutTail: last 512 chars}`.
4. If `exitCode !== 0`, the evidence MUST be rejected with `E_EVIDENCE_TOOL_FAILED` (exit 86).

#### 3.4.1 Tool Invocations

| Tool | Command (cwd = project root) |
|------|-----------------------------|
| `biome` | `pnpm biome ci .` |
| `tsc` | `pnpm tsc --noEmit` (or project-specific `tsc -b`) |
| `eslint` | `pnpm eslint .` |
| `pnpm-build` | `pnpm run build` |
| `pnpm-test` | `pnpm run test` |
| `security-scan` | `pnpm audit` |

If a tool is not available (binary missing), the evidence MUST be rejected with
`E_EVIDENCE_TOOL_UNAVAILABLE` (exit 87).

### 3.5 `url:<url>`
No validation. Record the URL verbatim.

### 3.6 `note:<note>`
No validation. Record the note verbatim (max 512 chars).

---

## 4. Persistence

On successful evidence validation, the CLI MUST:

1. Load the current `task.verification` state (initialise if null).
2. Set `task.verification.gates[<gate>] = true`.
3. Set `task.verification.evidence[<gate>] = {atoms: [...], capturedAt, capturedBy, override?}`.
4. Recompute `task.verification.passed` from `gates`.
5. Persist the task via the accessor in a single transaction.
6. Append one line to `.cleo/audit/gates.jsonl` (see §6).

If the evidence is insufficient or invalid, the task MUST NOT be modified.

---

## 5. Completion Re-Verification

`cleo complete <taskId>` MUST re-verify all hard evidence atoms before completing:

### 5.1 Hard vs Soft Evidence

- **Hard** (re-verified): `commit:`, `files:`, `test-run:`, `tool:`.
- **Soft** (not re-verified): `url:`, `note:`.

### 5.2 Re-Verification Algorithm

For each gate with evidence:
1. For each hard atom, re-run the validator from §3.
2. If the validator returns the same recorded values (SHA reachable, file sha256 matches,
   test-run sha256 matches, tool exit 0), the atom is current.
3. If ANY hard atom fails re-verification, the complete call MUST reject with
   `E_EVIDENCE_STALE` (exit 88) and report which atoms failed.

### 5.3 Fix Message

The `E_EVIDENCE_STALE` error MUST include a fix message of the form:
```
Evidence for gate '<gate>' on task <taskId> is stale.
Failed atoms: <list>
Re-verify with: cleo verify <taskId> --gate <gate> --evidence <updated-evidence>
```

---

## 6. Audit Trail

### 6.1 `.cleo/audit/gates.jsonl`

Every `cleo verify` write (successful or override) MUST append one JSON line to
`.cleo/audit/gates.jsonl`. Schema:

```json
{
  "timestamp": "2026-04-17T03:14:15.926Z",
  "taskId": "T832",
  "gate": "implemented",
  "action": "set|reset|all",
  "evidence": {
    "atoms": [...],
    "capturedAt": "...",
    "capturedBy": "...",
    "override": false
  },
  "agent": "opus-lead",
  "sessionId": "ses_20260416230443_5f23a3",
  "passed": true,
  "override": false
}
```

- Writer MUST use `fs.promises.appendFile` with `{flag: 'a'}`.
- Writer MUST serialise as a single line (no pretty-printing).
- Writer MUST NOT read the file — append-only semantics.
- The directory `.cleo/audit/` MUST be created if it does not exist.

### 6.2 `.cleo/audit/force-bypass.jsonl`

If `CLEO_OWNER_OVERRIDE=1` is set during `cleo verify`, one line MUST be appended to
`.cleo/audit/force-bypass.jsonl` with the same schema as §6.1 plus:

```json
{
  ...gates.jsonl fields...,
  "overrideReason": "<reason from CLEO_OWNER_OVERRIDE_REASON env or 'unspecified'>",
  "pid": 12345,
  "command": "cleo verify T832 --all --evidence ..."
}
```

---

## 7. `cleo complete --force` Removal

### 7.1 CLI Surface

The `--force` flag MUST be removed from `cleo complete` as declared in
`packages/cleo/src/cli/commands/complete.ts`. The `args` object MUST NOT contain `force`.

### 7.2 Dispatch Layer

The dispatch case for `tasks.complete` in `packages/cleo/src/dispatch/domains/tasks.ts` MUST
reject any `force` parameter in `params` with a structured error:

```ts
if (params?.force !== undefined) {
  return errorResult('mutate', 'tasks', 'complete', 'E_FLAG_REMOVED',
    'The --force flag has been removed. Use CLEO_OWNER_OVERRIDE=1 for emergency bypass (audited). See ADR-051.',
    startTime);
}
```

### 7.3 Engine Signature

`taskCompleteStrict` SHALL drop the `force?: boolean` parameter. All force branches in the
function body MUST be deleted, along with `ivtrBypassed` and `lifecycleGateBypassed` result
markers.

### 7.4 `CLEO_OWNER_OVERRIDE=1` Behaviour

When `CLEO_OWNER_OVERRIDE=1` is set in the process environment at `cleo verify` time:
1. Evidence validation MUST be skipped.
2. The gate MUST still be persisted with `evidence: {kind: 'override', reason}` where reason
   comes from `CLEO_OWNER_OVERRIDE_REASON` env (or "unspecified").
3. An audit line MUST be appended to `.cleo/audit/force-bypass.jsonl`.
4. A stderr warning MUST be emitted.
5. The stored evidence MUST include `override: true` so re-verification at complete time can
   detect and warn.

### 7.5 `CLEO_OWNER_OVERRIDE` at Complete Time

At `cleo complete <id>`, if ANY gate's evidence has `override: true`, the CLI MUST emit a
stderr warning but MUST proceed with completion (override evidence is not re-verified since
it has no programmatic proof).

---

## 8. `cleo update --pipelineStage` Wiring

### 8.1 Dispatch Forwarding

`packages/cleo/src/dispatch/domains/tasks.ts` `update` case MUST include
`pipelineStage: params?.pipelineStage as string | undefined` in the object passed to
`taskUpdate`.

### 8.2 Engine Forwarding

`taskUpdate` in `packages/cleo/src/dispatch/engines/task-engine.ts` MUST:
1. Accept `pipelineStage?: string` in its `updates` parameter type.
2. Forward `pipelineStage: updates.pipelineStage` to `coreUpdateTask`.

### 8.3 Core Behaviour (unchanged)

`coreUpdateTask` in `packages/core/src/tasks/update.ts` already validates and persists
`pipelineStage`. No core changes required for T834.

### 8.4 Forward-Only Enforcement

The existing `validatePipelineTransition` behaviour remains authoritative. Backward transitions
MUST raise `E_VALIDATION` (exit 6). Epic stage-ceiling and child stage-ceiling checks remain
active.

---

## 9. Lifecycle ↔ pipelineStage Unification

### 9.1 Dual Write in `recordStageProgress`

`recordStageProgress` in `packages/core/src/lifecycle/index.ts` MUST include an update to
`tasks.pipeline_stage` in the same DB transaction that updates `lifecycle_stages` and
`lifecycle_pipelines.currentStageId`.

The update MUST use the existing drizzle `db.update(schema.tasks).set({pipelineStage: stage})`
pattern and MUST be conditional: only update when `status === 'in_progress'` or
`status === 'completed'` (not for `skipped` or `failed` — those do not advance the canonical
stage).

### 9.2 Backfill

On next `cleo` startup after v2026.4.78 installs, a one-time backfill routine MUST reconcile
existing mismatches:

1. Select all `lifecycle_pipelines` where the corresponding task's `pipelineStage` does not
   equal `currentStageId`.
2. For each row, update `tasks.pipelineStage = lifecycle_pipelines.currentStageId`.
3. Record the backfill in `.cleo/audit/migration.jsonl` (one line per update).
4. Set a config key `verification.backfillV1Completed: true` to prevent repeat runs.

---

## 10. Contract Extensions

### 10.1 `TaskVerification.evidence`

`packages/contracts/src/task.ts` MUST add:

```ts
export interface TaskVerification {
  passed: boolean;
  round: number;
  gates: Partial<Record<VerificationGate, boolean | null>>;
  /** Evidence backing each gate (T832). */
  evidence?: Partial<Record<VerificationGate, GateEvidence>>;
  lastAgent: VerificationAgent | null;
  lastUpdated: string | null;
  failureLog: VerificationFailure[];
  initializedAt?: string | null;
}
```

### 10.2 `GateEvidence` and `EvidenceAtom`

```ts
export interface GateEvidence {
  atoms: EvidenceAtom[];
  capturedAt: string;
  capturedBy: string;
  override?: boolean;
  overrideReason?: string;
}

export type EvidenceAtom =
  | { kind: 'commit'; sha: string; shortSha: string }
  | { kind: 'files'; files: Array<{ path: string; sha256: string }> }
  | { kind: 'test-run'; path: string; sha256: string; passCount: number; failCount: number; skipCount: number }
  | { kind: 'tool'; tool: string; exitCode: number; stdoutTail: string }
  | { kind: 'url'; url: string }
  | { kind: 'note'; note: string }
  | { kind: 'override'; reason: string };
```

### 10.3 New Exit Codes

```ts
export const ExitCode = {
  ...,
  EVIDENCE_MISSING: 84,
  EVIDENCE_INSUFFICIENT: 84,
  EVIDENCE_INVALID: 84,
  EVIDENCE_TESTS_FAILED: 85,
  EVIDENCE_TOOL_FAILED: 86,
  EVIDENCE_TOOL_UNAVAILABLE: 87,
  EVIDENCE_STALE: 88,
  FLAG_REMOVED: 89,
} as const;
```

Exit codes MAY be consolidated under a single `EVIDENCE` code for simplicity if the error
structure carries the specific `codeName`. Implementation may choose either approach; tests
MUST assert on the `codeName`, not the numeric exit, to avoid fragility.

---

## 11. Migration Rules

### 11.1 Existing Done Tasks

Tasks where `status === 'done'` at the moment of v2026.4.78 install are considered immutable
with respect to verification. Their `verification.evidence` remains undefined; they are not
re-verified. `cleo verify <doneTaskId>` in read mode is permitted; write mode SHOULD return
`E_ALREADY_DONE` with a note pointing to the ADR.

### 11.2 In-Flight Verification Rounds

Tasks where `verification.round > 0` but `status !== 'done'` are treated as partial evidence.
On first `cleo verify --gate <g>` write after v2026.4.78, the evidence field is initialised.
Existing boolean gate values remain; only new writes populate evidence.

### 11.3 Orchestrator Migration Path

Agents following the pre-v2026.4.78 protocol will hit `E_EVIDENCE_MISSING` on their first
`cleo verify --all` call. The error message MUST include a migration hint:

```
Evidence is now required. See ADR-051.
Quick migration:
  cleo verify <id> --gate implemented --evidence commit:<sha>;files:<list>
  cleo verify <id> --gate testsPassed --evidence tool:pnpm-test
  cleo verify <id> --gate qaPassed   --evidence tool:biome;tool:tsc
```

---

## 12. Testing Requirements

### 12.1 Unit Tests (MUST)

- `tests/evidence/commit.test.ts` — reachable/unreachable/invalid SHAs.
- `tests/evidence/files.test.ts` — existing/missing files; sha256 correctness.
- `tests/evidence/test-run.test.ts` — valid/invalid/failing test runs.
- `tests/evidence/tool.test.ts` — each tool exit 0 / non-zero.
- `tests/evidence/mapping.test.ts` — gate-to-evidence minimums satisfied/unsatisfied.
- `tests/audit/gates-jsonl.test.ts` — append-only behaviour.

### 12.2 Integration Tests (MUST)

- `verify --all` without evidence → `E_EVIDENCE_MISSING`.
- `verify --gate implemented --evidence commit:<valid>;files:a,b` → persists atoms.
- Mutate a file post-verify → `complete` → `E_EVIDENCE_STALE`.
- `update --pipelineStage decomposition` → task.pipelineStage = 'decomposition'.
- Backward pipelineStage transition → `E_VALIDATION`.
- `lifecycle complete T832 research` → task.pipelineStage advances.

### 12.3 Regression Tests (MUST)

- Remove `taskCompleteStrict force=true` tests OR convert to tests asserting rejection.
- Existing gate infrastructure tests must pass unchanged.

### 12.4 E2E Closure Tests (MUST)

Executable script or test fixture that reproduces closure of T488, T490, T491, T830 with the
new evidence-based verify flow.

---

## 13. Rollout Plan

**v2026.4.78** (this release):
- All contract, engine, dispatch, CLI changes per Decisions 1-10.
- Migration backfill on startup.
- CHANGELOG entry documenting the breaking CLI change.
- Updated CLEO-INJECTION.md + ct-cleo + ct-orchestrator skills.

**v2026.4.79+** (future):
- `cleo audit gates` query command (optional follow-up).
- `cleo audit bypass` query command (optional follow-up).
- GC policy for audit logs (rotate monthly, keep 12 months).

---

## 14. Security Considerations

- Audit files MUST be append-only per Decision 7. An agent that modifies prior lines is a
  security violation; an append-check tool MAY be added as follow-up.
- `CLEO_OWNER_OVERRIDE=1` is a genuine escape hatch. The owner MUST understand the audit
  implication before setting it.
- Evidence sha256 hashes prevent the trivial "verify, modify, complete" attack. They do not
  prevent an agent from forging a commit — `git cat-file -e` + `merge-base --is-ancestor`
  verifies reachability, which is sufficient for this threat model.

---

## 15. Compatibility

- Backward compatible: existing `TaskVerification` persisted records load without errors
  (evidence is optional).
- Forward compatible: new evidence atoms MAY be added without breaking existing readers by
  adding discriminated union members.
- Breaking: `cleo complete --force` removal. Documented in CHANGELOG + release note.

---

## 16. Acceptance

This specification is ACCEPTED when all of the following hold:

- [ ] ADR-051 approved and linked.
- [ ] All §10 contract extensions shipped.
- [ ] All §7, §8, §9 code paths pass integration tests.
- [ ] `cleo verify --all` alone returns `E_EVIDENCE_MISSING` in a fresh project.
- [ ] T488, T490, T491, T830 closed using evidence-based flow.
- [ ] 8331+ existing tests pass with zero regressions.
