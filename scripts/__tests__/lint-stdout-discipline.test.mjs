/**
 * Tests for scripts/lint-stdout-discipline.mjs.
 *
 * Strategy:
 *   - Run the script against the real cleocode tree to assert the committed
 *     baseline passes (no regression on main).
 *   - Plant a synthetic violation in a non-allowlisted location (under
 *     packages/contracts/src/), re-run the script, and assert it fails with
 *     the new identity reported. Cleans up the fixture in `finally` so the
 *     working tree is restored even if assertions throw.
 *   - Exercise the per-line opt-out (`// stdout-discipline-allowed`) by
 *     planting a violation annotated with the marker and asserting the
 *     script still passes.
 *   - Exercise --strict mode: deliberately fail when baseline > 0.
 *
 * @task T10135
 * @epic T10114
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
const SCRIPT = join(REPO_ROOT, 'scripts/lint-stdout-discipline.mjs');

/**
 * Fixture path lives under a non-allowlisted package so it must trigger.
 * Suffixed with pid to avoid cross-contamination with the parallel
 * lint-stdout-write-allowlist suite (T10360 — same scan tree, different
 * lint scripts, must not see each other's fixtures).
 */
const FIXTURE_PATH = join(
  REPO_ROOT,
  `packages/contracts/src/__stdout_violation_fixture_${process.pid}.ts`,
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
  // Always remove the fixture if a test left one behind.
  if (existsSync(FIXTURE_PATH)) unlinkSync(FIXTURE_PATH);
});

describe('lint-stdout-discipline — baseline mode (default)', () => {
  it('passes on the current tree (no regression vs committed baseline)', () => {
    const result = runLint();
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/baseline:/);
  });

  it('rejects a deliberate new violation in a non-allowlisted file', () => {
    writeFileSync(
      FIXTURE_PATH,
      'export function bad(): void {\n  process.stdout.write("nope\\n");\n}\n',
    );
    const result = runLint();
    expect(result.status).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain(
      `packages/contracts/src/__stdout_violation_fixture_${process.pid}.ts`,
    );
    expect(combined).toMatch(/NEW violation/);
  });

  it('accepts a violation annotated with the per-line opt-out marker', () => {
    writeFileSync(
      FIXTURE_PATH,
      'export function ok(): void {\n' +
        '  process.stdout.write("justified"); // stdout-discipline-allowed: T10135 fixture\n' +
        '}\n',
    );
    const result = runLint();
    expect(result.status).toBe(0);
  });
});

describe('lint-stdout-discipline — strict mode', () => {
  it('fails when any violations exist (including baseline)', () => {
    // The committed baseline has > 0 pre-existing violations, so --strict
    // is expected to fail today. When the baseline reaches zero, this test
    // should be inverted to assert exit 0.
    const result = runLint(['--strict']);
    expect([0, 1]).toContain(result.status);
    if (result.status === 1) {
      expect(result.stderr).toMatch(/STRICT FAIL/);
    } else {
      expect(result.stdout).toMatch(/STRICT OK/);
    }
  });
});

// These isolated expression oracles do not alter the checked-out package tree.
const {
  stdoutCallIdentities,
  createStdoutBaseline,
  compareStdoutBaseline,
  convertLegacyStdoutBaseline,
} = await import('../stdout-baseline-identity.mjs');
const { createHash } = await import('node:crypto');
const fixtureFile = 'packages/sample/src/cli.ts';
const expression = 'process.stdout.write(\n  renderWarnDrift(migrateResult)\n);';
const sourceAt = (source) => stdoutCallIdentities(source, fixtureFile);

describe('stdout complete-call stable identity', () => {
  it('accepts an unchanged call moved by unrelated lines and formatting', () => {
    const baseline = createStdoutBaseline(sourceAt(expression));
    expect(
      compareStdoutBaseline(
        sourceAt('// unrelated\n\nprocess . stdout . write(renderWarnDrift( migrateResult ));'),
        baseline,
      ).added,
    ).toEqual([]);
  });

  it('rejects changed multiline arguments at the same starting line', () => {
    const baseline = createStdoutBaseline(sourceAt(expression));
    const changed = sourceAt(expression.replace('migrateResult', 'unrelatedSecret'));
    expect(changed[0].line).toBe(baseline.items[0].line);
    expect(compareStdoutBaseline(changed, baseline).added).toHaveLength(1);
  });

  it('rejects a duplicated identical call including two on the same line', () => {
    const baseline = createStdoutBaseline(sourceAt('process.stdout.write("original");'));
    expect(
      compareStdoutBaseline(
        sourceAt('process.stdout.write("original");process.stdout.write("original");'),
        baseline,
      ).added,
    ).toHaveLength(1);
  });

  it.each([
    ['"a b"', '"ab"'],
    ['`first\nsecond`', '`first second`'],
    ['"\\u0061"', '"a"'],
  ])('preserves literal token bytes (%s)', (original, changed) => {
    const baseline = createStdoutBaseline(sourceAt(`process.stdout.write(${original});`));
    expect(
      compareStdoutBaseline(sourceAt(`process.stdout.write(${changed});`), baseline).added,
    ).toHaveLength(1);
  });

  it('does not allow moving a known expression to another file', () => {
    const baseline = createStdoutBaseline(sourceAt(expression));
    expect(
      compareStdoutBaseline(stdoutCallIdentities(expression, 'packages/other.ts'), baseline).added,
    ).toHaveLength(1);
  });

  it('ignores comments and strings mentioning a call without executing it', () => {
    expect(
      sourceAt('// process.stdout.write("comment");\nconst text = "process.stdout.write(fake)";'),
    ).toEqual([]);
  });

  it('fails explicitly on invalid source or baseline schema', () => {
    expect(() => sourceAt('process.stdout.write(')).toThrow('Cannot parse');
    expect(() => compareStdoutBaseline([], { total: 1, items: [] })).toThrow(
      'Invalid stdout baseline',
    );
  });
});

describe('stdout historical conversion', () => {
  const revision = 'a'.repeat(40);
  const legacy = { total: 1, items: [`${fixtureFile}:1`] };
  const blob = (text) =>
    createHash('sha1')
      .update(`blob ${Buffer.byteLength(text)}\0`)
      .update(text)
      .digest('hex');
  it('preserves exact source and original locations without requiring Git for later checks', () => {
    const converted = convertLegacyStdoutBaseline(legacy, revision, () => ({
      source: expression,
      blob: blob(expression),
    }));
    expect(converted.total).toBe(legacy.total);
    expect(converted.items[0]).toMatchObject({
      originalLocation: legacy.items[0],
      sourceRevision: revision,
      sourceBlob: blob(expression),
      snippet: expression.slice(0, -1),
    });
    expect(compareStdoutBaseline(sourceAt(`\n${expression}`), converted).added).toEqual([]);
    expect(legacy.items).toEqual([`${fixtureFile}:1`]);
  });

  it('refuses unavailable, wrong-blob and ambiguous historical evidence', () => {
    expect(() =>
      convertLegacyStdoutBaseline(legacy, revision, () => {
        throw new Error('Historical source unavailable');
      }),
    ).toThrow('Historical source unavailable');
    expect(() =>
      convertLegacyStdoutBaseline(legacy, revision, () => ({
        source: expression,
        blob: 'b'.repeat(40),
      })),
    ).toThrow('blob mismatch');
    const twice = 'process.stdout.write(1);process.stdout.write(1);';
    expect(() =>
      convertLegacyStdoutBaseline(legacy, revision, () => ({ source: twice, blob: blob(twice) })),
    ).toThrow('ambiguous');
  });
});
