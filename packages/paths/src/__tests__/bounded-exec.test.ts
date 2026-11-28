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

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
