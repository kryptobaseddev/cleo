/**
 * Orchestrator-side worker re-verification gate (T1589 / T1586).
 *
 * Closes lie #4 from HONEST-HANDOFF-2026-04-28.md: predecessor orchestrators
 * trusted subagent self-reports without re-running gates. This module
 * re-validates a worker's claim BEFORE the orchestrator accepts completion.
 *
 * Project-agnostic: uses canonical `tool:test` resolution per ADR-061 so
 * pnpm/npm/cargo/pytest/go all work identically. Git operations go through
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

import { parseEvidence, validateAtom } from '../tasks/evidence.js';

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
   * re-verify always runs `tool:test` regardless of what the worker claimed.
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
}

// ---------------------------------------------------------------------------
// Default implementations (production)
// ---------------------------------------------------------------------------

/**
 * Default `tool:test` runner. Reuses {@link validateAtom} so the same
 * project-context.json resolution + ADR-061 evidence cache applies.
 *
 * @task T1589
 * @adr ADR-061
 */
export async function defaultRunProjectTests(projectRoot: string): Promise<TestRunResult> {
  const parsed = parseEvidence('tool:test');
  const atom = parsed.atoms[0];
  if (!atom) {
    return { ok: false, reason: 'tool:test parse returned no atom' };
  }
  const result = await validateAtom(atom, projectRoot);
  if (result.ok) return { ok: true };
  return { ok: false, reason: result.reason };
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
 * 1. **Test status** — runs `tool:test` (project-resolved per ADR-061) and
 *    compares the exit code against the worker's `selfReportSuccess` claim.
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
  if (report.selfReportSuccess && !testResult.ok) {
    mismatches.push({
      kind: 'tests',
      claimed: 'success',
      actual: `tool:test failed${testResult.reason ? `: ${testResult.reason}` : ''}`,
      reason: 'Worker claimed success but project test command failed.',
    });
  } else if (!report.selfReportSuccess && testResult.ok) {
    // Worker reported failure but tests passed — log as evidence mismatch
    // (still reject because the worker's claim doesn't match observed truth).
    mismatches.push({
      kind: 'tests',
      claimed: 'failure',
      actual: 'tool:test passed',
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
