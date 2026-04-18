/**
 * CLEO Team topology → lead/worker agent descriptors.
 *
 * CLEO agents are organised in a Lead → Worker hierarchy. Historically this
 * was wired into the `@openai/agents` first-class `handoffs` graph. Post T933
 * (ADR-052 — Vercel AI SDK consolidation) CLEO owns the topology entirely:
 *
 * - A Team Lead is a {@link CleoAgent} whose `handoffs` array lists its workers.
 * - Each Worker archetype (read-only, write, bash) is declared in
 *   `WORKER_ARCHETYPES` and built on demand.
 * - The mapping is driven by `SpawnContext.options.handoffs`, which is an
 *   array of worker archetype names.
 * - When a lead agent needs to delegate, the spawn provider runs a separate
 *   `generateText` call for the selected worker and injects the result back
 *   into the lead's context.
 *
 * @task T582 (original)
 * @task T933 (SDK consolidation — CLEO-native topology)
 */

import type { CleoInputGuardrail } from './guardrails.js';

// ---------------------------------------------------------------------------
// CLEO-native agent shape
// ---------------------------------------------------------------------------

/**
 * Agent descriptor used by the CLEO OpenAI adapter.
 *
 * @remarks
 * Intentionally mirrors the subset of `@openai/agents`'s `Agent` that CLEO
 * actually consumed. The Vercel AI SDK delivers model inference via
 * `generateText` / `streamText`; handoffs are orchestrated by the spawn
 * provider using this descriptor as input.
 */
export interface CleoAgent {
  /** Agent identifier surfaced in trace spans. */
  name: string;
  /** System-level instructions fed to the model. */
  instructions: string;
  /** Vercel AI SDK model identifier (e.g. `gpt-4.1`, `gpt-4.1-mini`). */
  model: string;
  /** Workers this agent may delegate to. Undefined when the agent is a leaf. */
  handoffs?: CleoAgent[];
  /** Input guardrails evaluated before the model call. */
  inputGuardrails?: CleoInputGuardrail[];
}

/**
 * @deprecated Use {@link CleoAgent}. Legacy alias for callers that imported
 *   the `Agent` type from this module. Removed in a future major.
 */
export type Agent = CleoAgent;

// ---------------------------------------------------------------------------
// Worker archetypes
// ---------------------------------------------------------------------------

/**
 * Descriptor for a pre-configured worker agent archetype.
 *
 * Archetypes are declarative templates. `buildWorkerAgent` inflates them into
 * live {@link CleoAgent} instances.
 */
export interface WorkerArchetype {
  /** Archetype identifier (also used as agent name). */
  name: string;
  /** Short description passed as the agent instructions. */
  instructions: string;
  /** Preferred model for this archetype. */
  model: string;
}

/**
 * Registry of built-in CLEO worker archetypes.
 *
 * Callers reference these by name in `SpawnContext.options.handoffs`.
 * New archetypes can be added here without changing the spawn provider.
 */
export const WORKER_ARCHETYPES: Record<string, WorkerArchetype> = {
  'worker-read': {
    name: 'worker-read',
    instructions:
      'You are a read-only CLEO worker. You may only read files and return findings. Never write, modify, or delete files.',
    model: 'gpt-4.1-mini',
  },
  'worker-write': {
    name: 'worker-write',
    instructions:
      'You are a CLEO write worker. You implement code changes directed by the lead agent. Follow the lead agent instructions precisely.',
    model: 'gpt-4.1-mini',
  },
  'worker-bash': {
    name: 'worker-bash',
    instructions:
      'You are a CLEO bash worker. You run shell commands directed by the lead agent. Only execute commands explicitly requested.',
    model: 'gpt-4.1-mini',
  },
};

// ---------------------------------------------------------------------------
// Agent builders
// ---------------------------------------------------------------------------

/**
 * Build a worker {@link CleoAgent} from a named archetype.
 *
 * @param archetypeName - Key in {@link WORKER_ARCHETYPES}.
 * @param guardrails - Input guardrails to attach to the worker agent.
 * @returns A configured agent descriptor or `null` when the archetype is unknown.
 */
export function buildWorkerAgent(
  archetypeName: string,
  guardrails: CleoInputGuardrail[],
): CleoAgent | null {
  const archetype = WORKER_ARCHETYPES[archetypeName];
  if (!archetype) return null;

  return {
    name: archetype.name,
    instructions: archetype.instructions,
    model: archetype.model,
    ...(guardrails.length > 0 ? { inputGuardrails: guardrails } : {}),
  };
}

/**
 * Build a team lead {@link CleoAgent} whose `handoffs` reference the given workers.
 *
 * @param leadInstructions - System instructions for the lead agent.
 * @param leadModel - Model to use for the lead agent.
 * @param workers - Worker agents this lead can hand off to.
 * @param guardrails - Input guardrails to attach to the lead agent.
 * @returns A configured lead agent descriptor.
 */
export function buildLeadAgent(
  leadInstructions: string,
  leadModel: string,
  workers: CleoAgent[],
  guardrails: CleoInputGuardrail[],
): CleoAgent {
  return {
    name: 'cleo-lead',
    instructions: leadInstructions,
    model: leadModel,
    ...(workers.length > 0 ? { handoffs: workers } : {}),
    ...(guardrails.length > 0 ? { inputGuardrails: guardrails } : {}),
  };
}

/**
 * Build a simple single-tier agent (no handoffs) from prompt and model.
 *
 * Used when `SpawnContext.options.tier` is `'worker'` or when no handoff
 * names are provided.
 *
 * @param instructions - Agent system instructions.
 * @param model - Model identifier.
 * @param guardrails - Input guardrails.
 * @returns A configured agent descriptor.
 */
export function buildStandaloneAgent(
  instructions: string,
  model: string,
  guardrails: CleoInputGuardrail[],
): CleoAgent {
  return {
    name: 'cleo-worker',
    instructions,
    model,
    ...(guardrails.length > 0 ? { inputGuardrails: guardrails } : {}),
  };
}

// ---------------------------------------------------------------------------
// Topology builder
// ---------------------------------------------------------------------------

/** Options for building the agent topology from a spawn context. */
export interface TopologyOptions {
  /** Prompt / instructions for the entry-point agent. */
  instructions: string;
  /** Model to use for the lead / standalone agent. */
  model: string;
  /** Agent tier determines whether workers and handoffs are wired. */
  tier: 'lead' | 'worker' | 'orchestrator';
  /** Names of worker archetypes to create and attach as handoffs. */
  handoffNames: string[];
  /** Input guardrails shared across all agents in the topology. */
  guardrails: CleoInputGuardrail[];
}

/**
 * Build the entry-point agent and its worker topology from spawn options.
 *
 * - `tier === 'lead'` or `tier === 'orchestrator'`: creates a lead agent with
 *   worker handoffs derived from `handoffNames`.
 * - `tier === 'worker'`: creates a standalone agent with no handoffs.
 *
 * Unknown archetype names in `handoffNames` are silently skipped.
 *
 * @param options - Topology build options.
 * @returns The entry-point agent descriptor.
 */
export function buildAgentTopology(options: TopologyOptions): CleoAgent {
  const { instructions, model, tier, handoffNames, guardrails } = options;

  if (tier === 'worker') {
    return buildStandaloneAgent(instructions, model, guardrails);
  }

  // Build worker agents from archetype names; skip unknown names.
  const workers: CleoAgent[] = handoffNames
    .map((name) => buildWorkerAgent(name, guardrails))
    .filter((a): a is CleoAgent => a !== null);

  if (workers.length === 0) {
    // Lead with no workers — still usable as a standalone agent.
    return buildStandaloneAgent(instructions, model, guardrails);
  }

  return buildLeadAgent(instructions, model, workers, guardrails);
}
