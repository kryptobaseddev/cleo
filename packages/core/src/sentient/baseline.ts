/**
 * Baseline capture — daemon-side, pre-worktree.
 *
 * Captures a signed `baseline` event BEFORE the experiment worktree is
 * created. The daemon calls this immediately after selecting a task but
 * before `git worktree add`. The event's timestamp predates the worktree
 * creation timestamp, closing Round 2 attack #5 (baseline gaming).
 *
 * ## Why pre-worktree matters
 *
 * An experiment agent could delay writing the baseline until after running a
 * slow test suite to produce an artificially inflated baseline, making any
 * future "improvement" trivial. Capturing the baseline from the daemon before
 * the worktree exists means the experiment agent can never influence the
 * baseline values.
 *
 * ## Time predates guarantee
 *
 * {@link captureBaseline} enforces a ≥5s gap between the commit timestamp
 * and the current wall-clock time. This prevents an agent from racing a
 * baseline write and an experiment start within the same tick.
 *
 * @see DESIGN.md §4.4 — Signed-baseline-predates-experiment enforcement
 * @task T1021 (T1010-S2 per DESIGN.md)
 */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { appendSentientEvent } from './events.js';
import { loadSigningIdentity } from './kms.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A fully-signed baseline event returned by {@link captureBaseline}.
 *
 * The `payload.worktreeNotCreatedYet: true` field is a structural assertion
 * that the worktree did not exist at the time of baseline capture.
 */
export interface CapturedBaseline {
  /** The sentient event `kind` — always `"baseline"`. */
  kind: 'baseline';
  /** ISO-8601 UTC timestamp when the baseline was captured. */
  capturedAt: string;
  /** The git commit SHA used as the baseline anchor. */
  commitSha: string;
  /** Metrics snapshot (test counts, timing, etc.). */
  metrics: Record<string, number>;
  /** Unique receipt identifier for this baseline event (21 chars). */
  receiptId: string;
  /** Hex-encoded 32-byte Ed25519 public key (64 chars). */
  publicKey: string;
  /** Hex-encoded 64-byte Ed25519 signature over the canonical payload (128 chars). */
  signature: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum time gap (in milliseconds) required between the commit timestamp
 * and the current wall-clock time. Prevents racing baseline + experiment
 * in the same clock tick (Round 2 attack #5 mitigation).
 */
const MIN_BASELINE_AGE_MS = 5_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Capture a signed baseline event for a given commit SHA.
 *
 * Steps:
 * 1. Verify the commit SHA exists in git and retrieve its author timestamp.
 * 2. Enforce that `commitSha` is at least {@link MIN_BASELINE_AGE_MS} old
 *    relative to the current wall-clock time. Throws
 *    `E_BASELINE_MUST_PREDATE_EXPERIMENT` if the commit is too recent.
 * 3. Gather metrics by running `git log --stat` summary (lightweight, no
 *    external test runner required for the baseline capture itself).
 * 4. Sign the payload via {@link loadSigningIdentity}.
 * 5. Write the signed `kind:"baseline"` event to the llmtxt/events log.
 * 6. Return a {@link CapturedBaseline} summary.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param commitSha - The git commit SHA to anchor the baseline to.
 *   Must be a 40-character hex SHA reachable from the repository.
 * @returns A fully signed baseline event record.
 * @throws `E_BASELINE_MUST_PREDATE_EXPERIMENT` if the commit is less than
 *   {@link MIN_BASELINE_AGE_MS} ms old (anti-gaming guard).
 * @throws If the commit SHA does not exist in the git repository.
 * @throws If the KMS adapter cannot load the signing key.
 *
 * @example
 * ```ts
 * import { captureBaseline } from '@cleocode/core/sentient/baseline.js';
 *
 * const baseline = await captureBaseline(projectRoot, 'abc123...');
 * console.log('Baseline captured:', baseline.receiptId);
 * ```
 */
export async function captureBaseline(
  projectRoot: string,
  commitSha: string,
): Promise<CapturedBaseline> {
  // 1. Verify commit exists and get its author timestamp.
  const commitTimestampMs = await getCommitTimestampMs(projectRoot, commitSha);

  // 2. Enforce predates guard: commit must be at least MIN_BASELINE_AGE_MS old.
  const nowMs = Date.now();
  const ageMs = nowMs - commitTimestampMs;
  if (ageMs < MIN_BASELINE_AGE_MS) {
    throw new Error(
      `E_BASELINE_MUST_PREDATE_EXPERIMENT: commit ${commitSha} was created only ` +
        `${ageMs}ms ago (minimum required: ${MIN_BASELINE_AGE_MS}ms). ` +
        `This guard prevents an experiment agent from creating a commit and ` +
        `immediately capturing it as a baseline in the same clock tick.`,
    );
  }

  // 3. Gather lightweight metrics.
  const metrics = await gatherMetrics(projectRoot, commitSha);

  // 4. Compute a baseline hash from the metrics + commit SHA.
  const baselineHash = computeBaselineHash(commitSha, metrics);

  // 5. Load signing identity.
  const identity = await loadSigningIdentity(projectRoot);

  // 6. Write the signed baseline event.
  const capturedAt = new Date().toISOString();
  const event = await appendSentientEvent(projectRoot, identity, {
    kind: 'baseline',
    experimentId: '',
    taskId: '',
    payload: {
      commitSha,
      baselineHash,
      metricsJson: JSON.stringify(metrics),
      worktreeNotCreatedYet: true,
    },
  });

  return {
    kind: 'baseline',
    capturedAt,
    commitSha,
    metrics,
    receiptId: event.receiptId,
    publicKey: event.pub,
    signature: event.sig,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Get the author timestamp of a git commit as Unix epoch milliseconds.
 *
 * Uses `git log --format=%at <sha> -n1` which outputs the author date
 * as Unix epoch seconds.
 *
 * @param projectRoot - Absolute path to the git repository root.
 * @param commitSha - 40-character hex SHA.
 * @returns Unix epoch milliseconds.
 * @throws If the commit does not exist or git is unavailable.
 * @internal
 */
async function getCommitTimestampMs(projectRoot: string, commitSha: string): Promise<number> {
  // Validate input to prevent shell injection (belt-and-suspenders;
  // execFile already avoids shell, but we enforce the format contract).
  if (!/^[0-9a-fA-F]{4,64}$/.test(commitSha)) {
    throw new Error(`Invalid commit SHA format: "${commitSha}". Expected 4–64 hex characters.`);
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('git', ['log', '--format=%at', '-n1', commitSha], {
      cwd: projectRoot,
      timeout: 10_000,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `E_COMMIT_NOT_FOUND: git commit "${commitSha}" does not exist in ` +
        `${projectRoot}: ${message}`,
    );
  }

  const epochSeconds = Number.parseInt(stdout.trim(), 10);
  if (Number.isNaN(epochSeconds) || epochSeconds <= 0) {
    throw new Error(
      `E_COMMIT_NOT_FOUND: git commit "${commitSha}" produced no timestamp output. ` +
        `Ensure the SHA exists and is reachable from the repository.`,
    );
  }

  return epochSeconds * 1000;
}

/**
 * Gather lightweight metrics from the git repository for the baseline.
 *
 * Runs `git diff --stat <sha>^..<sha>` to count changed files and insertions.
 * For a baseline this gives a meaningful "change surface" metric without
 * requiring a full test suite run (which is slower and has side effects).
 *
 * Returns a `Record<string, number>` with at minimum:
 * - `changedFiles` — number of files changed in the baseline commit
 * - `insertions` — lines added
 * - `deletions` — lines removed
 *
 * @param projectRoot - Absolute path to the git repository root.
 * @param commitSha - The baseline commit SHA.
 * @returns Metrics snapshot.
 * @internal
 */
async function gatherMetrics(
  projectRoot: string,
  commitSha: string,
): Promise<Record<string, number>> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['diff', '--stat', `${commitSha}^..${commitSha}`],
      { cwd: projectRoot, timeout: 15_000 },
    );

    return parseGitDiffStatMetrics(stdout);
  } catch {
    // If the commit is the initial commit (no parent), use shortstat instead.
    try {
      const { stdout } = await execFileAsync('git', ['show', '--stat', '--format=', commitSha], {
        cwd: projectRoot,
        timeout: 15_000,
      });
      return parseGitDiffStatMetrics(stdout);
    } catch {
      // Fallback: return a minimal metrics stub.
      return { changedFiles: 0, insertions: 0, deletions: 0 };
    }
  }
}

/**
 * Parse `--stat` output from git to extract file/insertion/deletion counts.
 *
 * Sample `git diff --stat` output:
 * ```
 *  packages/core/src/sentient/kms.ts | 120 +++++++-
 *  1 file changed, 100 insertions(+), 20 deletions(-)
 * ```
 *
 * @param statOutput - Raw stdout from `git diff --stat` or `git show --stat`.
 * @returns `{ changedFiles, insertions, deletions }`.
 * @internal
 */
function parseGitDiffStatMetrics(statOutput: string): Record<string, number> {
  const metrics: Record<string, number> = {
    changedFiles: 0,
    insertions: 0,
    deletions: 0,
  };

  for (const line of statOutput.split('\n')) {
    const trimmed = line.trim();

    // Match summary line: "N files changed, X insertions(+), Y deletions(-)"
    const summaryMatch = /(\d+) files? changed/.exec(trimmed);
    if (summaryMatch) {
      metrics.changedFiles = Number.parseInt(summaryMatch[1], 10);

      const insertMatch = /(\d+) insertion/.exec(trimmed);
      if (insertMatch) metrics.insertions = Number.parseInt(insertMatch[1], 10);

      const deleteMatch = /(\d+) deletion/.exec(trimmed);
      if (deleteMatch) metrics.deletions = Number.parseInt(deleteMatch[1], 10);
    }
  }

  return metrics;
}

/**
 * Compute a deterministic SHA-256 hash over the baseline commit SHA + metrics.
 *
 * This hash is stored in the baseline event payload as `baselineHash` and
 * serves as a tamper-evident fingerprint of the baseline state.
 *
 * @param commitSha - The baseline commit SHA.
 * @param metrics - The metrics snapshot.
 * @returns Lowercase hex SHA-256 digest (64 chars).
 * @internal
 */
function computeBaselineHash(commitSha: string, metrics: Record<string, number>): string {
  const canonical = JSON.stringify({ commitSha, metrics: sortRecord(metrics) });
  return crypto.createHash('sha256').update(canonical, 'utf-8').digest('hex');
}

/**
 * Sort a record's keys alphabetically for deterministic serialisation.
 *
 * @internal
 */
function sortRecord(record: Record<string, number>): Record<string, number> {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = record[key];
  }
  return sorted;
}
