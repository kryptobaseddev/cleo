/**
 * OpenAI SDK spawn provider — Vercel AI SDK edition.
 *
 * Implements `AdapterSpawnProvider` using the Vercel AI SDK
 * (`ai` v6 + `@ai-sdk/openai`) instead of the legacy `@openai/agents`. CLEO
 * retains its own orchestration (handoff topology, guardrails, tracing); the
 * SDK is strictly the LLM bridge.
 *
 * Unlike the Claude Code provider (detached fire-and-forget), this provider
 * awaits the run and returns `status: 'completed'` or `status: 'failed'` so
 * the orchestrator receives rich output immediately.
 *
 * Key features:
 * - Tier-based model selection (lead → gpt-4.1, worker → gpt-4.1-mini)
 * - Handoff topology built from `SpawnContext.options.handoffs` (CLEO-native)
 * - CLEO path ACL guardrails evaluated before the model call
 * - Default-on tracing via `CleoConduitTraceProcessor`
 * - CANT prompt enrichment (best-effort, same as Claude Code provider)
 *
 * @task T582 (original)
 * @task T933 (SDK consolidation — Vercel AI SDK migration)
 * @see ADR-052 — SDK consolidation decision
 */

import type { AdapterSpawnProvider, SpawnContext, SpawnResult } from '@cleocode/contracts';
import { getErrorMessage } from '@cleocode/contracts';
import { mapSdkRunOutcome } from '../shared/sdk-result-mapper.js';
import { buildDefaultGuardrails, evaluateGuardrails } from './guardrails.js';
import { buildAgentTopology, type CleoAgent } from './handoff.js';
import type { CleoSpan, CleoTraceProcessor } from './tracing.js';
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
   * (enforcement is structural via CLEO orchestration).
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
// Trace processor registry (module-scoped)
// ---------------------------------------------------------------------------

/** Registered trace processors that receive span events across the module. */
const registeredProcessors: CleoTraceProcessor[] = [];

/** Module-level flag that disables span dispatch globally. */
let tracingGlobalDisabled = false;

/**
 * Register a CLEO trace processor. Mirrors `addTraceProcessor` from the
 * legacy `@openai/agents` surface so existing consumers continue to work.
 *
 * @param processor - Processor to register.
 */
export function registerTraceProcessor(processor: CleoTraceProcessor): void {
  registeredProcessors.push(processor);
}

/**
 * Remove a previously registered trace processor.
 *
 * @param processor - Processor to remove.
 */
export function unregisterTraceProcessor(processor: CleoTraceProcessor): void {
  const idx = registeredProcessors.indexOf(processor);
  if (idx >= 0) {
    registeredProcessors.splice(idx, 1);
  }
}

/**
 * Enable or disable global tracing. Equivalent to `setTracingDisabled` from
 * the legacy `@openai/agents` surface.
 *
 * @param disabled - When true, no spans are emitted.
 */
export function setTracingDisabled(disabled: boolean): void {
  tracingGlobalDisabled = disabled;
}

/**
 * Dispatch a span to every registered trace processor, subject to the global
 * `tracingGlobalDisabled` flag.
 *
 * @param span - Span event to dispatch.
 */
async function emitSpan(span: CleoSpan): Promise<void> {
  if (tracingGlobalDisabled) return;
  for (const processor of registeredProcessors) {
    try {
      await processor.onSpanEnd(span);
    } catch {
      // Tracing failures must never break a run.
    }
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Spawn provider for the Vercel AI SDK (OpenAI flavour).
 *
 * Spawns SDK-backed agent runs for a given `SpawnContext`. The run is awaited
 * synchronously and the result mapped to a `SpawnResult` with
 * `status: 'completed'` or `status: 'failed'`. In-flight runs are tracked by
 * instance ID so `listRunning()` and `terminate()` work correctly.
 *
 * @remarks
 * Handoff topology is resolved by this provider, not the SDK. When the entry
 * agent is a lead with workers, the provider:
 *
 *   1. Runs the lead agent's `generateText` with the enriched prompt.
 *   2. For each worker listed in handoffs, runs a sequential `generateText`
 *      using the worker's archetype model, passing the lead's output as the
 *      worker prompt. Results are concatenated.
 *
 * This preserves the visible behaviour of the legacy `@openai/agents` runner
 * while keeping CLEO as the orchestration owner.
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
   * Spawn a subagent via the Vercel AI SDK.
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
      let traceProcessor: CleoConduitTraceProcessor | undefined;
      const previousTracingDisabled = tracingGlobalDisabled;
      if (!opts.tracingDisabled) {
        traceProcessor = new CleoConduitTraceProcessor(context.taskId);
        registerTraceProcessor(traceProcessor);
        setTracingDisabled(false);
      } else {
        setTracingDisabled(true);
      }

      try {
        // Evaluate guardrails before any model call. A tripped guardrail
        // aborts the run with a structured failure.
        const guardResult = await evaluateGuardrails(agent.inputGuardrails ?? [], finalPrompt);
        if (guardResult.tripwireTriggered) {
          this.runningInstances.delete(instanceId);
          return mapSdkRunOutcome(instanceId, context.taskId, 'openai-sdk', startTime, {
            finalOutput: '',
            succeeded: false,
            errorMessage: `guardrail tripped: ${JSON.stringify(guardResult.outputInfo)}`,
          });
        }

        // Run the lead/worker topology.
        const runOutput = await runAgentTopology(agent, finalPrompt, emitSpan);

        this.runningInstances.delete(instanceId);

        return mapSdkRunOutcome(instanceId, context.taskId, 'openai-sdk', startTime, {
          finalOutput: runOutput,
          succeeded: true,
        });
      } finally {
        // Restore previous tracing state and unregister this run's processor.
        if (traceProcessor) {
          unregisterTraceProcessor(traceProcessor);
        }
        setTracingDisabled(previousTracingDisabled);
      }
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
   * The Vercel AI SDK does not support external termination of in-flight
   * requests; this method removes the instance from the tracking set so it
   * will no longer appear in `listRunning()`.
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

// ---------------------------------------------------------------------------
// Topology runner
// ---------------------------------------------------------------------------

/**
 * Execute a CLEO agent topology against the Vercel AI SDK.
 *
 * Runs the entry agent via `generateText`. When the entry agent declares
 * handoffs, each worker is executed sequentially with the lead's output as
 * input and the concatenated result returned.
 *
 * @param agent - Entry agent descriptor.
 * @param userPrompt - Enriched user prompt.
 * @param emit - Span emitter invoked after every agent run.
 * @returns Concatenated assistant output.
 */
async function runAgentTopology(
  agent: CleoAgent,
  userPrompt: string,
  emit: (span: CleoSpan) => Promise<void>,
): Promise<string> {
  const { createOpenAI } = await import('@ai-sdk/openai');
  const { generateText } = await import('ai');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set — OpenAI SDK provider cannot run');
  }

  const openai = createOpenAI({ apiKey });

  // Run the entry agent.
  const startedAt = new Date().toISOString();
  const leadResult = await generateText({
    model: openai(agent.model),
    system: agent.instructions,
    prompt: userPrompt,
  });
  const leadText = (leadResult.text ?? '').trim();
  const leadEnd = new Date().toISOString();

  await emit({
    spanId: `${agent.name}-${Date.now()}`,
    startedAt,
    endedAt: leadEnd,
    spanData: { type: 'agent', name: agent.name },
  });

  // When there are no handoffs, return the lead output directly.
  const workers = agent.handoffs ?? [];
  if (workers.length === 0) {
    return leadText;
  }

  // Sequential handoff execution. Each worker receives the lead output as
  // input, and the concatenated worker outputs become the final run output.
  const workerOutputs: string[] = [];
  for (const worker of workers) {
    const handoffStart = new Date().toISOString();
    await emit({
      spanId: `handoff-${agent.name}-${worker.name}-${Date.now()}`,
      startedAt: handoffStart,
      endedAt: handoffStart,
      spanData: { type: 'handoff', from_agent: agent.name, to_agent: worker.name },
    });

    const workerStart = new Date().toISOString();
    const workerResult = await generateText({
      model: openai(worker.model),
      system: worker.instructions,
      prompt: leadText,
    });
    const workerEnd = new Date().toISOString();

    await emit({
      spanId: `${worker.name}-${Date.now()}`,
      startedAt: workerStart,
      endedAt: workerEnd,
      spanData: { type: 'agent', name: worker.name },
    });

    workerOutputs.push(`[${worker.name}] ${(workerResult.text ?? '').trim()}`);
  }

  return [leadText, ...workerOutputs].join('\n\n');
}
