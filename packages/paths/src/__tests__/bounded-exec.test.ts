/**
 * T14670 AC1 — a sync `gh`/`git`/`ps` exec must not block past its timeout.
 *
 * `execFileSync`'s timeout sends SIGTERM to the direct child only and then
 * waits for that child to exit. A child that ignores SIGTERM (here a stub
 * `gh` that traps it and forks a grandchild holding stdout open) keeps the
 * main thread blocked for as long as it lives. While it is blocked no libuv
 * loop runs: async children that finished stay defunct, and no JS signal
 * listener runs — the state `cleo review verdict` pid 42072 was found in.
 *
 * The control runs the raw options and must still be blocked, with both
 * async children defunct, long after its 1 s timeout. The fixed run passes
 * the same options through `boundedExecOptions` and must return at the
 * timeout. Remove `killSignal: 'SIGKILL'` from `boundedExecOptions` and the
 * fixed run blocks exactly like the control.
 *
 * @task T14670
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/** How long the stub `gh` (and its grandchild) live, in s. */
const STUB_LIFE_S = 8;
/** The exec's own timeout. */
const TIMEOUT_MS = 1_000;

const sandbox = mkdtempSync(join(tmpdir(), 'cleo-bounded-exec-'));

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** A stub `gh` that ignores SIGTERM and forks a grandchild holding stdout. */
function writeStubGh(): string {
  const bin = join(sandbox, 'bin');
  spawnSync('mkdir', ['-p', bin]);
  const gh = join(bin, 'gh');
  writeFileSync(
    gh,
    [
      '#!/bin/sh',
      "trap '' TERM",
      `( sleep ${STUB_LIFE_S} ) &`,
      'echo 0123456789abcdef0123456789abcdef01234567',
      `sleep ${STUB_LIFE_S}`,
      '',
    ].join('\n'),
  );
  chmodSync(gh, 0o755);
  return bin;
}

/**
 * Bundle a child: two async children that exit 800 ms in, then (at 400 ms,
 * while both still run) one sync `gh pr view`, so they finish while the main
 * thread is inside it.
 */
async function buildChild(name: string, bounded: boolean): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = join(sandbox, `${name}.mjs`);
  const { build } = await import('esbuild');
  await build({
    stdin: {
      contents: [
        "import { execFileSync, spawn } from 'node:child_process';",
        `import { boundedExecOptions } from ${JSON.stringify(resolve(here, '../exec-path.ts'))};`,
        "for (let i = 0; i < 2; i++) spawn(process.execPath, ['-e', 'setTimeout(() => {}, 800)']);",
        'setTimeout(() => {',
        `  const options = { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: ${TIMEOUT_MS} };`,
        'const started = Date.now();',
        '  try {',
        `    execFileSync('gh', ['pr', 'view', '1'], ${bounded ? 'boundedExecOptions(options)' : 'options'});`,
        "    process.stderr.write('returned\\n');",
        '  } catch (err) {',
        '    process.stderr.write(`threw ${err.code} after ${Date.now() - started}ms\\n`);',
        '  }',
        '}, 400);',
      ].join('\n'),
      resolveDir: here,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'silent',
  });
  return out;
}

/** Zombie children of `pid`. */
function zombies(pid: number): number {
  const ps = spawnSync('ps', ['-axo', 'ppid=,stat='], { encoding: 'utf-8' });
  return ps.stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([ppid, stat]) => ppid === String(pid) && stat?.startsWith('Z')).length;
}

/** Run a child; sample it at `sampleMs`, then let it end (or kill it at `killMs`). */
async function run(
  script: string,
  bin: string,
  sampleMs: number,
  killMs: number,
): Promise<{ aliveAtSample: boolean; zombiesAtSample: number; elapsed: number; stderr: string }> {
  const started = Date.now();
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let exited = false;
  let exitedAt = 0;
  const done = new Promise<void>((settle) =>
    child.on('exit', () => {
      exited = true;
      exitedAt = Date.now();
      settle();
    }),
  );
  await new Promise((r) => setTimeout(r, sampleMs));
  const aliveAtSample = !exited;
  const zombiesAtSample = aliveAtSample && child.pid !== undefined ? zombies(child.pid) : 0;
  const killer = setTimeout(() => child.kill('SIGKILL'), Math.max(0, killMs - sampleMs));
  await done;
  clearTimeout(killer);
  return { aliveAtSample, zombiesAtSample, elapsed: exitedAt - started, stderr };
}

describe.skipIf(process.platform === 'win32')('boundedExecOptions (T14670)', () => {
  it('control: a raw sync exec blocks past its timeout and leaves its async children defunct', async () => {
    const bin = writeStubGh();
    const script = await buildChild('control', false);
    // Timeout fires ~1.4 s after start; sample well after it.
    const result = await run(script, bin, 3_500, 4_000);
    expect(result.aliveAtSample, result.stderr).toBe(true);
    expect(result.zombiesAtSample).toBe(2);
  }, 20_000);

  it('returns at its timeout with a SIGTERM-proof child holding the pipe', async () => {
    const bin = writeStubGh();
    const script = await buildChild('bounded', true);
    const result = await run(script, bin, 3_500, (STUB_LIFE_S + 2) * 1_000);
    expect(result.aliveAtSample, result.stderr).toBe(false);
    expect(result.stderr).toContain('threw ETIMEDOUT');
    expect(result.elapsed).toBeLessThan(3_500);
  }, 20_000);

  it('bounds a call with no timeout of its own, keeps a caller timeout and signal, sets a quiet env', async () => {
    const { BOUNDED_EXEC_DEFAULT_TIMEOUT_MS, boundedExecOptions, NON_INTERACTIVE_EXEC_ENV } =
      await import('../exec-path.js');
    const bare = boundedExecOptions();
    expect(bare.timeout).toBe(BOUNDED_EXEC_DEFAULT_TIMEOUT_MS);
    expect(bare.killSignal).toBe('SIGKILL');
    expect(bare.env).toMatchObject({ GH_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' });
    const own = boundedExecOptions({
      encoding: 'utf-8',
      timeout: 5,
      killSignal: 'SIGINT',
      env: { ONLY: '1', PAGER: 'less' },
    });
    expect(own).toMatchObject({ encoding: 'utf-8', timeout: 5, killSignal: 'SIGINT' });
    expect(own.env).toEqual({ ONLY: '1', ...NON_INTERACTIVE_EXEC_ENV });
  });
});

/**
 * T14676 AC1 — a timed-out git write must not leave `.git/index.lock`.
 *
 * `git commit -- <path>` holds `index.lock` while its pre-commit hook runs; a hook that
 * sleeps makes the write outlive a 1 s timeout. SIGKILL (the control, plain
 * `boundedExecOptions`) skips git's lock cleanup and the next git write fails;
 * `gracefulKillExec` sends SIGTERM first, git removes its lock, and the next
 * write succeeds. Make the supervisor send SIGKILL first and the fixed run
 * leaves the lock exactly like the control.
 */
describe.skipIf(process.platform === 'win32')('gracefulKillExec (T14676)', () => {
  /** A repo with one staged change and a pre-commit hook that sleeps 20 s. */
  function slowCommitRepo(name: string): { cwd: string; env: NodeJS.ProcessEnv } {
    const cwd = join(sandbox, name);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd, env, stdio: 'ignore' });
    };
    spawnSync('mkdir', ['-p', cwd]);
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    git('config', 'core.hooksPath', '.git/hooks');
    writeFileSync(join(cwd, 'a.txt'), 'a\n');
    git('add', 'a.txt');
    const hook = join(cwd, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\nexec sleep 20 </dev/null >/dev/null 2>&1\n');
    chmodSync(hook, 0o755);
    return { cwd, env };
  }

  /** Whether a follow-up git write in `cwd` succeeds (it fails on a stale index.lock). */
  function nextWriteSucceeds(cwd: string, env: NodeJS.ProcessEnv): boolean {
    return spawnSync('git', ['add', 'a.txt'], { cwd, env, stdio: 'ignore' }).status === 0;
  }

  it('control: a SIGKILLed git write leaves index.lock and the next write fails', async () => {
    const { boundedExecOptions } = await import('../exec-path.js');
    const { cwd, env } = slowCommitRepo('control-repo');
    expect(() =>
      execFileSync(
        'git',
        ['commit', '-q', '-m', 'x', '--', 'a.txt'],
        boundedExecOptions({ cwd, env, stdio: 'ignore', timeout: TIMEOUT_MS }),
      ),
    ).toThrow(expect.objectContaining({ code: 'ETIMEDOUT' }));
    expect(existsSync(join(cwd, '.git', 'index.lock'))).toBe(true);
    expect(nextWriteSucceeds(cwd, env)).toBe(false);
  }, 20_000);

  it('SIGTERMs a timed-out git write so git removes its lock, within timeout + grace', async () => {
    const { GRACEFUL_KILL_TIMEOUT_STATUS, gracefulKillExec } = await import('../exec-path.js');
    const { cwd, env } = slowCommitRepo('graceful-repo');
    const started = Date.now();
    expect(() =>
      execFileSync(
        ...gracefulKillExec(
          'git',
          ['commit', '-q', '-m', 'x', '--', 'a.txt'],
          { cwd, env, stdio: 'ignore', timeout: TIMEOUT_MS },
          2_000,
        ),
      ),
    ).toThrow(expect.objectContaining({ status: GRACEFUL_KILL_TIMEOUT_STATUS }));
    expect(Date.now() - started).toBeLessThan(TIMEOUT_MS + 2_000 + 2_000);
    expect(existsSync(join(cwd, '.git', 'index.lock'))).toBe(false);
    expect(nextWriteSucceeds(cwd, env)).toBe(true);
  }, 20_000);

  it('SIGKILLs a command that ignores SIGTERM after the grace period', async () => {
    const { GRACEFUL_KILL_TIMEOUT_STATUS, gracefulKillExec } = await import('../exec-path.js');
    const started = Date.now();
    const result = spawnSync(
      ...gracefulKillExec(
        'sh',
        ['-c', "trap '' TERM; sleep 20"],
        { stdio: 'ignore', timeout: 500 },
        500,
      ),
    );
    expect(result.status).toBe(GRACEFUL_KILL_TIMEOUT_STATUS);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it('passes stdin, stdout and a non-zero exit through, and runs directly with no timeout', async () => {
    const { gracefulKillExec } = await import('../exec-path.js');
    expect(
      execFileSync(
        ...gracefulKillExec('cat', [], { input: 'piped', encoding: 'utf-8', timeout: 5_000 }),
      ),
    ).toBe('piped');
    expect(spawnSync(...gracefulKillExec('sh', ['-c', 'exit 3'], { timeout: 5_000 })).status).toBe(
      3,
    );
    const [file, args] = gracefulKillExec('git', ['--version'], { timeout: 0 });
    expect([file, args]).toEqual(['git', ['--version']]);
  });
});
