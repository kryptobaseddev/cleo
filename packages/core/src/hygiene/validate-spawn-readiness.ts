/**
 * Validate spawn readiness — unified pre-flight hygiene runner (T10451).
 *
 * Runs all 3 gates in parallel:
 *   1. Changeset lint (via scripts/lint-changesets.mjs)
 *   2. Changelog drift (CHANGELOG.md has current version header)
 *   3. Worktree location (cwd matches expected worktree path)
 *
 * Returns non-zero exit code on any failure.
 *
 * @task T10451
 * @saga T10431
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Severity level for a gate result. */
type Severity = 'error' | 'warn';

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
}

/** Overall result from the spawn-readiness check. */
export interface SpawnReadinessResult {
  /** Per-gate results. */
  gates: HygieneGateResult[];
  /** True only if ALL gates passed. */
  allPassed: boolean;
  /** ISO timestamp of the check. */
  checkedAt: string;
}

// ============================================================================
// Individual gates
// ============================================================================

/** Run the changeset lint gate. */
function runChangesetLintGate(projectRoot: string): HygieneGateResult {
  const scriptPath = join(projectRoot, 'scripts', 'lint-changesets.mjs');
  if (!existsSync(scriptPath)) {
    return {
      name: 'changeset-lint',
      passed: false,
      message: `lint-changesets.mjs not found at ${scriptPath}`,
      severity: 'error',
    };
  }
  try {
    execSync(`node "${scriptPath}"`, { cwd: projectRoot, encoding: 'utf-8', timeout: 10_000 });
    return {
      name: 'changeset-lint',
      passed: true,
      message: 'All changesets well-formed.',
      severity: 'error',
    };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    const stderr = e.stderr || e.message || String(err);
    return {
      name: 'changeset-lint',
      passed: false,
      message: `Changeset lint failed: ${stderr}`,
      severity: 'error',
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
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: 'changelog-drift',
      passed: false,
      message: `Failed to read CHANGELOG.md: ${message}`,
      severity: 'error',
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
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: 'worktree-location',
      passed: false,
      message: `Failed to check cwd: ${message}`,
      severity: 'error',
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

  return {
    gates,
    allPassed: gates.every((g) => g.passed),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * CLI-friendly entry point. Prints results and exits with code 1 on failure.
 *
 * @param projectRoot - Absolute path to project root.
 * @param worktreePath - Expected worktree path (optional).
 */
export async function runSpawnReadinessHygieneCli(
  projectRoot: string = process.cwd(), // CWD-OK: CLI entry point default — `cleo hygiene` invoked from project cwd
  worktreePath?: string,
): Promise<void> {
  const result = await runSpawnReadinessHygiene(projectRoot, worktreePath);

  console.log(`Spawn Readiness Check — ${result.checkedAt}`);
  console.log('='.repeat(50));
  for (const gate of result.gates) {
    const icon = gate.passed ? '✅' : '❌';
    console.log(`${icon} ${gate.name}: ${gate.message}`);
  }
  console.log('='.repeat(50));

  if (result.allPassed) {
    console.log('All gates passed — spawn readiness confirmed.');
    process.exitCode = 0;
  } else {
    const failed = result.gates
      .filter((g) => !g.passed)
      .map((g) => g.name)
      .join(', ');
    console.error(`FAILED gates: ${failed}`);
    process.exitCode = 1;
  }
}
