/**
 * Sleep-Time Consolidation — LLM-driven background memory hygiene for CLEO BRAIN.
 *
 * Implements the "sleep-time compute" pattern inspired by Letta OS: after a
 * session ends, a cheap LLM pass runs in the background to:
 *   1. Merge near-duplicate entries (embedding similarity > 0.85)
 *   2. Prune short-tier stale entries with low quality (7d old, quality < 0.4)
 *   3. Synthesize frequently-cited learnings into higher-quality patterns
 *   4. Extract cross-cutting insights from clusters of related observations
 *
 * All LLM calls use `claude-haiku-4-5-20251001` (cheapest available model).
 * No API key = silent no-op for LLM steps; structural steps still run.
 * All errors are caught and logged — nothing here may block session end.
 *
 * ## Configuration
 *
 * Add to `config.json` under `brain.sleepConsolidation`:
 * ```json
 * {
 *   "brain": {
 *     "sleepConsolidation": {
 *       "enabled": true
 *     }
 *   }
 * }
 * ```
 *
 * @task T555
 * @epic T549
 * @see packages/core/src/memory/observer-reflector.ts (Observer/Reflector pattern)
 * @see packages/core/src/memory/brain-lifecycle.ts (runConsolidation)
 */

import { randomBytes } from 'node:crypto';
import { resolveAnthropicApiKey } from '../llm/credentials.js';
import { getBrainNativeDb } from '../store/memory-sqlite.js';
import { typedAll } from '../store/typed-query.js';
import { storeLearning } from './learnings.js';
import { storePattern } from './patterns.js';

// ============================================================================
// Constants
// ============================================================================

/** Cheap model for all sleep-consolidation LLM calls. */
const SLEEP_MODEL = 'claude-haiku-4-5-20251001';

/** Embedding similarity threshold above which two entries are considered duplicates. */
const DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

/** Minimum age (days) before a short-tier entry can be pruned for low quality. */
const STALE_AGE_DAYS = 7;

/** Maximum quality score for a short-tier entry to be considered for pruning. */
const PRUNE_QUALITY_THRESHOLD = 0.4;

/** Minimum citation count to trigger pattern synthesis for a learning. */
const SYNTHESIS_CITATION_MIN = 3;

/** Maximum tokens for LLM responses. */
const MAX_RESPONSE_TOKENS = 1024;

/** Source tag written to brain_observations for sleep-consolidation results. */
const SLEEP_SOURCE = 'sleep-consolidation';

// ============================================================================
// Internal row types
// ============================================================================

/** Minimal observation row returned from direct SQLite queries. */
interface RawObsRow {
  id: string;
  title: string | null;
  narrative: string | null;
  quality_score: number | null;
  citation_count: number;
  memory_tier: string | null;
  created_at: string | null;
  embedding: Buffer | null;
}

/** Minimal learning row for synthesis queries. */
interface RawLearningRow {
  id: string;
  insight: string;
  confidence: number;
  citation_count: number;
  source: string | null;
  memory_tier: string | null;
}

/** Minimal pattern row for cluster queries. */
interface RawPatternRow {
  id: string;
  pattern: string;
  context: string | null;
  impact: string | null;
  frequency: number;
  memory_tier: string | null;
}

// ============================================================================
// Result types
// ============================================================================

/** Count of changes from the merge-duplicates step. */
export interface MergeDuplicatesResult {
  /** Number of duplicate entries merged (soft-evicted clones). */
  merged: number;
  /** Number of LLM merge decisions made. */
  llmDecisions: number;
}

/** Count of changes from the prune-stale step. */
export interface PruneStaleResult {
  /** Number of entries soft-evicted. */
  pruned: number;
  /** Number of entries the LLM decided to preserve. */
  preserved: number;
}

/** Count of changes from the strengthen-patterns step. */
export interface StrengthenPatternsResult {
  /** Number of high-citation learnings synthesized. */
  synthesized: number;
  /** Number of new patterns generated. */
  patternsGenerated: number;
}

/** Count of changes from the generate-insights step. */
export interface GenerateInsightsResult {
  /** Number of observation clusters processed. */
  clustersProcessed: number;
  /** Number of new insight observations stored. */
  insightsStored: number;
}

/** Wave 6 Dreamer upgrade result (T1146). */
export interface DreamerUpgradeResult {
  /** Number of observations with surprisal scores computed. */
  surprisalScored: number;
  /** Number of tree nodes written to brain_memory_trees. */
  treeNodesWritten: number;
  /** Number of brain_observations assigned to tree leaves. */
  treeObsAssigned: number;
  /** Total new BRAIN entries created by specialists. */
  specialistsCreated: number;
  /** Number of specialists that ran successfully. */
  specialistsRan: number;
  /** Number of specialists skipped (no LLM, no observations, etc.). */
  specialistsSkipped: number;
}

/** Aggregated result from the full sleep consolidation run. */
export interface SleepConsolidationResult {
  /** Whether the run was enabled and fully attempted. */
  ran: boolean;
  /** Step 1: merge duplicates. */
  mergeDuplicates: MergeDuplicatesResult;
  /** Step 2: prune stale entries. */
  pruneStale: PruneStaleResult;
  /** Step 3: strengthen frequently-cited patterns. */
  strengthenPatterns: StrengthenPatternsResult;
  /** Step 4: generate cross-cutting insights. */
  generateInsights: GenerateInsightsResult;
  /** Steps 5-7: Wave 6 dreamer upgrade (T1146 — surprisal + tree + specialists). */
  dreamerUpgrade?: DreamerUpgradeResult;
}

// ============================================================================
// Configuration
// ============================================================================

/** Sleep consolidation configuration resolved from config.json. */
export interface SleepConsolidationConfig {
  enabled: boolean;
}

/**
 * Load sleep consolidation configuration from the project config.
 * Defaults to enabled=true when config is missing or unreadable.
 *
 * @param projectRoot - Project root directory.
 */
async function loadSleepConfig(projectRoot: string): Promise<SleepConsolidationConfig> {
  try {
    const { loadConfig } = await import('../config.js');
    const config = await loadConfig(projectRoot);
    const brain = config.brain as Record<string, unknown> | undefined;
    const sc = brain?.['sleepConsolidation'] as Record<string, unknown> | undefined;
    return { enabled: sc?.['enabled'] !== false };
  } catch {
    return { enabled: true };
  }
}

// ============================================================================
// LLM client (shared with observer-reflector pattern)
// ============================================================================

/** Response envelope from the Anthropic Messages API. */
interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
  stop_reason: string;
}

/**
 * Call the Anthropic Messages API via native fetch using the cheap model.
 *
 * Uses `resolveAnthropicApiKey()` — never accesses ANTHROPIC_API_KEY directly.
 * Returns null when the key is unavailable or the call fails.
 *
 * @param systemPrompt - System instruction for the LLM.
 * @param userContent - User message content.
 */
async function callLlm(systemPrompt: string, userContent: string): Promise<string | null> {
  const apiKey = resolveAnthropicApiKey();
  if (!apiKey) return null;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      // 30-second hard deadline prevents open network handles from blocking
      // test process teardown (T753: vitest hang root cause).
      signal: AbortSignal.timeout(30_000),
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: SLEEP_MODEL,
        max_tokens: MAX_RESPONSE_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.warn(
        `[sleep-consolidation] Anthropic API error ${response.status}: ${body.slice(0, 200)}`,
      );
      return null;
    }

    const data = (await response.json()) as AnthropicResponse;
    const textBlock = data.content.find((b) => b.type === 'text');
    return textBlock?.text ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[sleep-consolidation] LLM call failed: ${msg}`);
    return null;
  }
}

/**
 * Attempt to parse LLM response as JSON. Strips markdown code fences before
 * parsing. Returns null on parse failure.
 */
function parseJson<T>(text: string): T | null {
  try {
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
// Cosine similarity helper
// ============================================================================

/**
 * Compute cosine similarity between two Float32 embedding buffers.
 *
 * Returns 0 when either buffer is null, empty, or different lengths.
 * Embeddings are stored as raw Buffer of 4-byte floats (sqlite-vec format).
 *
 * @param a - First embedding buffer.
 * @param b - Second embedding buffer.
 */
function cosineSimilarity(a: Buffer | null, b: Buffer | null): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;

  const floatCount = Math.floor(a.length / 4);
  if (floatCount === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < floatCount; i++) {
    const va = a.readFloatLE(i * 4);
    const vb = b.readFloatLE(i * 4);
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ============================================================================
// Step 1: Merge Duplicates
// ============================================================================

/**
 * Find near-duplicate entries using embedding cosine similarity > 0.85.
 *
 * For each pair above the threshold, asks the LLM whether to keep/merge.
 * The LLM confirms or overrides the merge decision. Kept entry gains the
 * evicted entry's citation count. Duplicates are soft-evicted (invalid_at set).
 *
 * Falls back to structural merge (keep higher quality) when no API key is
 * available or the LLM call fails.
 *
 * @param projectRoot - Project root for brain.db resolution.
 */
async function stepMergeDuplicates(projectRoot: string): Promise<MergeDuplicatesResult> {
  const { getBrainDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return { merged: 0, llmDecisions: 0 };

  let merged = 0;
  let llmDecisions = 0;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Fetch observations that have embeddings and are active
  let rows: RawObsRow[];
  try {
    rows = typedAll<RawObsRow>(
      nativeDb.prepare(
        `
        SELECT id, title, narrative, quality_score, citation_count, memory_tier, created_at, embedding
        FROM brain_observations
        WHERE embedding IS NOT NULL
          AND invalid_at IS NULL
          AND memory_tier = 'short'
        ORDER BY quality_score DESC
        LIMIT 200
      `,
      ),
    );
  } catch {
    return { merged: 0, llmDecisions: 0 };
  }

  if (rows.length < 2) return { merged: 0, llmDecisions: 0 };

  // Build candidate pairs above the similarity threshold
  const pairs: Array<{ a: RawObsRow; b: RawObsRow; similarity: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const sim = cosineSimilarity(rows[i]!.embedding, rows[j]!.embedding);
      if (sim >= DUPLICATE_SIMILARITY_THRESHOLD) {
        pairs.push({ a: rows[i]!, b: rows[j]!, similarity: sim });
      }
    }
  }

  if (pairs.length === 0) return { merged: 0, llmDecisions: 0 };

  // Ask the LLM for a batch merge decision (max 10 pairs per call)
  const pairBatch = pairs.slice(0, 10);
  const pairDescriptions = pairBatch.map(({ a, b, similarity }, idx) => ({
    pair: idx,
    similarity: Math.round(similarity * 100) / 100,
    a: { id: a.id, text: `${a.title ?? ''} ${a.narrative ?? ''}`.trim().slice(0, 120) },
    b: { id: b.id, text: `${b.title ?? ''} ${b.narrative ?? ''}`.trim().slice(0, 120) },
  }));

  const systemPrompt =
    'You are a memory deduplication assistant. Given pairs of nearly-identical memory entries ' +
    'evaluate whether they should be merged. For each pair output: {"pair":N,"merge":true/false,"keep":"<id>"}. ' +
    'Output a JSON array only, no prose. Merge when content is substantially the same; keep when content is distinct.';

  const userContent = `Memory entry pairs to evaluate:\n${JSON.stringify(pairDescriptions, null, 2)}`;

  interface MergeDecision {
    pair: number;
    merge: boolean;
    keep: string;
  }

  let decisions: MergeDecision[] = [];
  const rawResponse = await callLlm(systemPrompt, userContent);
  if (rawResponse) {
    const parsed = parseJson<MergeDecision[]>(rawResponse);
    if (Array.isArray(parsed)) {
      decisions = parsed;
      llmDecisions = decisions.filter((d) => d.merge).length;
    }
  }

  // Apply decisions (structural fallback when LLM unavailable)
  const processedIds = new Set<string>();
  for (let idx = 0; idx < pairBatch.length; idx++) {
    const { a, b } = pairBatch[idx]!;
    if (processedIds.has(a.id) || processedIds.has(b.id)) continue;

    const decision = decisions.find((d) => d.pair === idx);
    const shouldMerge = decision ? decision.merge : true; // default: merge near-duplicates
    if (!shouldMerge) continue;

    // Determine which to keep: prefer LLM decision, fallback to higher quality
    let keepId: string;
    let evictId: string;
    if (decision?.keep === a.id || decision?.keep === b.id) {
      keepId = decision.keep;
      evictId = keepId === a.id ? b.id : a.id;
    } else {
      const aQ = a.quality_score ?? 0.5;
      const bQ = b.quality_score ?? 0.5;
      keepId = aQ >= bQ ? a.id : b.id;
      evictId = keepId === a.id ? b.id : a.id;
    }

    const keepRow = a.id === keepId ? a : b;
    const evictRow = a.id === evictId ? a : b;
    const combinedCitations = (keepRow.citation_count ?? 0) + (evictRow.citation_count ?? 0);

    try {
      nativeDb
        .prepare(`UPDATE brain_observations SET invalid_at = ?, updated_at = ? WHERE id = ?`)
        .run(now, now, evictId);

      if (combinedCitations > (keepRow.citation_count ?? 0)) {
        nativeDb
          .prepare(`UPDATE brain_observations SET citation_count = ?, updated_at = ? WHERE id = ?`)
          .run(combinedCitations, now, keepId);
      }

      merged++;
      processedIds.add(a.id);
      processedIds.add(b.id);
    } catch {
      /* best-effort */
    }
  }

  return { merged, llmDecisions };
}

// ============================================================================
// Step 2: Prune Stale Entries
// ============================================================================

/**
 * Prune short-tier entries older than STALE_AGE_DAYS with quality < PRUNE_QUALITY_THRESHOLD.
 *
 * Before evicting, asks the LLM whether any entries should be preserved despite
 * their low score. Preserved entries have their quality_score bumped to 0.5 so
 * they survive future prune passes.
 *
 * @param projectRoot - Project root for brain.db resolution.
 */
async function stepPruneStale(projectRoot: string): Promise<PruneStaleResult> {
  const { getBrainDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return { pruned: 0, preserved: 0 };

  const staleCutoff = new Date(Date.now() - STALE_AGE_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  let candidates: RawObsRow[];
  try {
    candidates = typedAll<RawObsRow>(
      nativeDb.prepare(
        `
        SELECT id, title, narrative, quality_score, citation_count, memory_tier, created_at, embedding
        FROM brain_observations
        WHERE memory_tier = 'short'
          AND invalid_at IS NULL
          AND quality_score IS NOT NULL
          AND quality_score < ?
          AND created_at < ?
        ORDER BY quality_score ASC
        LIMIT 50
      `,
      ),
      PRUNE_QUALITY_THRESHOLD,
      staleCutoff,
    );
  } catch {
    return { pruned: 0, preserved: 0 };
  }

  if (candidates.length === 0) return { pruned: 0, preserved: 0 };

  // Ask LLM which entries to preserve despite low quality
  const candidateDescriptions = candidates.slice(0, 20).map((row) => ({
    id: row.id,
    age_days: Math.round(
      (Date.now() - new Date(row.created_at ?? 0).getTime()) / (24 * 60 * 60 * 1000),
    ),
    quality: Math.round((row.quality_score ?? 0) * 100) / 100,
    citations: row.citation_count,
    text: `${row.title ?? ''} ${row.narrative ?? ''}`.trim().slice(0, 100),
  }));

  const systemPrompt =
    'You are a memory curator. Given a list of low-quality, stale memory entries, ' +
    'decide which ones are worth preserving (i.e. contain unique, non-redundant information ' +
    'that would be hard to reconstruct). Return a JSON array of IDs to preserve: {"preserve":["id1","id2",...]}. ' +
    'Only preserve entries with genuinely unique information. When in doubt, allow eviction.';

  const userContent = `Candidate entries for eviction:\n${JSON.stringify(candidateDescriptions, null, 2)}`;

  interface PreserveDecision {
    preserve: string[];
  }

  let preserveIds = new Set<string>();
  const rawResponse = await callLlm(systemPrompt, userContent);
  if (rawResponse) {
    const parsed = parseJson<PreserveDecision>(rawResponse);
    if (parsed && Array.isArray(parsed.preserve)) {
      preserveIds = new Set(parsed.preserve);
    }
  }

  let pruned = 0;
  let preserved = 0;

  for (const row of candidates) {
    if (preserveIds.has(row.id)) {
      // Bump quality so it won't be pruned next pass
      try {
        nativeDb
          .prepare(`UPDATE brain_observations SET quality_score = 0.5, updated_at = ? WHERE id = ?`)
          .run(now, row.id);
        preserved++;
      } catch {
        /* best-effort */
      }
    } else {
      try {
        nativeDb
          .prepare(`UPDATE brain_observations SET invalid_at = ?, updated_at = ? WHERE id = ?`)
          .run(now, now, row.id);
        pruned++;
      } catch {
        /* best-effort */
      }
    }
  }

  return { pruned, preserved };
}

// ============================================================================
// Step 3: Strengthen Patterns
// ============================================================================

/**
 * Find learnings cited >= SYNTHESIS_CITATION_MIN times and ask the LLM to
 * synthesize them into a single higher-quality pattern entry.
 *
 * The synthesized pattern is stored via storePattern() with
 * source='sleep-consolidation'. The original learnings are left intact.
 *
 * @param projectRoot - Project root for brain.db resolution.
 */
async function stepStrengthenPatterns(projectRoot: string): Promise<StrengthenPatternsResult> {
  const { getBrainDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return { synthesized: 0, patternsGenerated: 0 };

  let candidates: RawLearningRow[];
  try {
    candidates = typedAll<RawLearningRow>(
      nativeDb.prepare(
        `
        SELECT id, insight, confidence, citation_count, source, memory_tier
        FROM brain_learnings
        WHERE citation_count >= ?
          AND invalid_at IS NULL
        ORDER BY citation_count DESC, confidence DESC
        LIMIT 10
      `,
      ),
      SYNTHESIS_CITATION_MIN,
    );
  } catch {
    return { synthesized: 0, patternsGenerated: 0 };
  }

  if (candidates.length === 0) return { synthesized: 0, patternsGenerated: 0 };

  // Check if we already have a sleep-consolidation pattern from these
  // (avoid re-synthesizing the same learnings every session)
  let existingPatterns: RawPatternRow[];
  try {
    existingPatterns = typedAll<RawPatternRow>(
      nativeDb.prepare(
        `
        SELECT id, pattern, context, impact, frequency, memory_tier
        FROM brain_patterns
        WHERE source_type = ?
          AND invalid_at IS NULL
        ORDER BY frequency DESC
        LIMIT 5
      `,
      ),
      SLEEP_SOURCE,
    );
  } catch {
    existingPatterns = [];
  }

  const existingPatternTexts = existingPatterns.map((p) => p.pattern.slice(0, 80)).join('; ');

  const learningDescriptions = candidates.map((l) => ({
    id: l.id,
    insight: l.insight.slice(0, 200),
    citations: l.citation_count,
    confidence: Math.round(l.confidence * 100) / 100,
  }));

  const systemPrompt =
    'You are a knowledge synthesizer. Given frequently-cited learnings, extract 1-3 ' +
    'higher-order patterns that capture the essence of what has been repeatedly confirmed. ' +
    'Each pattern should be actionable and generalizable. ' +
    'Return JSON: {"patterns":[{"pattern":"...","context":"...","impact":"high|medium|low"}]}. ' +
    'Skip patterns already captured in the existing list. Output JSON only, no prose.';

  const userContent =
    `Frequently-cited learnings to synthesize:\n${JSON.stringify(learningDescriptions, null, 2)}\n\n` +
    `Already captured patterns (do not duplicate): ${existingPatternTexts || 'none'}`;

  interface SynthesisOutput {
    patterns: Array<{ pattern: string; context: string; impact?: string }>;
  }

  const rawResponse = await callLlm(systemPrompt, userContent);
  if (!rawResponse) return { synthesized: candidates.length, patternsGenerated: 0 };

  const parsed = parseJson<SynthesisOutput>(rawResponse);
  if (!parsed || !Array.isArray(parsed.patterns)) {
    return { synthesized: candidates.length, patternsGenerated: 0 };
  }

  let patternsGenerated = 0;
  for (const p of parsed.patterns) {
    if (!p.pattern?.trim()) continue;
    try {
      const impact =
        p.impact === 'high' || p.impact === 'medium' || p.impact === 'low' ? p.impact : 'medium';
      await storePattern(projectRoot, {
        type: 'optimization',
        pattern: p.pattern.slice(0, 500),
        context: (p.context ?? '').slice(0, 500),
        impact,
        source: SLEEP_SOURCE,
      });
      patternsGenerated++;
    } catch {
      /* best-effort */
    }
  }

  return { synthesized: candidates.length, patternsGenerated };
}

// ============================================================================
// Step 4: Generate Cross-Cutting Insights
// ============================================================================

/**
 * Cluster recent observations by shared entity overlap and ask the LLM to
 * extract a cross-cutting insight for each cluster.
 *
 * Insights are stored as brain_observations with source='sleep-consolidation'
 * and memory_tier='medium' (they represent synthesized knowledge).
 *
 * @param projectRoot - Project root for brain.db resolution.
 */
async function stepGenerateInsights(projectRoot: string): Promise<GenerateInsightsResult> {
  const { getBrainDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return { clustersProcessed: 0, insightsStored: 0 };

  // Fetch recent non-sleep observations (last 14 days)
  const recent14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  interface TextRow {
    id: string;
    text: string;
  }

  let observations: TextRow[];
  try {
    observations = typedAll<TextRow>(
      nativeDb.prepare(
        `
        SELECT id,
               COALESCE(title, '') || ' ' || COALESCE(narrative, '') AS text
        FROM brain_observations
        WHERE created_at >= ?
          AND invalid_at IS NULL
          AND (source_type IS NULL OR source_type NOT IN (?, 'observer-compressed'))
        ORDER BY quality_score DESC
        LIMIT 60
      `,
      ),
      recent14d,
      SLEEP_SOURCE,
    );
  } catch {
    return { clustersProcessed: 0, insightsStored: 0 };
  }

  if (observations.length < 5) return { clustersProcessed: 0, insightsStored: 0 };

  // Simple entity-based clustering: tokenise each observation into words >=4
  // chars, group observations sharing >= 3 tokens into the same cluster.
  const STOP = new Set([
    'this',
    'that',
    'with',
    'from',
    'have',
    'been',
    'will',
    'when',
    'then',
    'they',
    'were',
    'also',
    'into',
    'over',
    'some',
    'more',
    'very',
    'just',
    'each',
    'both',
  ]);

  function tokenize(text: string): Set<string> {
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !STOP.has(t));
    return new Set(tokens);
  }

  const tokenSets = observations.map((o) => ({ id: o.id, text: o.text, tokens: tokenize(o.text) }));

  // Build clusters greedily (each observation joins the first compatible cluster)
  const clusters: Array<{ memberIds: string[]; texts: string[] }> = [];

  for (const obs of tokenSets) {
    let placed = false;
    for (const cluster of clusters) {
      // Check overlap with the first member of the cluster
      const firstText = tokenSets.find((t) => t.id === cluster.memberIds[0]);
      if (!firstText) continue;
      let shared = 0;
      for (const tok of obs.tokens) {
        if (firstText.tokens.has(tok)) shared++;
      }
      if (shared >= 3) {
        cluster.memberIds.push(obs.id);
        cluster.texts.push(obs.text.slice(0, 120));
        placed = true;
        break;
      }
    }
    if (!placed && clusters.length < 5) {
      clusters.push({ memberIds: [obs.id], texts: [obs.text.slice(0, 120)] });
    }
  }

  // Only process clusters with >= 3 members
  const validClusters = clusters.filter((c) => c.memberIds.length >= 3);
  if (validClusters.length === 0) return { clustersProcessed: 0, insightsStored: 0 };

  const clusterDescriptions = validClusters.map((c, i) => ({
    cluster: i,
    entries: c.texts.slice(0, 5),
  }));

  const systemPrompt =
    'You are a cross-domain insight extractor. Given clusters of related memory entries, ' +
    'identify one cross-cutting insight per cluster that would not be obvious from any single entry. ' +
    'Return JSON: {"insights":[{"cluster":N,"insight":"...","confidence":0.0-1.0}]}. ' +
    'Only include high-value insights (confidence >= 0.7). Output JSON only, no prose.';

  const userContent = `Memory clusters to analyse:\n${JSON.stringify(clusterDescriptions, null, 2)}`;

  interface InsightOutput {
    insights: Array<{ cluster: number; insight: string; confidence: number }>;
  }

  const rawResponse = await callLlm(systemPrompt, userContent);
  if (!rawResponse) return { clustersProcessed: validClusters.length, insightsStored: 0 };

  const parsed = parseJson<InsightOutput>(rawResponse);
  if (!parsed || !Array.isArray(parsed.insights)) {
    return { clustersProcessed: validClusters.length, insightsStored: 0 };
  }

  let insightsStored = 0;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  for (const insight of parsed.insights) {
    if (!insight.insight?.trim()) continue;
    const confidence = Math.max(0, Math.min(1, insight.confidence ?? 0.7));
    if (confidence < 0.7) continue;

    try {
      // Store as a learning (cross-cutting insights are learnings, not observations)
      await storeLearning(projectRoot, {
        insight: insight.insight.slice(0, 500),
        source: SLEEP_SOURCE,
        confidence,
        actionable: true,
        application: 'Cross-cutting insight synthesized from clustered observations',
      });
      insightsStored++;
    } catch {
      /* best-effort */
    }
  }

  // Log the run itself as an observation for traceability
  if (insightsStored > 0) {
    try {
      const runId = `O-${randomBytes(4).toString('hex')}`;
      nativeDb
        .prepare(
          `
          INSERT INTO brain_observations
            (id, type, title, narrative, source_type, quality_score, memory_tier, created_at)
          VALUES (?, 'change', ?, ?, ?, 0.6, 'short', ?)
        `,
        )
        .run(
          runId,
          `[sleep-consolidation] Insight generation run`,
          `Generated ${insightsStored} cross-cutting insights from ${validClusters.length} clusters.`,
          SLEEP_SOURCE,
          now,
        );
    } catch {
      /* best-effort */
    }
  }

  return { clustersProcessed: validClusters.length, insightsStored };
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Run the full sleep-time consolidation pipeline for CLEO BRAIN.
 *
 * This is the main entry point for LLM-driven background memory hygiene.
 * It is designed to run after session end (via setImmediate) and must never
 * throw — all errors are caught and logged.
 *
 * Steps (in order):
 *   1. Merge duplicates — embedding-similarity-based dedup with LLM confirmation
 *   2. Prune stale — evict low-quality short-tier entries; LLM may preserve some
 *   3. Strengthen patterns — synthesize frequently-cited learnings into patterns
 *   4. Generate insights — extract cross-cutting insights from observation clusters
 *
 * Graceful degradation: when no Anthropic API key is available, LLM steps
 * silently skip their LLM call and fall back to structural heuristics.
 *
 * @param projectRoot - Project root directory for brain.db resolution.
 * @returns Aggregated result counts from each step.
 */
export async function runSleepConsolidation(
  projectRoot: string,
): Promise<SleepConsolidationResult> {
  const empty: SleepConsolidationResult = {
    ran: false,
    mergeDuplicates: { merged: 0, llmDecisions: 0 },
    pruneStale: { pruned: 0, preserved: 0 },
    strengthenPatterns: { synthesized: 0, patternsGenerated: 0 },
    generateInsights: { clustersProcessed: 0, insightsStored: 0 },
  };

  // Check configuration
  let config: SleepConsolidationConfig;
  try {
    config = await loadSleepConfig(projectRoot);
  } catch {
    config = { enabled: true };
  }

  if (!config.enabled) {
    return empty;
  }

  const result: SleepConsolidationResult = {
    ran: true,
    mergeDuplicates: { merged: 0, llmDecisions: 0 },
    pruneStale: { pruned: 0, preserved: 0 },
    strengthenPatterns: { synthesized: 0, patternsGenerated: 0 },
    generateInsights: { clustersProcessed: 0, insightsStored: 0 },
  };

  // Step 1: Merge duplicates
  try {
    result.mergeDuplicates = await stepMergeDuplicates(projectRoot);
  } catch (err) {
    console.warn('[sleep-consolidation] Step 1 (merge duplicates) failed:', err);
  }

  // Step 2: Prune stale
  try {
    result.pruneStale = await stepPruneStale(projectRoot);
  } catch (err) {
    console.warn('[sleep-consolidation] Step 2 (prune stale) failed:', err);
  }

  // Step 3: Strengthen patterns
  try {
    result.strengthenPatterns = await stepStrengthenPatterns(projectRoot);
  } catch (err) {
    console.warn('[sleep-consolidation] Step 3 (strengthen patterns) failed:', err);
  }

  // Step 4: Generate insights
  try {
    result.generateInsights = await stepGenerateInsights(projectRoot);
  } catch (err) {
    console.warn('[sleep-consolidation] Step 4 (generate insights) failed:', err);
  }

  // Steps 5-7: Wave 6 Dreamer Upgrade — Bayesian surprisal + RPTree + specialists
  // Lazy-imported to keep test surface small and avoid breaking existing mocks.
  // Errors in any step are swallowed — dreamer upgrade must never abort consolidation.
  try {
    const dreamerResult = await runDreamerUpgrade(projectRoot);
    result.dreamerUpgrade = dreamerResult;
  } catch (err) {
    console.warn('[sleep-consolidation] Wave 6 dreamer upgrade failed:', err);
  }

  return result;
}

// ============================================================================
// Wave 6: Dreamer Upgrade — Steps 5-7
// ============================================================================

/**
 * Internal row type for fetching recent observations with embeddings.
 */
interface RawObsWithEmbedding {
  id: string;
  type: string;
  title: string | null;
  narrative: string | null;
  project: string | null;
  peer_id: string;
  source_session_id: string | null;
  embedding: Buffer | null;
  created_at: string | null;
}

/**
 * Run the Wave 6 dreamer upgrade:
 *   Step 5: Compute Bayesian surprisal scores for recent observations
 *   Step 6: Build RPTree from high-surprisal observations
 *   Step 7: Dispatch consolidation specialists in surprisal-priority order
 *
 * Gracefully degrades when:
 *   - No embeddings available → returns neutral scores, skips tree/specialists
 *   - No LLM backend → specialists no-op silently
 *   - Any step errors → logged, not thrown
 *
 * @param projectRoot - Project root for DB resolution.
 * @returns DreamerUpgradeResult with counts from each step.
 *
 * @task T1146
 */
async function runDreamerUpgrade(_projectRoot: string): Promise<DreamerUpgradeResult> {
  const result: DreamerUpgradeResult = {
    surprisalScored: 0,
    treeNodesWritten: 0,
    treeObsAssigned: 0,
    specialistsCreated: 0,
    specialistsRan: 0,
    specialistsSkipped: 0,
  };

  // Lazy import to preserve vi.mock('../sleep-consolidation.js') test surface
  const [{ computeSurprisalBatch }, { buildSurprisalTree }, { dispatchSpecialists }] =
    await Promise.all([
      import('./surprisal.js'),
      import('./surprisal-tree.js'),
      import('./specialists.js'),
    ]);

  const { getBrainNativeDb } = await import('../store/memory-sqlite.js');
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    console.warn('[dreamer-upgrade] No database available; skipping all steps.');
    return result;
  }

  // Fetch recent observations (up to 100) with their embeddings
  const rawObs = nativeDb
    .prepare(
      `SELECT o.id, o.type, o.title, o.narrative, o.project, o.peer_id,
              o.source_session_id, e.embedding, o.created_at
       FROM brain_observations o
       LEFT JOIN brain_embeddings e ON e.id = o.id
       WHERE o.level IS NULL OR o.level = 'explicit'
       ORDER BY o.created_at DESC
       LIMIT 100`,
    )
    .all() as unknown as RawObsWithEmbedding[];

  if (rawObs.length === 0) {
    return result;
  }

  // Step 5: Surprisal scoring
  const observationsForSurprisal = rawObs.map((r) => {
    let embedding: number[] | null = null;
    if (r.embedding instanceof Uint8Array || Buffer.isBuffer(r.embedding)) {
      const buf = r.embedding as Buffer;
      embedding = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
    }
    return { id: r.id, embedding };
  });

  const surprisalResults = computeSurprisalBatch(observationsForSurprisal, { db: nativeDb });
  result.surprisalScored = surprisalResults.length;

  // Step 6: RPTree from observations that have embeddings
  const obsWithEmbeddings = rawObs
    .filter((r) => r.embedding instanceof Uint8Array || Buffer.isBuffer(r.embedding))
    .map((r) => {
      const buf = r.embedding as Buffer;
      return {
        id: r.id,
        embedding: Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)),
      };
    });

  if (obsWithEmbeddings.length >= 2) {
    const treeResult = buildSurprisalTree(obsWithEmbeddings, { db: nativeDb });
    result.treeNodesWritten = treeResult.nodesWritten;
    result.treeObsAssigned = treeResult.obsAssigned;
  }

  // Step 7: Dispatch specialists
  const specialistObs = rawObs.map((r) => ({
    id: r.id,
    type: String(r.type ?? ''),
    title: r.title != null ? String(r.title) : null,
    narrative: r.narrative != null ? String(r.narrative) : null,
    project: r.project != null ? String(r.project) : null,
    peerId: String(r.peer_id ?? 'global'),
    sourceSessionId: r.source_session_id != null ? String(r.source_session_id) : null,
  }));

  const specialistResults = await dispatchSpecialists(specialistObs, surprisalResults, {
    db: nativeDb,
  });

  result.specialistsCreated = specialistResults.totalCreated;
  result.specialistsRan = specialistResults.specialists.filter((s) => !s.skipped).length;
  result.specialistsSkipped = specialistResults.totalSkipped;

  return result;
}
