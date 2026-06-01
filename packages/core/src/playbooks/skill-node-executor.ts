/**
 * Skill-node executor factory — wires the in-process {@link SkillExecutorAdapter}
 * into `CoreAgentDispatcherOptions.executor` while RETAINING the subprocess-spawn
 * path for isolation nodes (T11477 · epic T11391 · saga T11387).
 *
 * ## The routing decision (AC2 + AC3)
 *
 * `CoreAgentDispatcher` resolves `agentId = node.agent ?? node.skill` and then
 * calls its injected `executor` to perform the actual work. This factory builds
 * that executor so it routes on the node's nature:
 *
 *  - **In-process skill node** — the `agentId` names a `ct-*` skill that
 *    resolves via {@link findSkill}, AND the dispatch context does not request
 *    isolation. These run through {@link SkillExecutorAdapter} **in-process**:
 *    the skill→tool joint is a function call over the injected
 *    {@link GuardedToolSurface}, NOT a process boundary (AC1, AC4). This is the
 *    DEFAULT for in-process skill nodes, REPLACING `orchestrateSpawnExecute`
 *    for them (AC2).
 *
 *  - **Isolation / agent node** — anything else (an `agent`-backed node, a node
 *    whose context requests `isolation`, or a skill that does not resolve
 *    in-process). These delegate to the INJECTED {@link SubprocessSpawnExecutor}
 *    — typically the runtime's `orchestrateSpawnExecute`, which provisions a git
 *    worktree and spawns a real subagent (AC3). The fallback is injected, not
 *    imported, so `@cleocode/core` keeps its no-dependency-on-`@cleocode/runtime`
 *    invariant (DIP again — the worktree mechanism is a detail core depends on
 *    through an abstraction).
 *
 * ## Why the fallback is injected
 *
 * `orchestrateSpawnExecute` lives in `@cleocode/runtime/gateway`. `core` must not
 * import it (directed layering `contracts → core → runtime`). The CLI/runtime
 * layer that already imports the gateway supplies it via
 * {@link SkillNodeExecutorOptions.subprocessSpawn}; when omitted, isolation nodes
 * report a structured failure rather than silently degrading.
 *
 * @epic T11391
 * @task T11477
 * @saga T11387
 */

import type { ResolvedAgent } from '@cleocode/contracts';
import type { GuardedToolSurface } from '@cleocode/contracts/tools/skill-executor';
import { findSkill } from '../skills/discovery.js';
import { SkillExecutorAdapter, type SkillRunner } from '../skills/skill-executor-adapter.js';
import type { DispatchContext, DispatchResult } from './agent-dispatcher.js';

/**
 * Context-binding key the playbook author / dispatcher uses to FORCE the
 * subprocess-spawn (isolation) path even when the node names a resolvable
 * `ct-*` skill. Truthy → isolation; absent/falsy → in-process skill execution.
 */
export const ISOLATION_CONTEXT_KEY = 'isolation';

/**
 * Subprocess-spawn fallback for isolation / agent nodes. Mirrors the shape the
 * runtime's `orchestrateSpawnExecute` is adapted to: given the resolved agent
 * and dispatch context, perform a real (worktree-isolated) spawn and return a
 * dispatch envelope.
 *
 * Injected (not imported) so `core` never depends on `@cleocode/runtime`.
 *
 * @param agent - The resolved agent/skill envelope from the dispatcher.
 * @param context - The dispatch context (run id, node id, agent id, bindings).
 * @returns The terminal {@link DispatchResult} for the subprocess spawn.
 */
export type SubprocessSpawnExecutor = (
  agent: ResolvedAgent,
  context: DispatchContext,
) => Promise<DispatchResult>;

/**
 * Options accepted by {@link createSkillNodeExecutor}.
 *
 * @task T11477
 */
export interface SkillNodeExecutorOptions {
  /**
   * The deny-first guarded tool surface handed to every in-process skill
   * execution. Typically the result of `createToolGuard({ allowedRoots: [...] })`.
   * Injected (DIP) — the executor never constructs its own guard.
   */
  readonly tools: GuardedToolSurface;
  /**
   * The subprocess-spawn fallback used for isolation / agent nodes (AC3). When
   * omitted, isolation nodes return a structured failure instead of silently
   * running in-process — refusing to weaken the isolation guarantee.
   */
  readonly subprocessSpawn?: SubprocessSpawnExecutor;
  /**
   * Working directory used to resolve `ct-*` skills. Defaults to the process
   * cwd via {@link findSkill}.
   */
  readonly cwd?: string;
  /**
   * Optional in-process runner strategy forwarded to the
   * {@link SkillExecutorAdapter} (the GenKit-phase model runner plugs in here).
   */
  readonly runner?: SkillRunner;
}

/**
 * `true` when this dispatch should take the in-process skill path: the agentId
 * names a `ct-*`-resolvable skill AND the context does not request isolation.
 *
 * @param agentId - The resolved agent/skill id (`node.agent ?? node.skill`).
 * @param context - The dispatch context whose bindings may request isolation.
 * @param cwd - Skill-resolution cwd.
 * @returns Whether the in-process {@link SkillExecutorAdapter} should handle it.
 */
function isInProcessSkillNode(
  agentId: string,
  context: DispatchContext,
  cwd: string | undefined,
): boolean {
  if (context.context[ISOLATION_CONTEXT_KEY]) return false;
  return findSkill(agentId, cwd) !== null;
}

/**
 * Build a `CoreAgentDispatcherOptions.executor` that runs in-process skill nodes
 * through {@link SkillExecutorAdapter} and routes isolation / agent nodes to the
 * injected subprocess-spawn fallback.
 *
 * Inject the result as `executor` when constructing a `CoreAgentDispatcher`:
 *
 * @example
 * ```ts
 * import { createToolGuard } from '@cleocode/core/tools/guard';
 * import { orchestrateSpawnExecute } from '@cleocode/runtime/gateway';
 *
 * const tools = createToolGuard({ allowedRoots: [projectRoot] });
 * const dispatcher = new CoreAgentDispatcher({
 *   db,
 *   projectRoot,
 *   executor: createSkillNodeExecutor({
 *     tools,
 *     cwd: projectRoot,
 *     subprocessSpawn: async (agent, ctx) => adaptOrchestrateSpawn(agent, ctx),
 *   }),
 * });
 * ```
 *
 * @param opts - Injected tool surface + subprocess-spawn fallback + cwd/runner.
 * @returns An executor suitable for `CoreAgentDispatcherOptions.executor`.
 * @task T11477
 */
export function createSkillNodeExecutor(
  opts: SkillNodeExecutorOptions,
): (agent: ResolvedAgent, context: DispatchContext) => Promise<DispatchResult> {
  const adapter = new SkillExecutorAdapter({
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
  });

  return async (agent: ResolvedAgent, context: DispatchContext): Promise<DispatchResult> => {
    // In-process skill node (default; replaces orchestrateSpawnExecute) — AC1/AC2/AC4.
    if (isInProcessSkillNode(context.agentId, context, opts.cwd)) {
      const result = await adapter.execute({
        skillId: context.agentId,
        context: context.context,
        tools: opts.tools,
      });
      // SkillExecuteResult and DispatchResult are structurally identical envelopes.
      return result.error !== undefined
        ? { status: result.status, output: { ...result.output }, error: result.error }
        : { status: result.status, output: { ...result.output } };
    }

    // Isolation / agent node — RETAIN the subprocess-spawn path (AC3).
    if (opts.subprocessSpawn !== undefined) {
      return opts.subprocessSpawn(agent, context);
    }
    return {
      status: 'failure',
      output: {},
      error:
        `node "${context.nodeId}" requires subprocess-spawn (isolation/agent "${context.agentId}") ` +
        'but no subprocessSpawn executor was injected',
    };
  };
}

// ---------------------------------------------------------------------------
// Runtime-input-shaped routing (the CLI `cleo playbook run` default path)
// ---------------------------------------------------------------------------

/**
 * Minimal projection of the playbook runtime's `AgentDispatchInput` that the
 * routing helper needs. Declared structurally so `core` does NOT import
 * `@cleocode/playbooks` (preserves the directed layering `contracts → core →
 * playbooks`) — the CLI passes its runtime input through unchanged.
 */
export interface SkillNodeDispatchInput {
  /** Node identifier within the run graph. */
  readonly nodeId: string;
  /** Agent identity resolved from `node.agent ?? node.skill`. */
  readonly agentId: string;
  /** Accumulated bindings at dispatch time (may carry an `isolation` flag). */
  readonly context: Record<string, unknown>;
}

/**
 * Route a single agentic dispatch: run it in-process via
 * {@link SkillExecutorAdapter} when it is a resolvable `ct-*` skill node, else
 * delegate to the injected subprocess-spawn fallback (isolation/agent nodes).
 *
 * This is the runtime-input-shaped companion to {@link createSkillNodeExecutor},
 * used by the CLI's default `cleo playbook run` dispatcher so the in-process
 * skill path becomes the DEFAULT, REPLACING `orchestrateSpawnExecute` for skill
 * nodes (AC2) while RETAINING it for isolation nodes (AC3). Keeping the routing
 * decision here keeps the CLI dispatcher a thin adapter (CLI package boundary).
 *
 * @param input - The runtime dispatch input (node id, agent id, context).
 * @param opts - Injected tool surface, cwd/runner, and subprocess-spawn fallback.
 * @returns The terminal {@link DispatchResult} envelope.
 * @task T11477
 */
export async function runSkillNodeOrSpawn(
  input: SkillNodeDispatchInput,
  opts: SkillNodeExecutorOptions & { subprocessSpawn: () => Promise<DispatchResult> },
): Promise<DispatchResult> {
  const isolationRequested = Boolean(input.context[ISOLATION_CONTEXT_KEY]);
  if (!isolationRequested && findSkill(input.agentId, opts.cwd) !== null) {
    const adapter = new SkillExecutorAdapter({
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    });
    const result = await adapter.execute({
      skillId: input.agentId,
      context: input.context,
      tools: opts.tools,
    });
    return result.error !== undefined
      ? { status: result.status, output: { ...result.output }, error: result.error }
      : { status: result.status, output: { ...result.output } };
  }
  // Isolation / agent node — RETAIN the subprocess-spawn path (AC3).
  return opts.subprocessSpawn();
}
