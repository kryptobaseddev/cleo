/**
 * OpenAI Agents SDK spawn provider.
 *
 * Implements `AdapterSpawnProvider` using the `@openai/agents` SDK runner.
 * Unlike the Claude Code provider (detached fire-and-forget), this provider
 * awaits the run and returns `status: 'completed'` or `status: 'failed'`
 * so the orchestrator receives rich output immediately.
 *
 * Key features:
 * - Tier-based model selection (lead → gpt-4.1, worker → gpt-4.1-mini)
 * - Handoff topology built from `SpawnContext.options.handoffs`
 * - CLEO path ACL guardrails applied at input stage
 * - Default-on tracing via `CleoConduitTraceProcessor`
 * - CANT prompt enrichment (best-effort, same as Claude Code provider)
 *
 * @task T582
 */

import type { AdapterSpawnProvider, SpawnContext, SpawnResult } from '@cleocode/contracts';
import { getErrorMessage } from '@cleocode/contracts';
import { addTraceProcessor, OpenAIProvider, Runner, setTracingDisabled } from '@openai/agents';
import { mapSdkRunOutcome } from '../shared/sdk-result-mapper.js';
import { buildDefaultGuardrails } from './guardrails.js';
import { buildAgentTopology } from './handoff.js';
import { CleoConduitTraceProcessor } from './tracing.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * OpenAI SDK-specific spawn options carried in `SpawnContext.options`.
 *
 * @remarks
 * All fields are optional. Unknown fields are ignored.
 */
export interface OpenAiSdkSpawnOptions {
  /**
   * OpenAI model to use.
   *
   * @defaultValue Derived from `tier`:
   *   - `'lead'` / `'orchestrator'` → `'gpt-4.1'`
   *   - `'worker'` → `'gpt-4.1-mini'`
   */
  model?: string;

  /**
   * Agent archetype tier. Controls model selection and topology shape.
   *
   * @defaultValue `'worker'`
   */
  tier?: 'lead' | 'worker' | 'orchestrator';

  /**
   * Worker archetype names this agent may hand off to.
   * References keys in `WORKER_ARCHETYPES` from `handoff.ts`.
   *
   * @defaultValue `[]`
   */
  handoffs?: string[];

  /**
   * File-path glob ACL allowlist. Paths outside this list trip the path guardrail.
   *
   * @defaultValue `[]` (all paths allowed)
   */
  allowedGlobs?: string[];

  /**
   * Tool name allowlist. Tools not in this list are documented but not enforced
   * (enforcement is structural via the `tools` array on the Agent).
   *
   * @defaultValue `[]` (all tools allowed)
   */
  allowedTools?: string[];

  /**
   * Disable tracing to conduit.db.
   *
   * @defaultValue `false`
   */
  tracingDisabled?: boolean;

  /**
   * Agent display name used as the CANT persona.
   */
  agentName?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_LEAD = 'gpt-4.1';
const MODEL_WORKER = 'gpt-4.1-mini';

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Spawn provider for the OpenAI Agents SDK.
 *
 * Spawns SDK-backed agent runs for a given `SpawnContext`. The run is
 * awaited synchronously and the result mapped to a `SpawnResult` with
 * `status: 'completed'` or `status: 'failed'`. In-flight runs are tracked
 * by instance ID so `listRunning()` and `terminate()` work correctly.
 *
 * @remarks
 * The provider creates a fresh `Runner` per spawn so that `RunConfig`
 * settings do not bleed across parallel spawns. Trace processors are
 * registered globally via `addTraceProcessor` and removed by disabling
 * tracing when the option is set.
 *
 * @example
 * ```typescript
 * const provider = new OpenAiSdkSpawnProvider();
 * const result = await provider.spawn({
 *   taskId: 'T582',
 *   prompt: 'Implement feature X',
 *   options: { tier: 'lead', handoffs: ['worker-read', 'worker-write'] },
 * });
 * console.log(result.status); // 'completed'
 * ```
 */
export class OpenAiSdkSpawnProvider implements AdapterSpawnProvider {
  /** Currently running instance IDs (completed runs are removed). */
  private readonly runningInstances = new Set<string>();

  /**
   * Check whether the OpenAI SDK can spawn in the current environment.
   *
   * Requires `OPENAI_API_KEY` to be set. Does not make a network call.
   *
   * @returns `true` when `OPENAI_API_KEY` is present in the environment.
   */
  async canSpawn(): Promise<boolean> {
    return typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.length > 0;
  }

  /**
   * Spawn a subagent via the OpenAI Agents SDK runner.
   *
   * Awaits the run to completion and returns a fully-resolved `SpawnResult`.
   *
   * @param context - Spawn context with task ID, prompt, and options.
   * @returns Resolved spawn result with `status: 'completed'` or `'failed'`.
   */
  async spawn(context: SpawnContext): Promise<SpawnResult> {
    const instanceId = `openai-sdk-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const startTime = new Date().toISOString();

    this.runningInstances.add(instanceId);

    try {
      const opts = this.parseOptions(context.options);

      // Enrich prompt with CANT bundle (best-effort, same pattern as Claude Code provider).
      let finalPrompt = context.prompt;
      try {
        const { buildCantEnrichedPrompt } = await import('../../cant-context.js');
        finalPrompt = await buildCantEnrichedPrompt({
          projectDir: context.workingDirectory ?? process.cwd(),
          basePrompt: context.prompt,
          agentName: opts.agentName,
        });
      } catch {
        // CANT enrichment unavailable — use raw prompt.
      }

      // Build guardrails from ACL options.
      const guardrails = buildDefaultGuardrails(opts.allowedGlobs ?? [], opts.allowedTools ?? []);

      // Derive model from tier when not explicitly set.
      const model = opts.model ?? this.modelForTier(opts.tier ?? 'worker');

      // Build agent topology (lead + workers, or standalone worker).
      const agent = buildAgentTopology({
        instructions: finalPrompt,
        model,
        tier: opts.tier ?? 'worker',
        handoffNames: opts.handoffs ?? [],
        guardrails,
      });

      // Register trace processor globally (default-on).
      // The SDK uses global processor registration via addTraceProcessor().
      let traceProcessor: CleoConduitTraceProcessor | undefined;
      if (!opts.tracingDisabled) {
        traceProcessor = new CleoConduitTraceProcessor(context.taskId);
        addTraceProcessor(traceProcessor);
      } else {
        setTracingDisabled(true);
      }

      // Build OpenAI model provider and runner.
      const modelProvider = new OpenAIProvider();
      const runner = new Runner({ modelProvider });

      // Run the agent — no extra options needed beyond what is set on the runner.
      const runResult = await runner.run(agent, finalPrompt);

      // Restore tracing state if we disabled it for this spawn.
      if (opts.tracingDisabled) {
        setTracingDisabled(false);
      }

      const finalOutput =
        typeof runResult.finalOutput === 'string'
          ? runResult.finalOutput
          : JSON.stringify(runResult.finalOutput);

      this.runningInstances.delete(instanceId);

      return mapSdkRunOutcome(instanceId, context.taskId, 'openai-sdk', startTime, {
        finalOutput,
        succeeded: true,
      });
    } catch (error: unknown) {
      this.runningInstances.delete(instanceId);

      return mapSdkRunOutcome(instanceId, context.taskId, 'openai-sdk', startTime, {
        finalOutput: '',
        succeeded: false,
        errorMessage: getErrorMessage(error),
      });
    }
  }

  /**
   * List currently running OpenAI SDK agent instances.
   *
   * @returns Array of in-progress spawn results.
   */
  async listRunning(): Promise<SpawnResult[]> {
    return [...this.runningInstances].map((instanceId) => ({
      instanceId,
      taskId: 'unknown',
      providerId: 'openai-sdk',
      status: 'running' as const,
      startTime: new Date().toISOString(),
    }));
  }

  /**
   * Terminate a running spawn by instance ID.
   *
   * The OpenAI SDK runner does not support external termination of in-flight
   * runs; this method removes the instance from the tracking set so it will
   * no longer appear in `listRunning()`.
   *
   * @param instanceId - ID of the spawn instance to terminate.
   */
  async terminate(instanceId: string): Promise<void> {
    this.runningInstances.delete(instanceId);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Parse and validate `SpawnContext.options` into typed `OpenAiSdkSpawnOptions`.
   *
   * Unknown fields are silently ignored.
   */
  private parseOptions(raw?: Record<string, unknown>): OpenAiSdkSpawnOptions {
    if (!raw) return {};

    const opts: OpenAiSdkSpawnOptions = {};

    if (typeof raw.model === 'string') opts.model = raw.model;
    if (raw.tier === 'lead' || raw.tier === 'worker' || raw.tier === 'orchestrator') {
      opts.tier = raw.tier;
    }
    if (Array.isArray(raw.handoffs) && raw.handoffs.every((h) => typeof h === 'string')) {
      opts.handoffs = raw.handoffs as string[];
    }
    if (Array.isArray(raw.allowedGlobs) && raw.allowedGlobs.every((g) => typeof g === 'string')) {
      opts.allowedGlobs = raw.allowedGlobs as string[];
    }
    if (Array.isArray(raw.allowedTools) && raw.allowedTools.every((t) => typeof t === 'string')) {
      opts.allowedTools = raw.allowedTools as string[];
    }
    if (typeof raw.tracingDisabled === 'boolean') opts.tracingDisabled = raw.tracingDisabled;
    if (typeof raw.agentName === 'string') opts.agentName = raw.agentName;

    return opts;
  }

  /**
   * Derive the default model for a given tier.
   *
   * @param tier - Agent tier.
   * @returns Model identifier string.
   */
  private modelForTier(tier: 'lead' | 'worker' | 'orchestrator'): string {
    return tier === 'worker' ? MODEL_WORKER : MODEL_LEAD;
  }
}
