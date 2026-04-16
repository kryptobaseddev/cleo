/**
 * Observer/Reflector — LLM-driven session compression for CLEO BRAIN.
 *
 * Implements the Mastra-style two-agent compression pattern that achieves
 * 3-6x context compression on text and 5-40x on tool-call-heavy workloads.
 *
 * ## Architecture
 *
 * **Observer** (runs after each task or when observation count ≥ threshold):
 * - Takes raw brain observations from the current session
 * - Produces 3-5 dense, dated, prioritized observation notes (≤ 300 chars each)
 * - Compresses verbose tool outputs into 1-line summaries
 * - Stored as brain_observations with source='observer-compressed'
 * - Linked to original observation IDs via brain_memory_links table
 *
 * **Reflector** (runs at session end when observation count ≥ threshold):
 * - Takes accumulated observation notes from the current session
 * - Restructures: combines related items, identifies cross-cutting patterns,
 *   drops superseded observations
 * - Outputs stored as brain_patterns and brain_learnings via existing store fns
 * - Source tagged as 'reflector-synthesized'
 *
 * ## LLM Backend
 *
 * Calls the Anthropic Messages API directly via native fetch (no SDK dep).
 * Uses the cheapest available model (`claude-haiku-4-5` or env override).
 * When `ANTHROPIC_API_KEY` is not set, both functions silently no-op — the
 * rest of the memory pipeline still runs normally.
 *
 * ## Configuration
 *
 * Add to `config.json` under `brain.observer`:
 * ```json
 * {
 *   "brain": {
 *     "observer": {
 *       "enabled": true,
 *       "threshold": 10
 *     },
 *     "reflector": {
 *       "enabled": true
 *     }
 *   }
 * }
 * ```
 *
 * @task T554
 * @epic T549
 * @see .cleo/agent-outputs/R-llm-memory-systems-research.md §7 (Observer/Reflector Pattern)
 */

import { randomBytes } from 'node:crypto';
import { getBrainNativeDb } from '../store/brain-sqlite.js';
import { addGraphEdge } from './graph-auto-populate.js';
import { storeLearning } from './learnings.js';
import { storePattern } from './patterns.js';

// ============================================================================
// Internal row type (raw SQLite snake_case columns, not Drizzle camelCase)
// ============================================================================

/** Minimal raw-query row from brain_observations. */
interface RawObservationRow {
  id: string;
  type: string;
  title: string | null;
  narrative: string | null;
  created_at: string | null;
  source_type: string | null;
  source_session_id: string | null;
}

// ============================================================================
// Constants
// ============================================================================

/** Default model used for observer/reflector LLM calls. */
const DEFAULT_MODEL = 'claude-haiku-4-5';

/** Maximum tokens for LLM response. Enough for 5 structured observations. */
const MAX_RESPONSE_TOKENS = 1024;

/** Default threshold: trigger observer after this many session observations. */
const DEFAULT_OBSERVER_THRESHOLD = 10;

/** Maximum observations passed to observer in a single batch. */
const OBSERVER_BATCH_LIMIT = 30;

/** Source tag written to brain_observations for observer-compressed entries. */
const OBSERVER_SOURCE = 'observer-compressed';

/** Source tag written to brain_patterns / brain_learnings for reflector outputs. */
const REFLECTOR_SOURCE = 'reflector-synthesized';

// ============================================================================
// Types
// ============================================================================

/** A single compressed observation produced by the Observer. */
export interface ObserverNote {
  /** ISO date string when the original events occurred. */
  date: string;
  /**
   * Priority 1 (highest, architectural) through 5 (lowest, routine).
   * Maps to the research's RED/YELLOW/GREEN scale.
   */
  priority: 1 | 2 | 3 | 4 | 5;
  /** Dense observation text, ≤ 300 characters. */
  observation: string;
  /** IDs of the original observations this note compresses. */
  source_ids: string[];
}

/** Output of `runObserver`. */
export interface ObserverResult {
  /** Whether the LLM was invoked (false when no API key or disabled). */
  ran: boolean;
  /** Number of new compressed observation entries stored. */
  stored: number;
  /** IDs of original observations that were compressed. */
  compressedIds: string[];
  /** The raw notes produced by the LLM (for testing/debugging). */
  notes: ObserverNote[];
}

/** A single pattern extracted by the Reflector. */
export interface ReflectorPattern {
  pattern: string;
  context: string;
}

/** A single learning extracted by the Reflector. */
export interface ReflectorLearning {
  insight: string;
  confidence: number;
}

/** Structured output from the Reflector LLM call. */
interface ReflectorOutput {
  patterns: ReflectorPattern[];
  learnings: ReflectorLearning[];
  /** IDs of observation notes the reflector considers superseded. */
  superseded: string[];
}

/** Output of `runReflector`. */
export interface ReflectorResult {
  /** Whether the LLM was invoked (false when no API key or disabled). */
  ran: boolean;
  /** Number of new patterns stored. */
  patternsStored: number;
  /** Number of new learnings stored. */
  learningsStored: number;
  /** IDs of observations marked as superseded. */
  supersededIds: string[];
}

// ============================================================================
// Configuration helpers
// ============================================================================

/**
 * Observer configuration resolved from `brain.observer` in config.json,
 * with safe defaults.
 */
export interface ObserverConfig {
  enabled: boolean;
  threshold: number;
}

/**
 * Reflector configuration resolved from `brain.reflector` in config.json,
 * with safe defaults.
 */
export interface ReflectorConfig {
  enabled: boolean;
}

/**
 * Load observer configuration for the project.
 * Falls back to defaults on any error (enabled=true, threshold=10).
 */
async function loadObserverConfig(projectRoot: string): Promise<ObserverConfig> {
  try {
    const { loadConfig } = await import('../config.js');
    const config = await loadConfig(projectRoot);
    // Config type does not yet include observer/reflector — use dynamic cast
    const brain = config.brain as Record<string, unknown> | undefined;
    const observer = brain?.['observer'] as Record<string, unknown> | undefined;
    return {
      enabled: observer?.['enabled'] !== false,
      threshold:
        typeof observer?.['threshold'] === 'number'
          ? observer['threshold']
          : DEFAULT_OBSERVER_THRESHOLD,
    };
  } catch {
    return { enabled: true, threshold: DEFAULT_OBSERVER_THRESHOLD };
  }
}

/**
 * Load reflector configuration for the project.
 * Falls back to defaults on any error (enabled=true).
 */
async function loadReflectorConfig(projectRoot: string): Promise<ReflectorConfig> {
  try {
    const { loadConfig } = await import('../config.js');
    const config = await loadConfig(projectRoot);
    const brain = config.brain as Record<string, unknown> | undefined;
    const reflector = brain?.['reflector'] as Record<string, unknown> | undefined;
    return {
      enabled: reflector?.['enabled'] !== false,
    };
  } catch {
    return { enabled: true };
  }
}

// ============================================================================
// LLM client
// ============================================================================

/** Response envelope from the Anthropic Messages API. */
interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
  stop_reason: string;
}

/**
 * Call the Anthropic Messages API via native fetch.
 *
 * Uses `ANTHROPIC_API_KEY` from the environment. Returns null when the key is
 * not set or when the API call fails (caller handles graceful degradation).
 *
 * @param systemPrompt - System instruction for the LLM.
 * @param userContent - User message content.
 * @returns The assistant response text, or null on failure.
 */
async function callAnthropicLlm(systemPrompt: string, userContent: string): Promise<string | null> {
  const { resolveAnthropicApiKey } = await import('./anthropic-key-resolver.js');
  const apiKey = resolveAnthropicApiKey();
  if (!apiKey) {
    return null;
  }

  const model = process.env['CLEO_OBSERVER_MODEL'] ?? DEFAULT_MODEL;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: MAX_RESPONSE_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(
        `[observer-reflector] Anthropic API error ${response.status}: ${body.slice(0, 200)}`,
      );
      return null;
    }

    const data = (await response.json()) as AnthropicResponse;
    const textBlock = data.content.find((b) => b.type === 'text');
    return textBlock?.text ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[observer-reflector] LLM call failed: ${msg}`);
    return null;
  }
}

// ============================================================================
// JSON parse helper
// ============================================================================

/**
 * Attempt to parse the LLM response as JSON. Strips markdown code fences
 * (```json ... ```) before parsing. Returns null on parse failure.
 */
function parseJsonResponse<T>(text: string): T | null {
  try {
    // Strip markdown code fences if present
    const cleaned = text
      .replace(/^```(?:json)?\s*/m, '')
      .replace(/\s*```\s*$/m, '')
      .trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

// ============================================================================
// Database helpers
// ============================================================================

/**
 * Query recent brain_observations for a session.
 *
 * Returns up to `limit` observations (most recent first) that:
 * - Were created within the current session (`source_session_id = sessionId`)
 * - Are not already observer-compressed (`source_type != 'observer-compressed'`)
 * - Have not been soft-evicted (`invalid_at IS NULL`)
 *
 * Falls back to all uncompressed observations from the last 24 hours when
 * sessionId is not provided or yields fewer than 2 results.
 */
function fetchSessionObservations(
  sessionId: string | undefined,
  limit: number,
): RawObservationRow[] {
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return [];

  try {
    if (sessionId) {
      const rows = nativeDb
        .prepare(
          `
          SELECT id, type, title, narrative, created_at, source_session_id
          FROM brain_observations
          WHERE source_session_id = ?
            AND (source_type IS NULL OR source_type != ?)
            AND invalid_at IS NULL
          ORDER BY created_at DESC
          LIMIT ?
        `,
        )
        .all(sessionId, OBSERVER_SOURCE, limit) as unknown as RawObservationRow[];

      if (rows.length >= 2) return rows;
    }

    // Fallback: recent uncompressed observations from the last 24 hours
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    return nativeDb
      .prepare(
        `
        SELECT id, type, title, narrative, created_at, source_session_id
        FROM brain_observations
        WHERE created_at >= ?
          AND (source_type IS NULL OR source_type != ?)
          AND invalid_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?
      `,
      )
      .all(cutoff, OBSERVER_SOURCE, limit) as unknown as RawObservationRow[];
  } catch {
    return [];
  }
}

/**
 * Count uncompressed observations for a session.
 * Used to check the trigger threshold before running the observer.
 */
function countSessionObservations(sessionId: string | undefined): number {
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return 0;

  try {
    if (sessionId) {
      const row = nativeDb
        .prepare(
          `
          SELECT COUNT(*) as cnt
          FROM brain_observations
          WHERE source_session_id = ?
            AND (source_type IS NULL OR source_type != ?)
            AND invalid_at IS NULL
        `,
        )
        .get(sessionId, OBSERVER_SOURCE) as { cnt: number } | undefined;
      if (row && row.cnt > 0) return row.cnt;
    }

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    const row = nativeDb
      .prepare(
        `
        SELECT COUNT(*) as cnt
        FROM brain_observations
        WHERE created_at >= ?
          AND (source_type IS NULL OR source_type != ?)
          AND invalid_at IS NULL
      `,
      )
      .get(cutoff, OBSERVER_SOURCE) as { cnt: number } | undefined;

    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Store a compressed observer note as a brain_observation entry.
 *
 * Uses source_type = 'observer-compressed' so it is excluded from
 * future observer input batches (no infinite compression loops).
 *
 * @returns ID of the stored entry, or null on failure.
 */
function storeObserverNote(
  projectRoot: string,
  note: ObserverNote,
  sessionId: string | undefined,
): string | null {
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return null;

  try {
    const id = `O-${randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const title = `[Observer p${note.priority}] ${note.observation.slice(0, 80)}`;
    const narrative = `${note.observation} (compressed from: ${note.source_ids.join(', ')})`;

    nativeDb
      .prepare(
        `
        INSERT INTO brain_observations
          (id, type, title, narrative, source_type, source_session_id, quality_score,
           memory_tier, created_at)
        VALUES (?, 'change', ?, ?, ?, ?, ?, 'short', ?)
      `,
      )
      .run(
        id,
        title,
        narrative,
        OBSERVER_SOURCE,
        sessionId ?? null,
        // Quality: priority 1 = highest quality (1.0), priority 5 = lowest (0.6)
        Math.max(0.6, 1.0 - (note.priority - 1) * 0.1),
        now,
      );

    // Link compressed note to its source observation IDs via graph edges
    // (best-effort, non-blocking)
    for (const sourceId of note.source_ids) {
      addGraphEdge(
        projectRoot,
        `observation:${id}`,
        `observation:${sourceId}`,
        'supersedes',
        0.9,
        'observer-reflector',
      ).catch(() => undefined);
    }

    return id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[observer-reflector] Failed to store observer note: ${msg}`);
    return null;
  }
}

/**
 * Mark observations as superseded by the reflector.
 * Sets invalid_at so they are excluded from future queries.
 */
function markSuperseded(ids: string[]): void {
  if (ids.length === 0) return;
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return;

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  try {
    // SQLite placeholder limit is 999; process in safe batches
    const BATCH = 100;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const placeholders = batch.map(() => '?').join(',');
      nativeDb
        .prepare(
          `UPDATE brain_observations
           SET invalid_at = ?, updated_at = ?
           WHERE id IN (${placeholders}) AND invalid_at IS NULL`,
        )
        .run(now, now, ...batch);
    }
  } catch {
    /* best-effort */
  }
}

// ============================================================================
// Observer
// ============================================================================

/** System prompt for the Observer LLM call. */
const OBSERVER_SYSTEM_PROMPT = `You are compressing AI coding session activity into dense observation notes.
Input: recent observations and tool outputs from a CLEO agent coding session.
Output: 3-5 dated, prioritized observation notes (each ≤300 chars).
Focus on: state changes, decisions, errors, completed work.
Drop: verbose tool output, repetition, transient state.
Format: JSON array of objects with keys:
  - date: ISO date string (YYYY-MM-DD)
  - priority: integer 1-5 (1=architectural decision, 2=implementation choice, 3=constraint/bug, 4=routine action, 5=noise)
  - observation: string ≤300 chars — capture DECISION+RATIONALE not the discussion
  - source_ids: array of original observation IDs that this note compresses

Rules:
- For tool calls: capture the outcome, not the invocation
- For file reads: capture what was LEARNED, not what was read
- For errors: capture the ROOT CAUSE, not the stack trace
- Prefer priority 1-2 items; include priority 4-5 only if significant count
- ONLY return valid JSON array, no markdown fences or extra text`;

/**
 * Run the Observer on current session observations.
 *
 * Triggered when:
 * 1. `brain.observer.enabled` is true (default)
 * 2. Uncompressed observation count ≥ `brain.observer.threshold` (default: 10)
 * 3. `ANTHROPIC_API_KEY` is set in the environment
 *
 * Steps:
 * 1. Fetch up to OBSERVER_BATCH_LIMIT recent uncompressed observations
 * 2. Call Anthropic LLM with Observer prompt
 * 3. Parse response as ObserverNote[]
 * 4. Store each note as brain_observation with source='observer-compressed'
 * 5. Add graph edges linking compressed notes → source observation IDs
 *
 * Always best-effort — errors are caught and logged, never thrown.
 *
 * @param projectRoot - Absolute path to project root.
 * @param sessionId - Current CLEO session ID (used to scope observation query).
 * @returns ObserverResult with counts and note details.
 */
/**
 * Options for overriding Observer behaviour at call time.
 *
 * T740: Callers (e.g. session-end hook) may bypass the default threshold
 * check by passing `thresholdOverride: 1` so Observer fires unconditionally
 * even in short sessions with fewer than 10 observations.
 */
export interface RunObserverOptions {
  /**
   * When provided, replaces `cfg.threshold` for this call only.
   * Pass `1` to fire unconditionally regardless of observation count.
   */
  thresholdOverride?: number;
}

export async function runObserver(
  projectRoot: string,
  sessionId?: string,
  options?: RunObserverOptions,
): Promise<ObserverResult> {
  const empty: ObserverResult = { ran: false, stored: 0, compressedIds: [], notes: [] };

  // Gate 1: API key must be present
  const { resolveAnthropicApiKey: resolveKey } = await import('./anthropic-key-resolver.js');
  if (!resolveKey()) return empty;

  // Gate 2: Configuration must allow observer
  const cfg = await loadObserverConfig(projectRoot);
  if (!cfg.enabled) return empty;

  // Gate 3: Ensure brain.db is initialized
  try {
    const { getBrainDb } = await import('../store/brain-sqlite.js');
    await getBrainDb(projectRoot);
  } catch {
    return empty;
  }

  // Gate 4: Threshold check — T740: allow override so session-end hook
  // can force Observer to run regardless of observation count.
  const effectiveThreshold = options?.thresholdOverride ?? cfg.threshold;
  const count = countSessionObservations(sessionId);
  if (count < effectiveThreshold) return empty;

  // Fetch input observations
  const observations = fetchSessionObservations(sessionId, OBSERVER_BATCH_LIMIT);
  if (observations.length < 2) return empty;

  // Build the user message: list of observation records
  const observationList = observations
    .map(
      (obs) =>
        `[${obs.id}] ${obs.created_at ?? 'unknown'}: ${obs.title ?? ''} — ${(obs.narrative ?? '').slice(0, 200)}`,
    )
    .join('\n');

  const userContent = `Recent observations to compress (${observations.length} entries):\n\n${observationList}`;

  // Call LLM
  const rawResponse = await callAnthropicLlm(OBSERVER_SYSTEM_PROMPT, userContent);
  if (!rawResponse) return empty;

  // Parse response
  const notes = parseJsonResponse<ObserverNote[]>(rawResponse);
  if (!notes || !Array.isArray(notes) || notes.length === 0) {
    console.warn('[observer-reflector] Observer: failed to parse LLM response as ObserverNote[]');
    return empty;
  }

  // Validate and store notes
  let stored = 0;
  const compressedIds: string[] = [];

  for (const note of notes) {
    // Basic structural validation
    if (
      typeof note.observation !== 'string' ||
      !note.observation ||
      !Array.isArray(note.source_ids)
    ) {
      continue;
    }

    const id = storeObserverNote(projectRoot, note, sessionId);
    if (id !== null) {
      stored++;
      compressedIds.push(...note.source_ids);
    }
  }

  return {
    ran: true,
    stored,
    compressedIds: [...new Set(compressedIds)],
    notes,
  };
}

// ============================================================================
// Reflector
// ============================================================================

/** System prompt for the Reflector LLM call. */
const REFLECTOR_SYSTEM_PROMPT = `You are restructuring accumulated observations from a coding agent session into durable knowledge.
Input: observation notes from the session (both raw and observer-compressed).
Output: extracted patterns + learnings.

Rules:
- Combine related observations into single insights
- Identify cross-cutting patterns (3+ similar events)
- Drop observations superseded by later ones (list their IDs in "superseded")
- Preserve ALL architectural decisions and their rationale
- Preserve ALL discovered constraints and bugs with root causes
- Add cross-cutting insights that emerge from the full picture

Format: JSON object with keys:
  - patterns: array of { pattern: string (≤300 chars), context: string (≤150 chars) }
  - learnings: array of { insight: string (≤300 chars), confidence: number 0.0-1.0 }
  - superseded: array of observation IDs (strings) that are now redundant

ONLY return valid JSON, no markdown fences or extra text.
Maximum 5 patterns, 5 learnings. Quality over quantity.`;

/**
 * Run the Reflector on accumulated session observation notes.
 *
 * Triggered at session end when:
 * 1. `brain.reflector.enabled` is true (default)
 * 2. Sufficient observations exist to reflect on (≥ 3)
 * 3. `ANTHROPIC_API_KEY` is set in the environment
 *
 * Steps:
 * 1. Fetch recent observations (raw + observer-compressed) for the session
 * 2. Call Anthropic LLM with Reflector prompt
 * 3. Parse response as { patterns, learnings, superseded }
 * 4. Store patterns via storePattern()
 * 5. Store learnings via storeLearning()
 * 6. Mark superseded observations as invalid (soft-evict)
 *
 * Always best-effort — errors are caught and logged, never thrown.
 *
 * @param projectRoot - Absolute path to project root.
 * @param sessionId - Current CLEO session ID.
 * @returns ReflectorResult with counts.
 */
export async function runReflector(
  projectRoot: string,
  sessionId?: string,
): Promise<ReflectorResult> {
  const empty: ReflectorResult = {
    ran: false,
    patternsStored: 0,
    learningsStored: 0,
    supersededIds: [],
  };

  // Gate 1: API key must be present
  const { resolveAnthropicApiKey: resolveKey } = await import('./anthropic-key-resolver.js');
  if (!resolveKey()) return empty;

  // Gate 2: Configuration must allow reflector
  const cfg = await loadReflectorConfig(projectRoot);
  if (!cfg.enabled) return empty;

  // Gate 3: Ensure brain.db is initialized
  try {
    const { getBrainDb } = await import('../store/brain-sqlite.js');
    await getBrainDb(projectRoot);
  } catch {
    return empty;
  }

  // Fetch ALL recent session observations (both raw and compressed)
  // for reflector to synthesize across
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return empty;

  let observations: RawObservationRow[] = [];
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);

    if (sessionId) {
      observations = nativeDb
        .prepare(
          `
          SELECT id, type, title, narrative, created_at, source_type
          FROM brain_observations
          WHERE source_session_id = ?
            AND invalid_at IS NULL
          ORDER BY created_at DESC
          LIMIT 50
        `,
        )
        .all(sessionId) as unknown as RawObservationRow[];
    }

    if (observations.length < 3) {
      // Fallback: last 48 hours
      observations = nativeDb
        .prepare(
          `
          SELECT id, type, title, narrative, created_at, source_type
          FROM brain_observations
          WHERE created_at >= ?
            AND invalid_at IS NULL
          ORDER BY created_at DESC
          LIMIT 50
        `,
        )
        .all(cutoff) as unknown as RawObservationRow[];
    }
  } catch {
    return empty;
  }

  if (observations.length < 3) return empty;

  // Build user message
  const obsList = observations
    .map(
      (obs) =>
        `[${obs.id}] (${obs.source_type ?? 'raw'}): ${obs.title ?? ''} — ${(obs.narrative ?? '').slice(0, 200)}`,
    )
    .join('\n');

  const userContent = `Session observations to synthesize (${observations.length} entries):\n\n${obsList}`;

  // Call LLM
  const rawResponse = await callAnthropicLlm(REFLECTOR_SYSTEM_PROMPT, userContent);
  if (!rawResponse) return empty;

  // Parse response
  const output = parseJsonResponse<ReflectorOutput>(rawResponse);
  if (!output || typeof output !== 'object') {
    console.warn('[observer-reflector] Reflector: failed to parse LLM response');
    return empty;
  }

  let patternsStored = 0;
  let learningsStored = 0;

  // T742: Collect IDs of newly stored patterns/learnings so we can write
  // supersedes graph edges from them to the superseded source observations.
  const newEntryIds: string[] = [];

  // Store patterns
  if (Array.isArray(output.patterns)) {
    for (const p of output.patterns) {
      if (typeof p.pattern !== 'string' || !p.pattern) continue;
      try {
        const stored = await storePattern(projectRoot, {
          type: 'workflow',
          pattern: p.pattern.slice(0, 500),
          context: (p.context ?? '').slice(0, 200),
          source: REFLECTOR_SOURCE,
        });
        newEntryIds.push(`pattern:${stored.id}`);
        patternsStored++;
      } catch {
        /* best-effort */
      }
    }
  }

  // Store learnings
  if (Array.isArray(output.learnings)) {
    for (const l of output.learnings) {
      if (typeof l.insight !== 'string' || !l.insight) continue;
      const confidence =
        typeof l.confidence === 'number' ? Math.max(0.1, Math.min(1.0, l.confidence)) : 0.7;
      try {
        const stored = await storeLearning(projectRoot, {
          insight: l.insight.slice(0, 500),
          source: REFLECTOR_SOURCE,
          confidence,
          actionable: confidence >= 0.7,
        });
        newEntryIds.push(`learning:${stored.id}`);
        learningsStored++;
      } catch {
        /* best-effort */
      }
    }
  }

  // Mark superseded observations as invalid (soft-evict).
  const supersededIds = Array.isArray(output.superseded)
    ? output.superseded.filter((id): id is string => typeof id === 'string')
    : [];

  markSuperseded(supersededIds);

  // T742: Write supersedes graph edges from each new entry to each superseded
  // observation. This links the synthesized knowledge back to its source
  // observations in brain_page_edges so the supersession chain is traversable.
  // All edge writes are best-effort — never block the return.
  if (newEntryIds.length > 0 && supersededIds.length > 0) {
    for (const newNodeId of newEntryIds) {
      for (const obsId of supersededIds) {
        addGraphEdge(
          projectRoot,
          newNodeId,
          `observation:${obsId}`,
          'supersedes',
          1.0,
          'reflector-synthesized:session-end-reflection',
        ).catch(() => {
          /* best-effort */
        });
      }
    }
  }

  return {
    ran: true,
    patternsStored,
    learningsStored,
    supersededIds,
  };
}
