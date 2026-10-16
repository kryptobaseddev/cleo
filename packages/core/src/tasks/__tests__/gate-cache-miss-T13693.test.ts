/**
 * A typed-gate cache miss names the key part that moved since the newest
 * stored pass of the same gate (T13693): HEAD, the tracked dirty-tree
 * fingerprint, the execution root, or the inputs, with the environment and
 * each task file told apart.
 *
 * @task T13693
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcceptanceGate, AcceptanceGateResult } from '@cleocode/contracts';
import type { AcceptanceGateCacheInputs } from '@cleocode/contracts/acceptance-gate';
import { afterAll, describe, expect, it } from 'vitest';
import { createOperationExecutionContext } from '../../store/background-ops.js';
import {
  buildGateCacheEntryBody,
  describeGateCacheMiss,
  type GateCacheState,
} from '../gate-result-cache.js';
import { runGates } from '../gate-runner.js';

const root = mkdtempSync(join(tmpdir(), 'gate-cache-miss-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const gate: AcceptanceGate = {
  kind: 'test',
  command: 'node pass.mjs',
  expect: 'exit0',
  description: 'pass harness',
  req: 'REQ-1',
};
const pass = {
  index: 0,
  req: 'REQ-1',
  kind: 'test',
  result: 'pass',
  durationMs: 1,
  checkedAt: '2026-10-13T00:00:00.000Z',
  checkedBy: 'test',
} as AcceptanceGateResult;
const state: GateCacheState = { head: 'a'.repeat(40), dirtyFingerprint: 'd1', cwd: '/repo' };
const inputs: AcceptanceGateCacheInputs = {
  environmentHash: 'env-1',
  artifacts: [
    { path: '/repo/src/a.ts', sha256: 'sha-a', bytes: 1 },
    { path: '/repo/src/b.ts', sha256: 'sha-b', bytes: 1 },
  ],
};

const dir = join(root, '.cleo', 'cache', 'evidence');
mkdirSync(dir, { recursive: true });
const body = buildGateCacheEntryBody(gate, state, 'inputs-1', pass, inputs);
if (!body) throw new Error('expected a cacheable pass');
writeFileSync(join(dir, `gate-${body.key}.json`), JSON.stringify({ ...body, mac: 'x' }));

const why = (
  s: Partial<GateCacheState>,
  hash = 'inputs-1',
  i: AcceptanceGateCacheInputs = inputs,
) => describeGateCacheMiss(root, gate, { ...state, ...s }, hash, i);

describe('describeGateCacheMiss (T13693)', () => {
  it('names a moved HEAD', () => {
    expect(why({ head: 'b'.repeat(40) })).toMatch(/in: HEAD aaaaaaaaaaaa → bbbbbbbbbbbb\.$/);
  });

  it('names a changed tracked file as the dirty-tree fingerprint', () => {
    expect(why({ dirtyFingerprint: 'd2' })).toMatch(/in: tracked uncommitted changes/);
  });

  it('names a different execution root', () => {
    expect(why({ cwd: '/primary' })).toMatch(/in: execution root \/repo → \/primary\./);
  });

  it('tells the environment apart from a task file', () => {
    expect(why({}, 'inputs-2', { ...inputs, environmentHash: 'env-2' })).toMatch(
      /in: inputs: the environment\.$/,
    );
    const changedFile = {
      ...inputs,
      artifacts: [inputs.artifacts[0]!, { path: '/repo/src/b.ts', sha256: 'sha-b2', bytes: 2 }],
    };
    expect(why({}, 'inputs-2', changedFile)).toMatch(/in: inputs: \/repo\/src\/b\.ts\.$/);
  });

  it('caps the changed-file list at 10 and counts the rest (#2240 review)', () => {
    const many: AcceptanceGateCacheInputs = {
      environmentHash: 'env-1',
      artifacts: Array.from({ length: 13 }, (_, i) => ({
        path: `/repo/f${String(i).padStart(2, '0')}.ts`,
        sha256: `new-${i}`,
        bytes: 1,
      })),
    };
    const text = why({}, 'inputs-3', many) ?? '';
    expect(text).toMatch(/in: inputs: \/repo\/src\/a\.ts, \/repo\/src\/b\.ts, .* and 5 more\.$/);
    expect(text.match(/\/repo\//g)).toHaveLength(10);
  });

  it('says nothing when this gate has no stored pass', () => {
    expect(describeGateCacheMiss(root, { ...gate, req: 'REQ-2' }, state, 'inputs-1')).toBeNull();
  });
});

describe('a cache-only run names what moved since --run cached the pass (T13693)', () => {
  it('a tracked file the run rewrote shows as the dirty-tree fingerprint in the refusal', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'gate-cache-e2e-')));
    try {
      const git = (...a: string[]) =>
        execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', ...a], {
          cwd: repo,
          stdio: 'ignore',
        });
      git('init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'pass.mjs'), 'process.exit(0);\n');
      writeFileSync(join(repo, 'snapshot.txt'), 'v1\n');
      git('add', '.');
      git('commit', '-q', '-m', 'init');
      // Untracked, so the cache it holds never moves the dirty-tree fingerprint.
      mkdirSync(join(repo, '.cleo'));
      writeFileSync(
        join(repo, '.cleo', 'project-info.json'),
        JSON.stringify({ projectId: 'e2e', projectHash: 'e2e-path' }),
      );
      const g: AcceptanceGate = {
        kind: 'command',
        cmd: process.execPath,
        args: ['pass.mjs'],
        description: 'pass harness',
        req: 'REQ-E2E',
      };
      const run = async (cache: 'refresh' | 'only') => {
        const execution = createOperationExecutionContext(
          {
            projectId: 'e2e',
            projectRoot: repo,
            actor: 'test',
            operation: 'check.gate.verify',
            idempotencyKey: `e2e-${cache}`,
          },
          { budgetMs: 30_000 },
        );
        try {
          return (
            await runGates([g], {
              projectRoot: repo,
              execution,
              cache,
              cacheInputsHash: 'inputs-e2e',
              cacheInputs: { environmentHash: 'env', artifacts: [] },
            })
          )[0];
        } finally {
          execution.close();
        }
      };
      expect((await run('refresh'))?.result).toBe('pass');
      expect((await run('only'))?.source).toBe('cache');
      // The run (or anything after it) rewrote a tracked file.
      writeFileSync(join(repo, 'snapshot.txt'), 'v2\n');
      const missed = await run('only');
      expect(missed?.result).toBe('error');
      expect(missed?.errorMessage).toMatch(
        /typed gate not cached:.*differs from the newest cached pass of this gate .* in: tracked uncommitted changes/,
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);
});
