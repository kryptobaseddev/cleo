/**
 * Tests for the cron / todo agent-tool family (T11950 · M7 · epic T11456).
 *
 * FULLY MOCKED — no real `tasks.db`. The task ops are supplied through an INJECTED
 * fake {@link TaskOps} store. Covers:
 *   - AC1 register todo_add / todo_list / cron_schedule (toolset 'agent') via the
 *     self-registering marker + part of the built-in catalog;
 *   - AC2 todo_* delegate to the injected store; cron_schedule does NOT block on a
 *     daemon — it returns a typed unavailable result until a schedule store ships;
 *   - todo_* availability always-true daemon-OFF; cron_schedule hidden until the
 *     host advertises a schedule store;
 *   - AC3 no new table invented (cron_schedule returns E_SCHEDULE_STORE_UNAVAILABLE);
 *   - AC4 Zod schema validation (missing title → invalid-args).
 *
 * @task T11950
 * @epic T11456
 */

import type { GuardedToolSurface } from '@cleocode/contracts/tools/skill-executor';
import { describe, expect, it } from 'vitest';
import type { AddTaskResult } from '../../tasks/add.js';
import type { ListTasksResult } from '../../tasks/list.js';
import { AgentToolRegistry } from '../agent-registry.js';
import { registerBuiltinAgentTools } from '../builtin-agent-tools.js';
import { ToolDispatchEngine } from '../dispatch.js';
import { createToolGuard } from '../guard.js';
import {
  type CronScheduleResult,
  registerScheduleAgentTools,
  type TaskOps,
} from '../schedule-agent-tools.js';

const noopSurface = {} as GuardedToolSurface;

interface FakeCalls {
  add: Array<Record<string, unknown>>;
  list: Array<Record<string, unknown>>;
}

/** A fake {@link TaskOps} store that records every call. */
function fakeTasks(): { tasks: TaskOps; calls: FakeCalls } {
  const calls: FakeCalls = { add: [], list: [] };
  const tasks: TaskOps = {
    add: async (_root, params) => {
      calls.add.push(params);
      return { task: { id: 'T1', title: params.title } } as unknown as AddTaskResult;
    },
    list: async (_root, params) => {
      calls.list.push(params);
      return { tasks: [], total: 0, filtered: 0 } as unknown as ListTasksResult;
    },
  };
  return { tasks, calls };
}

// ===========================================================================
// AC1 — registration
// ===========================================================================

describe('schedule-agent-tools — registration (AC1)', () => {
  it('exports a self-registering marker that registers the three tools', async () => {
    const mod = await import('../schedule-agent-tools.js');
    expect(typeof mod.registerAgentTools).toBe('function');
    const registry = new AgentToolRegistry();
    mod.registerAgentTools(registry);
    for (const name of ['todo_add', 'todo_list', 'cron_schedule']) {
      expect(registry.get(name)).toBeDefined();
    }
  });

  it('is part of the built-in catalog in the agent toolset', async () => {
    const registry = new AgentToolRegistry();
    registerBuiltinAgentTools(registry);
    await registry.init({ skipBuiltins: true });
    const agentNames = registry.byToolset('agent').map((t) => t.name);
    expect(agentNames).toEqual(expect.arrayContaining(['todo_add', 'todo_list', 'cron_schedule']));
  });
});

// ===========================================================================
// AC2 — availability (todo_* always-on; cron_schedule gated)
// ===========================================================================

describe('schedule-agent-tools — availability (AC2)', () => {
  it('todo_* are available daemon-OFF; cron_schedule is hidden without a schedule store', async () => {
    const registry = new AgentToolRegistry();
    registerScheduleAgentTools(registry, { tasks: fakeTasks().tasks });
    await registry.init({ skipBuiltins: true });

    const off = registry.available({ networkEgressAllowed: false }).map((t) => t.name);
    expect(off).toEqual(expect.arrayContaining(['todo_add', 'todo_list']));
    expect(off).not.toContain('cron_schedule');

    // ... and visible once the host advertises a schedule store.
    const withStore = registry
      .available({ capabilities: { scheduleStore: true } })
      .map((t) => t.name);
    expect(withStore).toContain('cron_schedule');
  });
});

// ===========================================================================
// AC2/AC3 — delegation + cron_schedule does not block on a daemon
// ===========================================================================

describe('schedule-agent-tools — delegation (AC2/AC3)', () => {
  async function registryWith(): Promise<{ registry: AgentToolRegistry; calls: FakeCalls }> {
    const { tasks, calls } = fakeTasks();
    const registry = new AgentToolRegistry();
    registerScheduleAgentTools(registry, { tasks });
    await registry.init({ skipBuiltins: true });
    return { registry, calls };
  }

  it('todo_add delegates to the task store add op', async () => {
    const { registry, calls } = await registryWith();
    await registry.getExecutable('todo_add')?.(
      { title: 'do a thing', priority: 'high', acceptance: ['ac1'] },
      noopSurface,
    );
    expect(calls.add).toHaveLength(1);
    expect(calls.add[0]).toMatchObject({
      title: 'do a thing',
      priority: 'high',
      type: 'task',
      acceptance: ['ac1'],
    });
  });

  it('todo_list delegates to the task store list op', async () => {
    const { registry, calls } = await registryWith();
    await registry.getExecutable('todo_list')?.({ parent: 'T100', limit: 10 }, noopSurface);
    expect(calls.list).toHaveLength(1);
    expect(calls.list[0]).toMatchObject({ parent: 'T100', limit: 10 });
  });

  it('cron_schedule returns a typed unavailable result (no schema invented; no daemon block)', async () => {
    const { registry } = await registryWith();
    const out = (await registry.getExecutable('cron_schedule')?.(
      { cron: '0 9 * * 1', title: 'weekly' },
      noopSurface,
    )) as CronScheduleResult;
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('E_SCHEDULE_STORE_UNAVAILABLE');
  });
});

// ===========================================================================
// AC4 — Zod schema validation through the frozen dispatch engine
// ===========================================================================

describe('schedule-agent-tools — schema validation (AC4)', () => {
  async function engine(): Promise<ToolDispatchEngine> {
    const registry = new AgentToolRegistry();
    registerScheduleAgentTools(registry, { tasks: fakeTasks().tasks });
    await registry.init({ skipBuiltins: true });
    return new ToolDispatchEngine({
      registry,
      tools: createToolGuard({ mode: 'enforce' }),
      availability: { capabilities: { scheduleStore: true } },
    });
  }

  it('rejects todo_add without a title as invalid-args', async () => {
    const res = await (await engine()).dispatch({ id: 'c1', name: 'todo_add', arguments: {} });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('invalid-args');
  });

  it('dispatches a valid todo_add call', async () => {
    const res = await (await engine()).dispatch({
      id: 'c2',
      name: 'todo_add',
      arguments: { title: 'x' },
    });
    expect(res.ok).toBe(true);
  });
});
