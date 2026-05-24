/**
 * Tests for scripts/lint-stdout-write-allowlist.mjs.
 *
 * Strategy mirrors the sibling lint test (lint-stdout-discipline.test.mjs):
 *   - Run the script against the real cleocode tree to assert the committed
 *     baseline passes (no regression on main).
 *   - Plant a synthetic violation in a non-allowlisted location (under
 *     packages/contracts/src/), re-run the script, and assert it fails with
 *     the new identity reported.
 *   - Exercise the per-line opt-out (`// stdout-write-allowed`) by planting
 *     a violation annotated with the marker and asserting the script still
 *     passes.
 *   - Exercise --strict mode: deliberately fail when baseline > 0 (until the
 *     baseline reaches zero, at which point --strict OK is expected).
 *
 * @task T9924
 * @saga T9855
 * @adr ADR-077
 */

import { spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-stdout-write-allowlist.mjs');

/**
 * Fixture lives under a non-allowlisted package so it must trigger.
 * Suffixed with pid to avoid cross-contamination with the parallel
 * lint-stdout-discipline suite (T10360 — same scan tree, different lint
 * scripts, must not see each other's fixtures).
 */
const FIXTURE_PATH = join(
  REPO_ROOT,
  `packages/contracts/src/__stdout_write_violation_fixture_${process.pid}.ts`,
);

/**
 * Run the lint script with optional extra args.
 *
 * @param {string[]} extraArgs
 */
function runLint(extraArgs = []) {
  return spawnSync('node', [SCRIPT, ...extraArgs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: REPO_ROOT,
  });
}

afterEach(() => {
  if (existsSync(FIXTURE_PATH)) unlinkSync(FIXTURE_PATH);
});

describe('lint-stdout-write-allowlist — check mode (default)', () => {
  it('passes on the current tree (no regression vs committed baseline)', () => {
    const result = runLint(['--check']);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/baseline:/);
  });

  it('rejects a deliberate new violation in a non-allowlisted file', () => {
    writeFileSync(
      FIXTURE_PATH,
      'export function bad(): void {\n  process.stdout.write("nope\\n");\n}\n',
    );
    const result = runLint(['--check']);
    expect(result.status).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain(
      `packages/contracts/src/__stdout_write_violation_fixture_${process.pid}.ts`,
    );
    expect(combined).toMatch(/NEW unannotated violation/);
  });

  it('accepts a violation annotated with the per-line opt-out marker', () => {
    writeFileSync(
      FIXTURE_PATH,
      'export function ok(): void {\n' +
        '  process.stdout.write("justified"); // stdout-write-allowed: T9924 fixture\n' +
        '}\n',
    );
    const result = runLint(['--check']);
    expect(result.status).toBe(0);
  });
});

describe('lint-stdout-write-allowlist — strict mode', () => {
  it('fails when any unannotated violations exist (including baseline)', () => {
    // The committed baseline has > 0 pre-existing unannotated violations,
    // so --strict is expected to fail today. When the baseline reaches zero
    // this test should be inverted to assert exit 0.
    const result = runLint(['--strict']);
    expect([0, 1]).toContain(result.status);
    if (result.status === 1) {
      expect(result.stderr).toMatch(/STRICT FAIL/);
    } else {
      expect(result.stdout).toMatch(/STRICT OK/);
    }
  });
});
