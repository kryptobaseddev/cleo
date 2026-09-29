/**
 * T12689 — two focus LOWs from the T12684 review:
 *  - completion's focus clear is a compare-and-clear inside the store's
 *    transaction, so a pointer re-set between the read and the write survives;
 *  - a stale `cleo current` names the next ready task without brain pattern
 *    scoring (no brain store opened for a one-line hint).
 *
 * @task T12689
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskWorkState } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const searchPatterns = vi.fn(async () => []);
vi.mock('../../memory/patterns.js', () => ({ searchPatterns }));

import { taskCurrentGet } from '../../session/engine-ops.js';
import { getTaskAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { coreTaskNext } from '../../tasks/task-next.js';
import {
  clearFocusForFinishedTask,
  type FocusStateMetaAccessor,
  LEGACY_FOCUS_STATE_KEY,
} from '../focus-state-store.js';

const roots: string[] = [];

async function scratchProject() {
  const root = mkdtempSync(join(tmpdir(), 'cleo-t12689-'));
  roots.push(root);
  mkdirSync(join(root, '.cleo'), { recursive: true });
  writeFileSync(
    join(root, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: 'proj-t12689', projectHash: 'hash-t12689' }),
  );
  const acc = await getTaskAccessor(root);
  for (const [id, status] of [
    ['T1', 'done'],
    ['T3', 'pending'],
  ] as const)
    await acc.upsertSingleTask({
      id,
      title: `task ${id}`,
      description: 'T12689 fixture',
      status,
      priority: 'medium',
      acceptance: ['first', 'second', 'third'],
      createdAt: '2026-09-18T00:00:00Z',
    });
  return { root, acc };
}

beforeEach(() => {
  vi.stubEnv('CLEO_SESSION_ID', undefined);
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined);
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  searchPatterns.mockClear();
  resetDbState();
});

afterEach(() => {
  resetDbState();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('completion clears focus with a compare-and-clear in one transaction', () => {
  it('reads and writes each key inside the transaction', async () => {
    const meta = new Map<string, unknown>([[LEGACY_FOCUS_STATE_KEY, { currentTask: 'T1' }]]);
    let inTx = false;
    const reads: boolean[] = [];
    const writes: boolean[] = [];
    const accessor: FocusStateMetaAccessor = {
      getMetaValue: async <T>(key: string) => {
        reads.push(inTx);
        return (meta.get(key) as T | undefined) ?? null;
      },
      setMetaValue: async () => {
        throw new Error('the clear must write through the transaction');
      },
      transaction: async (fn) => {
        inTx = true;
        try {
          return await fn({
            setMetaValue: async (key, value) => {
              writes.push(inTx);
              meta.set(key, value);
            },
          });
        } finally {
          inTx = false;
        }
      },
    };
    expect(await clearFocusForFinishedTask(accessor, [], 'T1')).toEqual([LEGACY_FOCUS_STATE_KEY]);
    expect(reads).toEqual([true]);
    expect(writes).toEqual([true]);
    expect((meta.get(LEGACY_FOCUS_STATE_KEY) as TaskWorkState).currentTask).toBeNull();
  });

  it('works against the real store (no self-deadlock)', async () => {
    const { acc } = await scratchProject();
    await acc.setMetaValue(LEGACY_FOCUS_STATE_KEY, { currentTask: 'T1', sessionNote: 'kept' });
    expect(await clearFocusForFinishedTask(acc, [], 'T1')).toEqual([LEGACY_FOCUS_STATE_KEY]);
    expect(await acc.getMetaValue<TaskWorkState>(LEGACY_FOCUS_STATE_KEY)).toMatchObject({
      currentTask: null,
      sessionNote: 'kept',
    });
  });
});

describe('a stale `cleo current` hint does no brain scoring', () => {
  it('coreTaskNext with brain:false never searches patterns; the default does', async () => {
    const { root } = await scratchProject();
    await coreTaskNext(root, { count: 1, brain: false });
    expect(searchPatterns).not.toHaveBeenCalled();
    await coreTaskNext(root, { count: 1 });
    expect(searchPatterns).toHaveBeenCalled();
  });

  it('stale cleo current names the next task without opening brain patterns', async () => {
    const { root, acc } = await scratchProject();
    await acc.setMetaValue(LEGACY_FOCUS_STATE_KEY, { currentTask: 'T1' });
    const envelope = await taskCurrentGet(root);
    expect(envelope.data).toMatchObject({
      currentTask: null,
      staleFocus: { taskId: 'T1', status: 'done' },
      nextSuggested: { id: 'T3' },
    });
    expect(searchPatterns).not.toHaveBeenCalled();
  });
});
