/**
 * A typed-gate pass cached by `cleo verify --run` is found from another shell
 * (T14034): the cache key hashes only the gate's declared env, its `envKeys`
 * and a fixed tool-input set, never shell or harness noise such as `PWD`,
 * `SHLVL`, `TERM_SESSION_ID` or `CLAUDE_*`.
 *
 * @task T14034
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcceptanceGate, Task } from '@cleocode/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { createOperationExecutionContext } from '../../store/background-ops.js';
import { captureGateInputs, runGates } from '../gate-runner.js';

const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gate-env-hash-')));
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const git = (...a: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...a], {
    cwd: repo,
    stdio: 'ignore',
  });
git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'pass.mjs'), 'process.exit(0);\n');
git('add', '.');
git('commit', '-q', '-m', 'init');
// Untracked, so the cache it holds never moves the dirty-tree fingerprint.
mkdirSync(join(repo, '.cleo'));
writeFileSync(
  join(repo, '.cleo', 'project-info.json'),
  JSON.stringify({ projectId: 'env-hash', projectHash: 'env-hash-path' }),
);

const gate: AcceptanceGate = {
  kind: 'command',
  cmd: process.execPath,
  args: ['pass.mjs'],
  description: 'pass harness',
  req: 'REQ-ENV',
  envKeys: ['DATABASE_URL'],
};
const task: Task = {
  id: 'T14034',
  title: 'Env hash fixture',
  description: 'Typed gate cache key fixture',
  status: 'active',
  type: 'task',
  priority: 'medium',
  createdAt: '2026-10-25T00:00:00.000Z',
  files: [],
  acceptance: [gate],
};

const envA: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: repo,
  DATABASE_URL: 'postgres://a',
  PWD: '/shell/a',
  SHLVL: '1',
  TERM_SESSION_ID: 'session-a',
  CLAUDE_CODE_SESSION_ID: 'claude-a',
};

/** Capture the inputs digest in `env`, then run the gate with that cache mode. */
async function run(cache: 'refresh' | 'only', env: NodeJS.ProcessEnv, key: string) {
  const execution = createOperationExecutionContext(
    {
      projectId: 'env-hash',
      projectRoot: repo,
      actor: 'test',
      operation: 'check.gate.verify',
      idempotencyKey: `env-hash-${cache}-${key}`,
    },
    { budgetMs: 30_000 },
  );
  try {
    const { hash, inputs } = await captureGateInputs(task, gate, execution, env);
    return (
      await runGates([gate], {
        projectRoot: repo,
        execution,
        env,
        cache,
        cacheInputsHash: hash,
        cacheInputs: inputs,
      })
    )[0];
  } finally {
    execution.close();
  }
}

describe('typed-gate cache key ignores shell and harness env (T14034)', () => {
  it('a --run pass is a hit from a shell with other PWD, SHLVL, TERM_SESSION_ID and CLAUDE_*', async () => {
    expect((await run('refresh', envA, 'a'))?.result).toBe('pass');
    const envB: NodeJS.ProcessEnv = {
      ...envA,
      PWD: '/shell/b',
      SHLVL: '3',
      TERM_SESSION_ID: 'session-b',
      CLAUDE_CODE_SESSION_ID: 'claude-b',
      CLAUDE_PROJECT_DIR: '/elsewhere',
    };
    expect((await run('only', envB, 'b'))?.source).toBe('cache');
  }, 60_000);

  it('a changed declared envKey is a miss naming the environment', async () => {
    const missed = await run('only', { ...envA, DATABASE_URL: 'postgres://b' }, 'db');
    expect(missed?.result).toBe('error');
    expect(missed?.errorMessage).toMatch(/typed gate not cached:.*in: inputs: the environment/);
  }, 60_000);

  it('a changed PATH is a miss', async () => {
    const missed = await run('only', { ...envA, PATH: `${envA.PATH}:/changed` }, 'path');
    expect(missed?.result).toBe('error');
    expect(missed?.errorMessage).toMatch(/typed gate not cached:.*the environment/);
  }, 60_000);
});
