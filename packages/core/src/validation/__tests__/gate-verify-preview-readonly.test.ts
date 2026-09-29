/**
 * The `cleo done --plan` preview persists nothing (T12671 review): its `pr:`
 * and `ci:` lookups run read-only, so neither the PR-result cache nor the
 * branch-protection cache is written. A real write keeps caching.
 *
 * @task T12671
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const prCalls: Array<{ readOnly?: boolean } | undefined> = [];
const ciCalls: Array<{ readOnly?: boolean } | undefined> = [];

vi.mock('../../release/pr-evidence.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../release/pr-evidence.js')>();
  return {
    ...original,
    resolvePrEvidenceAtom: vi.fn(async (_n: number, _r: unknown, opts?: { readOnly?: boolean }) => {
      prCalls.push(opts);
      return { ok: false, reason: 'stop here', codeName: 'E_EVIDENCE_INSUFFICIENT' };
    }),
  };
});

vi.mock('../../release/ci-evidence.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../release/ci-evidence.js')>();
  return {
    ...original,
    resolveCiEvidenceAtom: vi.fn(async (_n: number, _r: unknown, opts?: { readOnly?: boolean }) => {
      ciCalls.push(opts);
      return { ok: false, reason: 'stop here', codeName: 'E_EVIDENCE_INSUFFICIENT' };
    }),
  };
});

import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { validateGateVerify } from '../engine-ops.js';

let env: TestDbEnv;

beforeEach(async () => {
  prCalls.length = 0;
  ciCalls.length = 0;
  env = await createTestDb();
  await seedTasks(env.accessor, [
    {
      id: 'T901',
      title: 'Preview fixture',
      status: 'active',
      priority: 'medium',
      createdAt: new Date().toISOString(),
    },
  ]);
});

afterEach(async () => {
  await env.cleanup();
});

describe('validateGateVerify preview is read-only', () => {
  it('a preview pr: lookup runs readOnly; a write does not', async () => {
    await validateGateVerify(env.tempDir, {
      taskId: 'T901',
      preview: true,
      gateEvidence: { implemented: 'pr:42;files:a.ts' },
    });
    await validateGateVerify(env.tempDir, {
      taskId: 'T901',
      gateEvidence: { implemented: 'pr:42;files:a.ts' },
    });
    expect(prCalls.map((o) => o?.readOnly === true)).toEqual([true, false]);
  });

  it('a preview ci: lookup runs readOnly; a write does not', async () => {
    await validateGateVerify(env.tempDir, {
      taskId: 'T901',
      preview: true,
      gateEvidence: { testsPassed: 'ci:42' },
    });
    await validateGateVerify(env.tempDir, {
      taskId: 'T901',
      gateEvidence: { testsPassed: 'ci:42' },
    });
    expect(ciCalls.map((o) => o?.readOnly === true)).toEqual([true, false]);
  });
});
