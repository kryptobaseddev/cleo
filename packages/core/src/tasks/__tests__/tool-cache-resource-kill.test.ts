/**
 * T12989 — a run killed for resources is never a reusable red, and the cache
 * key carries the heap and worker limits the run was given.
 *
 * Field report (axiom, T963): a `tool:test` run under a 3 GB heap ran out of
 * memory; vitest caught the worker's OOM and exited 1, which the cache stored
 * as an ordinary red. The retry under a 6 GB heap computed the SAME key — the
 * key saw the tree, the installed deps and the command, never `NODE_OPTIONS` —
 * and was served the 3 GB OOM until someone deleted the entry by hand.
 *
 * Two independent defects, each sufficient on its own:
 *
 *   1. a resource kill was cached at all (`resourceKillReason`, rule 3 of
 *      `isEntryUsable`);
 *   2. a heap or worker change did not move the key (`captureResourceEnv`,
 *      the `resourceEnv` identity field).
 *
 * The runtime tests spawn real `sh` scripts that PRINT what an OOM prints, or
 * kill their own shell, and count their spawns in a side directory outside the
 * repo (a marker inside it would move the tree hash). Reproducing real memory
 * exhaustion would test V8 and the kernel, not this module.
 *
 * @task T12989
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { HEAVY_TOOL_HEAP_MB, heavyRunBudgetMb, heavyToolEnv } from '../heavy-tool-env.js';
import { resourceKillReason, runToolCached } from '../tool-cache.js';
import { captureResourceEnv, effectiveHeapFlags } from '../tool-cache-env.js';
import { readFailedFirstPointer } from '../tool-cache-failed-first.js';
import type { ResolvedToolCommand } from '../tool-resolver.js';

const OOM_LINE =
  'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory';

describe('resourceKillReason', () => {
  const run = (exitCode: number | null, out = '', signal: NodeJS.Signals | null = null) => ({
    exitCode,
    signal,
    stdout: out,
    stderr: '',
  });

  it('a plain non-zero exit is a real result — failed-first needs it cached', () => {
    expect(resourceKillReason(run(1, ' FAIL  src/a.test.ts > suite > case'))).toBeNull();
    expect(resourceKillReason(run(7))).toBeNull();
  });

  it('exit 0 is always a result, whatever the output says', () => {
    expect(resourceKillReason(run(0, OOM_LINE))).toBeNull();
  });

  it('a run that never started is not a kill', () => {
    expect(resourceKillReason(run(null))).toBeNull();
  });

  it('a heap OOM the runner turned into exit 1 is a kill', () => {
    expect(resourceKillReason(run(1, OOM_LINE))).toBe(
      'output reports "JavaScript heap out of memory"',
    );
    expect(resourceKillReason(run(1, '<--- Last few GCs ---> Reached heap limit'))).not.toBeNull();
    expect(
      resourceKillReason(run(1, 'Error [ERR_WORKER_OUT_OF_MEMORY]: Worker terminated')),
    ).not.toBeNull();
    expect(
      resourceKillReason({ exitCode: 1, signal: null, stdout: '', stderr: OOM_LINE }),
      'stderr is read as well as stdout',
    ).not.toBeNull();
  });

  it('a kill signal reported as 128 + n by a wrapper is a kill', () => {
    expect(resourceKillReason(run(137))).toBe('exit 137 (128 + SIGKILL)');
    expect(resourceKillReason(run(143))).toBe('exit 143 (128 + SIGTERM)');
    expect(resourceKillReason(run(134))).toBe('exit 134 (128 + SIGABRT)');
  });

  it('a segfault stays a result — it can be a deterministic bug in the code', () => {
    expect(resourceKillReason(run(139))).toBeNull();
  });

  it('a terminating signal is a kill', () => {
    expect(resourceKillReason(run(null, '', 'SIGKILL'))).toBe('killed by SIGKILL');
    expect(resourceKillReason(run(null, '', 'SIGTERM'))).toBe('killed by SIGTERM');
  });
});

describe('effectiveHeapFlags', () => {
  it('keeps only the heap flags, the last occurrence winning', () => {
    expect(
      effectiveHeapFlags(
        '--enable-source-maps --max-old-space-size=3072 --require ./x.js --max-old-space-size=6144',
      ),
    ).toBe('--max-old-space-size=6144');
  });

  it('reads underscores as dashes and the space-separated spelling', () => {
    expect(effectiveHeapFlags('--max_old_space_size=8192')).toBe('--max-old-space-size=8192');
    expect(effectiveHeapFlags('--max-old-space-size 2048')).toBe('--max-old-space-size=2048');
    expect(effectiveHeapFlags('--max-semi-space-size=64 --max-old-space-size=4096')).toBe(
      '--max-old-space-size=4096 --max-semi-space-size=64',
    );
  });

  it('is empty when no heap flag is set', () => {
    expect(effectiveHeapFlags(undefined)).toBe('');
    expect(effectiveHeapFlags('--enable-source-maps --experimental-vm-modules')).toBe('');
  });
});

describe('captureResourceEnv', () => {
  // T13122: the overlay is planned against a RAM-derived budget, so the key
  // reads it on a fixed 62 GiB machine rather than whatever runs the suite.
  const keyed = (canonical: 'test' | 'lint', env: NodeJS.ProcessEnv): string =>
    captureResourceEnv(canonical, env, heavyToolEnv(canonical, env, 62));

  it('a heavy tool keys the heap the overlay supplies when the caller sets none', () => {
    expect(keyed('test', {})).toContain(`NODE_OPTIONS=--max-old-space-size=${HEAVY_TOOL_HEAP_MB}`);
  });

  it("a heavy tool keys the caller's heap when it sets one", () => {
    const env = { NODE_OPTIONS: '--max-old-space-size=6144' };
    expect(keyed('test', env)).toContain('NODE_OPTIONS=--max-old-space-size=6144');
    expect(keyed('test', env)).not.toBe(
      keyed('test', { NODE_OPTIONS: '--max-old-space-size=3072' }),
    );
  });

  it('keys the heap and workers the run GETS: an inherited heap above the budget is clamped (T13122)', () => {
    // 65536 MiB is above the 24 GiB budget of a 62 GiB machine, so the run is
    // spawned with the budget, and keyed with it — not with what was asked.
    expect(keyed('test', { NODE_OPTIONS: '--max-old-space-size=65536' })).toBe(
      keyed('test', { NODE_OPTIONS: '--max-old-space-size=24576' }),
    );
    // A kept inherited heap shrinks the worker count, which the key carries.
    expect(keyed('test', { NODE_OPTIONS: '--max-old-space-size=8192' })).toContain(
      'VITEST_MAX_WORKERS=3',
    );
  });

  it('an unrelated NODE_OPTIONS flag does not move it', () => {
    expect(
      captureResourceEnv('test', {
        NODE_OPTIONS: '--enable-source-maps --max-old-space-size=6144',
      }),
    ).toBe(captureResourceEnv('test', { NODE_OPTIONS: '--max-old-space-size=6144' }));
  });

  it('every variable heavyToolEnv sets is keyed for a heavy tool', () => {
    // Derived from heavyToolEnv itself, so this fails if a lever is added there
    // and somehow left out of the key. Each value is one the plan KEEPS (a
    // lower heap or count; MAKEFLAGS is never rewritten): a value it clamps is
    // spawned, and keyed, as the plan's own (T13122).
    const levers = Object.keys(heavyToolEnv('test', {}));
    expect(levers).toEqual(expect.arrayContaining(['VITEST_MAX_WORKERS', 'JEST_MAX_WORKERS']));
    const reference = keyed('test', {});
    for (const name of levers) {
      const value =
        name === 'NODE_OPTIONS' ? '--max-old-space-size=1234' : name === 'MAKEFLAGS' ? '-j97' : '1';
      if (
        name === 'npm_config_workspace_concurrency' ||
        name === 'pnpm_config_workspace_concurrency'
      ) {
        // The plan is already 1, the lowest value there is; keyed all the same.
        expect(reference).toContain(`${name}=1`);
        continue;
      }
      expect(keyed('test', { [name]: value }), `${name} must move the key`).not.toBe(reference);
    }
  });

  it('the cgroup ceiling overrides are keyed for a heavy tool', () => {
    const reference = captureResourceEnv('test', {});
    expect(captureResourceEnv('test', { CLEO_TOOL_MEMORY_MAX_MB: '16384' })).not.toBe(reference);
    expect(captureResourceEnv('test', { CLEO_NO_TOOL_CGROUP: '1' })).not.toBe(reference);
  });

  it("MAKEFLAGS' per-invocation jobserver handle does not move it", () => {
    expect(
      captureResourceEnv('test', { MAKEFLAGS: '-j4 --jobserver-auth=fifo:/tmp/GMfifo123' }),
    ).toBe(captureResourceEnv('test', { MAKEFLAGS: '-j4 --jobserver-auth=fifo:/tmp/GMfifo456' }));
  });

  it('a non-heavy tool keys only the heap: worker counts are inert for it', () => {
    expect(captureResourceEnv('lint', { VITEST_MAX_WORKERS: '2' })).toBe(
      captureResourceEnv('lint', { VITEST_MAX_WORKERS: '6' }),
    );
    expect(captureResourceEnv('lint', { NODE_OPTIONS: '--max-old-space-size=3072' })).toBe(
      'NODE_OPTIONS=--max-old-space-size=3072',
    );
  });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).trim();
}

/** Non-pending entries in the project's evidence cache directory. */
function persistedEntries(projectRoot: string): Array<Record<string, unknown>> {
  const dir = join(projectRoot, '.cleo', 'cache', 'evidence');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^[0-9a-f]{32}\.json$/.test(f))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Record<string, unknown>)
    .filter((e) => e['pending'] !== true);
}

const ENV_KEYS = [
  'CLEO_HOME',
  'CLEO_NO_TOOL_CGROUP',
  'NODE_OPTIONS',
  'VITEST_MAX_WORKERS',
] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;
let cleoHomeDir: string;
beforeAll(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) if (process.env[k] !== undefined) savedEnv[k] = process.env[k];
  cleoHomeDir = mkdtempSync(join(tmpdir(), 't12989-cleohome-'));
  process.env['CLEO_HOME'] = cleoHomeDir;
  // Deterministic spawn shape on every platform: these tests exercise the
  // cache, not the systemd scope.
  process.env['CLEO_NO_TOOL_CGROUP'] = '1';
});
afterAll(() => {
  rmSync(cleoHomeDir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('runToolCached — resource kills and resource limits (T12989)', () => {
  let repo: string;
  let side: string;
  let spawns: string;
  let root: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 't12989-repo-'));
    side = mkdtempSync(join(tmpdir(), 't12989-side-'));
    spawns = join(side, 'spawns');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t.t');
    git(repo, 'config', 'user.name', 'T');
    execFileSync('mkdir', ['-p', join(repo, 'src')]);
    writeFileSync(join(repo, 'src', 'a.test.ts'), '// v1\n');
    writeFileSync(join(repo, '.gitignore'), '.cleo\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');
    root = git(repo, 'rev-parse', '--show-toplevel');
    delete process.env['NODE_OPTIONS'];
    delete process.env['VITEST_MAX_WORKERS'];
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(side, { recursive: true, force: true });
    delete process.env['NODE_OPTIONS'];
    delete process.env['VITEST_MAX_WORKERS'];
  });

  /** A `test` command that logs each spawn outside the repo, then runs `body`. */
  const testCommand = (body: string): ResolvedToolCommand => ({
    canonical: 'test',
    displayName: 'test',
    cmd: 'sh',
    args: ['-c', `echo run >> "${spawns}"\n${body}`],
    source: 'language-default',
  });
  const spawnCount = (): number =>
    existsSync(spawns) ? readFileSync(spawns, 'utf-8').split('\n').filter(Boolean).length : 0;
  const run = (cmd: ResolvedToolCommand) =>
    runToolCached(cmd, repo, { skipGlobalSemaphore: true, spawnTimeoutMs: 30_000 });

  it('AC1: a heap OOM reported as exit 1 is returned but never cached', async () => {
    const cmd = testCommand(`echo "${OOM_LINE}" >&2; exit 1`);

    const first = await run(cmd);
    expect(first.exitCode).toBe(1);
    expect(first.resourceKill).toBe('output reports "JavaScript heap out of memory"');
    expect(first.cacheHit).toBe(false);
    expect(persistedEntries(repo)).toEqual([]);

    // Same tree, same limits, same key: had the OOM been cached, this would be
    // served from it without spawning.
    const second = await run(cmd);
    expect(second.cacheHit).toBe(false);
    expect(spawnCount()).toBe(2);
  });

  it('AC1: a kill a wrapper reports as exit 137 is never cached', async () => {
    // The inner shell SIGKILLs itself; the outer one reports it as 128 + 9,
    // exactly what `pnpm` or `sh -c` hand back for an OOM-killed child.
    const cmd = testCommand(`sh -c 'kill -9 $$'; exit $?`);

    const first = await run(cmd);
    expect(first.exitCode).toBe(137);
    expect(first.signal).toBeNull();
    expect(first.resourceKill).toBe('exit 137 (128 + SIGKILL)');

    const second = await run(cmd);
    expect(second.cacheHit).toBe(false);
    expect(spawnCount()).toBe(2);
    expect(persistedEntries(repo)).toEqual([]);
  });

  it('AC1: a plain assertion failure IS still cached — the guard is narrow', async () => {
    const cmd = testCommand('echo " FAIL  src/nope.test.ts > suite > case"; exit 1');

    const first = await run(cmd);
    expect(first.exitCode).toBe(1);
    expect(first.resourceKill).toBeNull();

    const second = await run(cmd);
    expect(second.cacheHit).toBe(true);
    expect(second.exitCode).toBe(1);
  });

  it('AC1: an OOM is not flake-retried and leaves no failed-first pointer', async () => {
    // A FAIL line that names a real tracked file would normally trigger the one
    // full flake retry and record the file for failed-first.
    const cmd = testCommand(
      `echo " FAIL  src/a.test.ts > suite > case"; echo "${OOM_LINE}" >&2; exit 1`,
    );

    const r = await run(cmd);
    expect(r.exitCode).toBe(1);
    expect(r.resourceKill).not.toBeNull();
    expect(spawnCount()).toBe(1);
    expect(r.entry.failedTestFiles).toBeUndefined();
    expect(readFailedFirstPointer(repo, 'test', root)).toBeNull();
  });

  it('AC1: a flake retry killed for resources decides nothing — the first failure stands', async () => {
    // First spawn: a genuine assertion failure in a tracked file, which earns
    // the one full flake retry. Second spawn (the retry): an OOM. The retry
    // is not a verdict, so the first run's red is the result, and that red is
    // a real one — cached, with the first run's output and failing files.
    const cmd = testCommand(
      [
        `if [ "$(grep -c . "${spawns}")" -eq 1 ]; then`,
        '  echo "first-run"; echo " FAIL  src/a.test.ts > suite > case"; exit 1',
        'fi',
        `echo "second-run"; echo " FAIL  src/a.test.ts > suite > case"; echo "${OOM_LINE}" >&2; exit 1`,
      ].join('\n'),
    );

    const r = await run(cmd);
    expect(spawnCount()).toBe(2);
    expect(r.exitCode).toBe(1);
    expect(r.resourceKill).toBeNull();
    expect(r.entry.stdoutTail).toContain('first-run');
    expect(r.entry.stdoutTail).not.toContain('second-run');
    expect(r.entry.stderrTail).not.toContain('JavaScript heap out of memory');
    expect(r.entry.failedTestFiles).toEqual(['src/a.test.ts']);
    expect(readFailedFirstPointer(repo, 'test', root)?.files).toEqual(['src/a.test.ts']);

    const again = await run(cmd);
    expect(again.cacheHit).toBe(true);
    expect(again.entry.stdoutTail).toContain('first-run');
    expect(spawnCount()).toBe(2);
  });

  it('AC1: a focused failed-first run killed for resources is inconclusive', async () => {
    // Fake vitest for the focused stage: it names the failing file AND reports
    // an OOM. A focused run may shorten a red result but never invent one, so
    // the normal command must decide.
    writeFileSync(join(repo, 'vitest.config.ts'), 'export default {};\n');
    writeFileSync(join(repo, '.gitignore'), '.cleo\nnode_modules\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'vitest');
    execFileSync('mkdir', ['-p', join(repo, 'node_modules', '.bin')]);
    const bin = join(repo, 'node_modules', '.bin', 'vitest');
    writeFileSync(
      bin,
      `#!/bin/sh\necho " FAIL  src/a.test.ts > suite > case"\necho "${OOM_LINE}" >&2\nexit 1\n`,
    );
    execFileSync('chmod', ['755', bin]);
    const state = join(side, 'state');
    const cmd = testCommand(
      `if [ "$(cat "${state}")" = red ]; then echo " FAIL  src/a.test.ts > suite > case"; exit 1; fi; echo ok`,
    );

    writeFileSync(state, 'red');
    const red = await run(cmd);
    expect(red.exitCode).toBe(1);
    expect(readFailedFirstPointer(repo, 'test', root)?.files).toEqual(['src/a.test.ts']);

    writeFileSync(join(repo, 'src', 'a.test.ts'), '// fixed\n');
    writeFileSync(state, 'green');
    const fixed = await run(cmd);
    expect(fixed.exitCode).toBe(0);
    expect(fixed.failedFirst?.outcome).toBe('inconclusive');
    expect(fixed.entry.scope).toBeUndefined();
  });

  // T13122: an inherited heap or worker count is kept only within the run's
  // RAM-derived budget, so these use values that fit every machine CI runs on
  // (a 7 GiB runner's budget is 3584 MiB × 1 worker) — or the explicit
  // CLEO_HEAVY_* overrides, which are never clamped.
  it('AC3: a heap change misses the cache; an unrelated NODE_OPTIONS flag does not', async () => {
    const cmd = testCommand('echo ok');

    process.env['NODE_OPTIONS'] = '--max-old-space-size=1024';
    expect((await run(cmd)).cacheHit).toBe(false);
    const hit = await run(cmd);
    expect(hit.cacheHit).toBe(true);
    expect(hit.entry.resourceEnv).toContain('NODE_OPTIONS=--max-old-space-size=1024');

    process.env['NODE_OPTIONS'] = '--max-old-space-size=2048';
    const bigger = await run(cmd);
    expect(bigger.cacheHit).toBe(false);
    expect(bigger.entry.resourceEnv).toContain('NODE_OPTIONS=--max-old-space-size=2048');
    expect(spawnCount()).toBe(2);

    process.env['NODE_OPTIONS'] = '--enable-source-maps --max-old-space-size=2048';
    expect((await run(cmd)).cacheHit).toBe(true);
    expect(spawnCount()).toBe(2);
  });

  it('AC3: a worker-count change misses the cache', async () => {
    const cmd = testCommand('echo ok');
    process.env['CLEO_HEAVY_WORKERS'] = '6';
    try {
      await run(cmd);
      expect((await run(cmd)).cacheHit).toBe(true);

      process.env['CLEO_HEAVY_WORKERS'] = '2';
      expect((await run(cmd)).cacheHit).toBe(false);
      expect(spawnCount()).toBe(2);
    } finally {
      delete process.env['CLEO_HEAVY_WORKERS'];
    }
  });

  it('the field report: OOM at 3 GB, then a 6 GB retry runs and passes', async () => {
    // Runs out of memory exactly when it is given 3072 MiB. The retry raises
    // the heap the way the resource-kill message says to (T13122).
    const cmd = testCommand(
      `case "$NODE_OPTIONS" in *=3072*) echo "${OOM_LINE}" >&2; exit 1;; esac; echo ok`,
    );

    try {
      process.env['CLEO_HEAVY_HEAP_MB'] = '3072';
      const oom = await run(cmd);
      expect(oom.exitCode).toBe(1);
      expect(oom.resourceKill).not.toBeNull();

      process.env['CLEO_HEAVY_HEAP_MB'] = '6144';
      const retry = await run(cmd);
      expect(retry.cacheHit).toBe(false);
      expect(retry.exitCode).toBe(0);
      expect(retry.resourceKill).toBeNull();

      // And going back to 3 GB re-runs rather than replaying anything.
      process.env['CLEO_HEAVY_HEAP_MB'] = '3072';
      const again = await run(cmd);
      expect(again.cacheHit).toBe(false);
      expect(again.resourceKill).not.toBeNull();
      expect(spawnCount()).toBe(3);
    } finally {
      delete process.env['CLEO_HEAVY_HEAP_MB'];
    }
  });

  it('T13122: an inherited heap above the budget reaches the tool clamped, and the result says so', async () => {
    const seen = join(side, 'node-options');
    const cmd = testCommand(`printf '%s' "$NODE_OPTIONS" > "${seen}"; echo ok`);
    process.env['NODE_OPTIONS'] = '--enable-source-maps --max-old-space-size=999999';

    const result = await run(cmd);
    expect(result.exitCode).toBe(0);
    expect(result.resources?.heapSource).toBe('clamped');
    expect(result.resources?.inheritedHeapMb).toBe(999999);
    expect(result.resources?.heapMb).toBe(heavyRunBudgetMb());
    expect(readFileSync(seen, 'utf-8')).toBe(
      `--enable-source-maps --max-old-space-size=${heavyRunBudgetMb()}`,
    );
    // A cache hit reports the same plan: the key carries the limits.
    const hit = await run(cmd);
    expect(hit.cacheHit).toBe(true);
    expect(hit.resources?.summary).toBe(result.resources?.summary);
  });
});
