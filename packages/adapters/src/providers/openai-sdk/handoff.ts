/**
 * CLEO Team topology → OpenAI Agents SDK handoff mapping.
 *
 * CLEO agents are organised in a Lead → Worker hierarchy. This module maps
 * that topology to the SDK's first-class `handoffs` graph:
 *
 * - A Team Lead becomes an `Agent` whose `handoffs` array lists its workers.
 * - Each Worker archetype (read-only, write, bash) is declared in
 *   `WORKER_ARCHETYPES` and built on demand.
 * - The mapping is driven by `SpawnContext.options.handoffs`, which is an
 *   array of worker archetype names.
 *
 * @task T582
 */

import type { InputGuardrail } from '@openai/agents';
import { Agent } from '@openai/agents';

// ---------------------------------------------------------------------------
// Worker archetypes
// ---------------------------------------------------------------------------

/**
 * Descriptor for a pre-configured worker agent archetype.
 *
 * Archetypes are declarative templates. `buildWorkerAgent` inflates them into
 * live SDK `Agent` instances.
 */
export interface WorkerArchetype {
  /** Archetype identifier (also used as SDK agent name). */
  name: string;
  /** Short description passed as the SDK agent instructions. */
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
 * Build a worker `Agent` instance from a named archetype.
 *
 * @param archetypeName - Key in {@link WORKER_ARCHETYPES}.
 * @param guardrails - Input guardrails to attach to the worker agent.
 * @returns A configured SDK `Agent` or `null` when the archetype is unknown.
 */
export function buildWorkerAgent(
  archetypeName: string,
  guardrails: InputGuardrail[],
): Agent | null {
  const archetype = WORKER_ARCHETYPES[archetypeName];
  if (!archetype) return null;

  return new Agent({
    name: archetype.name,
    instructions: archetype.instructions,
    model: archetype.model,
    inputGuardrails: guardrails.length > 0 ? guardrails : undefined,
  });
}

/**
 * Build a team lead `Agent` whose `handoffs` reference the given workers.
 *
 * @param leadInstructions - System instructions for the lead agent.
 * @param leadModel - Model to use for the lead agent.
 * @param workers - Worker agents this lead can hand off to.
 * @param guardrails - Input guardrails to attach to the lead agent.
 * @returns A configured lead SDK `Agent`.
 */
export function buildLeadAgent(
  leadInstructions: string,
  leadModel: string,
  workers: Agent[],
  guardrails: InputGuardrail[],
): Agent {
  return new Agent({
    name: 'cleo-lead',
    instructions: leadInstructions,
    model: leadModel,
    handoffs: workers.length > 0 ? workers : undefined,
    inputGuardrails: guardrails.length > 0 ? guardrails : undefined,
  });
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
 * @returns A configured SDK `Agent`.
 */
export function buildStandaloneAgent(
  instructions: string,
  model: string,
  guardrails: InputGuardrail[],
): Agent {
  return new Agent({
    name: 'cleo-worker',
    instructions,
    model,
    inputGuardrails: guardrails.length > 0 ? guardrails : undefined,
  });
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
  guardrails: InputGuardrail[];
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
 * @returns The entry-point agent to pass to `runner.run()`.
 */
export function buildAgentTopology(options: TopologyOptions): Agent {
  const { instructions, model, tier, handoffNames, guardrails } = options;

  if (tier === 'worker') {
    return buildStandaloneAgent(instructions, model, guardrails);
  }

  // Build worker agents from archetype names; skip unknown names.
  const workers: Agent[] = handoffNames
    .map((name) => buildWorkerAgent(name, guardrails))
    .filter((a): a is Agent => a !== null);

  if (workers.length === 0) {
    // Lead with no workers — still usable as a standalone agent.
    return buildStandaloneAgent(instructions, model, guardrails);
  }

  return buildLeadAgent(instructions, model, workers, guardrails);
}
