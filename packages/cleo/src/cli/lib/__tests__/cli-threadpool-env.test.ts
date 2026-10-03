/**
 * The CLI's `UV_THREADPOOL_SIZE=64` stays with the CLI (T13122).
 *
 * `bin/cleo.js` exported it for the CLI's own thread pool, and every process
 * the CLI spawned inherited it — the live `cleo verify` test child on
 * 2026-10-03 carried it into each of its workers.
 *
 * @task T13122
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { CLI_THREADPOOL_MARKER, releaseCliThreadpoolEnv } from '../cli-threadpool-env.js';

const SHIM = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../bin/cleo.js');

describe('releaseCliThreadpoolEnv (T13122)', () => {
  it("removes CLEO's own default once this process's pool exists", () => {
    const order: string[] = [];
    const env: NodeJS.ProcessEnv = { UV_THREADPOOL_SIZE: '64', [CLI_THREADPOOL_MARKER]: '64' };
    const startPool = vi.fn(() => order.push(`pool started, env=${env.UV_THREADPOOL_SIZE}`));

    expect(releaseCliThreadpoolEnv(env, startPool)).toBe(true);

    // The pool reads the variable when it starts, so it must start first.
    expect(order).toEqual(['pool started, env=64']);
    expect(env.UV_THREADPOOL_SIZE).toBeUndefined();
    expect(env[CLI_THREADPOOL_MARKER]).toBeUndefined();
  });

  it("leaves an operator's own value alone (no marker)", () => {
    const env: NodeJS.ProcessEnv = { UV_THREADPOOL_SIZE: '128' };
    const startPool = vi.fn();
    expect(releaseCliThreadpoolEnv(env, startPool)).toBe(false);
    expect(env.UV_THREADPOOL_SIZE).toBe('128');
    expect(startPool).not.toHaveBeenCalled();
  });

  it('leaves a value that no longer matches the marker, and drops the marker', () => {
    const env: NodeJS.ProcessEnv = { UV_THREADPOOL_SIZE: '16', [CLI_THREADPOOL_MARKER]: '64' };
    expect(releaseCliThreadpoolEnv(env, vi.fn())).toBe(false);
    expect(env.UV_THREADPOOL_SIZE).toBe('16');
    expect(env[CLI_THREADPOOL_MARKER]).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')(
    'the CLI keeps its 64 pool threads; a child it spawns inherits none',
    () => {
      // Real processes: the default startPool must create the pool BEFORE the
      // variable goes, or the CLI itself would lose its 64 threads.
      const script = [
        `import { releaseCliThreadpoolEnv } from ${JSON.stringify(
          pathToFileURL(
            resolve(dirname(fileURLToPath(import.meta.url)), '../cli-threadpool-env.ts'),
          ).href,
        )};`,
        `import { execFileSync, spawnSync } from 'node:child_process';`,
        `import { readFileSync } from 'node:fs';`,
        'releaseCliThreadpoolEnv();',
        // Threads in THIS process: the pool must already hold its 64.
        `const threads = process.platform === 'linux'`,
        `  ? Number(/Threads:\\s+(\\d+)/.exec(readFileSync('/proc/self/status', 'utf8'))[1])`,
        `  : execFileSync('ps', ['-M', '-p', String(process.pid)], { encoding: 'utf8' }).trim().split('\\n').length - 1;`,
        `const child = spawnSync(process.execPath, ['-p', 'process.env.UV_THREADPOOL_SIZE ?? "unset"'], { encoding: 'utf8' });`,
        'console.log(JSON.stringify({ threads, child: child.stdout.trim() }));',
      ].join('\n');
      const run = spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', script],
        {
          encoding: 'utf8',
          env: { ...process.env, UV_THREADPOOL_SIZE: '64', [CLI_THREADPOOL_MARKER]: '64' },
        },
      );
      expect(run.stderr).not.toMatch(/Error/);
      const out = JSON.parse(run.stdout.trim()) as { threads: number; child: string };
      expect(out.child).toBe('unset');
      expect(out.threads).toBeGreaterThanOrEqual(64);
    },
  );

  it('bin/cleo.js marks the default it supplies, and only that one', () => {
    const shim = readFileSync(SHIM, 'utf-8');
    expect(shim).toContain(`const CLI_THREADPOOL_MARKER = '${CLI_THREADPOOL_MARKER}';`);
    expect(shim).toMatch(
      /if \(!process\.env\.UV_THREADPOOL_SIZE\) \{\n\s+process\.env\.UV_THREADPOOL_SIZE = DEFAULT_UV_THREADPOOL_SIZE;\n\s+process\.env\[CLI_THREADPOOL_MARKER\] = DEFAULT_UV_THREADPOOL_SIZE;\n\}/,
    );
  });
});
