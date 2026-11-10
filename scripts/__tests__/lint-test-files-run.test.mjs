/**
 * Gate 43 (T14410): every tracked test file is collected by a vitest run CI
 * performs, and the baseline of files that never ran only shrinks.
 *
 * @task T14410
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE,
  BASELINE_PIN,
  baseBaseline,
  baselineGrowth,
  CI_RUNNERS,
  compare,
  parseBaseline,
  quarantinedFiles,
  SECRET_GATED,
  TEST_FILE,
  workflowCommands,
  workflowInvokes,
} from '../lint-test-files-run.mjs';

const SCRIPT = fileURLToPath(new URL('../lint-test-files-run.mjs', import.meta.url));
const CI_YML = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url));

/**
 * A fake `git` for {@link baseBaseline}: answers by subcommand.
 *
 * @param {Record<string, { status: number, stdout?: string }>} answers
 */
function fakeGit(answers) {
  return (args) => ({ stdout: '', ...(answers[args[0]] ?? { status: 0 }) });
}

const none = { quarantined: new Set(), baseline: {}, ignoredPrefixes: [] };

describe('lint-test-files-run (gate 43)', () => {
  it('fails a tracked test file no CI run collects', () => {
    const r = compare({
      ...none,
      tracked: ['a/x.test.ts', 'a/y-integration.test.ts'],
      collected: new Set(['a/x.test.ts']),
    });
    expect(r.uncollected).toEqual(['a/y-integration.test.ts']);
  });

  it('accepts quarantined, ignored and baselined files, and reports baselined ones', () => {
    const r = compare({
      tracked: ['q.test.ts', '.cleo/z.test.js', 'b.spec.ts'],
      collected: new Set(),
      quarantined: new Set(['q.test.ts']),
      baseline: { 'b.spec.ts': 'reason' },
      ignoredPrefixes: ['.cleo/'],
    });
    expect(r.uncollected).toEqual([]);
    expect(r.baselined).toEqual(['b.spec.ts']);
    expect(r.stale).toEqual([]);
  });

  it('fails a stale baseline entry: collected now, or deleted', () => {
    const r = compare({
      ...none,
      tracked: ['now-runs.test.ts'],
      collected: new Set(['now-runs.test.ts']),
      baseline: { 'now-runs.test.ts': 'r', 'gone.test.ts': 'r' },
    });
    expect(r.stale.sort()).toEqual(['gone.test.ts', 'now-runs.test.ts']);
  });

  it('matches test file names, not their fixtures or helpers', () => {
    for (const f of [
      'a.test.ts',
      'a.spec.ts',
      'a.test.mjs',
      'a.test.tsx',
      'a.integration.test.ts',
    ]) {
      expect(TEST_FILE.test(f), f).toBe(true);
    }
    for (const f of ['a.ts', 'test-helpers.ts', 'a.test.ts.snap']) {
      expect(TEST_FILE.test(f), f).toBe(false);
    }
  });

  it('counts a runner invoked only on a comment line as not invoked', () => {
    expect(workflowInvokes('  # run: vitest --config x.ts\n', 'vitest --config x.ts')).toBe(false);
    expect(workflowInvokes('        run: vitest --config x.ts\n', 'vitest --config x.ts')).toBe(
      true,
    );
    expect(workflowInvokes('      - run: vitest --config x.ts\n', 'vitest --config x.ts')).toBe(
      true,
    );
  });

  it('matches the whole command: an added filter, flag or longer path is not an invocation', () => {
    const cmd = 'vitest run --config x.ts';
    for (const line of [
      'vitest run --config x.ts src/only-this',
      'vitest run --config x.ts --exclude "**/slow/**"',
      'vitest run --config x.ts -t "one test"',
      'vitest run --config x.ts.bak',
      'vitest run --config other/x.ts',
      'echo vitest run --config x.ts',
    ]) {
      expect(workflowInvokes(`        run: |\n          ${line}\n`, cmd), line).toBe(false);
    }
    expect(workflowInvokes(`        run: |\n          ${cmd}\n`, cmd)).toBe(true);
  });

  it('joins backslash continuations, so a filter on a continuation line is seen', () => {
    const src =
      '          vitest run \\\n            --config x.ts \\\n            src/only-this\n';
    expect(workflowCommands(src)).toEqual(['vitest run --config x.ts src/only-this']);
    expect(workflowInvokes(src, 'vitest run --config x.ts')).toBe(false);
    expect(workflowInvokes(src, 'vitest run   --config x.ts src/only-this')).toBe(true);
  });

  it('finds every pinned runner command in ci.yml, and loses it when a filter is appended', () => {
    const ci = readFileSync(CI_YML, 'utf8');
    for (const runner of CI_RUNNERS) {
      expect(runner.commands.length, runner.config).toBeGreaterThan(0);
      for (const command of runner.commands) {
        expect(workflowInvokes(ci, command), command).toBe(true);
      }
    }
    const run = CI_RUNNERS[1].commands.find((c) => c.startsWith('pnpm exec vitest run'));
    expect(run).toBeDefined();
    const filtered = ci.replace(run, `${run} src/llm/transports`);
    expect(filtered).not.toBe(ci);
    expect(workflowInvokes(filtered, run)).toBe(false);
  });

  it('fails a --base that names no commit, and names the fetch that fixes it', () => {
    const missing = fakeGit({ 'rev-parse': { status: 1 } });
    expect(() => baseBaseline('origin/main', missing)).toThrow(
      /--base origin\/main: not a commit in this clone.*git fetch --no-tags origin main/s,
    );
    expect(() => baseBaseline('0123abc', missing)).toThrow(/git fetch --no-tags origin 0123abc/);
    // `--base "$(git rev-parse HEAD^1)"` in a shallow clone passes an empty value.
    expect(() => baseBaseline('', missing)).toThrow(/--base needs a ref/);
    expect(() => baseBaseline(undefined, missing)).toThrow(/--base needs a ref/);
    expect(() => baseBaseline('--strict', missing)).toThrow(/--base needs a ref/);
  });

  it('fails a base whose copy of the gate cannot be read or parsed', () => {
    const path = 'scripts/lint-test-files-run.mjs\n';
    const unreadable = fakeGit({ 'ls-tree': { status: 0, stdout: path }, show: { status: 128 } });
    expect(() => baseBaseline('abc', unreadable)).toThrow(
      /cannot read .* at that commit.*git fetch/s,
    );
    const noTree = fakeGit({ 'ls-tree': { status: 128 } });
    expect(() => baseBaseline('abc', noTree)).toThrow(/cannot read its tree.*git fetch/s);
    const noPin = fakeGit({
      'ls-tree': { status: 0, stdout: path },
      show: { status: 0, stdout: "export const BASELINE = {\n  'a.test.ts': 'r',\n};\n" },
    });
    expect(() => baseBaseline('abc', noPin)).toThrow(/no readable BASELINE_PIN/);
  });

  it('reads the base baseline, and treats only a base without the gate as nothing to compare', () => {
    const src =
      "export const BASELINE = {\n  'a.test.ts': 'r',\n};\nexport const BASELINE_PIN = 1;\n";
    const present = fakeGit({
      'ls-tree': { status: 0, stdout: 'scripts/lint-test-files-run.mjs\n' },
      show: { status: 0, stdout: src },
    });
    const base = baseBaseline('abc', present);
    expect([...base.keys]).toEqual(['a.test.ts']);
    expect(base.pin).toBe(1);
    // The shrink checks then run against it.
    expect(
      baselineGrowth({ keys: new Set(['a.test.ts', 'b.test.ts']), pin: 2 }, base),
    ).toHaveLength(2);
    expect(baseBaseline('abc', fakeGit({ 'ls-tree': { status: 0, stdout: '' } }))).toBeNull();
  });

  it('exits 1 on an unresolvable --base before listing anything', () => {
    const res = spawnSync(process.execPath, [SCRIPT, '--check', '--base', 'no-such-ref-t14410'], {
      encoding: 'utf8',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/--base no-such-ref-t14410: not a commit in this clone/);
    expect(res.stderr).toMatch(/git fetch --no-tags origin no-such-ref-t14410/);
    expect(res.stdout).not.toMatch(/OK/);
  });

  it('parses quarantine entries and skips comment text with apostrophes', () => {
    const src =
      "export const CLEO_TEST_QUARANTINE: readonly string[] = [\n  // the section's file\n  'p/a.test.ts',\n];\n";
    expect(quarantinedFiles(src)).toEqual(['p/a.test.ts']);
  });

  it('gives every baseline entry a reason naming its burn-down task', () => {
    for (const [file, reason] of Object.entries(BASELINE)) {
      expect(reason, file).toMatch(/T\d{4,}/);
    }
  });

  it("parses this script's own BASELINE and pin", () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const parsed = parseBaseline(src);
    expect([...parsed.keys].sort()).toEqual(Object.keys(BASELINE).sort());
    expect(parsed.pin).toBe(BASELINE_PIN);
    expect(Object.keys(BASELINE).length).toBeLessThanOrEqual(BASELINE_PIN);
  });

  it('fails a baseline entry the base lacks, a pin that rose, and a count above the pin', () => {
    const base = { keys: new Set(['a.test.ts']), pin: 1 };
    expect(baselineGrowth({ keys: new Set(['a.test.ts']), pin: 1 }, base)).toEqual([]);
    expect(baselineGrowth({ keys: new Set([]), pin: 0 }, base)).toEqual([]);
    const grown = baselineGrowth({ keys: new Set(['a.test.ts', 'b.test.ts']), pin: 2 }, base);
    expect(grown.some((m) => m.startsWith('b.test.ts'))).toBe(true);
    expect(grown.some((m) => m.includes('rose from 1 to 2'))).toBe(true);
    expect(baselineGrowth({ keys: new Set(['a.test.ts', 'b.test.ts']), pin: 1 }, null)).toEqual([
      'BASELINE has 2 entries, above BASELINE_PIN 1',
    ]);
    // An unreadable pin on either side is a failure, never a skipped comparison.
    expect(baselineGrowth({ keys: new Set([]), pin: Number.NaN }, base)).toHaveLength(1);
    expect(
      baselineGrowth({ keys: new Set([]), pin: 0 }, { keys: new Set(), pin: Number.NaN }),
    ).toHaveLength(1);
  });

  it('names why each secret-gated file skips in CI', () => {
    for (const [file, why] of Object.entries(SECRET_GATED)) {
      expect(file).toMatch(/\.integration\.test\.ts$/);
      expect(why.length, file).toBeGreaterThan(0);
    }
  });
});
