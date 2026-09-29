/**
 * T12684 — every focus read that reports or acts on the current task goes
 * through `readLiveFocus`, so no reader (inject, bootstrap, orchestrator
 * startup, stats, validation, attention, drift) surfaces a finished task.
 *
 * @task T12684
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TaskWorkState } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { injectTasks } from '../../inject/index.js';
import { buildBrainState } from '../../orchestration/bootstrap.js';
import { type DataAccessor, getTaskAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { currentTask } from '../../task-work/index.js';
import { taskComplete } from '../../tasks/complete.js';
import { focusStateKey, LEGACY_FOCUS_STATE_KEY, readLiveFocus } from '../focus-state-store.js';

const roots: string[] = [];

async function scratchProject(): Promise<{ root: string; acc: DataAccessor }> {
  const root = mkdtempSync(join(tmpdir(), 'cleo-t12684-'));
  roots.push(root);
  mkdirSync(join(root, '.cleo'), { recursive: true });
  writeFileSync(
    join(root, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: 'proj-t12684', projectHash: 'hash-t12684' }),
  );
  const acc = await getTaskAccessor(root);
  const tasks: Array<[string, 'done' | 'cancelled' | 'archived' | 'pending']> = [
    ['T1', 'done'],
    ['T2', 'cancelled'],
    ['T3', 'pending'],
    ['T5', 'archived'],
  ];
  for (const [id, status] of tasks)
    await acc.upsertSingleTask({
      id,
      title: `task ${id}`,
      description: 'T12684 fixture',
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

describe('readLiveFocus — the one validating focus reader', () => {
  it.each([
    ['T1', 'done'],
    ['T2', 'cancelled'],
    ['T5', 'archived'],
    ['T404', 'missing'],
  ])('a pointer at %s (%s) is null + staleFocus, the blob kept', async (id, status) => {
    const { acc } = await scratchProject();
    await acc.setMetaValue(LEGACY_FOCUS_STATE_KEY, focusOn(id));
    const live = await readLiveFocus(acc, null);
    expect(live.currentTask).toBeNull();
    expect(live.staleFocus).toEqual({ taskId: id, status });
    expect(live.state?.sessionNote).toBe('kept');
  });

  it('a workable pointer is the current task', async () => {
    const { acc } = await scratchProject();
    await acc.setMetaValue(LEGACY_FOCUS_STATE_KEY, focusOn('T3'));
    expect(await readLiveFocus(acc, null)).toMatchObject({ currentTask: 'T3', staleFocus: null });
  });
});

describe("another session's completion", () => {
  it("leaves session B's key untouched, but B is reported stale", async () => {
    const { root, acc } = await scratchProject();
    await acc.setMetaValue(focusStateKey('ses_a'), focusOn('T3'));
    await acc.setMetaValue(focusStateKey('ses_b'), focusOn('T3'));

    vi.stubEnv('CLEO_SESSION_ID', 'ses_a');
    const done = await taskComplete(root, 'T3');
    expect(done.error).toBeUndefined();

    // B's stored pointer is B's to change — completion by A does not touch it.
    const raw = await acc.getMetaValue<TaskWorkState>(focusStateKey('ses_b'));
    expect(raw?.currentTask).toBe('T3');
    // …but every reader reports it stale, never current.
    expect(await readLiveFocus(acc, 'ses_b')).toMatchObject({
      currentTask: null,
      staleFocus: { taskId: 'T3', status: 'done' },
    });
    vi.stubEnv('CLEO_SESSION_ID', 'ses_b');
    const current = await currentTask(root, acc);
    expect(current.currentTask).toBeNull();
    expect(current.staleFocus).toEqual({ taskId: 'T3', status: 'done' });
  });
});

describe('inject and bootstrap never put a finished task into agent context', () => {
  it('inject --focused-only on a cancelled focus injects no finished task', async () => {
    const { root, acc } = await scratchProject();
    await acc.setMetaValue(LEGACY_FOCUS_STATE_KEY, focusOn('T2'));
    const result = (await injectTasks({ focusedOnly: true, cwd: root }, acc)) as {
      tasks: Array<{ id: string; status: string }>;
    };
    // Only the workable task; no done, cancelled or archived one.
    expect(result.tasks.map((t) => t.id)).toEqual(['T3']);
  });

  it('bootstrap has no current task when the focus points at a done task', async () => {
    const { root, acc } = await scratchProject();
    await acc.setMetaValue(LEGACY_FOCUS_STATE_KEY, focusOn('T1'));
    const brain = await buildBrainState(root, { speed: 'fast' }, acc);
    expect(brain.currentTask).toBeUndefined();
  });

  it('bootstrap keeps a workable current task', async () => {
    const { root, acc } = await scratchProject();
    await acc.setMetaValue(LEGACY_FOCUS_STATE_KEY, focusOn('T3'));
    const brain = await buildBrainState(root, { speed: 'fast' }, acc);
    expect(brain.currentTask).toMatchObject({ id: 'T3' });
  });
});

describe('no reader bypasses the validating accessor', () => {
  /** Files allowed the RAW read: read-modify-write of the blob, never reporting. */
  const RAW_READ_ALLOWED = new Set([
    'sessions/focus-state-store.ts',
    'sessions/session-switch.ts',
    'tasks/analyze.ts',
    'task-work/index.ts',
    'phases/index.ts',
    'orchestrate/pivot.ts',
    'session/engine-ops.ts',
  ]);
  const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
      return name.endsWith('.ts') ? [path] : [];
    });
  }

  it('the legacy key is read only inside the store, and raw reads only by writers', () => {
    const rawLegacy: string[] = [];
    const rawRead: string[] = [];
    for (const file of sourceFiles(src)) {
      const rel = relative(src, file);
      const text = readFileSync(file, 'utf-8');
      if (
        rel !== 'sessions/focus-state-store.ts' &&
        /getMetaValue[^(]*\(\s*'focus_state'/.test(text)
      )
        rawLegacy.push(rel);
      if (!RAW_READ_ALLOWED.has(rel) && /\breadFocusState\(/.test(text)) rawRead.push(rel);
    }
    expect(rawLegacy).toEqual([]);
    expect(rawRead).toEqual([]);
  });
});
