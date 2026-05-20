/**
 * Integration tests for the progressive-disclosure-depth rule (T9684).
 *
 * Exercises `packages/skills/skills/ct-skill-validator/scripts/check_depth.py`
 * against (a) the gold-standard ct-orchestrator skill — must pass, and
 * (b) a synthetic stub fixture written to a tmp dir — must fail.
 *
 * The depth rule guards against the "stub skill" regression that
 * E-SKILLS-DEPTH-BACKFILL (T9567) corrected. Future stub skills MUST
 * fail this check, which the CI workflow surfaces on PRs touching
 * `packages/skills/skills/**`.
 *
 * @task T9684
 */

import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(thisFile), '..', '..', '..');
const checkDepthScript = join(
  repoRoot,
  'packages/skills/skills/ct-skill-validator/scripts/check_depth.py',
);
const ctOrchestratorPath = join(repoRoot, 'packages/skills/skills/ct-orchestrator');

/** Run check_depth.py and capture exit code + JSON output. */
function runCheckDepth(args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
  report?: unknown;
} {
  try {
    const stdout = execSync(`python3 "${checkDepthScript}" ${args.join(' ')}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      exitCode: 0,
      stdout,
      stderr: '',
      report: args.includes('--json') ? JSON.parse(stdout) : undefined,
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      report: args.includes('--json') && e.stdout ? JSON.parse(e.stdout) : undefined,
    };
  }
}

// ---------------------------------------------------------------------------
// Pass case — gold-standard ct-orchestrator
// ---------------------------------------------------------------------------

describe('check_depth.py — pass case (gold standard)', () => {
  it('ct-orchestrator passes the progressive-disclosure-depth rule', () => {
    const result = runCheckDepth([`"${ctOrchestratorPath}"`, '--json']);
    expect(result.exitCode).toBe(0);
    const report = result.report as {
      skill_name: string;
      passed: boolean;
      ref_files_on_disk: number;
    };
    expect(report.skill_name).toBe('ct-orchestrator');
    expect(report.passed).toBe(true);
    // Gold standard has 9 reference files
    expect(report.ref_files_on_disk).toBeGreaterThanOrEqual(3);
  });

  it('each T9567-backfilled skill passes the rule', () => {
    const backfilled = [
      'ct-research-agent',
      'ct-spec-writer',
      'ct-task-executor',
      'ct-validator',
      'ct-documentor',
      'ct-docs-lookup',
      'ct-docs-write',
      'ct-docs-review',
    ];
    for (const name of backfilled) {
      const skillPath = join(repoRoot, 'packages/skills/skills', name);
      const result = runCheckDepth([`"${skillPath}"`, '--json']);
      expect(result.exitCode, `${name} should pass depth check, got: ${result.stdout}`).toBe(0);
      const report = result.report as { passed: boolean };
      expect(report.passed, `${name} should pass depth check`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Fail case — synthetic stub fixture
// ---------------------------------------------------------------------------

describe('check_depth.py — fail case (synthetic stub)', () => {
  let stubDir: string;

  beforeAll(() => {
    // Create a synthetic stub: minimal SKILL.md, no references/, not in
    // any manifest. The depth rule MUST flag it.
    stubDir = mkdtempSync(join(tmpdir(), 'cleo-depth-stub-'));
    const stubSkillDir = join(stubDir, 'ct-synthetic-stub');
    mkdirSync(stubSkillDir, { recursive: true });

    const stubSkillMd = `---
name: ct-synthetic-stub
description: A deliberately minimal stub used to exercise the progressive-disclosure-depth rule in tests. Use only for the test suite.
---

# Synthetic stub

This is too short.
`;
    writeFileSync(join(stubSkillDir, 'SKILL.md'), stubSkillMd);
  });

  afterAll(() => {
    if (stubDir) {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('synthetic stub fails the rule', () => {
    const stubSkillDir = join(stubDir, 'ct-synthetic-stub');
    const result = runCheckDepth([`"${stubSkillDir}"`, '--json']);
    expect(result.exitCode).toBe(1);
    const report = result.report as {
      skill_name: string;
      passed: boolean;
      body_lines: number;
      ref_files_on_disk: number;
      remediation: string[];
    };
    expect(report.skill_name).toBe('ct-synthetic-stub');
    expect(report.passed).toBe(false);
    expect(report.body_lines).toBeLessThan(100);
    expect(report.ref_files_on_disk).toBe(0);
    // Remediation MUST point at the gold standard
    const remediationText = report.remediation.join(' ');
    expect(remediationText).toMatch(/ct-orchestrator/);
    expect(remediationText).toMatch(/ct-skill-creator/);
  });
});

// ---------------------------------------------------------------------------
// Repo-wide sweep
// ---------------------------------------------------------------------------

describe('check_depth.py --all (repo sweep)', () => {
  it('every skill currently in the repo passes or is allowlisted', () => {
    const result = runCheckDepth([`"${repoRoot}"`, '--all', '--json']);
    expect(result.exitCode).toBe(0);
    const report = result.report as {
      summary: { total: number; passed: number; failed: number };
    };
    expect(report.summary.failed).toBe(0);
    expect(report.summary.total).toBeGreaterThan(0);
    expect(report.summary.passed).toBe(report.summary.total);
  });
});
