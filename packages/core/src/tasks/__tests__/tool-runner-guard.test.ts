/**
 * T13203 — the evidence tool runner refuses to spawn inside a test runner.
 *
 * A stale mock once let a vitest worker reach the real runner, which ran
 * `pnpm run test`; every worker of that suite did the same and whole-suite runs
 * multiplied. These tests call the REAL `runToolCached` with no injected
 * runner and prove it refuses with the typed error before any process starts.
 *
 * @task T13203
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runToolCached } from '../tool-cache.js';
import type { ResolvedToolCommand } from '../tool-resolver.js';
import {
  detectTestRunner,
  injectToolProcessRunner,
  resolveToolProcessRunner,
  type ToolProcessRunner,
  ToolSpawnInTestRunnerError,
} from '../tool-runner-guard.js';

const dirs: string[] = [];

afterEach(() => {
  injectToolProcessRunner(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function command(marker: string): ResolvedToolCommand {
  // If the guard failed, this would create `marker` — the test then sees it.
  return {
    canonical: 'test',
    displayName: 'test',
    cmd: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    source: 'project-context',
  };
}

describe('evidence tool runner inside a test runner (T13203)', () => {
  it('refuses the real runner with a typed error naming the guard, and starts nothing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-t13203-'));
    dirs.push(root);
    const marker = join(root, 'spawned');
    const err = await runToolCached(command(marker), root, {
      bypassCache: true,
      skipGlobalSemaphore: true,
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(ToolSpawnInTestRunnerError);
    expect((err as ToolSpawnInTestRunnerError).codeName).toBe('E_TOOL_SPAWN_IN_TEST_RUNNER');
    expect((err as ToolSpawnInTestRunnerError).message).toMatch(/inside a test runner \(VITEST/);
    const { existsSync } = await import('node:fs');
    expect(existsSync(marker)).toBe(false);
  });

  it('uses an injected runner instead of refusing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-t13203-'));
    dirs.push(root);
    const seen: string[] = [];
    const fake: ToolProcessRunner = async (cmd) => {
      seen.push(cmd);
      return {
        exitCode: 0,
        signal: null,
        stdout: 'ok',
        stderr: '',
        timedOut: false,
        spawnError: null,
      };
    };
    injectToolProcessRunner(fake);
    const result = await runToolCached(command(join(root, 'spawned')), root, {
      bypassCache: true,
      skipGlobalSemaphore: true,
    });
    expect(result.exitCode).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe('detectTestRunner / resolveToolProcessRunner (T13203)', () => {
  const real: ToolProcessRunner = async () => ({
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    spawnError: null,
  });

  it.each([
    [{ VITEST: 'true' }, 'VITEST'],
    [{ VITEST_WORKER_ID: '3' }, 'VITEST_WORKER_ID'],
    [{ JEST_WORKER_ID: '1' }, 'JEST_WORKER_ID'],
    [{ NODE_ENV: 'test' }, 'NODE_ENV=test'],
    [{ NODE_ENV: 'production' }, null],
    [{}, null],
  ] as const)('detects %o as %s', (env, expected) => {
    expect(detectTestRunner(env)).toBe(expected);
  });

  it('returns the real runner outside a test runner', () => {
    expect(resolveToolProcessRunner('build', 'pnpm build', real, {})).toBe(real);
  });

  it('throws inside a test runner when nothing is injected', () => {
    expect(() => resolveToolProcessRunner('build', 'pnpm build', real, { VITEST: 'true' })).toThrow(
      ToolSpawnInTestRunnerError,
    );
  });
});
