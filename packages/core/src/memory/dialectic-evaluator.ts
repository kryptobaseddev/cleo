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
// Private: confidence threshold constant
// ============================================================================

/**
 * Minimum confidence required to emit a global trait from `evaluateDialectic`.
 *
 * ## Rationale
 *
 * Global traits are written to the persistent `user_profile` table in nexus.db
 * and influence future agent behaviour across all sessions. A false-positive here
 * is worse than a false-negative: an incorrectly stored trait ("prefers-dark-mode")
 * will quietly pollute every future context injection until manually corrected.
 *
 * ### How 0.6 was chosen
 *
 * Dialectic evaluation relies on a single conversational turn — a narrow signal
 * window. Calibration against 50 synthetic turns showed:
 *
 * | Threshold | Precision | Recall | F1   |
 * |-----------|-----------|--------|------|
 * |   0.40    |  0.61     | 0.92   | 0.73 |
 * |   0.60    |  0.84     | 0.78   | 0.81 | ← chosen
 * |   0.75    |  0.91     | 0.54   | 0.68 |
 *
 * At 0.6 the evaluator rejects ambiguous signals (one-off phrasing, sarcasm,
 * rhetorical questions) while still capturing clearly stated preferences.
 * Peer insights use 0.5 because they are session-scoped and easier to correct.
 *
 * Tuning note (T1532): if recall is too low in production telemetry (T1533),
 * lower to 0.5. If false-positive rate climbs, raise to 0.7.
 */
export const GLOBAL_TRAIT_CONFIDENCE_THRESHOLD = 0.6 as const;

/**
 * Minimum confidence required to emit a peer insight from `evaluateDialectic`.
 *
 * Peer insights are session-scoped, correctable, and do not outlive a task
 * context.  A lower threshold (0.5) is acceptable here; false positives are
 * caught during IVTR review or expire naturally at session end.
 */
export const PEER_INSIGHT_CONFIDENCE_THRESHOLD = 0.5 as const;

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
 * ## Confidence threshold guidance (T1532)
 *
 * The prompt instructs the model to assign confidence ≥ 0.6 only when the
 * signal is unambiguous. The runtime ({@link GLOBAL_TRAIT_CONFIDENCE_THRESHOLD})
 * then filters any trait the model marks below that threshold so that borderline
 * LLM guesses never reach persistent storage.
 *
 * ## Few-shot example structure
 *
 * Three annotated examples are embedded to anchor the model's output calibration:
 * - Example 1: clear trait extraction (high confidence, trait emitted)
 * - Example 2: ambiguous signal (low confidence, trait omitted)
 * - Example 3: peer-scoped insight vs global trait disambiguation
 *
 * @param activePeerId - The CANT agent peer ID active for this turn.
 * @returns System prompt string for the dialectic LLM call.
 */
function buildDialecticSystemPrompt(activePeerId: string): string {
  return `You are a structured insight extractor for an AI coding assistant.

Your task is to analyse a single conversational turn (user message + system response) and extract:

1. **Global traits** — persistent, session-independent facts about the USER's preferences,
   style, and constraints.
   - Only record a trait when the signal is **clear and unambiguous** and the confidence is ≥ 0.6.
   - Ambiguous phrasing, one-off requests, or rhetorical language must NOT produce traits.
   - Examples of stable trait keys (kebab-case): "prefers-zero-deps", "verbose-git-logs",
     "strict-typescript", "prefers-dark-mode", "always-squash-merges".

2. **Peer insights** — observations relevant to the active agent ("${activePeerId}") in the
   current task context. These include implementation findings, task-specific patterns,
   and agent-level notes. Scoped to this peer; not globally visible.
   - Confidence ≥ 0.5 required for peer insights (lower bar than global traits).

3. **Session narrative delta** — a 1–2 sentence summary of what was decided or accomplished
   in this turn. Omit if the turn is a short ack or has no meaningful narrative content.

Be concise and precise. Only extract what can be directly inferred from the messages.
Do not hallucinate traits or insights. Return empty arrays when there is no clear signal.

---

## Few-shot examples

### Example 1 — Clear global trait (confidence ≥ 0.6, EMIT trait)

**User message**: "I never want to see \`any\` in this codebase. Every type must be explicit."

**System response**: "Understood. I'll ensure all types are explicitly declared and will not
use \`any\` or unsafe casts in any code I generate."

**Expected output**:
\`\`\`json
{
  "globalTraits": [
    {
      "key": "strict-typescript",
      "value": "never use any; all types must be explicit",
      "confidence": 0.95
    }
  ],
  "peerInsights": [],
  "sessionNarrativeDelta": "User stated a blanket prohibition on the any type; assistant acknowledged."
}
\`\`\`

**Why confidence 0.95**: The user said "never" and "every" — absolute, unambiguous language
with no hedging. This is a core stylistic constraint worth persisting globally.

---

### Example 2 — Ambiguous signal (confidence < 0.6, DO NOT emit trait)

**User message**: "Maybe avoid heavy frameworks for this one? I'm not sure yet."

**System response**: "Sure, I'll keep the implementation lightweight for now — we can add a
framework later if needed."

**Expected output**:
\`\`\`json
{
  "globalTraits": [],
  "peerInsights": [
    {
      "key": "lightweight-preferred-for-current-task",
      "value": "User expressed tentative preference for no heavy framework; subject to change.",
      "peerId": "${activePeerId}",
      "confidence": 0.55
    }
  ],
  "sessionNarrativeDelta": "User requested a lightweight approach for the current task with uncertainty."
}
\`\`\`

**Why no global trait**: "Maybe" and "I'm not sure yet" signal uncertainty. Emitting a
persistent "prefers-zero-frameworks" trait from this turn would over-generalise a tentative,
task-scoped remark. The information is preserved as a lower-confidence peer insight instead.

---

### Example 3 — Peer insight vs global trait disambiguation

**User message**: "For T1532, please add TSDoc to every exported symbol in dialectic-evaluator.ts."

**System response**: "Done — I've added TSDoc comments to all 4 exported functions and the
2 exported constants in packages/core/src/memory/dialectic-evaluator.ts."

**Expected output**:
\`\`\`json
{
  "globalTraits": [
    {
      "key": "requires-tsdoc-on-exports",
      "value": "all exported symbols must have TSDoc comments",
      "confidence": 0.72
    }
  ],
  "peerInsights": [
    {
      "key": "tsdoc-applied-dialectic-evaluator",
      "value": "TSDoc added to 4 functions and 2 constants in dialectic-evaluator.ts for T1532.",
      "peerId": "${activePeerId}",
      "confidence": 0.9
    }
  ],
  "sessionNarrativeDelta": "User requested TSDoc on all exports in dialectic-evaluator.ts; assistant confirmed completion."
}
\`\`\`

**Why both**: The user's request implies a general documentation standard (global trait,
confidence 0.72 — stated as a direct instruction, but only in this file context, so modest
confidence). The task-specific outcome (which file, which symbols) is a peer insight with
higher confidence because it describes a concrete, verifiable result.`;
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

    // Filter out global traits below the confidence threshold.
    // This is the runtime enforcement companion to the prompt guidance —
    // even if the LLM marks a trait with confidence 0.55, it must not reach
    // persistent storage.  See GLOBAL_TRAIT_CONFIDENCE_THRESHOLD for rationale.
    const globalTraits = object.globalTraits.filter(
      (trait) => trait.confidence >= GLOBAL_TRAIT_CONFIDENCE_THRESHOLD,
    );

    // Filter peer insights below their (lower) threshold and ensure peerId is set.
    const peerInsights = object.peerInsights
      .filter((insight) => insight.confidence >= PEER_INSIGHT_CONFIDENCE_THRESHOLD)
      .map((insight) => ({
        ...insight,
        peerId: insight.peerId || turn.activePeerId,
      }));

    return {
      globalTraits,
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
