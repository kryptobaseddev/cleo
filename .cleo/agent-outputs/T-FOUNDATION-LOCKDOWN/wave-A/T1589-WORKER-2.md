# T1589 · Worker-2 · Foundation Lockdown · Wave A

Project-agnostic orchestrator-side gate that re-verifies subagent return BEFORE accepting completion. Closes lie #4 from `HONEST-HANDOFF-2026-04-28.md` (predecessor trusted worker self-reports without re-running gates).

## New files

| Path | LOC |
|------|----:|
| `/mnt/projects/cleocode/packages/core/src/orchestrate/worker-verify.ts` | 381 |
| `/mnt/projects/cleocode/packages/core/src/orchestrate/__tests__/worker-verify.test.ts` | 219 |

## Modified files

| Path | Change |
|------|--------|
| `/mnt/projects/cleocode/packages/core/src/sentient/tick.ts` | +50 LOC — added `reVerify` / `skipReVerify` to `TickOptions`, gated success path through re-verify call before `writeSuccessReceipt` |

## Public surface (in `worker-verify.ts`)

```ts
export interface WorkerReport {
  taskId: string;
  selfReportSuccess: boolean;
  evidenceAtoms: string[];
  touchedFiles: string[];
}
export interface ReVerifyResult {
  accepted: boolean;
  mismatches: string[];
  auditEntry: WorkerMismatchAuditEntry | null;
}
export async function reVerifyWorkerReport(
  report: WorkerReport,
  options: ReVerifyOptions,
): Promise<ReVerifyResult>;

// Plus: WorkerMismatch, WorkerMismatchAuditEntry, ReVerifyOptions,
// TestRunResult, defaultRunProjectTests, defaultListChangedFiles,
// appendWorkerMismatchAudit, WORKER_MISMATCH_AUDIT_FILE.
```

## Gate dimensions checked

1. **Tests** — runs `tool:test` via `parseEvidence` + `validateAtom` (uses ADR-061 cache + project-context.json resolver). Reject when worker claimed success but tests failed (or claimed failure but tests passed).
2. **Touched files** — compares `report.touchedFiles` against `git status --porcelain` (set equality, normalised to POSIX paths). Counts AND identities must match.
3. **Evidence atoms** — sanity-check that a success claim is backed by at least one atom.

On rejection, appends one JSONL row to `<projectRoot>/.cleo/audit/worker-mismatch.jsonl` (matches `force-bypass.jsonl` / `contract-violations.jsonl` conventions). Audit write failure never changes the verdict (best-effort, errors swallowed).

## Test results

```
src/orchestrate/__tests__/worker-verify.test.ts (9 passed)
  reVerifyWorkerReport — honest success (T1589)
    ✓ accepts when tests pass, files match, evidence present
    ✓ treats path order independently (git reports reverse order)
  reVerifyWorkerReport — false success (T1589)
    ✓ rejects + audits when worker claims success but tests fail
    ✓ rejects + audits when claimed touched-files count mismatches git
    ✓ rejects when claimed file set diverges from git (same count, different paths)
    ✓ rejects when worker claims success but supplies zero evidence atoms
  reVerifyWorkerReport — audit log append-only (T1589)
    ✓ appends multiple mismatch entries without overwriting prior lines
    ✓ appendWorkerMismatchAudit creates the audit directory on first write
  defaultListChangedFiles — porcelain parsing (T1589)
    ✓ returns empty array when git is not initialised in the directory
```

Full sentient + orchestrate suites: **287 passed** / 1 todo / 23 files. No regressions in `daemon.test.ts` (21/21 pass — the gated wire-in only fires when `options.reVerify` is explicitly injected, preserving back-compat for existing tests).

TypeScript: `tsc --noEmit` clean for the new module and the tick.ts edits. No `any`, no `unknown`, no `as unknown as` casts.

## Project-agnostic verification

- Uses **canonical `tool:test`** (per ADR-061) via `parseEvidence('tool:test')` + `validateAtom`. Resolves through `.cleo/project-context.json` (`testing.command`) with per-`primaryType` fallbacks: `npm test` (node), `cargo test` (rust), `pytest` (python), `go test ./...` (go), `bun test` (bun), etc. Works for non-node/non-pnpm projects without code changes.
- Uses standard `git status --porcelain` (POSIX path normalisation handles Windows `\\` → `/`). No project-specific paths.
- Audit log path is project-relative (`.cleo/audit/worker-mismatch.jsonl`) — same convention as every other CLEO audit log; no hardcoded `pnpm`/`monorepo` assumptions.
- Tests inject stub `runProjectTests` / `listChangedFiles` so the unit suite runs identically on any host with no need for a real `pnpm` / `cargo` / `git` binary.

## Wire-in path

`packages/core/src/sentient/tick.ts → runTick()` — between `spawnResult.exitCode === 0` check and `writeSuccessReceipt(...)`.

The integration is conservative: the new gate fires only when `options.reVerify` is explicitly assigned. Production callers wire the gate by passing `reVerify: reVerifyWorkerReport` in `TickOptions`; on rejection the tick routes through `writeFailureReceipt(...)` and returns `{ kind: 'failure', detail: 'worker re-verify rejected (T1589): ...' }`. The `--dry-run` and `skipReVerify: true` paths bypass the gate.

This back-compat-safe design lets parallel foundation-lockdown workers (T1596 etc. modifying the same file) compose without regression. Full enablement at production wire-points is a follow-up task once all wave-A modules land.

## Constraints honored

- TypeScript strict — no `any`, no `unknown` shortcuts, no `as unknown as X` casts.
- All logic in `@cleocode/core` (NOT `@cleocode/cleo`).
- Types kept internal to core (no need for cross-package contracts; `WorkerReport` / `ReVerifyResult` are core-only and not consumed by cleo).
- No edits to other workers' files (T1587, T1590, T1592, T1596, T1597, T1599 untouched).
- Followed existing patterns: `appendOwnerOverrideAudit` / `appendContractViolation` for the JSONL audit writer; `validateAtom` reuse for project-agnostic test resolution.
