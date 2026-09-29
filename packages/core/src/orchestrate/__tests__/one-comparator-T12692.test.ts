/**
 * T12692 — every task-ordering surface ranks through THE comparator (D11161):
 * band, attested severity (unset = unknown), bounded tiebreak, createdAt, id.
 *
 * One fixture, every surface: `cleo next`'s ranker, `cleo orchestrate ready`
 * (whose list the focus ready wave renders verbatim), the task-context ready
 * frontier, `cleo orchestrate next`, the wave listing, the bootstrap
 * suggestion and `cleo plan` must agree on the relative order — and an unset
 * severity never outranks an attested P1 of the same band on any of them.
 *
 * @task T12692
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildBrainState } from '../../orchestration/bootstrap.js';
import { getNextTask } from '../../orchestration/index.js';
import { getTaskAccessor } from '../../store/data-accessor.js';
import { closeAllDatabases, resetDbState } from '../../store/sqlite.js';
import { coreTaskPlan } from '../../tasks/plan.js';
import { coreTaskContext } from '../../tasks/task-context.js';
import { coreTaskNext } from '../../tasks/task-next.js';
import { orchestrateReady, orchestrateWaves } from '../query-ops.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const daysAgo = (days: number): string => new Date(NOW - days * DAY).toISOString();

/**
 * The expected D11161 order of the ready children of E1:
 * - F  critical, severity unset           → band 4
 * - D  high, P0                           → band 3, severity 4
 * - C  high, P1                           → band 3, severity 3
 * - B  high, severity unset (older than C) → band 3, unknown — below attested P1
 * - G  medium, P1
 * - H  medium, unset, unblocks I          → tiebreak 10 + 5
 * - A  medium, unset                      → tiebreak 10
 * Input order is deliberately scrambled.
 */
const EXPECTED = ['F', 'D', 'C', 'B', 'G', 'H', 'A'];

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'cleo-t12692-'));
  roots.push(root);
  mkdirSync(join(root, '.cleo'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(
    join(root, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: 'proj-t12692', projectHash: 'hash-t12692' }),
  );
  const acc = await getTaskAccessor(root);
  const child = (
    id: string,
    priority: Task['priority'],
    createdAt: string,
    extra: Partial<Task> = {},
  ): Partial<Task> & Pick<Task, 'id' | 'title'> => ({
    id,
    title: `Task ${id}`,
    type: 'task',
    parentId: 'E1',
    priority,
    createdAt,
    ...extra,
  });
  const tasks: Array<Partial<Task> & Pick<Task, 'id' | 'title'>> = [
    { id: 'E1', title: 'Epic', type: 'epic', status: 'active', priority: 'high' },
    child('A', 'medium', daysAgo(2)),
    child('G', 'medium', daysAgo(1), { severity: 'P1' }),
    child('B', 'high', daysAgo(3)),
    child('H', 'medium', daysAgo(1)),
    child('D', 'high', daysAgo(0), { severity: 'P0' }),
    child('C', 'high', daysAgo(0), { severity: 'P1' }),
    child('F', 'critical', daysAgo(0)),
    // Not ready: waits on H (gives H its leverage) — wave 2.
    child('I', 'critical', daysAgo(0), { depends: ['H'] }),
  ];
  for (const task of tasks)
    await acc.upsertSingleTask({
      description: 'T12692 fixture',
      status: 'pending',
      ...task,
    } as Task);
  return root;
}

/** Keep only the fixture's ready ids, in the order a surface returned them. */
const readyOrder = (ids: readonly string[]): string[] => ids.filter((id) => EXPECTED.includes(id));

beforeEach(() => {
  vi.stubEnv('CLEO_SESSION_ID', undefined);
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined);
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  resetDbState();
});

afterEach(async () => {
  await closeAllDatabases();
  resetDbState();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('T12692 — one comparator on every ordering surface', () => {
  it('cleo next, orchestrate ready (focus ready wave) and the context frontier agree', async () => {
    const root = await fixture();

    const next = await coreTaskNext(root, { count: 20, brain: false });
    const nextOrder = readyOrder(next.suggestions.map((s) => s.id));
    expect(nextOrder).toEqual(EXPECTED);

    const ready = await orchestrateReady('E1', root);
    expect(ready.success).toBe(true);
    const readyIds = (ready.data as { readyTasks: Array<{ id: string }> }).readyTasks.map(
      (t) => t.id,
    );
    // The focus ready wave is this list, mapped 1:1 (cleo focus → orchestrate.ready).
    expect(readyIds).toEqual(nextOrder);

    const context = await coreTaskContext(root, { taskId: 'E1', scope: 'epic' });
    expect((context.readyFrontier ?? []).map((t) => t.id)).toEqual(nextOrder);
  });

  it('orchestrate next, the wave listing, bootstrap and plan agree with cleo next', async () => {
    const root = await fixture();
    const acc = await getTaskAccessor(root);

    expect((await getNextTask('E1', root, acc))?.taskId).toBe('F');

    const waves = await orchestrateWaves('E1', root);
    expect(waves.success).toBe(true);
    const plan = (waves.data as { waves: Array<{ waveNumber: number; taskIds: string[] }> }).waves;
    // Wave numbers stay structural (T12683): I waits on H, so it is wave 2.
    expect(plan.map((w) => w.waveNumber)).toEqual([1, 2]);
    expect(plan[0]?.taskIds).toEqual(EXPECTED);
    expect(plan[1]?.taskIds).toEqual(['I']);

    const brain = await buildBrainState(root, {}, acc);
    expect(brain.nextSuggestion?.id).toBe('F');

    const planned = await coreTaskPlan(root);
    expect(readyOrder(planned.ready.map((t) => t.id))).toEqual(EXPECTED);
  });

  it('an unset severity never outranks an attested P1 of the same band on any surface', async () => {
    const root = await fixture();
    const acc = await getTaskAccessor(root);
    const before = (ids: readonly string[]): boolean => ids.indexOf('C') < ids.indexOf('B');

    const next = await coreTaskNext(root, { count: 20, brain: false });
    expect(before(next.suggestions.map((s) => s.id))).toBe(true);

    const ready = await orchestrateReady('E1', root);
    expect(
      before((ready.data as { readyTasks: Array<{ id: string }> }).readyTasks.map((t) => t.id)),
    ).toBe(true);

    const waves = await orchestrateWaves('E1', root);
    expect(
      before((waves.data as { waves: Array<{ taskIds: string[] }> }).waves[0]?.taskIds ?? []),
    ).toBe(true);

    const planned = await coreTaskPlan(root);
    expect(before(planned.ready.map((t) => t.id))).toBe(true);

    // Same band, B older: only the attested severity puts C first.
    const b = await acc.loadSingleTask('B');
    const c = await acc.loadSingleTask('C');
    expect(b?.priority).toBe(c?.priority);
    expect(b?.severity ?? null).toBeNull();
  });
});
