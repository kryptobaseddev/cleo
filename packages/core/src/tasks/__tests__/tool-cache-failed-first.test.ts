/**
 * T12961 — failed-first reruns for `tool:test`.
 *
 * A failing test run records its failing test files; the next run in the same
 * tree re-runs only those first. Still red → that is the result and the full
 * command never spawns. Green → the normal command runs as before.
 *
 * The fixtures stand up a real git repo with a `vitest.config.ts` and a FAKE
 * `node_modules/.bin/vitest` that logs its argv and passes or fails according
 * to a state file outside the repo, and a "full suite" shell command that
 * does the same and counts its spawns. No real vitest is started.
 *
 * @task T12961
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cacheEntryPath,
  MAX_FLAKE_RETRY_FILES,
  readCacheEntry,
  runToolCached,
} from '../tool-cache.js';
import {
  extractFailingTestRefs,
  failedFirstPointerPath,
  parseFailingTestFiles,
  planFocusedRuns,
  readFailedFirstPointer,
} from '../tool-cache-failed-first.js';
import type { ResolvedToolCommand } from '../tool-resolver.js';
import { useRealToolRunner } from './real-tool-runner.js';

// These tests spawn tiny real commands on purpose (T13203 guard opt-in).
useRealToolRunner();

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
}

let originalCleoHome: string | undefined;
let cleoHomeDir: string;
beforeAll(() => {
  originalCleoHome = process.env['CLEO_HOME'];
  cleoHomeDir = mkdtempSync(join(tmpdir(), 'failed-first-cleohome-'));
  process.env['CLEO_HOME'] = cleoHomeDir;
});
afterAll(() => {
  rmSync(cleoHomeDir, { recursive: true, force: true });
  if (originalCleoHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = originalCleoHome;
});

describe('parseFailingTestFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ff-parse-'));
    mkdirSync(join(dir, 'packages', 'core', 'src'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'core', 'src', 'a.test.ts'), '');
    writeFileSync(join(dir, 'packages', 'core', 'src', 'b.spec.ts'), '');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads vitest FAIL lines with ANSI colour and a project label', () => {
    const out = [
      '\u001b[31m FAIL \u001b[39m |core| packages/core/src/a.test.ts > suite > case',
      ' ✓ packages/core/src/ok.test.ts (3 tests) 4ms',
    ].join('\n');
    expect(parseFailingTestFiles(out, dir)).toEqual(['packages/core/src/a.test.ts']);
  });

  it('reads the per-file ❯ summary only when it reports a failure', () => {
    const out = [
      ' ❯ packages/core/src/b.spec.ts (4 tests | 1 failed) 9ms',
      ' ❯ packages/core/src/a.test.ts (2 tests) 3ms',
    ].join('\n');
    expect(parseFailingTestFiles(out, dir)).toEqual(['packages/core/src/b.spec.ts']);
  });

  it('resolves a path relative to a `pnpm -r` package prefix', () => {
    const out = 'packages/core test:  FAIL  src/a.test.ts > suite > case';
    expect(extractFailingTestRefs(out)).toEqual([{ base: 'packages/core', file: 'src/a.test.ts' }]);
    expect(parseFailingTestFiles(out, dir)).toEqual(['packages/core/src/a.test.ts']);
  });

  it('falls back to a unique tracked-file suffix match', () => {
    const out = ' FAIL  src/a.test.ts > x';
    const tracked = () => ['packages/core/src/a.test.ts', 'packages/core/src/b.spec.ts'];
    expect(parseFailingTestFiles(out, dir, tracked)).toEqual(['packages/core/src/a.test.ts']);
  });

  it('drops an ambiguous or unresolvable reference', () => {
    const out = ' FAIL  src/a.test.ts > x\n FAIL  src/missing.test.ts > y';
    const tracked = () => ['p1/src/a.test.ts', 'p2/src/a.test.ts'];
    expect(parseFailingTestFiles(out, dir, tracked)).toEqual([]);
  });

  it('de-duplicates the many FAIL lines one file produces', () => {
    const out = [
      ' FAIL  packages/core/src/a.test.ts > s > one',
      ' FAIL  packages/core/src/a.test.ts > s > two',
    ].join('\n');
    expect(parseFailingTestFiles(out, dir)).toEqual(['packages/core/src/a.test.ts']);
  });

  it('returns nothing for output with no FAIL lines', () => {
    expect(parseFailingTestFiles('error: something broke\nexit 1', dir)).toEqual([]);
  });
});

describe('planFocusedRuns', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ff-plan-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('groups files under their nearest vitest config with the nearest vitest bin', () => {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.bin', 'vitest'), '');
    for (const pkg of ['core', 'cli']) {
      mkdirSync(join(dir, 'packages', pkg, 'src'), { recursive: true });
      writeFileSync(join(dir, 'packages', pkg, 'vitest.config.ts'), '');
      writeFileSync(join(dir, 'packages', pkg, 'src', 'x.test.ts'), '');
    }
    const plan = planFocusedRuns(
      ['packages/core/src/x.test.ts', 'packages/cli/src/x.test.ts'],
      dir,
    );
    expect(plan).toEqual([
      {
        cwd: join(dir, 'packages', 'core'),
        cmd: join(dir, 'node_modules', '.bin', 'vitest'),
        args: ['run', 'src/x.test.ts'],
      },
      {
        cwd: join(dir, 'packages', 'cli'),
        cmd: join(dir, 'node_modules', '.bin', 'vitest'),
        args: ['run', 'src/x.test.ts'],
      },
    ]);
  });

  it('declines (null) when there is no vitest config, binary, or file', () => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'x.test.ts'), '');
    expect(planFocusedRuns(['src/x.test.ts'], dir)).toBeNull();
    writeFileSync(join(dir, 'vitest.config.ts'), '');
    expect(planFocusedRuns(['src/x.test.ts'], dir)).toBeNull();
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.bin', 'vitest'), '');
    expect(planFocusedRuns(['src/x.test.ts'], dir)).not.toBeNull();
    expect(planFocusedRuns(['src/gone.test.ts'], dir)).toBeNull();
  });
});

describe('runToolCached — failed-first reruns and flake retries', () => {
  let repo: string;
  let side: string;
  let state: string;
  let fullLog: string;
  let focusedLog: string;
  let admissionLog: string;
  let cmd: ResolvedToolCommand;
  let root: string;

  /**
   * Shared state for the fake full suite and the fake vitest:
   *   red        — both fail (a real failure)
   *   green      — both pass
   *   flaky-full — the full suite fails on its FIRST run only, then passes
   *   isolated   — the focused file fails, the full suite passes
   *   crash      — focused vitest exits 1 with no FAIL line (startup crash)
   *   nofiles    — focused vitest reports "No test files found"
   */
  type State = 'red' | 'green' | 'flaky-full' | 'isolated' | 'crash' | 'nofiles';
  const setState = (value: State): void => writeFileSync(state, value);
  const lines = (f: string): string[] =>
    existsSync(f) ? readFileSync(f, 'utf-8').split('\n').filter(Boolean) : [];
  const fullRuns = (): number => lines(fullLog).length;
  const focusedCalls = (): string[] => lines(focusedLog);

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ff-repo-'));
    side = mkdtempSync(join(tmpdir(), 'ff-side-'));
    state = join(side, 'state');
    fullLog = join(side, 'full.log');
    focusedLog = join(side, 'focused.log');
    admissionLog = join(side, 'admission.log');

    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 'T');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.test.ts'), '// v1\n');
    writeFileSync(join(repo, 'src', 'b.test.ts'), '// v1\n');
    writeFileSync(join(repo, 'vitest.config.ts'), 'export default {};\n');
    writeFileSync(join(repo, '.gitignore'), 'node_modules\n.cleo\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    root = git(repo, 'rev-parse', '--show-toplevel');

    mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
    const bin = join(repo, 'node_modules', '.bin', 'vitest');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        `echo "$(pwd -P) $*" >> "${focusedLog}"`,
        `echo "adm=$CLEO_ADMISSION" >> "${admissionLog}"`,
        `s=$(cat "${state}")`,
        'if [ "$s" = red ] || [ "$s" = isolated ]; then echo " FAIL  src/a.test.ts > suite > case"; exit 1; fi',
        'if [ "$s" = crash ]; then echo "Error: failed to load config"; exit 1; fi',
        'if [ "$s" = nofiles ]; then echo "No test files found, exiting with code 1"; exit 1; fi',
        'echo " ✓ src/a.test.ts (1 test)"; exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(bin, 0o755);

    const once = join(side, 'full-failed-once');
    cmd = {
      canonical: 'test',
      displayName: 'test',
      cmd: 'sh',
      args: [
        '-c',
        [
          `echo run >> "${fullLog}"`,
          `s=$(cat "${state}")`,
          `if [ "$s" = flaky-full ] && [ ! -f "${once}" ]; then touch "${once}"; s=red; fi`,
          'if [ "$s" = red ]; then echo " FAIL  src/a.test.ts > suite > case"; exit 1; fi',
          'echo " Test Files  2 passed (2)"; exit 0',
        ].join('\n'),
      ],
      source: 'language-default',
    };
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(side, { recursive: true, force: true });
  });

  const run = (extra: { bypassCache?: boolean } = {}) =>
    runToolCached(cmd, repo, { skipGlobalSemaphore: true, spawnTimeoutMs: 30_000, ...extra });
  /** A tracked edit, so the next run is on a new tree (a cache miss). */
  const edit = (label: string): void =>
    writeFileSync(join(repo, 'src', 'a.test.ts'), `// ${label}\n`);
  const focusedA = (): string => `${root} run src/a.test.ts`;

  it('a failing run is re-run in FULL once, then stores the failing files on the entry and pointer', async () => {
    setState('red');
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(fullRuns()).toBe(2); // the run + its one full retry
    expect(focusedCalls()).toEqual([]); // never a focused retry
    expect(r.entry.failedTestFiles).toEqual(['src/a.test.ts']);
    expect(r.flaky).toBeUndefined();
    expect(readFailedFirstPointer(repo, 'test', root)?.files).toEqual(['src/a.test.ts']);
  });

  it('FLAKE: a failure whose full rerun passes is a pass marked `flaky` with the first run’s files', async () => {
    setState('flaky-full');
    const r = await run();
    expect(fullRuns()).toBe(2);
    expect(r.exitCode).toBe(0);
    expect(r.flaky).toEqual(['src/a.test.ts']);
    expect(r.entry.flaky).toEqual(['src/a.test.ts']);
    expect(r.entry.flakyFailureTail).toContain('FAIL  src/a.test.ts');
    expect(r.entry.failedTestFiles).toBeUndefined();
    expect(existsSync(failedFirstPointerPath(repo, 'test', root))).toBe(false);

    // Cached as a flaky pass — visible on every hit, not a clean pass.
    const again = await run();
    expect(again.cacheHit).toBe(true);
    expect(again.flaky).toEqual(['src/a.test.ts']);
    expect(fullRuns()).toBe(2);
  });

  it('FLAKE retry only for a NARROW failure: more than MAX_FLAKE_RETRY_FILES named files are not retried', async () => {
    const many = Array.from({ length: MAX_FLAKE_RETRY_FILES + 1 }, (_, i) => `src/m${i}.test.ts`);
    for (const f of many) writeFileSync(join(repo, f), '// m\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'many');
    const fails = many.map((f) => `echo " FAIL  ${f} > s"`).join('; ');
    cmd = { ...cmd, args: ['-c', `echo run >> "${fullLog}"; ${fails}; exit 1`] };
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(fullRuns()).toBe(1);
    expect(r.entry.failedTestFiles).toHaveLength(MAX_FLAKE_RETRY_FILES + 1);
  });

  it('fail-then-fix: re-runs the failing file first, then the full suite, then clears', async () => {
    setState('red');
    await run();
    edit('fixed');
    setState('green');
    const r = await run();

    expect(focusedCalls()).toEqual([focusedA()]);
    expect(r.failedFirst).toEqual({ files: ['src/a.test.ts'], outcome: 'passed' });
    expect(r.entry.failedFirst?.outcome).toBe('passed');
    expect(r.exitCode).toBe(0);
    expect(r.cacheHit).toBe(false);
    expect(fullRuns()).toBe(3);
    expect(existsSync(failedFirstPointerPath(repo, 'test', root))).toBe(false);
  });

  it('fail-then-still-fail: the focused red returns at once, uncached and marked focused', async () => {
    setState('red');
    await run();
    expect(fullRuns()).toBe(2);

    edit('attempted fix');
    const r = await run();
    expect(focusedCalls()).toEqual([focusedA()]);
    expect(fullRuns()).toBe(2); // the full suite did not run
    expect(r.exitCode).toBe(1);
    expect(r.failedFirst).toEqual({ files: ['src/a.test.ts'], outcome: 'failed' });
    expect(r.entry.scope).toBe('focused');
    expect(r.entry.ranFiles).toEqual(['src/a.test.ts']);
    expect(existsSync(cacheEntryPath(repo, r.entry.key))).toBe(true); // only the pending placeholder
    expect(readCacheEntry(repo, r.entry.key)).toBeNull(); // never served as the suite's result

    // Same tree again: the pointer is on this tree, so the normal command
    // decides (and its red result is cached).
    const again = await run();
    expect(focusedCalls()).toHaveLength(1);
    expect(fullRuns()).toBe(4);
    expect(again.exitCode).toBe(1);
    expect(again.entry.scope).toBeUndefined();
    const third = await run();
    expect(third.cacheHit).toBe(true);
  });

  it("the focused rerun carries the run's admission token, so a nested cleo rides the grant (#1875 review)", async () => {
    setState('red');
    await run();
    edit('attempted fix');
    // Through the real ledger (sandboxed CLEO_HOME, no pressure sampling).
    const prev = process.env.CLEO_ADMISSION_PRESSURE;
    process.env.CLEO_ADMISSION_PRESSURE = 'off';
    try {
      const r = await runToolCached(cmd, repo, { spawnTimeoutMs: 30_000 });
      expect(r.failedFirst?.outcome).toBe('failed');
    } finally {
      if (prev === undefined) delete process.env.CLEO_ADMISSION_PRESSURE;
      else process.env.CLEO_ADMISSION_PRESSURE = prev;
    }
    expect(lines(admissionLog)).toHaveLength(1);
    expect(lines(admissionLog)[0]).toMatch(/^adm=\d+-\d+-[0-9a-f]+\.[0-9a-f]+$/);
  });

  it('LIVENESS: a file that fails only in isolation cannot pin the tree red', async () => {
    setState('red');
    await run();
    edit('changed');
    setState('isolated');
    const focusedRed = await run();
    expect(focusedRed.exitCode).toBe(1);
    expect(focusedRed.entry.scope).toBe('focused');
    // Next run on the same tree: the real suite runs and passes.
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(r.entry.scope).toBeUndefined();
    expect(existsSync(failedFirstPointerPath(repo, 'test', root))).toBe(false);
  });

  it('LIVENESS: CLEO_EVIDENCE_FRESH / bypassCache skips failed-first', async () => {
    setState('red');
    await run();
    edit('changed');
    setState('green');
    const r = await run({ bypassCache: true });
    expect(focusedCalls()).toEqual([]);
    expect(r.failedFirst).toBeUndefined();
    expect(r.exitCode).toBe(0);
  });

  it('LIVENESS: a focused run with no FAIL line (startup crash) is inconclusive and runs the normal command', async () => {
    setState('red');
    await run();
    edit('changed');
    setState('crash');
    const r = await run();
    expect(r.failedFirst?.outcome).toBe('inconclusive');
    expect(r.exitCode).toBe(0); // the full suite passes in the crash state
    expect(fullRuns()).toBe(3);
  });

  it('"No test files found" is inconclusive: falls back to the full suite', async () => {
    setState('red');
    await run();
    edit('changed');
    setState('nofiles');
    const r = await run();
    expect(r.failedFirst?.outcome).toBe('inconclusive');
    expect(fullRuns()).toBe(3);
  });

  it('falls back to today’s behaviour when the failing files cannot be named', async () => {
    cmd = { ...cmd, args: ['-c', `echo run >> "${fullLog}"; echo "something broke"; exit 1`] };
    setState('red');
    const first = await run();
    expect(first.entry.failedTestFiles).toBeUndefined();
    edit('changed');
    const r = await run();
    expect(r.failedFirst).toBeUndefined();
    expect(focusedCalls()).toEqual([]);
    expect(fullRuns()).toBe(2); // unnamed failing files: no flake retry
  });

  it('the result exposes `flaky`, `treeHash` and `cacheHit` for evidence atoms', async () => {
    setState('flaky-full');
    const first = await run();
    expect(first.flaky).toEqual(['src/a.test.ts']);
    expect(first.treeHash).toBe(git(repo, 'rev-parse', 'HEAD^{tree}'));
    expect(first.cacheHit).toBe(false);
    const second = await run();
    expect(second.cacheHit).toBe(true);
    expect(second.treeHash).toBe(first.treeHash);
    expect(second.flaky).toEqual(['src/a.test.ts']);
  });

  it('only `test` records failing files or retries — other tools are untouched', async () => {
    setState('red');
    cmd = { ...cmd, canonical: 'lint', displayName: 'lint' };
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(fullRuns()).toBe(1);
    expect(r.entry.failedTestFiles).toBeUndefined();
    expect(existsSync(failedFirstPointerPath(repo, 'lint', root))).toBe(false);
  });
});
