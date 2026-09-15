/**
 * Validate spawn readiness — unified pre-flight hygiene runner (T10451).
 *
 * Runs all 3 gates in parallel:
 *   1. Changeset lint (via scripts/lint-changesets.mjs)
 *   2. Changelog drift (CHANGELOG.md has current version header)
 *   3. Worktree location (cwd matches expected worktree path)
 *
 * The result is a VALUE, not a side effect (gh#1366). `runSpawnReadinessHygieneCli`
 * returns the structured result and additionally sets `process.exitCode` for the
 * bare `cleo hygiene` surface; it never calls `process.exit`, so every caller
 * MUST branch on the returned value. The previous contract — report failure by
 * setting `process.exitCode` and returning normally — read as "exits on failure"
 * to its caller in `release.ts`, which therefore ran on past a failed gate.
 *
 * @task T10451
 * @task gh#1366 — readiness result is a value; envelope and exit code agree
 * @task gh#1367 — a timeout and a validation failure are different facts
 * @saga T10431
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Severity level for a gate result. */
type Severity = 'error' | 'warn';

/**
 * Why a gate failed.
 *
 * Exists so a timeout is never reported as a validation failure (gh#1367). The
 * two facts imply different remedies: `validation` means "the checked artifact
 * is wrong", `timeout` means "we never finished checking it". Collapsing them
 * into one message told operators to repair changesets that were all valid.
 */
export type HygieneGateFailureReason = 'validation' | 'timeout' | 'not-found' | 'io-error';

/** Result from a single hygiene gate. */
export interface HygieneGateResult {
  /** Gate name. */
  name: string;
  /** Whether the gate passed. */
  passed: boolean;
  /** Human-readable message. */
  message: string;
  /** Severity if failed. */
  severity: Severity;
  /** Why the gate failed. Absent when `passed` is true. */
  reason?: HygieneGateFailureReason;
}

/** Overall result from the spawn-readiness check. */
export interface SpawnReadinessResult {
  /** Per-gate results. */
  gates: HygieneGateResult[];
  /** True only if ALL gates passed, regardless of severity. */
  allPassed: boolean;
  /**
   * True when at least one gate of severity `'error'` failed.
   *
   * This — not `allPassed` — is what a caller blocks on: a failed `'warn'` gate
   * is informational and must not stop a release.
   */
  hasBlockingFailure: boolean;
  /** Names of the gates that failed at severity `'error'`. */
  blockingGates: string[];
  /** ISO timestamp of the check. */
  checkedAt: string;
}

// ============================================================================
// Changeset lint bound (gh#1367)
// ============================================================================

/**
 * Wall-clock bound for the changeset lint subprocess.
 *
 * Deliberately left at 10 s. gh#1367 argued for raising it from a measurement of
 * 91,061 ms over 275 entries, concluding the gate "is expected to fail on every
 * invocation, on every machine, indefinitely". That conclusion does not survive
 * re-measurement: the 91 s was taken while the repo lived on an ntfs-3g FUSE
 * mount, and it measured the filesystem, not this script. Re-measured
 * 2026-09-14 over 315 entries — MORE entries than the original run:
 *
 *   btrfs (canonical /home checkout)      0.54 s
 *   GitHub Actions runner                 1.60 s
 *   ntfs-3g mount, cold page cache      346.69 s
 *
 * On the two environments that actually run this gate, 10 s is 6–18x of
 * HEADROOM, not 9x of overrun. Widening the bound to accommodate a number we
 * can no longer reproduce would spend a real signal: at 10 s, a future timeout
 * means a genuine hang rather than a slow disk, which is exactly when the
 * operator most needs to be told the truth about it.
 *
 * The per-entry cost is not the driver either — parsing is ~0.21 ms/entry, so
 * even 10,000 changesets add ~2 s. Runtime here is dominated by module loading,
 * which is why `lint-changesets.mjs` imports the deep changesets module instead
 * of the core barrel.
 *
 * `CLEO_CHANGESET_LINT_TIMEOUT_MS` is the escape hatch for an environment
 * genuinely slower than both measurements above, so a degraded filesystem needs
 * a variable rather than a source edit.
 */
export const DEFAULT_CHANGESET_LINT_TIMEOUT_MS = 10_000;

/** Environment variable that overrides {@link DEFAULT_CHANGESET_LINT_TIMEOUT_MS}. */
export const CHANGESET_LINT_TIMEOUT_ENV = 'CLEO_CHANGESET_LINT_TIMEOUT_MS';

/**
 * Resolve the changeset-lint timeout from the environment.
 *
 * An invalid override is REJECTED rather than silently replaced by the default:
 * a bound that quietly ignores what the operator set is how a gate ends up
 * measuring something nobody asked for.
 *
 * @param env - Environment to read (default: `process.env`).
 * @returns The resolved bound, or an error message when the override is invalid.
 */
export function resolveChangesetLintTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; ms: number } | { ok: false; message: string } {
  const raw = env[CHANGESET_LINT_TIMEOUT_ENV];
  if (raw === undefined || raw.trim() === '') {
    return { ok: true, ms: DEFAULT_CHANGESET_LINT_TIMEOUT_MS };
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      ok: false,
      message:
        `${CHANGESET_LINT_TIMEOUT_ENV}="${raw}" is not a positive integer number of ` +
        `milliseconds. Unset it to use the default of ${DEFAULT_CHANGESET_LINT_TIMEOUT_MS} ms.`,
    };
  }
  return { ok: true, ms: parsed };
}

// ============================================================================
// Individual gates
// ============================================================================

/**
 * Run the changeset lint gate.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param env - Environment used to resolve the timeout bound.
 * @returns The gate result, carrying a `reason` that distinguishes a timeout
 *          from a genuine validation failure (gh#1367).
 */
function runChangesetLintGate(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): HygieneGateResult {
  const scriptPath = join(projectRoot, 'scripts', 'lint-changesets.mjs');
  if (!existsSync(scriptPath)) {
    return {
      name: 'changeset-lint',
      passed: false,
      message: `lint-changesets.mjs not found at ${scriptPath}`,
      severity: 'error',
      reason: 'not-found',
    };
  }

  const bound = resolveChangesetLintTimeoutMs(env);
  if (!bound.ok) {
    return {
      name: 'changeset-lint',
      passed: false,
      message: `Changeset lint not run: ${bound.message}`,
      severity: 'error',
      reason: 'io-error',
    };
  }

  try {
    execSync(`node "${scriptPath}"`, {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: bound.ms,
    });
    return {
      name: 'changeset-lint',
      passed: true,
      message: 'All changesets well-formed.',
      severity: 'error',
    };
  } catch (err) {
    const e = err as { code?: string; signal?: string; stderr?: string; message?: string };

    // Measured shape of an execSync timeout (node 22): code='ETIMEDOUT',
    // signal='SIGTERM', status=null. A real lint failure carries a numeric
    // `status` and no signal, so the two never collide.
    if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') {
      return {
        name: 'changeset-lint',
        passed: false,
        message:
          `Changeset lint did not COMPLETE within ${bound.ms} ms — this is a timeout, ` +
          'NOT a changeset validation failure. No entry was found to be malformed; the ' +
          'check never finished. Run `node scripts/lint-changesets.mjs` directly to see ' +
          `the real result, or raise ${CHANGESET_LINT_TIMEOUT_ENV}.`,
        severity: 'error',
        reason: 'timeout',
      };
    }

    const stderr = e.stderr || e.message || String(err);
    return {
      name: 'changeset-lint',
      passed: false,
      message: `Changeset lint failed: ${stderr}`,
      severity: 'error',
      reason: 'validation',
    };
  }
}

/** Run the changelog drift gate. */
function runChangelogDriftGate(projectRoot: string): HygieneGateResult {
  const changelogPath = join(projectRoot, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) {
    return {
      name: 'changelog-drift',
      passed: false,
      message: `CHANGELOG.md not found at ${changelogPath}`,
      severity: 'error',
      reason: 'not-found',
    };
  }
  try {
    const head = execSync('head -n 5 CHANGELOG.md', {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 5_000,
    });
    const hasHeader = /^## \[/m.test(head);
    if (hasHeader) {
      return {
        name: 'changelog-drift',
        passed: true,
        message: 'CHANGELOG.md has valid version header.',
        severity: 'error',
      };
    }
    return {
      name: 'changelog-drift',
      passed: false,
      message: 'CHANGELOG.md missing version header (expected ## [YYYY.MM.PATCH]).',
      severity: 'error',
      reason: 'validation',
    };
  } catch (err) {
    const e = err as { code?: string; signal?: string };
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM';
    return {
      name: 'changelog-drift',
      passed: false,
      message: timedOut
        ? 'Reading CHANGELOG.md timed out — the gate could not complete, which is not the same as a missing version header.'
        : `Failed to read CHANGELOG.md: ${message}`,
      severity: 'error',
      reason: timedOut ? 'timeout' : 'io-error',
    };
  }
}

/** Run the worktree location gate. */
function runWorktreeLocationGate(expectedPath?: string): HygieneGateResult {
  if (!expectedPath) {
    return {
      name: 'worktree-location',
      passed: true,
      message: 'No worktree path provided — skipping location check.',
      severity: 'warn',
    };
  }
  try {
    const cwd = execSync('pwd', { encoding: 'utf-8', timeout: 5_000 }).trim();
    if (cwd === expectedPath || cwd.includes(expectedPath)) {
      return {
        name: 'worktree-location',
        passed: true,
        message: `cwd matches worktree (${cwd}).`,
        severity: 'error',
      };
    }
    return {
      name: 'worktree-location',
      passed: false,
      message: `cwd mismatch: expected ${expectedPath}, got ${cwd}`,
      severity: 'error',
      reason: 'validation',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: 'worktree-location',
      passed: false,
      message: `Failed to check cwd: ${message}`,
      severity: 'error',
      reason: 'io-error',
    };
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Run the full spawn-readiness hygiene check.
 *
 * @param projectRoot - Absolute path to project root (default: process.cwd()).
 * @param worktreePath - Expected worktree path (optional).
 * @returns Structured result with per-gate details.
 */
export async function runSpawnReadinessHygiene(
  projectRoot: string = process.cwd(), // CWD-OK: public API default — caller passes explicit root when invoked from non-cwd context
  worktreePath?: string,
): Promise<SpawnReadinessResult> {
  const gates = await Promise.all([
    runChangesetLintGate(projectRoot),
    runChangelogDriftGate(projectRoot),
    runWorktreeLocationGate(worktreePath),
  ]);

  const blockingGates = gates.filter((g) => !g.passed && g.severity === 'error').map((g) => g.name);

  return {
    gates,
    allPassed: gates.every((g) => g.passed),
    hasBlockingFailure: blockingGates.length > 0,
    blockingGates,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * CLI-friendly entry point. Prints results and RETURNS them.
 *
 * Sets `process.exitCode = 1` on a blocking failure so the bare
 * `cleo hygiene validate-spawn-readiness` surface still exits non-zero, but it
 * never calls `process.exit` and never throws. **Callers must branch on the
 * returned value** — that is the whole of gh#1366. It also no longer forces
 * `process.exitCode = 0` on success, which would have cleared a failure code
 * set by something else earlier in the process.
 *
 * @param projectRoot - Absolute path to project root.
 * @param worktreePath - Expected worktree path (optional).
 * @returns The structured readiness result.
 */
export async function runSpawnReadinessHygieneCli(
  projectRoot: string = process.cwd(), // CWD-OK: CLI entry point default — `cleo hygiene` invoked from project cwd
  worktreePath?: string,
): Promise<SpawnReadinessResult> {
  const result = await runSpawnReadinessHygiene(projectRoot, worktreePath);

  console.log(`Spawn Readiness Check — ${result.checkedAt}`);
  console.log('='.repeat(50));
  for (const gate of result.gates) {
    const icon = gate.passed ? '✅' : '❌';
    const tag = gate.reason === 'timeout' ? ' [TIMEOUT — not a validation failure]' : '';
    console.log(`${icon} ${gate.name}${tag}: ${gate.message}`);
  }
  console.log('='.repeat(50));

  if (result.hasBlockingFailure) {
    console.error(`FAILED gates: ${result.blockingGates.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('All gates passed — spawn readiness confirmed.');
  }

  return result;
}
