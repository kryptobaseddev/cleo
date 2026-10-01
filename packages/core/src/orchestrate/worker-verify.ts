/**
 * Orchestrator-side worker re-verification gate (T1589 / T1586).
 *
 * Closes lie #4 from HONEST-HANDOFF-2026-04-28.md: predecessor orchestrators
 * trusted subagent self-reports without re-running gates. This module
 * re-validates a worker's claim BEFORE the orchestrator accepts completion.
 *
 * Project-agnostic: uses canonical `tool:test` resolution per ADR-061 so
 * pnpm/npm/cargo/pytest/go all work identically. The test re-run is scoped
 * (T12962): `tool:test-affected` for the worker's change first, the full
 * `tool:test` only when affected planning refuses, and both go through the
 * ADR-061 cache, so a result the worker already recorded for the same tree is
 * reused instead of re-run. Git operations go through
 * the standard `git` CLI. The audit log lives at the project's
 * `.cleo/audit/worker-mismatch.jsonl` (matches `force-bypass.jsonl` /
 * `contract-violations.jsonl` conventions).
 *
 * Wire-in: `packages/core/src/sentient/tick.ts` calls {@link reVerifyWorkerReport}
 * after `spawnResult.exitCode === 0` and before `writeSuccessReceipt`. A
 * rejection downgrades the success path to the failure-receipt path so the
 * task is not silently marked complete on false-success worker output.
 *
 * @task T1589
 * @epic T1586
 * @adr ADR-051 (evidence-based gate ritual)
 * @adr ADR-061 (project-agnostic tool resolution)
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { type AtomValidation, parseEvidence, validateAtom } from '../tasks/evidence.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Self-reported outcome from a subagent worker. The orchestrator MUST NOT
 * trust any field here without re-verification through {@link reVerifyWorkerReport}.
 *
 * @task T1589
 */
export interface WorkerReport {
  /** Task ID the worker claims to have completed. */
  taskId: string;
  /** Worker's claimed success / failure outcome. */
  selfReportSuccess: boolean;
  /**
   * Evidence atoms the worker captured (CLI `--evidence` syntax, e.g.
   * `tool:test`, `commit:<sha>;files:a.ts,b.ts`). Used for cross-checking;
   * re-verify always re-runs the tests (affected scope first, T12962)
   * regardless of what the worker claimed.
   */
  evidenceAtoms: string[];
  /**
   * Files the worker claims it touched, relative to project root. Compared
   * against `git status --porcelain` since the last commit on the working
   * branch.
   */
  touchedFiles: string[];
}

/**
 * One mismatch between the worker's self-report and the re-verified ground
 * truth. Lives inside {@link WorkerMismatchAuditEntry.mismatches}.
 *
 * @task T1589
 */
export interface WorkerMismatch {
  /** Which dimension failed: tests, files, or evidence. */
  kind: 'tests' | 'files' | 'evidence';
  /** What the worker claimed. */
  claimed: string;
  /** What re-verification observed. */
  actual: string;
  /** Short human-readable reason. */
  reason: string;
}

/**
 * Append-only audit row written to `.cleo/audit/worker-mismatch.jsonl` when
 * {@link reVerifyWorkerReport} rejects. Each line is standalone JSON (same
 * convention as `force-bypass.jsonl`).
 *
 * @task T1589
 */
export interface WorkerMismatchAuditEntry {
  /** ISO-8601 timestamp the mismatch was detected. */
  timestamp: string;
  /** Task the worker claimed to have completed. */
  taskId: string;
  /** Worker's claimed success boolean (echoed for audit). */
  claimedSuccess: boolean;
  /** Files the worker claimed it touched. */
  claimedFiles: string[];
  /** Files git reports as modified (porcelain --short). */
  actualFiles: string[];
  /** Per-dimension mismatch records. */
  mismatches: WorkerMismatch[];
}

/**
 * Result of {@link reVerifyWorkerReport}. The orchestrator MUST treat
 * `accepted: false` as a failure and route the task into the retry/backoff
 * path (e.g. `writeFailureReceipt` in the sentient tick loop).
 *
 * @task T1589
 */
export interface ReVerifyResult {
  /** True only when every re-verified dimension matches the worker's claim. */
  accepted: boolean;
  /** Human-readable mismatch summaries (one per failed dimension). */
  mismatches: string[];
  /** Audit row written when `accepted === false`; `null` on acceptance. */
  auditEntry: WorkerMismatchAuditEntry | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Project-relative audit log path. Mirrors `.cleo/audit/force-bypass.jsonl`. */
export const WORKER_MISMATCH_AUDIT_FILE = '.cleo/audit/worker-mismatch.jsonl';

// ---------------------------------------------------------------------------
// Options (testability seam)
// ---------------------------------------------------------------------------

/**
 * Options for {@link reVerifyWorkerReport}. All fields except `projectRoot`
 * are injection seams used by unit tests to avoid spawning real subprocesses.
 *
 * @task T1589
 */
export interface ReVerifyOptions {
  /** Absolute path to the project root (where `.cleo/` and `.git/` live). */
  projectRoot: string;
  /**
   * Override the default `tool:test` runner. Returns `{ ok: true }` when the
   * project test command exits 0, `{ ok: false, reason }` otherwise. Tests
   * inject a stub here; production calls {@link defaultRunProjectTests}.
   */
  runProjectTests?: (projectRoot: string) => Promise<TestRunResult>;
  /**
   * Override the default `git status --porcelain` reader. Tests inject a
   * stub. Production calls {@link defaultListChangedFiles}.
   */
  listChangedFiles?: (projectRoot: string) => Promise<string[]>;
}

/** Outcome of running the project's canonical test command. */
export interface TestRunResult {
  ok: boolean;
  reason?: string;
  /**
   * Which run produced the verdict: `affected` (`tool:test-affected`) or
   * `full` (`tool:test`). Absent from injected stubs.
   *
   * @task T12962
   */
  scope?: 'affected' | 'full';
}

/**
 * Injection seam for {@link defaultRunProjectTests}: validates one evidence
 * atom string (e.g. `tool:test-affected`). Production uses {@link validateAtom}.
 *
 * @task T12962
 */
export type ValidateToolAtom = (atom: string, projectRoot: string) => Promise<AtomValidation>;

/**
 * Refusal codes from affected-scope PLANNING (no template, no default branch,
 * a workspace-wide change, an empty or unresolvable scope). Any other failure
 * of `tool:test-affected` means the affected tests ran and failed.
 */
const AFFECTED_PLAN_REFUSALS: ReadonlySet<string> = new Set([
  'E_EVIDENCE_TOOL_UNAVAILABLE',
  'E_EVIDENCE_INSUFFICIENT',
]);

// ---------------------------------------------------------------------------
// Default implementations (production)
// ---------------------------------------------------------------------------

/** Production {@link ValidateToolAtom}: parse one atom and run {@link validateAtom}. */
const validateToolAtom: ValidateToolAtom = async (atomText, projectRoot) => {
  const atom = parseEvidence(atomText).atoms[0];
  if (!atom) {
    return {
      ok: false,
      codeName: 'E_EVIDENCE_INVALID',
      reason: `${atomText} parse returned no atom`,
    };
  }
  return validateAtom(atom, projectRoot);
};

/**
 * Default test runner for worker re-verification (T1589, scoped by T12962).
 *
 * 1. `tool:test-affected` — the packages the worker's branch diff touches plus
 *    their dependents.
 * 2. `tool:test` — only when affected planning REFUSES (no
 *    `testing.affectedCommand`, no default branch, a root-config change, an
 *    empty or unresolvable scope). A failing affected run is the verdict; it
 *    never escalates to the full suite.
 *
 * Both atoms run through {@link validateAtom}, so project-context resolution
 * and the ADR-061 cache apply: a result the worker already recorded for the
 * same tree is reused, not re-run. This used to run a full `tool:test` for
 * every worker exit, whatever the worker claimed.
 *
 * @param projectRoot - Project root the worker ran against.
 * @param validate - Atom validator; tests inject a stub.
 * @returns The verdict and which scope produced it.
 *
 * @task T1589
 * @task T12962
 * @adr ADR-061
 */
export async function defaultRunProjectTests(
  projectRoot: string,
  validate: ValidateToolAtom = validateToolAtom,
): Promise<TestRunResult> {
  const affected = await validate('tool:test-affected', projectRoot);
  if (affected.ok) return { ok: true, scope: 'affected' };
  if (!AFFECTED_PLAN_REFUSALS.has(affected.codeName)) {
    return { ok: false, reason: affected.reason, scope: 'affected' };
  }
  const full = await validate('tool:test', projectRoot);
  if (full.ok) return { ok: true, scope: 'full' };
  return { ok: false, reason: full.reason, scope: 'full' };
}

/**
 * Default git-status reader. Returns the list of paths reported by
 * `git status --porcelain` since the last commit. Used to fact-check the
 * worker's `touchedFiles` claim.
 *
 * @task T1589
 */
export async function defaultListChangedFiles(projectRoot: string): Promise<string[]> {
  return new Promise<string[]>((resolve) => {
    let out = '';
    const child = spawn('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf-8');
    });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const files = out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          // Porcelain format: "XY path" — strip the 2-char status prefix.
          // Renames have form "XY old -> new"; we keep the new path only.
          const stripped = line.length > 3 ? line.slice(3).trim() : line;
          const arrow = stripped.indexOf(' -> ');
          return arrow >= 0 ? stripped.slice(arrow + 4) : stripped;
        });
      resolve(files);
    });
  });
}

// ---------------------------------------------------------------------------
// Core re-verify
// ---------------------------------------------------------------------------

/**
 * Re-verify a subagent worker's self-report against ground truth.
 *
 * Performs three independent checks and rejects on any hard-evidence
 * mismatch:
 *
 * 1. **Test status** — runs the affected tests, or the full `tool:test` when
 *    affected planning refuses (project-resolved per ADR-061), and compares the exit code against the worker's `selfReportSuccess` claim.
 *    Worker says success but tests fail → reject.
 * 2. **Touched files** — compares `touchedFiles` against `git status
 *    --porcelain`. Sets must match exactly (order-independent). Counts
 *    matter: worker says 3 but git shows 5 → reject.
 * 3. **Evidence atoms** — sanity-check that the worker actually captured
 *    evidence (non-empty list when claiming success). Does NOT re-validate
 *    every atom (that's `revalidateEvidence`'s job at `cleo complete`).
 *
 * On rejection, writes one append-only line to `.cleo/audit/worker-mismatch.jsonl`
 * with the full claimed-vs-actual diff. The audit write is best-effort; an
 * error there does not change the rejection verdict.
 *
 * @param report - The worker's self-report (untrusted input).
 * @param options - Project root + injectable test/git seams.
 * @returns Acceptance verdict + machine-readable mismatch detail.
 *
 * @task T1589
 * @epic T1586
 *
 * @example
 * ```ts
 * const result = await reVerifyWorkerReport(
 *   { taskId: 'T123', selfReportSuccess: true,
 *     evidenceAtoms: ['tool:test'], touchedFiles: ['src/a.ts'] },
 *   { projectRoot: '/path/to/project' },
 * );
 * if (!result.accepted) throw new Error(result.mismatches.join('; '));
 * ```
 */
export async function reVerifyWorkerReport(
  report: WorkerReport,
  options: ReVerifyOptions,
): Promise<ReVerifyResult> {
  const runTests = options.runProjectTests ?? defaultRunProjectTests;
  const listFiles = options.listChangedFiles ?? defaultListChangedFiles;

  const mismatches: WorkerMismatch[] = [];

  // -- 1. Test status check ------------------------------------------------
  const testResult = await runTests(options.projectRoot);
  const testAtom = testResult.scope === 'affected' ? 'tool:test-affected' : 'tool:test';
  if (report.selfReportSuccess && !testResult.ok) {
    mismatches.push({
      kind: 'tests',
      claimed: 'success',
      actual: `${testAtom} failed${testResult.reason ? `: ${testResult.reason}` : ''}`,
      reason: 'Worker claimed success but project test command failed.',
    });
  } else if (!report.selfReportSuccess && testResult.ok) {
    // Worker reported failure but tests passed — log as evidence mismatch
    // (still reject because the worker's claim doesn't match observed truth).
    mismatches.push({
      kind: 'tests',
      claimed: 'failure',
      actual: `${testAtom} passed`,
      reason: 'Worker claimed failure but project test command exited 0.',
    });
  }

  // -- 2. Touched-files check ----------------------------------------------
  const actualFiles = await listFiles(options.projectRoot);
  const fileMismatch = compareFileSets(report.touchedFiles, actualFiles);
  if (fileMismatch !== null) {
    mismatches.push(fileMismatch);
  }

  // -- 3. Evidence atom sanity check ---------------------------------------
  if (report.selfReportSuccess && report.evidenceAtoms.length === 0) {
    mismatches.push({
      kind: 'evidence',
      claimed: 'success',
      actual: 'no evidence atoms',
      reason: 'Worker claimed success but supplied zero evidence atoms.',
    });
  }

  if (mismatches.length === 0) {
    return { accepted: true, mismatches: [], auditEntry: null };
  }

  // -- Build + write audit row --------------------------------------------
  const auditEntry: WorkerMismatchAuditEntry = {
    timestamp: new Date().toISOString(),
    taskId: report.taskId,
    claimedSuccess: report.selfReportSuccess,
    claimedFiles: [...report.touchedFiles].sort(),
    actualFiles: [...actualFiles].sort(),
    mismatches,
  };
  appendWorkerMismatchAudit(options.projectRoot, auditEntry);

  return {
    accepted: false,
    mismatches: mismatches.map((m) => `${m.kind}: ${m.reason}`),
    auditEntry,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compare two file lists as sets. Returns `null` when they match, otherwise
 * a {@link WorkerMismatch} describing the missing/extra paths.
 */
function compareFileSets(claimed: string[], actual: string[]): WorkerMismatch | null {
  // T12080: an EMPTY claim means "no claim was made", not "the worker claimed
  // it touched nothing".
  //
  // The spawn contract gives a worker exactly one return channel — an exit code
  // — so `runTick` has no way to learn which files it touched and passes
  // `touchedFiles: []`. Comparing that against `git status --porcelain` then
  // mismatched on size (0 vs N) on EVERY run: after `cleo init` the working
  // tree is never clean, because CLEO's own scaffolding (`.cleo/`, `AGENTS.md`,
  // `.worktreeinclude`, …) is untracked. `runTick` was therefore structurally
  // incapable of returning `success` — every correct worker was rejected,
  // three rejections marked the task stuck, and five stuck tasks self-paused
  // the loop.
  //
  // Worse, it inverted the intent: a worker that follows CLEO's own evidence
  // protocol COMMITS its work (ADR-051 wants a `commit:<sha>` atom), which
  // leaves those paths out of `git status` entirely. The check punished exactly
  // the behaviour the protocol requires.
  //
  // Callers that DO supply a claim still get the full comparison, so the
  // anti-fabrication control is preserved wherever it can actually work.
  if (claimed.length === 0) return null;

  const claimedSet = new Set(claimed.map(normalizePath));
  const actualSet = new Set(actual.map(normalizePath));
  if (claimedSet.size !== actualSet.size) {
    return {
      kind: 'files',
      claimed: `${claimed.length} files: ${[...claimedSet].sort().join(',')}`,
      actual: `${actual.length} files: ${[...actualSet].sort().join(',')}`,
      reason: `Worker claimed ${claimed.length} touched files, git reports ${actual.length}.`,
    };
  }
  for (const path of claimedSet) {
    if (!actualSet.has(path)) {
      return {
        kind: 'files',
        claimed: [...claimedSet].sort().join(','),
        actual: [...actualSet].sort().join(','),
        reason: `File set differs (claimed but not in git status): ${path}`,
      };
    }
  }
  return null;
}

/**
 * Normalize a path for set comparison: strip leading `./`, collapse `\\` to
 * `/`. Production agents and git both report POSIX paths, but tests
 * sometimes synthesise mixed forms.
 */
function normalizePath(path: string): string {
  return path.replace(/^\.\//, '').replace(/\\/g, '/');
}

/**
 * Append one {@link WorkerMismatchAuditEntry} to `.cleo/audit/worker-mismatch.jsonl`.
 *
 * Errors are swallowed: an audit-write failure must never change the
 * rejection verdict (matches `appendOwnerOverrideAudit` /
 * `appendContractViolation`).
 *
 * @internal
 */
export function appendWorkerMismatchAudit(
  projectRoot: string,
  entry: WorkerMismatchAuditEntry,
): void {
  try {
    const filePath = join(projectRoot, WORKER_MISMATCH_AUDIT_FILE);
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8' });
  } catch {
    // non-fatal — audit must not block the rejection path
  }
}
