/**
 * T12660 — a finished task is never reported as the current focus.
 *
 * Field report: with no active session, `cleo current` returned T458, done
 * since 2026-09-18. Completion never touched focus_state, the legacy global
 * key was never cleared, and `currentTask` / the briefing returned the pointer
 * without checking the task's status. The handoff's `nextSuggested` ids were
 * likewise shown with no live status.
 *
 * Every case runs against a scratch project store in the per-fork sandbox.
 *
 * @task T12660
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskWorkState } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskCurrentGet } from '../../session/engine-ops.js';
import { type DataAccessor, getTaskAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { currentTask } from '../../task-work/index.js';
import { analyzeTaskPriority } from '../../tasks/analyze.js';
import { taskComplete } from '../../tasks/complete.js';
import {
  clearFocusForFinishedTask,
  focusStateKey,
  LEGACY_FOCUS_STATE_KEY,
  staleFocusPointer,
} from '../focus-state-store.js';

const roots: string[] = [];

async function scratchProject(): Promise<{ root: string; acc: DataAccessor }> {
  const root = mkdtempSync(join(tmpdir(), 'cleo-t12660-'));
  roots.push(root);
  mkdirSync(join(root, '.cleo'), { recursive: true });
  writeFileSync(
    join(root, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: 'proj-t12660', projectHash: 'hash-t12660' }),
  );
  const acc = await getTaskAccessor(root);
  const tasks: Array<[string, 'done' | 'cancelled' | 'pending']> = [
    ['T1', 'done'],
    ['T2', 'cancelled'],
    ['T3', 'pending'],
  ];
  for (const [id, status] of tasks)
    await acc.upsertSingleTask({
      id,
      title: `task ${id}`,
      description: 'T12660 fixture',
      status,
      priority: 'medium',
      acceptance: ['first', 'second', 'third'],
      createdAt: '2026-09-18T00:00:00Z',
    });
  return { root, acc };
}

const focusOn = (currentTask: string): TaskWorkState =>
  ({ currentTask, currentPhase: null, sessionNote: 'kept', nextAction: null }) as TaskWorkState;

beforeEach(() => {
  vi.stubEnv('CLEO_SESSION_ID', undefined);
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined);
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  resetDbState();
});

afterEach(() => {
  resetDbState();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('T12660 — completion clears the focus pointer', () => {
  it('clears the pointer in the session key AND the legacy key, keeping the rest of the blob', async () => {
    const { acc } = await scratchProject();
    await acc.setMetaValue(LEGACY_FOCUS_STATE_KEY, focusOn('T3'));
    await acc.setMetaValue(focusStateKey('ses_a'), focusOn('T3'));
    await acc.setMetaValue(focusStateKey('ses_b'), focusOn('T1'));

    const cleared = await clearFocusForFinishedTask(acc, ['ses_a', null, 'ses_a'], 'T3');
    expect(cleared.sort()).toEqual([LEGACY_FOCUS_STATE_KEY, focusStateKey('ses_a')].sort());
    expect(await acc.getMetaValue<TaskWorkState>(LEGACY_FOCUS_STATE_KEY)).toMatchObject({
      currentTask: null,
      sessionNote: 'kept',
    });
    // Another session's pointer to another task is untouched.
    expect((await acc.getMetaValue<TaskWorkState>(focusStateKey('ses_b')))?.currentTask).toBe('T1');
    // Nothing points at T3 any more: a second pass clears nothing.
    expect(await clearFocusForFinishedTask(acc, ['ses_a'], 'T3')).toEqual([]);
  });
});

describe('T12660 — cleo complete clears the focused task', () => {
  it('reports focusCleared plus the next suggestion, and current is then empty', async () => {
    const { root, acc } = await scratchProject();
    await acc.upsertSingleTask({
      id: 'T4',
      title: 'task T4',
      description: 'T12660 fixture',
      status: 'pending',
      priority: 'low',
      createdAt: '2026-09-18T00:00:00Z',
    });
    await acc.setMetaValue(LEGACY_FOCUS_STATE_KEY, focusOn('T3'));

    const result = await taskComplete(root, 'T3');
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({
      focusCleared: true,
      nextSuggested: { id: 'T4', title: 'task T4' },
    });
    expect((await acc.getMetaValue<TaskWorkState>(LEGACY_FOCUS_STATE_KEY))?.currentTask).toBeNull();
    const current = await currentTask(root, acc);
    expect(current.currentTask).toBeNull();
    expect(current.staleFocus).toBeUndefined();
  });
});

describe('T12660 — a done or cancelled pointer is never current', () => {
  it.each([
    ['T1', 'done'],
    ['T2', 'cancelled'],
    ['T404', 'missing'],
  ])('the legacy key pointing at %s (%s) is reported stale, not current', async (id, status) => {
    const { root, acc } = await scratchProject();
    await acc.setMetaValue(LEGACY_FOCUS_STATE_KEY, focusOn(id));

    const current = await currentTask(root, acc);
    expect(current.currentTask).toBeNull();
    expect(current.staleFocus).toEqual({ taskId: id, status });

    const envelope = await taskCurrentGet(root);
    expect(envelope.success).toBe(true);
    expect(envelope.data).toMatchObject({
      currentTask: null,
      staleFocus: { taskId: id, status },
      nextSuggested: { id: 'T3', title: 'task T3' },
    });
  });

  it('a workable pointer is still current', async () => {
    const { root, acc } = await scratchProject();
    await acc.setMetaValue(LEGACY_FOCUS_STATE_KEY, focusOn('T3'));
    const current = await currentTask(root, acc);
    expect(current.currentTask).toBe('T3');
    expect(current.staleFocus).toBeUndefined();
  });

  it('classifies terminal and missing statuses', () => {
    expect(staleFocusPointer('T1', 'done')).toEqual({ taskId: 'T1', status: 'done' });
    expect(staleFocusPointer('T1', 'archived')).toEqual({ taskId: 'T1', status: 'archived' });
    expect(staleFocusPointer('T1', undefined)).toEqual({ taskId: 'T1', status: 'missing' });
    expect(staleFocusPointer('T1', 'active')).toBeNull();
    expect(staleFocusPointer('T1', 'blocked')).toBeNull();
  });
});

describe('T12660 — analyze --auto-start writes through the focus store', () => {
  it('writes the session-scoped key, never the raw legacy key', async () => {
    const { root, acc } = await scratchProject();
    vi.stubEnv('CLEO_SESSION_ID', 'ses_analyze');
    const result = await analyzeTaskPriority({ autoStart: true, cwd: root }, acc);
    expect(result.recommended?.id).toBe('T3');
    expect((await acc.getMetaValue<TaskWorkState>(focusStateKey('ses_analyze')))?.currentTask).toBe(
      'T3',
    );
    expect(await acc.getMetaValue<TaskWorkState>(LEGACY_FOCUS_STATE_KEY)).toBeNull();
  });
});
