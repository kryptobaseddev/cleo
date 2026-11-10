/**
 * Tests for scripts/lint-stdout-write-allowlist.mjs.
 *
 * Strategy mirrors the sibling lint test (lint-stdout-discipline.test.mjs):
 *   - Run the script against the real cleocode tree to assert the committed
 *     baseline passes (no regression on main).
 *   - Plant a synthetic violation in a non-allowlisted location (under
 *     packages/contracts/src/) of a THROWAWAY copy-shaped root (committed
 *     baseline + fixture only), run the script there, and assert it fails
 *     with the new identity reported. The fixture never touches the real
 *     checkout: a file planted there was seen by every other real-tree scan
 *     running in the same vitest shard (T14431 — it made
 *     lint-no-runtime-in-contracts report `bad`/`ok` as net-new helpers).
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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { createStdoutBaseline, stdoutCallIdentities } from '../stdout-baseline-identity.mjs';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = join(REPO_ROOT, 'scripts/lint-stdout-write-allowlist.mjs');
const BASELINE_REL = 'scripts/.lint-stdout-write-allowlist-baseline.json';

/** Fixture path, relative to the isolated root, under a non-allowlisted package. */
const FIXTURE_REL = `packages/contracts/src/__stdout_write_violation_fixture_${process.pid}.ts`;

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

/**
 * Run the lint script in a throwaway root holding only the committed baseline
 * and one fixture source file, so the real checkout is never modified.
 *
 * @param {string} source - fixture file contents
 * @param {string[]} extraArgs
 */
function runLintOnFixture(source, extraArgs = []) {
  const root = mkdtempSync(join(tmpdir(), 'stdout-fixture-gate-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(join(REPO_ROOT, BASELINE_REL), join(root, BASELINE_REL));
    mkdirSync(join(root, dirname(FIXTURE_REL)), { recursive: true });
    writeFileSync(join(root, FIXTURE_REL), source);
    return spawnSync('node', [SCRIPT, ...extraArgs], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: root,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('lint-stdout-write-allowlist — check mode (default)', () => {
  it('passes on the current tree (no regression vs committed baseline)', () => {
    const result = runLint(['--check']);
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/baseline:/);
  });

  it('rejects a deliberate new violation in a non-allowlisted file', () => {
    const result = runLintOnFixture(
      'export function bad(): void {\n  process.stdout.write("nope\\n");\n}\n',
      ['--check'],
    );
    expect(result.status).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain(FIXTURE_REL);
    expect(combined).toMatch(/NEW unannotated violation/);
  });

  it('accepts a violation annotated with the per-line opt-out marker', () => {
    const result = runLintOnFixture(
      'export function ok(): void {\n' +
        '  process.stdout.write("justified"); // stdout-write-allowed: T9924 fixture\n' +
        '}\n',
      ['--check'],
    );
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

// Invoke both actual gates in checkout-shaped fixtures with no .git or history.
describe.each(['discipline', 'write-allowlist'])('stdout %s isolated gate identity', (gate) => {
  const sourceFile = 'packages/sample/src/writer.ts';
  const original = 'process.stdout.write(\n  renderValue("a b")\n);\n';
  function check(source, modifyBaseline = (baseline) => baseline) {
    const root = mkdtempSync(join(tmpdir(), 'stdout-expression-gate-'));
    try {
      mkdirSync(join(root, 'packages/sample/src'), { recursive: true });
      mkdirSync(join(root, 'scripts'));
      writeFileSync(join(root, sourceFile), source);
      const baseline = modifyBaseline(
        createStdoutBaseline(stdoutCallIdentities(original, sourceFile)),
      );
      if (baseline !== null)
        writeFileSync(
          join(root, `scripts/.lint-stdout-${gate}-baseline.json`),
          JSON.stringify(baseline),
        );
      const result = spawnSync(
        process.execPath,
        [join(REPO_ROOT, `scripts/lint-stdout-${gate}.mjs`)],
        {
          cwd: root,
          env: { PATH: '', HOME: root },
          encoding: 'utf8',
          timeout: 5000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(existsSync(join(root, '.git'))).toBe(false);
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('accepts movement/formatting with no runtime Git dependency', () => {
    const result = check(
      '// moved by an unrelated change\n\nprocess.stdout.write(renderValue( "a b" ));\n',
    );
    expect(result.status).toBe(0);
    expect(result.output).toContain('baseline: 1');
  });
  it('rejects changed multiline argument at the same old location', () => {
    const result = check(original.replace('"a b"', '"ab"'));
    expect(result.status).toBe(1);
    expect(result.output).toContain('NEW');
    expect(result.output).toContain('renderValue("ab")');
  });
  it('rejects a second occurrence of the same complete expression', () => {
    const result = check(original + original);
    expect(result.status).toBe(1);
    expect(result.output).toContain('1 NEW');
  });
  it('refuses malformed allowance multiplicity and missing baselines', () => {
    expect(check(original, (baseline) => ({ ...baseline, total: 2 })).status).toBe(1);
    const missing = check(original, () => null);
    expect(missing.status).toBe(1);
    expect(missing.output).toContain('missing baseline');
  });
});

describe('stdout jobs install their existing parser dependency', () => {
  it.each([
    'stdout-discipline',
    'stdout-write-allowlist',
  ])('keeps actual %s command after frozen dependency setup', (id) => {
    const workflow = parseYaml(readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8'));
    // T13838: both gates are steps of the consolidated installed-gates job;
    // T14367 folded it into ci.yml's Repo Lints, which the required `ci`
    // aggregate needs on every pull_request and merge_group run.
    const [jobId, job] = Object.entries(workflow.jobs).find(([, j]) =>
      j.steps?.some((step) => step.run?.startsWith(`node scripts/lint-${id}.mjs`)),
    );
    const install = job.steps.findIndex((step) => step.run === 'pnpm install --frozen-lockfile');
    const lint = job.steps.findIndex((step) => step.run?.startsWith(`node scripts/lint-${id}.mjs`));
    expect(install).toBeGreaterThan(-1);
    expect(lint).toBeGreaterThan(install);
    expect(job.steps.find((step) => step.uses === 'pnpm/action-setup@v4').with.version).toBe(
      '10.30.0',
    );
    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.on).toHaveProperty('merge_group');
    expect(workflow.jobs.ci.needs).toContain(jobId);
  });
});
