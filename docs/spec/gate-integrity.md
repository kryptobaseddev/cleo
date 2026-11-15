# CLI Gate Integrity Specification

**Version**: 2.0.0
**ADR**: ADR-051 ([`docs/adr/adr-051-programmatic-gate-integrity.md`](../adr/adr-051-programmatic-gate-integrity.md))
**Status**: ACCEPTED
**Introduced**: v2026.4.78

Task: T832

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT",
"RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in
RFC 2119.

---

## 1. Scope

This specification defines the programmatic gate integrity protocol for CLEO task verification
and completion. It governs:

- How `cleo verify` accepts, validates, and stores gate evidence.
- How `cleo complete` re-verifies evidence at completion time.
- The removal of `cleo complete --force` and the owner-override path.
- The coupling of lifecycle stages and `tasks.pipeline_stage`.
- The audit trail.

How a task reaches these gates:

- **PR work** closes through the merge sweep (ADR-099): the PR body carries
  `Closes: T#### AC1,AC2` (`Refs:` for partial delivery), a non-author records a
  per-AC verdict with `cleo review verdict`, and the sweep records `pr:`, `ci:`
  and `satisfies:` evidence and completes the task. `cleo done --from-merge <pr>
  --dry-run` previews it.
- **No-PR work**: `cleo done <id> --plan` names every required gate and the
  evidence it needs; record each with `cleo verify`, then `cleo complete <id>`.
  `cleo done <id>` without `--plan` derives the evidence, records every
  required gate in one write, and completes.

Code: evidence validation `packages/core/src/tasks/evidence.ts`; the verify write path
`packages/core/src/validation/engine-ops.ts`; completion `packages/core/src/tasks/complete.ts`;
atom grammar and gate minimums `packages/contracts/src/evidence-atom-schema.ts`.

---

## 2. Evidence Grammar

### 2.1 CLI Syntax

```
cleo verify <taskId> --gate <gateName> --evidence "<evidence-list>"
cleo verify <taskId> --all --evidence "<evidence-list>"
cleo verify <taskId> --auto [--satisfies AC1,AC3|all] [--pr <n>]   # derive and record, no complete
cleo verify <taskId> --run [--req REQ-A,REQ-B]                     # run typed acceptance gates
cleo verify <taskId> --criterion --evidence "satisfies:<id>#AC<n>;decision:<id>"
cleo verify <taskId> [--explain]                                   # view only (no write)
cleo verify <taskId> --reset                                       # reset verification
cleo done <taskId> --plan                                          # read-only evidence plan
```

- `<gateName>` is one of `implemented | testsPassed | qaPassed | cleanupDone | securityPassed |
  documented | nexusImpact` (`VerificationGate`, `packages/contracts/src/task.ts:151-165`).
  `nexusImpact` is opt-in via `CLEO_NEXUS_IMPACT_GATE=1`.
- `<evidence-list>` is a semicolon-separated list of atoms (§2.2). Quote it: `;` ends a shell
  command.
- `--fresh` bypasses the tool-result cache (ADR-061) and re-runs every `tool:` atom.

### 2.2 Evidence Atoms

The parser (`parseEvidenceString`, `packages/contracts/src/evidence-atom-schema.ts:1005-1215`)
accepts these kinds:

| Atom | Meaning |
|------|---------|
| `commit:<sha>` | A commit (7–40 hex chars) |
| `files:<p1,p2,…>` | Files, comma-separated; each is hashed |
| `test-run:<report.json>` | A test runner's JSON report (vitest `--reporter=json`, jest `--json`) |
| `qa-run:<receipt>` | A QA run receipt |
| `tool:<name>` | A tool CLEO runs itself (§2.3) |
| `pr:<number>` | A merged pull request (optionally followed by `state:MERGED`) |
| `ci:<pr>` | Green required CI for a PR (`<n>`, `<component>@<integration>` or `<owner>/<repo>#<n>`; same forms for `pr:`) |
| `ci-run:<…>` | A CI run record |
| `decision:<id>` | A recorded decision |
| `deploy:<…>` | A deployment record |
| `loc-drop:<…>`, `callsite-coverage:<…>` | Engine-migration proofs (tasks labelled `engine-migration`) |
| `satisfies:<taskId>#AC<n>` | Links the evidence to an acceptance criterion |
| `url:<url>` | A URL (soft) |
| `note:<text>` | Free text (soft); a note keeps every character, including `;` |

Stored shapes: `EvidenceAtom` in `packages/contracts/src/task.ts:283` onward (adds the
`override` kind written by the override path).

### 2.3 Tool Names

`tool:<name>` accepts (`packages/core/src/tasks/tool-resolver.ts`):

- **Canonical** (`:53-70`): `test`, `build`, `lint`, `typecheck`, `audit`, `security-scan`,
  `nexus-impact-full`.
- **Legacy aliases** (`:146-178`), mapped to a canonical tool: `pnpm-test`, `npm-test`,
  `yarn-test`, `bun-test`, `vitest`, `jest`, `pytest`, `cargo-test`, `go-test` → `test`;
  `pnpm-build`, `npm-build`, `yarn-build`, `bun-build`, `cargo-build`, `go-build` → `build`;
  `biome`, `eslint`, `prettier`, `ruff`, `clippy` → `lint`; `tsc`, `mypy`, `pyright` →
  `typecheck`; `pnpm-audit`, `npm-audit`, `cargo-audit` → `audit`.
- **Planned** (`:210`): `test-affected` (runs the tests the branch diff touches, from
  `testing.affectedCommand`) and `config-schema`.

The command for each canonical tool is resolved per project from `.cleo/project-context.json`
(`testing.command`, `build.command`, `lint.command`, `typecheck.command`, `audit.command`,
`security-scan.command`), falling back to per-language defaults (`:191-199`).

### 2.4 Gate-to-Evidence Mapping

SSoT: `GATE_EVIDENCE_REQUIREMENTS`, `packages/contracts/src/evidence-atom-schema.ts:579-600`.
A gate is satisfied when ANY one listed combination is fully present.

| Gate | Accepted combinations |
|------|-----------------------|
| `implemented` | `commit`+`files` · `commit`+`note` · `decision`+`files` · `decision`+`note` · `pr`+`files` · `pr`+`note` (deletion-only PR) |
| `testsPassed` | `test-run` · `tool` · `ci` |
| `qaPassed` | `tool` · `ci` · `qa-run` |
| `documented` | `files` · `url` |
| `securityPassed` | `tool` · `note` |
| `cleanupDone` | `note` |
| `nexusImpact` | `tool` · `note` |

A task that touches no code and declares a gate profile label (`profile:ops`, `profile:census`,
`profile:audit`) may also prove `implemented` with `files`+`note` when every `files:` path is a
document (`PROFILE_GATE_EVIDENCE`, same file). A documentation or research task does not owe
`testsPassed` or `qaPassed` (`packages/core/src/tasks/verification-policy.ts:98-157`).

If the atoms do not satisfy the gate, `cleo verify` MUST reject with `E_EVIDENCE_INSUFFICIENT`.
A gate write with no `--evidence` at all is rejected with `E_EVIDENCE_MISSING`
(`packages/core/src/validation/engine-ops.ts:1020-1030`).

---

## 3. Evidence Validation

For each atom the CLI MUST validate before persisting the gate (`validateAtom`,
`packages/core/src/tasks/evidence.ts:462`). Evidence about the repository is checked in the
evidence git root (the execution root), which may differ from the CLEO store root; an unusable
git root fails with `E_EVIDENCE_GIT_ROOT`.

### 3.1 `commit:<sha>`
1. The SHA MUST be 7–40 hex chars.
2. `git cat-file -e <sha>^{commit}` MUST succeed (else "Commit not found in repository").
3. The commit MUST be reachable (`git merge-base --is-ancestor`) from the task branch
   `task/<taskId>` when it exists, else `HEAD`, or from a configured integration branch.
4. Both full and short SHA are recorded.

Failures are `E_EVIDENCE_INVALID` (`evidence.ts:803-900`).

### 3.2 `files:<paths>`
At least one path is required. Each path MUST exist, resolved against a sibling `commit:` atom's
tree first, then the worktree and git refs; a missing path fails with "File does not exist"
(`evidence.ts:1722`). Each file's sha256 is recorded.

### 3.3 `test-run:<path>`
The file MUST exist and parse as a test runner's JSON report with test counts. It is rejected
with `E_EVIDENCE_TESTS_FAILED` when it reports failed tests, a non-zero exit code, zero total
tests, or a suite whose status is neither `passed` nor `skipped` (`evidence.ts:2100-2175`). Its
sha256 and pass count are recorded.

### 3.4 `tool:<name>`
CLEO resolves the command (§2.3) and runs it. Results are cached (ADR-061); `--fresh` re-runs.

| Outcome | Code |
|---------|------|
| Non-zero exit | `E_EVIDENCE_TOOL_FAILED` |
| Ran but provably checked nothing (e.g. `tsc` without `-b` on a references-only tsconfig) | `E_EVIDENCE_TOOL_VACUOUS` |
| Tool not available | `E_EVIDENCE_TOOL_UNAVAILABLE` |
| Timed out | `E_EVIDENCE_TOOL_TIMEOUT` |
| Not runnable yet (e.g. `tool:test` cannot resolve its affected scope; retry) | `E_EVIDENCE_TOOL_BUSY` |
| Started and was killed | `E_EVIDENCE_TOOL_KILLED` |

The recorded atom holds `tool`, `exitCode` and an optional `stdoutTail`.

### 3.5 `url:` and `note:`
Recorded verbatim. They are soft atoms (§5.1).

---

## 4. Persistence and Audit Trail

### 4.1 Persistence

On successful validation the CLI MUST:

1. Load `task.verification` (initialise if null).
2. Set `task.verification.gates[<gate>] = true`.
3. Set `task.verification.evidence[<gate>] = {atoms, capturedAt, capturedBy, override?, …}`.
4. Recompute `task.verification.passed`.
5. Persist the task.
6. Append one line to `.cleo/audit/gates.jsonl`.

If the evidence is insufficient or invalid, the task MUST NOT be modified. A `cleo verify` write
NEVER changes `task.status`; when the write makes every required gate green it returns
`hint: "All gates green. Run: cleo complete <id>"` (`engine-ops.ts:1452-1467`).

### 4.2 `.cleo/audit/gates.jsonl`

Writer: `appendGateAuditLine`, `packages/core/src/tasks/gate-audit.ts`. One JSON line per write,
append-only; new fields MAY be added, existing field semantics MUST NOT change. Record
(`GateAuditRecord`):

```json
{
  "timestamp": "2026-04-17T03:14:15.926Z",
  "taskId": "T832",
  "gate": "implemented",
  "action": "set",
  "evidence": { "atoms": [], "capturedAt": "...", "capturedBy": "..." },
  "agent": "...",
  "sessionId": "...",
  "passed": true,
  "override": false
}
```

`gate` is `"*all*"` for a multi-gate write; `action` is `set | reset | all`; `evidence` is
absent on reset.

### 4.3 `.cleo/audit/force-bypass.jsonl`

Owner-override writes and override refusals append here (`ForceBypassRecord`: the gates.jsonl
fields plus `overrideReason`, `pid`, `command`, and optional `sessionOverrideOrdinal`,
`sharedEvidence`, `sharedAtomWarning`, `workTreeContext`).

---

## 5. Completion Re-Verification

`cleo complete <taskId>` MUST re-verify every hard evidence atom before completing.

### 5.1 Hard vs Soft Evidence

- **Soft** (not re-verified): `note:`, `url:`, and override entries.
- **Hard** (re-verified): every other kind (`isHardAtom`, `packages/core/src/tasks/evidence.ts:4720-4722`).

### 5.2 Re-Verification

For each gate with evidence, each hard atom is re-validated (SHA still reachable, file sha256
unchanged, test-run sha256 unchanged). If ANY hard atom fails, completion MUST reject with
`E_EVIDENCE_STALE`, naming each stale gate and its failures
(`packages/core/src/tasks/complete.ts:1912-1927`). Fix text:

```
Re-capture evidence for the stale gates via 'cleo verify <taskId> --gate <gate> --evidence <updated>'
then retry 'cleo complete <taskId>'. See ADR-051.
```

A non-epic task with no verification record is refused with `E_EVIDENCE_MISSING`
(`complete.ts:1995-2010`). Override evidence is not re-validated at completion.

### 5.3 Error Codes

| Code | When |
|------|------|
| `E_EVIDENCE_MISSING` | A gate write has no evidence; bare `--all`; completing with no verification record |
| `E_EVIDENCE_INSUFFICIENT` | Atoms do not satisfy the gate's minimum (§2.4) |
| `E_EVIDENCE_INVALID` | An atom fails to parse or validate (bad SHA, unreachable commit, missing file, …) |
| `E_EVIDENCE_CONTENT_MISMATCH` | The evidence does not match the task's change (content-intersect check) |
| `E_EVIDENCE_GIT_ROOT` | The evidence git root is unusable |
| `E_EVIDENCE_TESTS_FAILED` | A `test-run:` report shows failures, a non-zero exit or no tests |
| `E_EVIDENCE_TOOL_FAILED` / `_VACUOUS` / `_UNAVAILABLE` / `_TIMEOUT` / `_BUSY` / `_KILLED` | See §3.4 |
| `E_EVIDENCE_STALE` | A hard atom changed between verify and complete |
| `E_CRITICAL_GATE_OVERRIDE_REJECTED` | Override with no hard atom on `implemented` or `testsPassed` (§6) |
| `E_ALREADY_DONE` | Evidence write on a `done` task (§8) |
| `E_FLAG_REMOVED` | `cleo complete --force` / a `force` param (§7) |

These codes have no dedicated numeric exit code in the CLI exit map
(`ERROR_CODE_TO_EXIT`, `packages/cleo/src/dispatch/adapters/cli.ts`). Callers and tests MUST
assert on the string code (`error.codeName`), not the numeric exit.

---

## 6. Owner Override (`CLEO_OWNER_OVERRIDE=1`)

The emergency path is `CLEO_OWNER_OVERRIDE=1` (with `CLEO_OWNER_OVERRIDE_REASON=<reason>`) on
`cleo verify`. It is honoured only for the owner
(`packages/core/src/security/owner-override-authority.ts:1-30`):

1. **Role fence**: refused when `CLEO_AGENT_ROLE` is `worker`, `lead` or `subagent` (at bootstrap
   or since).
2. **Owner-marked session**: the bound session was started with
   `cleo session start --scope global --name <n> --owner` (refused without an interactive
   terminal or with `CLEO_AGENT_ROLE` set).
3. **Owner's terminal**: the override call itself runs on a TTY.

Every refusal is appended to `.cleo/audit/force-bypass.jsonl`.

When honoured:

- The gate is stored with
  `{kind: 'override', reason}` plus any supplied atoms, which are still validated
  (`engine-ops.ts:925-1019`).
- `implemented` and `testsPassed` MUST still carry a hard atom; an override-only or soft-only
  write to them is refused with `E_CRITICAL_GATE_OVERRIDE_REJECTED`. The override may still pass
  `qaPassed`, `documented`, `securityPassed` and `cleanupDone`.
- Overrides are capped per session (T1501).
- `override: true` and `overrideReason` are stored on the gate's evidence, and a line is
  appended to `.cleo/audit/force-bypass.jsonl`.
- A derived multi-gate write (`cleo done`, `cleo verify --auto`) refuses `CLEO_OWNER_OVERRIDE`.

---

## 7. `cleo complete --force` Removal

- The `--force` flag is removed from `cleo complete`
  (`packages/cleo/src/cli/commands/complete.ts`).
- The dispatch case for `tasks.complete` rejects any `force` parameter
  (`packages/cleo/src/dispatch/domains/tasks.ts:502-511`):

```ts
if (params.force !== undefined) {
  return lafsError(
    'E_FLAG_REMOVED',
    '--force has been removed. Use evidence-based `cleo verify --gate … --evidence …` or set CLEO_OWNER_OVERRIDE=1 on verify for emergency bypass (audited). See ADR-051.',
    'complete',
  );
}
```

- The engine function `completeTaskStrict` (`packages/core/src/tasks/complete.ts:1858`) takes no
  `force` option. The audited bypasses it does take are named flags:
  `--override-reason` (pending children), `--waive-ac` + `--waive-reason`,
  `--waive-cancelled-children`, `--waive-depends`, `--acknowledge-risk` (`nexusImpact`).

---

## 8. Migration Rules

### 8.1 Done Tasks

Completed tasks are immutable with respect to verification. `cleo verify <doneTaskId>` in read
mode (and `--reset`) is permitted; an evidence write returns `E_ALREADY_DONE`
(`packages/core/src/validation/engine-ops.ts:512-520`).

### 8.2 In-Flight Verification

Existing boolean gate values remain. Only new writes populate `verification.evidence`.

### 8.3 Callers on the Pre-ADR-051 Protocol

A gate write with no evidence fails with `E_EVIDENCE_MISSING`; the message gives an example and
the fix is `cleo done <id> --plan`:

```
Evidence is required. See ADR-051.
Example: cleo verify <id> --gate implemented --evidence commit:<sha>;files:<path>
Or set CLEO_OWNER_OVERRIDE=1 with CLEO_OWNER_OVERRIDE_REASON=<reason> for emergency bypass (audited).
```

---

## 9. `cleo update --pipeline-stage` Wiring

- The dispatch `update` case forwards every update field, `pipelineStage` included, to
  `taskUpdate` (`packages/cleo/src/dispatch/domains/tasks.ts:495-499`;
  `packages/core/src/tasks/update.ts:1029`).
- `validatePipelineTransition` is authoritative: a backward move raises `E_VALIDATION` (exit 6)
  (`packages/core/src/tasks/pipeline-stage.ts:360`). Epic and child stage-ceiling checks
  remain active.

---

## 10. Lifecycle ↔ pipeline_stage Coupling

`recordStageProgress` (`packages/core/src/lifecycle/index.ts:752`) also writes
`tasks.pipeline_stage` when the recorded stage status is `in_progress` or `completed` (not
`skipped` or `failed`), and only when the new stage is at or after the current one, so lifecycle
initialisation never moves an already-advanced task back (`index.ts:858-886`).

---

## 11. Contract Extensions

`packages/contracts/src/task.ts`:

- `TaskVerification` (`:958-984`) carries `passed`, `round`, `gates`, optional `evidence`
  (`Partial<Record<VerificationGate, GateEvidence>>`), `lastAgent`, `lastUpdated`, `failureLog`,
  `initializedAt`, and `gateResults` (typed acceptance results).
- `GateEvidence` (`:910-938`) carries `atoms`, `capturedAt`, `capturedBy`, optional `scope`
  (task, gate, classification and linked criteria), `override`, `overrideReason`, and `standIn`
  (a recorded post-merge stand-in).
- `EvidenceAtom` (`:283` onward) is a discriminated union on `kind`; new kinds MAY be added
  without breaking readers.

---

## 12. Testing

Evidence and gate tests live beside the code, for example
`packages/core/src/tasks/__tests__/evidence-*.test.ts`,
`packages/core/src/tasks/__tests__/gate-audit.test.ts`,
`packages/core/src/tasks/__tests__/revalidation-cache.test.ts`,
`packages/core/src/tasks/__tests__/tool-resolver.test.ts`, and
`packages/core/src/validation/__tests__/gate-verify-hint.test.ts` (verify never
auto-completes). Tests MUST assert on the string error code.

---

## 13. Security Considerations

- Audit files are append-only. An agent that modifies prior lines is a security violation.
- `CLEO_OWNER_OVERRIDE=1` is a genuine escape hatch for the owner only (§6). Its checks are
  same-OS-user checks: they fence default and accidental agent use, but a process that emulates a
  terminal can pass the TTY check.
- Evidence sha256 hashes prevent the trivial "verify, modify, complete" attack. Commit
  validation checks existence and reachability, not authorship.

---

## 14. Compatibility

- Backward compatible: existing `TaskVerification` records load without errors (`evidence` is
  optional).
- Forward compatible: new atom kinds are added as discriminated-union members.
- Breaking: `cleo complete --force` removal.
