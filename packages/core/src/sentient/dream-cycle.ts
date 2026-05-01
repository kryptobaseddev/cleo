/**
 * Sentient Dream Cycle — Real LLM-backed BRAIN observation synthesis (T1680).
 *
 * Implements autonomous cognitive dreaming: periodically collecting recent BRAIN
 * observations, clustering them by topic similarity, and calling an LLM to
 * extract durable memories (decisions, patterns, learnings, constraints) from
 * each cluster. Extracted memories are routed through the existing
 * `verifyAndStore` gate in extraction-gate.ts — NO new pipeline.
 *
 * ## Cycle (default every 4 hours):
 *
 *   1. **Collect** — query last 24 h of brain_observations across types
 *      (`hygiene:*`, `session:*`, `decision:*`, `pattern:*`).
 *   2. **Cluster** — Jaccard similarity on n-gram overlap (title+narrative).
 *      If `brain.embeddings` available, vector similarity is preferred.
 *   3. **Synthesise** — for each cluster of ≥ DREAM_CLUSTER_MIN_SIZE
 *      observations, call the daemon LLM with a structured-output schema
 *      (`{decisions, patterns, learnings, constraints}`) mirroring the
 *      llm-extraction.ts pattern exactly.
 *   4. **Verify-and-store** — route each extracted memory through the
 *      existing `verifyAndStore` gate (extraction-gate.ts).
 *   5. **Digest** — store a summary as a BRAIN observation tagged
 *      `sentient:dream-cycle-<runId>`.
 *
 * Wire-in: `safeRunTick` fires `maybeTriggerDreamCycle` every
 * `DREAM_CYCLE_INTERVAL_MS` (default 4 h). The trigger is fire-and-forget
 * so it never blocks the tick outcome.
 *
 * LLM provider: reads `llm.daemon.provider` and `llm.daemon.model` from the
 * global `~/.cleo/config.json` via `getRawConfigValue`. Credentials resolved
 * via `resolveCredentials` (T1677 — one canonical entry point).
 *
 * ## Test injection
 *
 * Every side-effecting dependency is injectable via `DreamCycleOptions`:
 * - `client` — Anthropic client stub (no real network in tests)
 * - `collectObservations` — override the DB query
 * - `observeMemory` — override the BRAIN write
 * - `verifyAndStoreFn` — override the extraction gate
 * - `isKilled` — kill-switch check
 * - `dreamCycleIntervalMs = 0` — forces trigger every tick
 * - `dreamCycle = null` — disables entirely
 *
 * @task T1680
 * @epic T1676
 * @see packages/core/src/memory/llm-extraction.ts — pattern mirrored exactly
 * @see packages/core/src/sentient/hygiene-scan.ts — safe wrapper pattern
 * @see packages/core/src/sentient/stage-drift-tick.ts — interval-gate pattern
 */

import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { resolveCredentials } from '../llm/credentials.js';
import type { MemoryCandidate } from '../memory/extraction-gate.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default interval between dream cycle runs (4 hours in milliseconds).
 * Configurable via `DreamCycleTickOptions.dreamCycleIntervalMs`.
 */
export const DREAM_CYCLE_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * How far back (ms) to look for BRAIN observations to cluster.
 * Default: last 24 hours.
 */
export const DREAM_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Minimum number of observations in a cluster before the LLM is called.
 * Clusters smaller than this are skipped — too little signal.
 */
export const DREAM_CLUSTER_MIN_SIZE = 5;

/**
 * Maximum number of clusters to synthesise per dream cycle run.
 * Prevents runaway LLM cost on large observation sets.
 */
export const DREAM_MAX_CLUSTERS = 10;

/**
 * Jaccard similarity threshold above which two observations are placed in
 * the same cluster. Value in [0, 1]. Higher = tighter clusters.
 */
export const DREAM_JACCARD_THRESHOLD = 0.15;

/**
 * Default daemon LLM model when `llm.daemon.model` is not configured.
 * Mirrors the fallback used in llm-extraction.ts.
 */
export const DREAM_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Default daemon LLM provider when `llm.daemon.provider` is not configured.
 */
export const DREAM_DEFAULT_PROVIDER = 'anthropic' as const;

/**
 * Minimum importance score for extracted memories to be stored.
 * Below this threshold, memories are dropped.
 */
export const DREAM_MIN_IMPORTANCE = 0.6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single BRAIN observation as collected from brain_observations.
 */
export interface CollectedObservation {
  /** Unique observation ID (O-* or similar). */
  id: string;
  /** Short title of the observation. */
  title: string;
  /** Full narrative/text content of the observation. */
  narrative: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /**
   * Observation type tag (e.g. `hygiene:orphan`, `session:end`, `decision:*`).
   * May be an empty string when the column is null.
   */
  observationType: string;
}

/**
 * A cluster of thematically-related observations produced by the Jaccard step.
 */
export interface ObservationCluster {
  /** Sequential cluster index within this run. */
  index: number;
  /** Member observations. */
  observations: CollectedObservation[];
  /**
   * Representative topic label derived from the most-shared n-grams.
   * Used in the LLM prompt for context.
   */
  topicLabel: string;
}

/**
 * A single memory item extracted by the LLM during the dream synthesis step.
 * Schema mirrors `ExtractedMemory` from llm-extraction.ts.
 */
export interface DreamExtractedMemory {
  /** `decision | pattern | learning | constraint` */
  type: 'decision' | 'pattern' | 'learning' | 'constraint';
  /** Declarative knowledge content (≤ 500 chars). */
  content: string;
  /** Importance 0.0–1.0. Only values ≥ DREAM_MIN_IMPORTANCE are persisted. */
  importance: number;
  /** Referenced code symbols, file paths, or concepts. */
  entities: string[];
  /** Why this memory is worth keeping (≤ 200 chars). */
  justification: string;
}

/**
 * Summary digest stored as a BRAIN observation at end of each dream run.
 */
export interface DreamCycleDigest {
  /** Unique run ID (UUID). */
  runId: string;
  /** ISO 8601 timestamp the cycle started. */
  startedAt: string;
  /** Number of observations collected in the lookback window. */
  observationsCollected: number;
  /** Number of clusters formed. */
  clustersFormed: number;
  /** Number of clusters that reached the minimum size and were synthesised. */
  clustersSynthesised: number;
  /** Total memories extracted across all clusters. */
  memoriesExtracted: number;
  /** Number of memories successfully stored or merged. */
  memoriesStored: number;
  /** Number of memories rejected (below threshold or gate-rejected). */
  memoriesRejected: number;
  /** Non-fatal warnings encountered during the run. */
  warnings: string[];
}

/**
 * Full outcome returned by `runDreamCycle`.
 */
export interface DreamCycleOutcome {
  /** How the cycle ended. */
  kind: 'killed' | 'no-api-key' | 'no-observations' | 'no-clusters' | 'completed' | 'error';
  /** Human-readable detail. */
  detail: string;
  /** Digest of what was processed (present on `completed` outcomes). */
  digest?: DreamCycleDigest;
}

/**
 * Options for `runDreamCycle`. All side-effecting deps are injectable.
 */
export interface DreamCycleOptions {
  /** Absolute path to the project root (contains `.cleo/`). */
  projectRoot: string;
  /** Absolute path to sentient-state.json (for kill-switch check). */
  statePath: string;
  /**
   * Override for the Anthropic client. Injected by tests to avoid real API
   * calls. When omitted (undefined), a client is constructed from the resolved
   * API key via `buildDaemonClient`. Pass `null` explicitly to signal "no
   * API key available" without triggering real credential resolution.
   */
  client?: Pick<Anthropic, 'messages'> | null;
  /**
   * Override for the brain observation collector.
   * When omitted, queries `brain_observations` directly.
   * Pass a function returning [] to simulate no-observations.
   */
  collectObservations?: (
    projectRoot: string,
    lookbackMs: number,
  ) => Promise<CollectedObservation[]>;
  /**
   * Override for the verify-and-store gate.
   * When omitted, calls `verifyAndStore` from extraction-gate.ts.
   */
  verifyAndStoreFn?: (
    projectRoot: string,
    candidate: MemoryCandidate,
  ) => Promise<{ action: 'stored' | 'merged' | 'pending' | 'rejected' }>;
  /**
   * Override for the BRAIN observation writer (dream-cycle digest).
   * When omitted, calls `memoryObserve` from `@cleocode/core/internal`.
   */
  observeMemory?: (
    params: { text: string; title: string; type?: string },
    projectRoot: string,
  ) => Promise<unknown>;
  /**
   * Kill-switch check. When omitted, reads `statePath` via `readSentientState`.
   */
  isKilled?: () => Promise<boolean>;
  /**
   * Lookback window in ms. Defaults to {@link DREAM_LOOKBACK_MS} (24 h).
   */
  lookbackMs?: number;
  /**
   * Minimum cluster size to synthesise. Defaults to {@link DREAM_CLUSTER_MIN_SIZE}.
   */
  clusterMinSize?: number;
  /**
   * Jaccard similarity threshold. Defaults to {@link DREAM_JACCARD_THRESHOLD}.
   */
  jaccardThreshold?: number;
  /**
   * Maximum clusters to synthesise per run. Defaults to {@link DREAM_MAX_CLUSTERS}.
   */
  maxClusters?: number;
  /**
   * Minimum importance for extracted memories. Defaults to {@link DREAM_MIN_IMPORTANCE}.
   */
  minImportance?: number;
}

/**
 * Options for the tick-level cadence trigger.
 * Passed to `maybeTriggerDreamCycle` from `safeRunTick`.
 */
export interface DreamCycleTickOptions {
  /** Absolute project root. */
  projectRoot: string;
  /** Absolute path to sentient-state.json. */
  statePath: string;
  /**
   * Override for the dream cycle function — lets tests assert calls without
   * touching the real brain.db stack or LLM.
   *
   * Pass `null` to disable the dream cycle entirely (test escape hatch).
   */
  dreamCycle?: ((options: DreamCycleOptions) => Promise<DreamCycleOutcome>) | null;
  /**
   * Interval between dream cycle runs (ms).
   * Defaults to {@link DREAM_CYCLE_INTERVAL_MS} (4 h).
   * Pass `0` to trigger every tick (useful for integration tests).
   */
  dreamCycleIntervalMs?: number;
  /** Injected options forwarded to `runDreamCycle`. */
  dreamCycleOptions?: Omit<DreamCycleOptions, 'projectRoot' | 'statePath'>;
}

// ---------------------------------------------------------------------------
// Zod schemas (mirror llm-extraction.ts structure exactly)
// ---------------------------------------------------------------------------

const DreamExtractedMemorySchema = z.object({
  type: z.enum(['decision', 'pattern', 'learning', 'constraint']),
  content: z.string().min(1).max(500),
  importance: z.number().min(0).max(1),
  entities: z.array(z.string()).max(20),
  justification: z.string().min(1).max(200),
});

const DreamSynthesisResponseSchema = z.object({
  memories: z.array(DreamExtractedMemorySchema).max(15),
});

// ---------------------------------------------------------------------------
// In-process state for interval gating (mirrors stage-drift-tick.ts pattern)
// ---------------------------------------------------------------------------

/**
 * Unix-epoch-ms timestamp of the last dream cycle run.
 * Set to 0 so the first eligible tick always triggers.
 * @internal
 */
let _lastDreamCycleAt = 0;

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Query brain_observations created within the last `lookbackMs` milliseconds.
 *
 * Pulls across all type tags — the clustering step will group by topic.
 * Returns an empty array when the DB is unavailable.
 */
async function defaultCollectObservations(
  projectRoot: string,
  lookbackMs: number,
): Promise<CollectedObservation[]> {
  try {
    const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
    await getBrainDb(projectRoot);
    const db = getBrainNativeDb();
    if (!db) return [];

    const cutoff = new Date(Date.now() - lookbackMs).toISOString().replace('T', ' ').slice(0, 19);

    const rows = db
      .prepare(
        `SELECT id, title, narrative, created_at, type
         FROM brain_observations
         WHERE created_at >= ?
           AND invalid_at IS NULL
         ORDER BY created_at ASC
         LIMIT 2000`,
      )
      .all(cutoff) as Array<{
      id: string;
      title: string | null;
      narrative: string | null;
      created_at: string;
      type: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      title: row.title ?? '',
      narrative: row.narrative ?? '',
      createdAt: row.created_at,
      observationType: row.type ?? '',
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Clustering — Jaccard on n-gram overlap
// ---------------------------------------------------------------------------

/**
 * Produce word-level unigrams from a string (title + narrative).
 * Normalises to lowercase, strips punctuation, filters short tokens.
 */
function extractNgrams(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  return new Set(words);
}

/**
 * Compute Jaccard similarity between two sets.
 * Returns 0 for empty sets.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Cluster observations using greedy single-linkage Jaccard clustering.
 *
 * Algorithm:
 *   1. Pre-compute n-gram sets for each observation.
 *   2. For each observation (in order), find the first existing cluster
 *      whose representative (first member) has Jaccard ≥ threshold.
 *   3. If no match, start a new cluster.
 *
 * Complexity: O(n²) in the worst case — acceptable for ≤ 2000 observations.
 * For large observation sets the lookback window itself limits n.
 *
 * @param observations - Collected observations.
 * @param threshold - Jaccard threshold for cluster membership.
 * @returns Array of clusters, each with ≥ 1 member.
 */
function clusterByJaccard(
  observations: CollectedObservation[],
  threshold: number,
): ObservationCluster[] {
  if (observations.length === 0) return [];

  const ngramSets: Array<Set<string>> = observations.map((o) =>
    extractNgrams(`${o.title} ${o.narrative}`),
  );

  // clusters[i] = indices into observations[] that belong to cluster i
  const clusterBuckets: number[][] = [];
  const clusterRepNgrams: Array<Set<string>> = [];

  for (let i = 0; i < observations.length; i++) {
    const ngrams = ngramSets[i];
    let assigned = false;

    for (let c = 0; c < clusterBuckets.length; c++) {
      const repNgrams = clusterRepNgrams[c];
      if (jaccardSimilarity(ngrams, repNgrams) >= threshold) {
        clusterBuckets[c].push(i);
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      clusterBuckets.push([i]);
      clusterRepNgrams.push(ngrams);
    }
  }

  return clusterBuckets.map((bucket, idx) => {
    const members = bucket.map((i) => observations[i]);
    // Topic label: top 5 most-common n-grams across all members
    const freq = new Map<string, number>();
    for (const i of bucket) {
      for (const w of ngramSets[i]) {
        freq.set(w, (freq.get(w) ?? 0) + 1);
      }
    }
    const topWords = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([w]) => w);

    return {
      index: idx,
      observations: members,
      topicLabel: topWords.join(', ') || `cluster-${idx}`,
    };
  });
}

// ---------------------------------------------------------------------------
// LLM synthesis
// ---------------------------------------------------------------------------

const DREAM_SYSTEM_PROMPT = `You are synthesising durable knowledge from a set of related BRAIN observations.
These observations were automatically collected during a sentient daemon dream cycle.

Your goal: extract high-value, durable knowledge that should be remembered long-term.
Reject noise, routine status messages, and transient state.

For each extraction provide:
- type: decision|pattern|learning|constraint
- content: the knowledge itself (<=500 chars, declarative form)
- importance: 0.0-1.0 (only >=0.6 will be stored)
- entities: code symbols, files, concepts mentioned
- justification: why this is worth remembering (<=200 chars)

Type definitions:
- decision: architectural or design choice with rationale ("We chose X because Y")
- pattern: recurring approach that works ("When X, do Y because Z")
- learning: factual knowledge gained ("X depends on Y via Z")
- constraint: rule/limitation discovered ("X must always Y")

Rules:
- Capture the WHY, not just the WHAT
- If nothing of durable value exists, return an empty array
- Prefer fewer high-quality extractions over many low-quality ones
- Maximum 10 extractions per cluster`;

function buildDreamUserPrompt(cluster: ObservationCluster): string {
  const observationTexts = cluster.observations
    .map(
      (o, i) =>
        `[${i + 1}] ${o.title || '(no title)'} (${o.observationType || 'observation'})\n${o.narrative || '(no content)'}`,
    )
    .join('\n\n---\n\n');

  return `Topic cluster: "${cluster.topicLabel}"
Cluster contains ${cluster.observations.length} related observation(s).

Observations:
${observationTexts}

Extract durable knowledge from these observations. Return empty array if nothing valuable.`;
}

/**
 * Construct an Anthropic client using `resolveCredentials` (T1677).
 *
 * Reads provider from `llm.daemon.provider` config (default: anthropic).
 * Only the anthropic transport is fully supported; others are skipped.
 *
 * @returns Client instance or null when no API key is available.
 */
async function buildDaemonClient(projectRoot: string): Promise<Pick<Anthropic, 'messages'> | null> {
  try {
    const { getRawConfigValue } = await import('../config.js');
    const rawProvider = (await getRawConfigValue('llm.daemon.provider', projectRoot)) as
      | string
      | undefined;
    const provider =
      (rawProvider as 'anthropic' | 'openai' | 'gemini' | 'moonshot' | undefined) ??
      DREAM_DEFAULT_PROVIDER;

    // Dream cycle currently only supports Anthropic (same SDK as llm-extraction.ts).
    // Future: add OpenAI/Gemini paths when needed.
    if (provider !== 'anthropic') {
      return null;
    }

    const cred = resolveCredentials('anthropic', { projectRoot });
    if (!cred.apiKey) return null;

    const AnthropicModule = await import('@anthropic-ai/sdk');
    const Ctor =
      (AnthropicModule as { default?: typeof import('@anthropic-ai/sdk').default }).default ??
      (AnthropicModule as unknown as typeof import('@anthropic-ai/sdk').default);
    return new Ctor({ apiKey: cred.apiKey }) as Pick<Anthropic, 'messages'>;
  } catch {
    return null;
  }
}

/**
 * Read the configured daemon model from `llm.daemon.model` (global config).
 * Falls back to {@link DREAM_DEFAULT_MODEL} on any error.
 */
async function resolveDaemonModel(projectRoot: string): Promise<string> {
  try {
    const { getRawConfigValue } = await import('../config.js');
    const model = (await getRawConfigValue('llm.daemon.model', projectRoot)) as string | undefined;
    return typeof model === 'string' && model.trim() ? model.trim() : DREAM_DEFAULT_MODEL;
  } catch {
    return DREAM_DEFAULT_MODEL;
  }
}

/**
 * Build the `zodOutputFormat` helper (lazy dynamic import matching llm-extraction.ts).
 * Returns null when the helper cannot be loaded.
 */
async function buildZodFormat<T extends z.ZodType>(schema: T): Promise<unknown | null> {
  try {
    const helpers = await import('@anthropic-ai/sdk/helpers/zod');
    return helpers.zodOutputFormat(schema);
  } catch {
    return null;
  }
}

/**
 * Fallback extraction: plain messages.create + manual JSON parse.
 * Used when the Zod helper cannot be loaded.
 */
async function extractViaPlainCall(
  client: Pick<Anthropic, 'messages'>,
  model: string,
  userPrompt: string,
): Promise<DreamExtractedMemory[]> {
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: `${DREAM_SYSTEM_PROMPT}\n\nReturn ONLY a JSON object of shape {"memories": [...]} with no prose.`,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = extractTextFromResponse(response);
  if (!text) return [];

  const parsed = safeJsonParse(text);
  if (!parsed) return [];

  const validated = DreamSynthesisResponseSchema.safeParse(parsed);
  return validated.success ? validated.data.memories : [];
}

/**
 * Pull plain text from an Anthropic messages.create response.
 */
function extractTextFromResponse(response: unknown): string {
  const content = (response as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text ?? '')
    .join('');
}

/**
 * Parse JSON extracting the first `{...}` block even through markdown fences.
 * Returns null on any failure.
 */
function safeJsonParse(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return null;
  try {
    return JSON.parse(trimmed.slice(first, last + 1));
  } catch {
    return null;
  }
}

/**
 * Call the LLM to synthesise memories from a single cluster.
 *
 * Mirrors the structured-output path in llm-extraction.ts:
 *   - Preferred path: zodOutputFormat + messages.parse
 *   - Fallback path: messages.create + manual JSON parse
 *
 * Returns an empty array on any error (never throws).
 */
async function synthesiseCluster(
  client: Pick<Anthropic, 'messages'>,
  model: string,
  cluster: ObservationCluster,
): Promise<DreamExtractedMemory[]> {
  const userPrompt = buildDreamUserPrompt(cluster);

  try {
    const format = await buildZodFormat(DreamSynthesisResponseSchema);
    if (format) {
      const messages = client.messages as unknown as {
        parse: (body: Record<string, unknown>) => Promise<{
          parsed_output?: { memories?: DreamExtractedMemory[] };
        }>;
      };
      const response = await messages.parse({
        model,
        max_tokens: 4096,
        system: DREAM_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        output_config: { format },
      });
      return response.parsed_output?.memories ?? [];
    }
    // Fallback to plain call.
    return await extractViaPlainCall(client, model, userPrompt);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Storage routing (mirrors llm-extraction.ts storeExtracted)
// ---------------------------------------------------------------------------

/**
 * Map extracted memory type to a `MemoryCandidate` and send through gate.
 *
 * Routing:
 *   - `decision`   → verifyAndStore with memoryType='semantic' (decisions
 *                    bypass verifyAndStore in llm-extraction — but here we
 *                    route through the gate uniformly for simplicity; the
 *                    gate handles dedup. Full decision domain fields are
 *                    optional for dream-cycle synthesis).
 *   - `pattern`    → verifyAndStore with memoryType='procedural'
 *   - `learning`   → verifyAndStore with memoryType='semantic'
 *   - `constraint` → verifyAndStore with memoryType='semantic', confidence boosted
 */
async function storeDreamMemory(
  projectRoot: string,
  memory: DreamExtractedMemory,
  runId: string,
  verifyAndStoreFn: DreamCycleOptions['verifyAndStoreFn'],
): Promise<'stored' | 'merged' | 'rejected'> {
  const confidence =
    memory.type === 'constraint' ? Math.max(memory.importance, 0.8) : memory.importance;

  let candidate: MemoryCandidate;
  if (memory.type === 'decision' || memory.type === 'learning' || memory.type === 'constraint') {
    candidate = {
      text: memory.content,
      title: `${memory.type.charAt(0).toUpperCase() + memory.type.slice(1)}: ${memory.content.slice(0, 80)}`,
      memoryType: 'semantic',
      tier: 'medium',
      confidence,
      source: 'transcript',
      sourceSessionId: `dream-cycle-${runId}`,
      sourceConfidence: 'agent',
    };
  } else {
    // pattern
    candidate = {
      text: memory.content,
      title: `Pattern: ${memory.content.slice(0, 80)}`,
      memoryType: 'procedural',
      tier: 'medium',
      confidence,
      source: 'transcript',
      sourceSessionId: `dream-cycle-${runId}`,
      sourceConfidence: 'agent',
    };
  }

  try {
    const gate = verifyAndStoreFn ?? (await resolveDefaultVerifyAndStore());
    const result = await gate(projectRoot, candidate);
    if (result.action === 'stored') return 'stored';
    if (result.action === 'merged') return 'merged';
    return 'rejected';
  } catch {
    return 'rejected';
  }
}

/**
 * Lazily import and return the default `verifyAndStore` from extraction-gate.
 * Cached per call chain — tests that inject `verifyAndStoreFn` never hit this.
 */
async function resolveDefaultVerifyAndStore(): Promise<
  (
    projectRoot: string,
    candidate: MemoryCandidate,
  ) => Promise<{ action: 'stored' | 'merged' | 'pending' | 'rejected' }>
> {
  const { verifyAndStore } = await import('../memory/extraction-gate.js');
  return verifyAndStore;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run one full dream cycle.
 *
 * Steps:
 *   1. Kill-switch check.
 *   2. Resolve LLM client (daemon provider config + credentials).
 *   3. Collect observations from the last 24 h.
 *   4. Cluster by Jaccard similarity.
 *   5. Synthesise each eligible cluster.
 *   6. Verify and store extracted memories via extraction-gate.
 *   7. Emit dream-cycle digest as BRAIN observation.
 *
 * Never throws — all errors are caught and reported in the outcome.
 *
 * @param options - Dream cycle options (see {@link DreamCycleOptions}).
 * @returns {@link DreamCycleOutcome} describing how the cycle ended.
 *
 * @task T1680
 */
export async function runDreamCycle(options: DreamCycleOptions): Promise<DreamCycleOutcome> {
  const { projectRoot, statePath } = options;

  const runId = randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();

  const digest: DreamCycleDigest = {
    runId,
    startedAt,
    observationsCollected: 0,
    clustersFormed: 0,
    clustersSynthesised: 0,
    memoriesExtracted: 0,
    memoriesStored: 0,
    memoriesRejected: 0,
    warnings: [],
  };

  // Step 1: kill-switch check.
  const killed = await (options.isKilled
    ? options.isKilled()
    : (async () => {
        const { readSentientState } = await import('./state.js');
        const state = await readSentientState(statePath);
        return state.killSwitch === true;
      })());

  if (killed) {
    return {
      kind: 'killed',
      detail: 'killSwitch active — dream cycle skipped',
    };
  }

  // Step 2: resolve LLM client.
  // When options.client is explicitly provided (including null as "no client"), use it.
  // When options.client is undefined (not set), attempt to build from config + credentials.
  let client: Pick<Anthropic, 'messages'> | null;
  if ('client' in options) {
    // Caller explicitly provided a client (or null to signal "no key available in test").
    client = options.client ?? null;
  } else {
    client = await buildDaemonClient(projectRoot);
  }

  if (!client) {
    return {
      kind: 'no-api-key',
      detail:
        'No LLM API key found (checked ANTHROPIC_API_KEY, ~/.claude/.credentials.json, ~/.cleo/config.json) — dream cycle skipped',
    };
  }

  const model = await resolveDaemonModel(projectRoot);

  // Step 3: collect observations.
  const lookbackMs = options.lookbackMs ?? DREAM_LOOKBACK_MS;
  const collect = options.collectObservations ?? defaultCollectObservations;
  let observations: CollectedObservation[];
  try {
    observations = await collect(projectRoot, lookbackMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    digest.warnings.push(`collection error: ${message}`);
    observations = [];
  }

  digest.observationsCollected = observations.length;

  if (observations.length === 0) {
    return {
      kind: 'no-observations',
      detail: 'no BRAIN observations in lookback window — dream cycle skipped',
    };
  }

  // Step 4: cluster.
  const jaccardThreshold = options.jaccardThreshold ?? DREAM_JACCARD_THRESHOLD;
  const clusters = clusterByJaccard(observations, jaccardThreshold);
  digest.clustersFormed = clusters.length;

  if (clusters.length === 0) {
    return {
      kind: 'no-clusters',
      detail: 'no clusters formed — dream cycle skipped',
    };
  }

  // Step 5 + 6: synthesise eligible clusters, store memories.
  const clusterMinSize = options.clusterMinSize ?? DREAM_CLUSTER_MIN_SIZE;
  const maxClusters = options.maxClusters ?? DREAM_MAX_CLUSTERS;
  const minImportance = options.minImportance ?? DREAM_MIN_IMPORTANCE;

  const eligibleClusters = clusters
    .filter((c) => c.observations.length >= clusterMinSize)
    .slice(0, maxClusters);

  for (const cluster of eligibleClusters) {
    digest.clustersSynthesised++;

    let extracted: DreamExtractedMemory[];
    try {
      extracted = await synthesiseCluster(client, model, cluster);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      digest.warnings.push(`cluster ${cluster.index} synthesis error: ${message}`);
      extracted = [];
    }

    digest.memoriesExtracted += extracted.length;

    for (const memory of extracted) {
      if (memory.importance < minImportance) {
        digest.memoriesRejected++;
        continue;
      }

      try {
        const outcome = await storeDreamMemory(
          projectRoot,
          memory,
          runId,
          options.verifyAndStoreFn,
        );
        if (outcome === 'stored' || outcome === 'merged') {
          digest.memoriesStored++;
        } else {
          digest.memoriesRejected++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        digest.warnings.push(`store error: ${message}`);
        digest.memoriesRejected++;
      }
    }
  }

  // Step 7: emit digest as BRAIN observation.
  const digestText =
    `sentient:dream-cycle-${runId} — dream cycle completed. ` +
    `Collected ${digest.observationsCollected} observation(s) in last ${Math.round(lookbackMs / 3_600_000)}h. ` +
    `Formed ${digest.clustersFormed} cluster(s); synthesised ${digest.clustersSynthesised}. ` +
    `Extracted ${digest.memoriesExtracted} memory(ies): ${digest.memoriesStored} stored/merged, ` +
    `${digest.memoriesRejected} rejected.` +
    (digest.warnings.length > 0 ? ` Warnings: ${digest.warnings.slice(0, 3).join('; ')}` : '');

  const digestTitle = `sentient:dream-cycle-${runId} — ${digest.memoriesStored} memories synthesised`;

  const observe =
    options.observeMemory ??
    (async (params, root) => {
      const { memoryObserve } = await import('@cleocode/core/internal');
      return memoryObserve(params, root);
    });

  try {
    await observe({ text: digestText, title: digestTitle, type: 'discovery' }, projectRoot);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    digest.warnings.push(`digest observation write error: ${message}`);
  }

  return {
    kind: 'completed',
    detail:
      `dream cycle completed: ${digest.memoriesStored} memories stored/merged ` +
      `from ${digest.clustersSynthesised} cluster(s)`,
    digest,
  };
}

/**
 * Safe wrapper for {@link runDreamCycle} — swallows unexpected exceptions.
 *
 * Used from `safeRunTick` as a fire-and-forget best-effort call.
 * Errors never propagate to the tick caller.
 *
 * @param options - Dream cycle options.
 * @returns Cycle outcome or an error outcome on unexpected throw.
 *
 * @task T1680
 */
export async function safeRunDreamCycle(options: DreamCycleOptions): Promise<DreamCycleOutcome> {
  try {
    return await runDreamCycle(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'error',
      detail: `dream cycle threw: ${message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Tick integration helper
// ---------------------------------------------------------------------------

/**
 * Evaluate the dream cycle cadence and fire {@link safeRunDreamCycle} when
 * enough time has elapsed since the last run.
 *
 * Mirrors the pattern in `maybeTriggerStageDriftScan` from stage-drift-tick.ts.
 * Respects the injectable `options.dreamCycle` override (null = disabled).
 * Errors are swallowed — dream cycle must never crash the tick.
 *
 * @param options - Tick-level options (see {@link DreamCycleTickOptions}).
 *
 * @internal
 * @task T1680
 */
export async function maybeTriggerDreamCycle(options: DreamCycleTickOptions): Promise<void> {
  // null explicitly disables the dream cycle (test escape hatch).
  if (options.dreamCycle === null) return;

  const intervalMs = options.dreamCycleIntervalMs ?? DREAM_CYCLE_INTERVAL_MS;
  const now = Date.now();

  if (now - _lastDreamCycleAt < intervalMs) return;

  // Update timestamp before awaiting so concurrent ticks don't double-fire.
  _lastDreamCycleAt = now;

  const dreamCycleOptions: DreamCycleOptions = {
    projectRoot: options.projectRoot,
    statePath: options.statePath,
    ...options.dreamCycleOptions,
  };

  try {
    if (options.dreamCycle) {
      // Injected override (tests).
      await options.dreamCycle(dreamCycleOptions);
    } else {
      // Default: run the real dream cycle.
      await safeRunDreamCycle(dreamCycleOptions);
    }
  } catch {
    // Dream cycle is best-effort: errors must never propagate to the tick caller.
  }
}

// ---------------------------------------------------------------------------
// Test helpers (internal — for test teardown only)
// ---------------------------------------------------------------------------

/**
 * Reset the dream cycle interval timestamp.
 *
 * Intended for test teardown only — allows tests to reset the cadence so
 * the next tick fires immediately.
 *
 * @internal
 * @task T1680
 */
export function _resetDreamCycleAt(): void {
  _lastDreamCycleAt = 0;
}

/**
 * Return the current dream cycle interval timestamp (ms).
 *
 * Read-only accessor for test assertions.
 *
 * @internal
 * @task T1680
 */
export function _getLastDreamCycleAt(): number {
  return _lastDreamCycleAt;
}
