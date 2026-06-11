/**
 * Tests for the memory (BRAIN) agent-tool family (T11947 · M7 · epic T11456).
 *
 * FULLY MOCKED — no real `brain.db`. The four BRAIN memory ops are supplied
 * through an INJECTED fake {@link MemoryOps} surface, so every assertion runs
 * in-process. Covers:
 *   - AC1 registration via the self-registering marker + part of the built-in
 *     catalog (toolset 'agent');
 *   - AC2 each tool DELEGATES to the injected memory op with the right params;
 *   - AC3 Zod schema validation (missing query / empty ids → invalid-args);
 *   - AC4 availability always-true daemon-OFF;
 *   - AC5 delegation asserted with an injected fake Brain surface.
 *
 * @task T11947
 * @epic T11456
 */

import type { GuardedToolSurface } from '@cleocode/contracts/tools/skill-executor';
import { describe, expect, it } from 'vitest';
import type { EngineResult } from '../../engine-result.js';
import { AgentToolRegistry } from '../agent-registry.js';
import { registerBuiltinAgentTools } from '../builtin-agent-tools.js';
import { ToolDispatchEngine } from '../dispatch.js';
import { createToolGuard } from '../guard.js';
import { type MemoryOps, registerMemoryAgentTools } from '../memory-agent-tools.js';

/** Unused guarded surface — the memory tools resolve their own seam. */
const noopSurface = {} as GuardedToolSurface;

// ===========================================================================
// Test doubles
// ===========================================================================

interface FakeCalls {
  find: Array<{ query: string; limit?: number }>;
  observe: Array<{ text: string; title?: string }>;
  fetch: Array<{ ids: string[] }>;
  timeline: Array<{ anchor: string; depthBefore?: number; depthAfter?: number }>;
}

/** A fake {@link MemoryOps} that records every call and returns canned success. */
function fakeMemory(): { memory: MemoryOps; calls: FakeCalls } {
  const calls: FakeCalls = { find: [], observe: [], fetch: [], timeline: [] };
  const ok = (data: unknown): EngineResult => ({ success: true, data });
  const memory: MemoryOps = {
    find: async (params) => {
      calls.find.push(params);
      return ok({ hits: [{ id: 'O-1', title: 'hit' }] });
    },
    observe: async (params) => {
      calls.observe.push(params);
      return ok({ id: 'O-new' });
    },
    fetch: async (params) => {
      calls.fetch.push(params);
      return ok({ entries: [{ id: params.ids[0] }] });
    },
    timeline: async (params) => {
      calls.timeline.push(params);
      return ok({ before: [], after: [] });
    },
  };
  return { memory, calls };
}

// ===========================================================================
// AC1 — registration
// ===========================================================================

describe('memory-agent-tools — registration (AC1)', () => {
  it('exports a self-registering marker that registers the four memory tools', async () => {
    const mod = await import('../memory-agent-tools.js');
    expect(typeof mod.registerAgentTools).toBe('function');
    const registry = new AgentToolRegistry();
    mod.registerAgentTools(registry);
    for (const name of ['memory_search', 'memory_observe', 'memory_fetch', 'memory_timeline']) {
      expect(registry.get(name)).toBeDefined();
    }
  });

  it('is part of the built-in catalog in the agent toolset', async () => {
    const registry = new AgentToolRegistry();
    registerBuiltinAgentTools(registry);
    await registry.init({ skipBuiltins: true });
    const agentNames = registry.byToolset('agent').map((t) => t.name);
    expect(agentNames).toEqual(
      expect.arrayContaining([
        'memory_search',
        'memory_observe',
        'memory_fetch',
        'memory_timeline',
      ]),
    );
  });
});

// ===========================================================================
// AC4 — availability always-true daemon-OFF
// ===========================================================================

describe('memory-agent-tools — availability (AC4)', () => {
  it('every memory tool is available with NO egress / capabilities (daemon-OFF)', async () => {
    const registry = new AgentToolRegistry();
    registerMemoryAgentTools(registry, { memory: fakeMemory().memory });
    await registry.init({ skipBuiltins: true });
    const available = registry.available({ networkEgressAllowed: false }).map((t) => t.name);
    expect(available).toEqual(
      expect.arrayContaining([
        'memory_search',
        'memory_observe',
        'memory_fetch',
        'memory_timeline',
      ]),
    );
  });
});

// ===========================================================================
// AC2 / AC5 — delegation to the injected Brain surface
// ===========================================================================

describe('memory-agent-tools — delegation (AC2/AC5)', () => {
  async function registryWith(): Promise<{ registry: AgentToolRegistry; calls: FakeCalls }> {
    const { memory, calls } = fakeMemory();
    const registry = new AgentToolRegistry();
    registerMemoryAgentTools(registry, { memory });
    await registry.init({ skipBuiltins: true });
    return { registry, calls };
  }

  it('memory_search delegates query + limit to memory.find', async () => {
    const { registry, calls } = await registryWith();
    const out = await registry.getExecutable('memory_search')?.(
      { query: 'auth', limit: 5 },
      noopSurface,
    );
    expect(calls.find).toEqual([{ query: 'auth', limit: 5 }]);
    expect(out).toEqual({ hits: [{ id: 'O-1', title: 'hit' }] });
  });

  it('memory_observe delegates text + title to memory.observe', async () => {
    const { registry, calls } = await registryWith();
    await registry.getExecutable('memory_observe')?.(
      { text: 'a learning', title: 'Title' },
      noopSurface,
    );
    expect(calls.observe).toEqual([{ text: 'a learning', title: 'Title' }]);
  });

  it('memory_fetch delegates ids to memory.fetch', async () => {
    const { registry, calls } = await registryWith();
    await registry.getExecutable('memory_fetch')?.({ ids: ['O-1', 'D-2'] }, noopSurface);
    expect(calls.fetch).toEqual([{ ids: ['O-1', 'D-2'] }]);
  });

  it('memory_timeline delegates anchor + depths to memory.timeline', async () => {
    const { registry, calls } = await registryWith();
    await registry.getExecutable('memory_timeline')?.(
      { anchor: 'O-1', depthBefore: 2, depthAfter: 3 },
      noopSurface,
    );
    expect(calls.timeline).toEqual([{ anchor: 'O-1', depthBefore: 2, depthAfter: 3 }]);
  });

  it('surfaces a typed EngineFailure as a non-ok result (never throws)', async () => {
    const registry = new AgentToolRegistry();
    const memory: MemoryOps = {
      find: async () => ({
        success: false,
        error: { code: 'E_BRAIN_SEARCH', message: 'boom' },
      }),
      observe: async () => ({ success: true, data: {} }),
      fetch: async () => ({ success: true, data: {} }),
      timeline: async () => ({ success: true, data: {} }),
    };
    registerMemoryAgentTools(registry, { memory });
    await registry.init({ skipBuiltins: true });
    const out = (await registry.getExecutable('memory_search')?.({ query: 'x' }, noopSurface)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('E_BRAIN_SEARCH');
  });
});

// ===========================================================================
// AC3 — Zod schema validation through the frozen dispatch engine
// ===========================================================================

describe('memory-agent-tools — schema validation (AC3)', () => {
  async function engine(): Promise<ToolDispatchEngine> {
    const registry = new AgentToolRegistry();
    registerMemoryAgentTools(registry, { memory: fakeMemory().memory });
    await registry.init({ skipBuiltins: true });
    return new ToolDispatchEngine({ registry, tools: createToolGuard({ mode: 'enforce' }) });
  }

  it('rejects memory_search without a query as invalid-args', async () => {
    const res = await (await engine()).dispatch({
      id: 'c1',
      name: 'memory_search',
      arguments: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('invalid-args');
  });

  it('rejects memory_fetch with an empty ids array as invalid-args', async () => {
    const res = await (await engine()).dispatch({
      id: 'c2',
      name: 'memory_fetch',
      arguments: { ids: [] },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('invalid-args');
  });

  it('dispatches a valid memory_search call', async () => {
    const res = await (await engine()).dispatch({
      id: 'c3',
      name: 'memory_search',
      arguments: { query: 'auth' },
    });
    expect(res.ok).toBe(true);
  });
});
