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

import { runToolCached } from '../tool-cache.js';
import {
  extractFailingTestRefs,
  failedFirstPointerPath,
  parseFailingTestFiles,
  planFocusedRuns,
  readFailedFirstPointer,
} from '../tool-cache-failed-first.js';
import type { ResolvedToolCommand } from '../tool-resolver.js';

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

describe('runToolCached — failed-first reruns', () => {
  let repo: string;
  let side: string;
  let state: string;
  let fullLog: string;
  let focusedLog: string;
  let cmd: ResolvedToolCommand;

  /** Red/green state shared by the fake suite and the fake vitest. */
  const setState = (value: 'red' | 'green' | 'nofiles'): void => writeFileSync(state, value);
  const fullRuns = (): number =>
    existsSync(fullLog) ? readFileSync(fullLog, 'utf-8').split('\n').filter(Boolean).length : 0;
  const focusedCalls = (): string[] =>
    existsSync(focusedLog) ? readFileSync(focusedLog, 'utf-8').split('\n').filter(Boolean) : [];

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ff-repo-'));
    side = mkdtempSync(join(tmpdir(), 'ff-side-'));
    state = join(side, 'state');
    fullLog = join(side, 'full.log');
    focusedLog = join(side, 'focused.log');

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

    // Fake vitest: log argv, then behave per the state file.
    mkdirSync(join(repo, 'node_modules', '.bin'), { recursive: true });
    const bin = join(repo, 'node_modules', '.bin', 'vitest');
    writeFileSync(
      bin,
      [
        '#!/bin/sh',
        `echo "$(pwd -P) $*" >> "${focusedLog}"`,
        `s=$(cat "${state}")`,
        'if [ "$s" = red ]; then echo " FAIL  src/a.test.ts > suite > case"; exit 1; fi',
        'if [ "$s" = nofiles ]; then echo "No test files found, exiting with code 1"; exit 1; fi',
        'echo " ✓ src/a.test.ts (1 test)"; exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(bin, 0o755);

    // The "full suite": counts its spawns; red names a.test.ts as failing.
    cmd = {
      canonical: 'test',
      displayName: 'test',
      cmd: 'sh',
      args: [
        '-c',
        [
          `echo run >> "${fullLog}"`,
          `s=$(cat "${state}")`,
          'if [ "$s" = red ]; then echo " FAIL  src/a.test.ts > suite > case"; echo " Test Files  1 failed | 1 passed (2)"; exit 1; fi',
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

  const run = () => runToolCached(cmd, repo, { skipGlobalSemaphore: true, spawnTimeoutMs: 30_000 });
  /** A tracked edit, so the next run is on a new tree (a cache miss). */
  const edit = (label: string): void =>
    writeFileSync(join(repo, 'src', 'a.test.ts'), `// ${label}\n`);

  it('a failing run stores the failing test files on the entry and in the pointer', async () => {
    setState('red');
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.entry.failedTestFiles).toEqual(['src/a.test.ts']);
    expect(r.failedFirst).toBeUndefined();
    const root = git(repo, 'rev-parse', '--show-toplevel');
    expect(readFailedFirstPointer(repo, 'test', root)?.files).toEqual(['src/a.test.ts']);
  });

  it('fail-then-fix: re-runs the failing file first, then the full suite, then clears', async () => {
    setState('red');
    await run();
    expect(fullRuns()).toBe(1);

    edit('fixed');
    setState('green');
    const r = await run();

    expect(focusedCalls()).toEqual([
      `${git(repo, 'rev-parse', '--show-toplevel')} run src/a.test.ts`,
    ]);
    expect(r.failedFirst).toEqual({ files: ['src/a.test.ts'], outcome: 'passed' });
    expect(r.exitCode).toBe(0);
    expect(r.cacheHit).toBe(false);
    expect(fullRuns()).toBe(2);
    const root = git(repo, 'rev-parse', '--show-toplevel');
    expect(existsSync(failedFirstPointerPath(repo, 'test', root))).toBe(false);

    // A later run on a new tree has nothing to try first.
    edit('later');
    await run();
    expect(focusedCalls()).toHaveLength(1);
    expect(fullRuns()).toBe(3);
  });

  it('fail-then-still-fail: stops after the focused run, never spawning the full suite', async () => {
    setState('red');
    await run();
    expect(fullRuns()).toBe(1);

    edit('attempted fix');
    const r = await run();

    expect(focusedCalls()).toHaveLength(1);
    expect(fullRuns()).toBe(1);
    expect(r.exitCode).toBe(1);
    expect(r.failedFirst).toEqual({ files: ['src/a.test.ts'], outcome: 'failed' });
    expect(r.entry.failedTestFiles).toEqual(['src/a.test.ts']);
    expect(r.stdoutTail).toContain('FAIL  src/a.test.ts');

    // The focused failure is cached under the normal key: same tree, no spawn.
    const again = await run();
    expect(again.cacheHit).toBe(true);
    expect(again.exitCode).toBe(1);
    expect(again.failedFirst?.outcome).toBe('failed');
    expect(focusedCalls()).toHaveLength(1);
    expect(fullRuns()).toBe(1);
  });

  it('"No test files found" is inconclusive: falls back to the full suite', async () => {
    setState('red');
    await run();
    edit('changed');
    setState('nofiles');
    const r = await run();
    expect(r.failedFirst?.outcome).toBe('inconclusive');
    expect(fullRuns()).toBe(2);
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
    expect(fullRuns()).toBe(2);
  });

  it('only `test` records failing files — other tools are untouched', async () => {
    setState('red');
    cmd = { ...cmd, canonical: 'lint', displayName: 'lint' };
    const r = await run();
    expect(r.entry.failedTestFiles).toBeUndefined();
    const root = git(repo, 'rev-parse', '--show-toplevel');
    expect(existsSync(failedFirstPointerPath(repo, 'lint', root))).toBe(false);
  });
});
