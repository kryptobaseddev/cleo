/**
 * JIT Agent Composer -- composes agent spawn payloads at runtime.
 *
 * Takes a compiled agent definition + context sources + mental model
 * and produces a token-budgeted system prompt with tier escalation.
 *
 * Implements ULTRAPLAN section 9.3: at spawn time, the composer resolves context
 * sources from BRAIN, loads the agent's mental model, enforces token budgets
 * per tier, and escalates tiers when content overflows.
 *
 * @packageDocumentation
 */

// ---------------------------------------------------------------------------
// Token budget caps per tier (ULTRAPLAN section 9.4)
// ---------------------------------------------------------------------------

/** Token budget caps per tier. */
export const TIER_CAPS = {
  low: { systemPrompt: 4000, mentalModel: 0, contextSources: 0 },
  mid: { systemPrompt: 12000, mentalModel: 1000, contextSources: 4000 },
  high: { systemPrompt: 32000, mentalModel: 2000, contextSources: 12000 },
} as const;

/** Agent tier levels: low, mid, or high. */
export type Tier = 'low' | 'mid' | 'high';

/**
 * Return the next tier up for escalation.
 *
 * @param tier - The current tier.
 * @returns The next tier, or `null` if already at the highest tier.
 */
export function escalateTier(tier: Tier): Tier | null {
  if (tier === 'low') return 'mid';
  if (tier === 'mid') return 'high';
  return null;
}

/**
 * Rough token estimation: approximately 4 characters per token.
 *
 * @param text - The text to estimate tokens for.
 * @returns The estimated token count.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Context and mental model interfaces
// ---------------------------------------------------------------------------

/** A context source query result from BRAIN. */
export interface ContextSlice {
  /** The source category (e.g. "patterns", "decisions", "conventions"). */
  source: string;
  /** The retrieved text content. */
  content: string;
  /** Pre-computed token count for this slice. */
  tokens: number;
}

/** A mental model loaded from BRAIN. */
export interface MentalModelSlice {
  /** The mental model text content. */
  content: string;
  /** Pre-computed token count for this slice. */
  tokens: number;
  /** ISO date of the last consolidation, or `null` if never consolidated. */
  lastConsolidated: string | null;
}

/**
 * Interface for BRAIN context retrieval (mockable for testing).
 *
 * @remarks
 * Implementations should query the BRAIN database for relevant context
 * and mental model data, respecting the provided token budgets.
 */
export interface ContextProvider {
  /** Retrieve context for a named source with a token budget. */
  queryContext(source: string, query: string, maxTokens: number): Promise<ContextSlice>;
  /** Load the mental model for an agent + project. */
  loadMentalModel(agentName: string, projectHash: string, maxTokens: number): Promise<MentalModelSlice>;
}

// ---------------------------------------------------------------------------
// Spawn payload
// ---------------------------------------------------------------------------

/** The composed spawn payload returned by {@link composeSpawnPayload}. */
export interface SpawnPayload {
  /** The agent name. */
  agentName: string;
  /** The resolved tier (may be escalated from declared tier). */
  resolvedTier: Tier;
  /** Whether the tier was escalated from the declared tier. */
  escalated: boolean;
  /** The original declared tier. */
  declaredTier: Tier;
  /** The composed system prompt. */
  systemPrompt: string;
  /** Token count of the system prompt. */
  systemPromptTokens: number;
  /** The model to use (from the tier matrix). */
  model: string;
  /** Fallback models. */
  fallbackModels: string[];
  /** Skills to load. */
  skills: string[];
  /** Tools allowed. */
  tools: string[];
  /** Context sources that were injected. */
  injectedContextSources: string[];
  /** Whether mental model was injected. */
  mentalModelInjected: boolean;
}

// ---------------------------------------------------------------------------
// Agent definition (extracted from compiled .cant bundle)
// ---------------------------------------------------------------------------

/** Agent definition extracted from a compiled `.cant` bundle. */
export interface AgentDefinition {
  /** The agent name as declared in the `.cant` file. */
  name: string;
  /** The declared tier for this agent. */
  tier: Tier;
  /** The base system prompt for this agent. */
  prompt: string;
  /** Skills this agent should load. */
  skills: string[];
  /** Tools this agent is allowed to use. */
  tools: string[];
  /** Context sources to resolve from BRAIN at spawn time. */
  contextSources: Array<{
    /** The BRAIN source category. */
    source: string;
    /** The query string for context retrieval. */
    query: string;
    /** Maximum number of entries to retrieve. */
    maxEntries: number;
  }>;
  /**
   * Mental model configuration, or `null` if not enabled.
   *
   * @remarks
   * When enabled, the composer loads the agent's mental model from BRAIN
   * and injects it with a validation prefix instructing the agent to
   * re-evaluate each claim against the current code state.
   */
  mentalModel: {
    /** Whether the mental model is enabled. */
    enabled: boolean;
    /** Scope: project-specific or global. */
    scope: 'project' | 'global';
    /** Maximum tokens allocated for mental model content. */
    maxTokens: number;
    /** Whether to add a validation prefix before the mental model. */
    validateOnLoad: boolean;
  } | null;
  /** Behavior when total tokens exceed the tier cap. */
  onOverflow: 'escalate_tier' | 'fail';
}

// ---------------------------------------------------------------------------
// Model selection per tier (mirrors cant-router section 11)
// ---------------------------------------------------------------------------

/** Model selection per tier. */
const TIER_MODELS: Record<Tier, { primary: string; fallbacks: string[] }> = {
  low: { primary: 'claude-haiku-4-5', fallbacks: ['kimi-k2.5'] },
  mid: { primary: 'claude-sonnet-4-6', fallbacks: ['kimi-k2.5', 'claude-haiku-4-5'] },
  high: { primary: 'claude-opus-4-6', fallbacks: ['claude-sonnet-4-6', 'kimi-k2.5'] },
};

// ---------------------------------------------------------------------------
// Mental model validation prefix (ULTRAPLAN section 12.3)
// ---------------------------------------------------------------------------

/** Validation prefix injected before mental model content. */
const MENTAL_MODEL_VALIDATION_PREFIX =
  'VALIDATE THIS MENTAL MODEL. Re-evaluate each claim against current ' +
  'code state. Mental models are dynamic per project; assume drift.';

// ---------------------------------------------------------------------------
// Core composer
// ---------------------------------------------------------------------------

/**
 * Compose a spawn payload for an agent.
 *
 * Implements ULTRAPLAN section 9.3 spawn-time composition:
 * 1. Start with agent's declared tier
 * 2. Resolve `context_sources` via {@link ContextProvider}
 * 3. Load `mental_model` via {@link ContextProvider}
 * 4. Check token budget -- if over, escalate tier (per L4)
 * 5. Compose final system prompt
 *
 * @param agent - The agent definition from a compiled `.cant` bundle.
 * @param contextProvider - The BRAIN context retrieval interface.
 * @param projectHash - Hash identifying the current project for scoped queries.
 * @returns The composed spawn payload ready for PiHarness.spawnSubagent.
 *
 * @throws Error if context exceeds the `high` tier cap and `onOverflow` is `'fail'`
 * @throws Error if context exceeds the `high` tier cap even with escalation
 */
export async function composeSpawnPayload(
  agent: AgentDefinition,
  contextProvider: ContextProvider,
  projectHash: string,
): Promise<SpawnPayload> {
  let currentTier = agent.tier;
  let escalated = false;

  // Step 1: Build base prompt
  const basePrompt = agent.prompt;
  const baseTokens = estimateTokens(basePrompt);

  // Step 2: Resolve context sources within the current tier's budget
  const contextSlices: ContextSlice[] = [];
  let contextBudget = TIER_CAPS[currentTier].contextSources;

  for (const src of agent.contextSources) {
    if (contextBudget <= 0) break;
    const slice = await contextProvider.queryContext(src.source, src.query, contextBudget);
    contextSlices.push(slice);
    contextBudget -= slice.tokens;
  }

  // Step 3: Load mental model if enabled and tier allows it
  let mentalModel: MentalModelSlice | null = null;
  if (agent.mentalModel?.enabled) {
    const mmCap = TIER_CAPS[currentTier].mentalModel;
    if (mmCap > 0) {
      mentalModel = await contextProvider.loadMentalModel(
        agent.name,
        agent.mentalModel.scope === 'project' ? projectHash : 'global',
        mmCap,
      );
    }
  }

  // Step 4: Check total token budget and escalate if needed
  const contextText = contextSlices.map((s) => s.content).join('\n\n');
  const mmText = mentalModel?.content ?? '';
  const totalTokens = baseTokens + estimateTokens(contextText) + estimateTokens(mmText);

  // Escalation loop: keep escalating until the content fits or we hit the ceiling
  let effectiveTier = currentTier;
  while (totalTokens > TIER_CAPS[effectiveTier].systemPrompt) {
    if (agent.onOverflow === 'fail') {
      throw new Error(
        `Agent ${agent.name}: total tokens (${totalTokens}) exceeds ` +
          `${effectiveTier} tier cap (${TIER_CAPS[effectiveTier].systemPrompt}) ` +
          `and onOverflow is 'fail'`,
      );
    }
    const next = escalateTier(effectiveTier);
    if (next === null) {
      throw new Error(
        `Agent ${agent.name}: total tokens (${totalTokens}) exceeds ` +
          `high tier cap (${TIER_CAPS.high.systemPrompt}) — cannot escalate further`,
      );
    }
    effectiveTier = next;
    escalated = true;
  }
  currentTier = effectiveTier;

  // Step 5: Compose system prompt
  const parts: string[] = [basePrompt];

  if (contextSlices.length > 0) {
    parts.push('\n\n## Context (JIT-injected)\n');
    for (const slice of contextSlices) {
      parts.push(`### ${slice.source}\n${slice.content}\n`);
    }
  }

  if (mentalModel && mmText.length > 0) {
    parts.push(
      '\n\n## Mental Model (validate before acting)\n' +
        `${MENTAL_MODEL_VALIDATION_PREFIX}\n\n` +
        mmText,
    );
  }

  const systemPrompt = parts.join('');
  const model = TIER_MODELS[currentTier];

  return {
    agentName: agent.name,
    resolvedTier: currentTier,
    escalated,
    declaredTier: agent.tier,
    systemPrompt,
    systemPromptTokens: estimateTokens(systemPrompt),
    model: model.primary,
    fallbackModels: model.fallbacks,
    skills: agent.skills,
    tools: agent.tools,
    injectedContextSources: contextSlices.map((s) => s.source),
    mentalModelInjected: mentalModel !== null && mmText.length > 0,
  };
}
