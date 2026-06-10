/**
 * Memory (BRAIN) agent-tool family — `memory_search` / `memory_observe` /
 * `memory_fetch` / `memory_timeline` (T11947 · M7 · epic T11456 · SG-TOOLS).
 *
 * Surfaces the EXISTING BRAIN cognitive-memory operations to the agent loop as
 * `agent`-toolset tools, mirroring the `cleo memory find|observe|fetch|timeline`
 * CLI verbs. It adds NO new store, NO new SQL, and NO new schema: each tool
 * DELEGATES to the established memory ops in
 * {@link import('../memory/engine-compat.js')}
 * ({@link memoryFind} / {@link memoryObserve} / {@link memoryFetch} /
 * {@link memoryTimeline}), which themselves route through the BRAIN retrieval
 * accessors + the store chokepoint. The agent loop never re-implements brain
 * retrieval — it reuses the SAME path the CLI and the orchestrator use.
 *
 * ## Why a seam, not a hardcoded import (AC5 + Gate-11)
 *
 * The four memory ops are injected through the {@link MemoryOps} seam, defaulting
 * to the real `engine-compat` functions. This lets the unit test inject a FAKE
 * Brain surface and assert delegation + schema validation WITHOUT opening a real
 * `brain.db`. Production binds the real ops. The tools are DEFINED here under
 * `packages/core/src/tools` and CONSUME the memory subsystem — they construct no
 * new atomic primitive (Gate-11).
 *
 * ## Availability (AC4)
 *
 * BRAIN read/write is a LOCAL SQLite operation through the store chokepoint — no
 * credential, no network, no daemon. Every memory tool is therefore
 * {@link ALWAYS_AVAILABLE}: it works daemon-OFF and credential-OFF.
 *
 * ## Gate-13
 *
 * No model/transport/provider client is constructed here — BRAIN search is a
 * local FTS/SQLite query, not an LLM call. There is no chokepoint concern.
 *
 * @epic T11456
 * @task T11947
 * @see ../memory/engine-compat.js — the memory ops this family delegates to
 * @see ./exec-code-agent-tool.js — the injectable-seam + self-registering-marker pattern mirrored here
 */

import { z } from 'zod';
import type { EngineResult } from '../engine-result.js';
import {
  memoryFetch as realMemoryFetch,
  memoryFind as realMemoryFind,
  memoryObserve as realMemoryObserve,
  memoryTimeline as realMemoryTimeline,
} from '../memory/engine-compat.js';
import { resolveOrCwd } from '../paths.js';
import { type AgentToolRegistry, ALWAYS_AVAILABLE } from './agent-registry.js';

/**
 * The BRAIN memory operations the family delegates to. Each member has the SAME
 * signature as the corresponding `engine-compat` function — `(params, root?) →
 * Promise<EngineResult>`. Injectable so the unit test can supply a fake Brain
 * surface; defaults to the real ops in production.
 */
export interface MemoryOps {
  /** Token-efficient compact search (→ `cleo memory find`). */
  readonly find: (
    params: { query: string; limit?: number },
    projectRoot?: string,
  ) => Promise<EngineResult>;
  /** Append an observation (→ `cleo memory observe`). */
  readonly observe: (
    params: { text: string; title?: string },
    projectRoot?: string,
  ) => Promise<EngineResult>;
  /** Batch fetch entries by ID (→ `cleo memory fetch`). */
  readonly fetch: (params: { ids: string[] }, projectRoot?: string) => Promise<EngineResult>;
  /** Chronological context around an anchor (→ `cleo memory timeline`). */
  readonly timeline: (
    params: { anchor: string; depthBefore?: number; depthAfter?: number },
    projectRoot?: string,
  ) => Promise<EngineResult>;
}

/** The real BRAIN memory ops — the production default for {@link MemoryOps}. */
const REAL_MEMORY_OPS: MemoryOps = {
  find: realMemoryFind,
  observe: realMemoryObserve,
  fetch: realMemoryFetch,
  timeline: realMemoryTimeline,
};

/** Options for {@link registerMemoryAgentTools} — all injectable for testing. */
export interface MemoryAgentToolOptions {
  /** The memory ops seam. Defaults to the real `engine-compat` functions. */
  readonly memory?: MemoryOps;
  /**
   * The project root threaded into every op (defaults to the resolved project
   * root via {@link resolveOrCwd} — never a bare `process.cwd()` in core, T9584).
   */
  readonly projectRoot?: string;
}

/**
 * Coerce an {@link EngineResult} into the opaque value the loop serialises back
 * to the model. On success the `data` payload is returned as-is; on failure a
 * stable `{ ok: false, error }` shape is returned (the op never throws for an
 * expected failure — it returns a typed `EngineFailure`).
 *
 * @param result - The op's EngineResult.
 * @returns The success data, or a typed failure object.
 */
function unwrapEngineResult(result: EngineResult): unknown {
  if (result.success) return result.data;
  return { ok: false, error: result.error };
}

/**
 * Register the memory (BRAIN) agent-tool family into `registry`. Pure
 * registration — no `brain.db` is opened, no query runs here; all of that happens
 * later inside each tool's `execute` through the injected (or default) ops.
 * Import-time side-effect-free.
 *
 * @param registry - The registry to populate.
 * @param options - Injectable memory ops / project root (for testing).
 */
export function registerMemoryAgentTools(
  registry: AgentToolRegistry,
  options: MemoryAgentToolOptions = {},
): void {
  const memory: MemoryOps = options.memory ?? REAL_MEMORY_OPS;
  const projectRoot = resolveOrCwd(options.projectRoot);

  // --- memory_search (→ memoryFind) ----------------------------------------
  registry.register({
    name: 'memory_search',
    // 'search' — a local read-query of the BRAIN store (no side effect beyond reading).
    class: 'search',
    description:
      'Search BRAIN cognitive memory (decisions / patterns / learnings / observations) ' +
      'for entries matching a query, returning compact hits (IDs + titles). Use memory_fetch ' +
      'to retrieve full details for a hit.',
    toolset: 'agent',
    stateless: true,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({
      query: z.string().describe('Free-text search query.'),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Maximum number of compact hits to return.'),
    }),
    execute: async (rawArgs): Promise<unknown> => {
      const query = String(rawArgs.query);
      const limit = typeof rawArgs.limit === 'number' ? rawArgs.limit : undefined;
      const result = await memory.find({ query, limit }, projectRoot);
      return unwrapEngineResult(result);
    },
  });

  // --- memory_observe (→ memoryObserve) ------------------------------------
  registry.register({
    name: 'memory_observe',
    // 'fs' — persists a row to the local BRAIN store (its strongest side-effect surface).
    class: 'fs',
    description:
      'Append a new observation to BRAIN memory (an O-prefixed entry). Use after a ' +
      'non-trivial step to record a learning or decision for future sessions.',
    toolset: 'agent',
    stateless: false,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({
      text: z.string().describe('The observation body to store.'),
      title: z.string().optional().describe('A short title for the observation.'),
    }),
    execute: async (rawArgs): Promise<unknown> => {
      const text = String(rawArgs.text);
      const title = rawArgs.title === undefined ? undefined : String(rawArgs.title);
      const result = await memory.observe({ text, title }, projectRoot);
      return unwrapEngineResult(result);
    },
  });

  // --- memory_fetch (→ memoryFetch) ----------------------------------------
  registry.register({
    name: 'memory_fetch',
    class: 'search',
    description:
      'Fetch full details for one or more BRAIN entries by ID (e.g. O-abc123, D-def456). ' +
      'Use after memory_search to expand a compact hit.',
    toolset: 'agent',
    stateless: true,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({
      ids: z
        .array(z.string())
        .min(1)
        .describe('One or more BRAIN entry IDs to fetch (e.g. ["O-abc123"]).'),
    }),
    execute: async (rawArgs): Promise<unknown> => {
      const ids = Array.isArray(rawArgs.ids) ? rawArgs.ids.map(String) : [];
      const result = await memory.fetch({ ids }, projectRoot);
      return unwrapEngineResult(result);
    },
  });

  // --- memory_timeline (→ memoryTimeline) ----------------------------------
  registry.register({
    name: 'memory_timeline',
    class: 'search',
    description:
      'Retrieve chronological context around a BRAIN entry — the entries recorded before ' +
      'and after a given anchor ID — to understand the sequence of observations and decisions.',
    toolset: 'agent',
    stateless: true,
    available: ALWAYS_AVAILABLE,
    parameters: z.object({
      anchor: z.string().describe('The BRAIN entry ID to anchor the timeline window on.'),
      depthBefore: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('How many entries before the anchor to include.'),
      depthAfter: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe('How many entries after the anchor to include.'),
    }),
    execute: async (rawArgs): Promise<unknown> => {
      const anchor = String(rawArgs.anchor);
      const depthBefore = typeof rawArgs.depthBefore === 'number' ? rawArgs.depthBefore : undefined;
      const depthAfter = typeof rawArgs.depthAfter === 'number' ? rawArgs.depthAfter : undefined;
      const result = await memory.timeline({ anchor, depthBefore, depthAfter }, projectRoot);
      return unwrapEngineResult(result);
    },
  });
}

/**
 * Self-registration marker (AC1) — the identifier the
 * {@link AgentToolRegistry.discover} bounded source scan greps for. Aliases
 * {@link registerMemoryAgentTools} so a future scan-dir discovery (or the
 * built-in aggregator) can call it uniformly with the other agent-tool modules.
 *
 * @param registry - The registry to populate.
 */
export function registerAgentTools(registry: AgentToolRegistry): void {
  registerMemoryAgentTools(registry);
}
