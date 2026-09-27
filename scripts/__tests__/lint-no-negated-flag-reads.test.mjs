/**
 * Tests for `scripts/lint-no-negated-flag-reads.mjs` (T12528).
 *
 * Proves the violation fails, the remedy passes, comments are not violations,
 * the helper is exempt, the baseline ratchets, and the CLI entry point really
 * runs when invoked from a path containing a space (the entry check compares
 * resolved file paths, never a hand-built `file://` string).
 *
 * @task T12528
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASELINE, findNegatedFlagReads, HELPER, runGate } from '../lint-no-negated-flag-reads.mjs';

const SCRIPT = 'scripts/lint-no-negated-flag-reads.mjs';
const CMD = 'packages/cleo/src/cli/commands/sample.ts';

describe('findNegatedFlagReads', () => {
  it.each([
    ["if (!args['no-hygiene']) {}", "args['no-…']"],
    ['const x = args["no-launch"];', "args['no-…']"],
    ['const x = args[`no-launch`];', "args['no-…']"],
    ['const x = !args.noDepends;', 'args.noFoo'],
    ["const x = readBoolFlag(args, 'no-delta');", "reader(args, 'no-…')"],
  ])('flags %s', (src, pattern) => {
    const hits = findNegatedFlagReads(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.pattern).toBe(pattern);
  });

  it.each([
    "const x = negatedFlag(args, 'hygiene');",
    "// args['no-hygiene'] used to be read here",
    "/* args['no-hygiene'] */ const y = 1;",
    "const def = { 'no-hygiene': { type: 'boolean' } };",
    'const notes = args.notes; const n = args.nodeId;',
  ])('does not flag %s', (src) => {
    expect(findNegatedFlagReads(src)).toEqual([]);
  });

  it('reports the right line number after a block comment', () => {
    const hits = findNegatedFlagReads("/*\n * doc\n */\nconst a = 1;\nif (args['no-x']) {}\n");
    expect(hits[0]?.line).toBe(5);
  });
});

describe('runGate', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'negated-flag-gate-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Write a file under the temp repo root. */
  function put(rel, content) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  it('fails on a raw read and names file:line', () => {
    put(CMD, "export const a = 1;\nif (!args['no-hygiene']) {}\n");
    const result = runGate(root);
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain(`${CMD}:2`);
  });

  it('passes the remedy', () => {
    put(CMD, "if (!negatedFlag(args, 'hygiene')) {}\n");
    expect(runGate(root).ok).toBe(true);
  });

  it('exempts the helper and test files', () => {
    put(HELPER, "export const read = (args) => args['no-x'] === true;\n");
    put('packages/cleo/src/cli/commands/__tests__/x.test.ts', "args['no-x'];\n");
    put('packages/cleo/src/cli/commands/y.test.ts', "args['no-x'];\n");
    put(CMD, 'export {};\n');
    expect(runGate(root).ok).toBe(true);
  });

  it('allows a baselined file up to its count, rejects one more, and ignores it under --strict', () => {
    const [file, count] = Object.entries(BASELINE)[0];
    put(file, "args['no-worktree'];\n".repeat(count));
    expect(runGate(root).ok).toBe(true);
    expect(runGate(root, { strict: true }).ok).toBe(false);
    put(file, "args['no-worktree'];\n".repeat(count + 1));
    expect(runGate(root).ok).toBe(false);
  });

  it('fails when the scan root is missing (lost input is not a pass)', () => {
    expect(runGate(root).ok).toBe(false);
  });
});

describe('CLI entry point', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'negated flag gate with space-'));
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    copyFileSync(SCRIPT, join(dir, SCRIPT));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Run the copied script from a directory whose path contains a space. */
  function run() {
    const r = spawnSync('node', [join(dir, SCRIPT), '--check'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 10_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  }

  it('actually runs from a path with a space and exits 1 on a violation', () => {
    mkdirSync(join(dir, 'packages/cleo/src/cli/commands'), { recursive: true });
    writeFileSync(join(dir, CMD), "if (args['no-hygiene']) {}\n");
    const { code, out } = run();
    expect(code).toBe(1);
    expect(out).toContain('FAIL');
  });

  it('exits 0 with an OK line on a clean tree', () => {
    mkdirSync(join(dir, 'packages/cleo/src/cli/commands'), { recursive: true });
    writeFileSync(join(dir, CMD), "if (negatedFlag(args, 'hygiene')) {}\n");
    const { code, out } = run();
    expect(code).toBe(0);
    expect(out).toContain('OK');
  });
});
