/**
 * Dialectic Evaluator — Continuous insight extraction from conversational turns.
 *
 * Ports the core idea from PSYCHE's dialectic subsystem
 * (`upstream psyche-lineage · dialectic/`) to CLEO's architecture:
 *
 *  1. `evaluateDialectic(turn)` — analyses one user↔system exchange and returns
 *     structured `DialecticInsights` (global traits + peer insights + narrative).
 *  2. `applyInsights(insights, nexusDb, brainDb)` — persists the extracted
 *     insights to the correct storage backends:
 *       - Global traits → user_profile table via Wave 1 `upsertUserProfileTrait`
 *       - Peer insights → brain.db observations via `observeBrain` with peerId
 *       - Narrative delta → session_narrative table via `appendNarrativeDelta`
 *
 * ## LLM Integration
 *
 * Uses `resolveLlmBackend('cold')` from `llm-backend-resolver.ts` so this
 * module never imports PSYCHE's `llm/` layer directly.  The LLM call uses
 * `generateObject()` (Vercel AI SDK) with a Zod schema that maps directly to
 * `DialecticInsights`.
 *
 * When no LLM backend is available (no `ANTHROPIC_API_KEY`, no local Ollama),
 * `evaluateDialectic` returns empty arrays so the caller can continue without
 * failing.  Prompt-iteration work is tracked in T1532 (confidence thresholds +
 * few-shot examples) and T1533 (telemetry for missing backend / errors).
 *
 * ## PSYCHE Reference
 *
 * Prompt shape ported from `upstream psyche-lineage · dialectic/prompts.py`
 * but rewritten for Claude 4.x structured output — no OpenAI-style function
 * calling; we use Vercel AI SDK `generateObject()` with `schema:` instead.
 *
 * @task T1087
 * @epic T1082
 * @see packages/contracts/src/operations/dialectic.ts — wire-format types
 * @see packages/core/src/memory/session-narrative.ts   — narrative storage
 * @see packages/core/src/nexus/user-profile.ts         — global trait upsert
 */

import type { DialecticInsights, DialecticTurn } from '@cleocode/contracts';
import { generateObject } from 'ai';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { z } from 'zod';
import { upsertUserProfileTrait } from '../nexus/user-profile.js';
import type * as memorySchema from '../store/memory-schema.js';
import type * as nexusSchema from '../store/nexus-schema.js';
import { observeBrain } from './brain-retrieval.js';
import { resolveLlmBackend } from './llm-backend-resolver.js';
import { appendNarrativeDelta } from './session-narrative.js';

// ============================================================================
// Private: Zod schema for structured LLM output
// ============================================================================

/** Zod schema for a single global trait extracted from a turn. */
const GlobalTraitSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(100)
    .describe('Stable semantic key (kebab-case). E.g. "prefers-zero-deps".'),
  value: z.string().min(1).max(500).describe('JSON-serialisable value string.'),
  confidence: z.number().min(0).max(1).describe('Bayesian confidence in [0.0, 1.0].'),
});

/** Zod schema for a single peer-scoped insight extracted from a turn. */
const PeerInsightSchema = z.object({
  key: z.string().min(1).max(100).describe('Short observation title (kebab-case or sentence).'),
  value: z.string().min(1).max(300).describe('Observation detail text.'),
  peerId: z.string().min(1).describe('The peer ID that produced this insight.'),
  confidence: z.number().min(0).max(1).describe('Confidence level in [0.0, 1.0].'),
});

/**
 * Zod schema for the full `DialecticInsights` shape.
 *
 * Passed directly to `generateObject({ schema })` so the AI SDK validates and
 * coerces the model response into a typed object with no manual parsing needed.
 */
const DialecticInsightsSchema = z.object({
  globalTraits: z
    .array(GlobalTraitSchema)
    .max(10)
    .describe(
      'Persistent user-level traits extracted from this turn. ' +
        'Only include traits that can be inferred with reasonable confidence. ' +
        'Omit when there is no clear signal.',
    ),
  peerInsights: z
    .array(PeerInsightSchema)
    .max(10)
    .describe(
      'Agent-scoped observations relevant only to the active peer. ' +
        'Include implementation details, task-specific findings, and agent-level patterns.',
    ),
  sessionNarrativeDelta: z
    .string()
    .max(500)
    .optional()
    .describe(
      'One-to-two sentence summary of what happened in this turn. ' +
        'Omit for short acks or low-signal exchanges.',
    ),
});

// ============================================================================
// Private: system prompt (ported from PSYCHE dialectic/prompts.py)
// ============================================================================

/**
 * Build the system prompt for the dialectic evaluation call.
 *
 * Adapted from `upstream psyche-lineage · dialectic/prompts.py` — the
 * original is OpenAI-style; this version targets Claude 4.x structured output
 * via the Vercel AI SDK's `generateObject()`.
 *
 * T1532: iterate on confidence thresholds + add few-shot examples.
 *
 * @param activePeerId - The CANT agent peer ID active for this turn.
 * @returns System prompt string for the dialectic LLM call.
 */
function buildDialecticSystemPrompt(activePeerId: string): string {
  return `You are a structured insight extractor for an AI coding assistant.

Your task is to analyse a single conversational turn (user message + system response) and extract:

1. **Global traits** — persistent, session-independent facts about the USER's preferences,
   style, and constraints. Examples:
   - "prefers-zero-deps": user avoids adding external dependencies
   - "verbose-git-logs": user wants detailed commit messages
   - "strict-typescript": user enforces strict TypeScript with no \`any\`
   Only record a trait when the signal is clear and the confidence is ≥ 0.6.

2. **Peer insights** — observations relevant to the active agent ("${activePeerId}") in the
   current task context. These include implementation findings, task-specific patterns,
   and agent-level notes. Scoped to this peer; not globally visible.

3. **Session narrative delta** — a 1–2 sentence summary of what was decided or accomplished
   in this turn. Omit if the turn is a short ack or has no meaningful narrative content.

Be concise and precise. Only extract what can be directly inferred from the messages.
Do not hallucinate traits or insights. Return empty arrays when there is no clear signal.`;
}

// ============================================================================
// Public API: evaluateDialectic
// ============================================================================

/**
 * Analyse a single conversational turn and extract structured insights.
 *
 * Uses CLEO's existing `resolveLlmBackend('cold')` for the LLM call so that
 * no new network egress paths are introduced.  When no LLM backend is available,
 * returns empty `DialecticInsights` so the caller can continue safely.
 *
 * The result is intended to be immediately passed to `applyInsights`.
 *
 * @param turn - The conversational turn to evaluate.
 * @returns Extracted dialectic insights (empty arrays when no backend available).
 *
 * @example
 * ```ts
 * const insights = await evaluateDialectic({
 *   userMessage: "never use `any` type",
 *   systemResponse: "acknowledged — I'll only use strict types.",
 *   activePeerId: "cleo-prime",
 *   sessionId: "ses_20260422131135_5149eb",
 * });
 * ```
 *
 * @task T1087
 */
export async function evaluateDialectic(turn: DialecticTurn): Promise<DialecticInsights> {
  const EMPTY: DialecticInsights = { globalTraits: [], peerInsights: [] };

  // Reject obviously empty turns early
  if (!turn.userMessage.trim() && !turn.systemResponse.trim()) {
    return EMPTY;
  }

  const backend = await resolveLlmBackend('cold');
  if (!backend || backend.name === 'none') {
    // T1533: log telemetry when no backend is available
    return EMPTY;
  }

  const userPrompt =
    `<user_message>\n${turn.userMessage}\n</user_message>\n\n` +
    `<system_response>\n${turn.systemResponse}\n</system_response>\n\n` +
    `Active peer: ${turn.activePeerId}\n` +
    `Session: ${turn.sessionId}`;

  try {
    const { object } = await generateObject({
      model: backend.model,
      schema: DialecticInsightsSchema,
      system: buildDialecticSystemPrompt(turn.activePeerId),
      prompt: userPrompt,
    });

    // Ensure every peer insight carries the correct peerId
    const peerInsights = object.peerInsights.map((insight) => ({
      ...insight,
      peerId: insight.peerId || turn.activePeerId,
    }));

    return {
      globalTraits: object.globalTraits,
      peerInsights,
      sessionNarrativeDelta: object.sessionNarrativeDelta,
    };
  } catch {
    // T1533: surface errors via telemetry
    return EMPTY;
  }
}

// ============================================================================
// Public API: applyInsights
// ============================================================================

/** Type alias for the Drizzle nexus database instance. */
type NexusDb = NodeSQLiteDatabase<typeof nexusSchema>;

/** Type alias for the Drizzle brain (memory) database instance. */
type BrainDb = NodeSQLiteDatabase<typeof memorySchema>;

/**
 * Persist extracted dialectic insights to the correct storage backends.
 *
 * Routing:
 *  - `globalTraits`          → `upsertUserProfileTrait` (nexus.db user_profile)
 *  - `peerInsights`          → `observeBrain` with peerId + source tag
 *  - `sessionNarrativeDelta` → `appendNarrativeDelta` (brain.db session_narrative)
 *
 * This function is always called inside a `setImmediate` callback from the
 * CQRS dispatcher — errors are caught and logged without failing the caller.
 *
 * @param insights - Insights returned by `evaluateDialectic`.
 * @param nexusDb  - Open Drizzle nexus.db instance.
 * @param brainDb  - Open Drizzle brain.db instance (unused here; peer insights
 *                   use `observeBrain` which manages its own DB handle).
 * @param opts     - Extra metadata threaded from the dialectic turn.
 *
 * @task T1087
 */
export async function applyInsights(
  insights: DialecticInsights,
  nexusDb: NexusDb,
  brainDb: BrainDb,
  opts: { sessionId: string; activePeerId: string; projectRoot: string },
): Promise<void> {
  const { sessionId, activePeerId, projectRoot } = opts;
  const sourceTag = `dialectic:${sessionId}`;

  // -------------------------------------------------------------------------
  // 1. Global traits → nexus.db user_profile (Wave 1 SDK)
  // -------------------------------------------------------------------------
  const now = new Date().toISOString();
  for (const trait of insights.globalTraits) {
    try {
      await upsertUserProfileTrait(nexusDb, {
        traitKey: trait.key,
        traitValue: trait.value,
        confidence: trait.confidence,
        source: sourceTag,
        derivedFromMessageId: null,
        firstObservedAt: now,
        lastReinforcedAt: now,
        reinforcementCount: 1,
        supersededBy: null,
      });
    } catch {
      // Best-effort — do not surface individual trait failures upward
    }
  }

  // -------------------------------------------------------------------------
  // 2. Peer insights → brain.db observations (Wave 2 peer_id support)
  // -------------------------------------------------------------------------
  for (const insight of insights.peerInsights) {
    try {
      await observeBrain(projectRoot, {
        text: `[${insight.key}] ${insight.value}`,
        title: insight.key,
        // type omitted — observeBrain auto-classifies from text content
        sourceSessionId: sessionId,
        sourceType: 'agent',
        agent: activePeerId,
        // Wave 2: peer_id field; observeBrain will thread this through once
        // the peer_id column exists on brain_observations (T1084 migration applied).
        // The sourceConfidence maps insight confidence → agent tier.
        sourceConfidence: insight.confidence >= 0.8 ? 'task-outcome' : 'agent',
      });
    } catch {
      // Best-effort
    }
  }

  // -------------------------------------------------------------------------
  // 3. Session narrative delta → session_narrative table (T1089)
  // -------------------------------------------------------------------------
  if (insights.sessionNarrativeDelta) {
    try {
      await appendNarrativeDelta(sessionId, insights.sessionNarrativeDelta, projectRoot);
    } catch {
      // Best-effort
    }
  }

  // Suppress unused parameter warning — brainDb may be used by future callers
  void brainDb;
}
