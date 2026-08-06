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
 * via `resolveLLMForRole('consolidation')` (T9255 — Phase 2 role-based routing).
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
import { IMPLICIT_FALLBACK_MODEL, resolveAnthropicForRole } from '../llm/role-resolver.js';
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
 * Upper bound on the provider-liveness probe issued while resolving a dream
 * client (T12082).
 *
 * A provider with a dead credential does not fail fast — the transport retries
 * with backoff, so an unbounded probe blocks the entire consolidation pass
 * behind a chain that will never succeed. Background work must degrade, not
 * hang: a provider that cannot answer a 16-token ping in this window is not
 * usable for consolidation regardless of what it eventually returns.
 */
export const DREAM_PROBE_TIMEOUT_MS = 20_000;

/**
 * Jaccard similarity threshold above which two observations are placed in
 * the same cluster. Value in [0, 1]. Higher = tighter clusters.
 */
export const DREAM_JACCARD_THRESHOLD = 0.15;

/**
 * Default daemon LLM model when no `llm.roles.consolidation`, `llm.default`,
 * nor `llm.daemon` entry is configured. Re-exported for tests + downstream
 * code that historically relied on this constant — sourced from
 * `IMPLICIT_FALLBACK_MODEL` (T9255) so there is exactly one literal.
 */
export const DREAM_DEFAULT_MODEL = IMPLICIT_FALLBACK_MODEL;

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
    const db = getBrainNativeDb(projectRoot);
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
 * Resolve the LLM client + model for the dream cycle via
 * `resolveAnthropicForRole('consolidation')` (T9255 + T-LLM-CRED Phase 2
 * DRY review P2-1).
 *
 * The helper walks `config.llm.roles.consolidation` → `config.llm.default`
 * → `config.llm.daemon` → implicit fallback. Dream cycle currently only
 * supports Anthropic (same SDK as llm-extraction.ts); the helper returns
 * `null` for non-anthropic resolutions so the cycle records `no-api-key`
 * and skips synthesis without breaking the kill-switch / digest paths.
 *
 * @returns `{ client, model }` or `null` when no usable credential exists.
 */
async function resolveDreamLlm(
  projectRoot: string,
): Promise<{ client: Pick<Anthropic, 'messages'>; model: string } | null> {
  // Preferred: a real Anthropic client, which supports the structured-output
  // `messages.parse` path.
  const anthropic = await resolveAnthropicForRole('consolidation', { projectRoot });
  if (anthropic) return { client: anthropic.client, model: anthropic.model };

  // T12081: fall back to ANY resolvable provider via `executeForRole`.
  //
  // `resolveAnthropicForRole` returns null for every non-anthropic provider, so
  // a project whose `consolidation` role resolves to openai, gemini or a local
  // Ollama endpoint could not run the dream cycle at all — it reported "no
  // usable Anthropic client" and skipped. A provider-specific chokepoint inside
  // an otherwise provider-agnostic system, and the reason the dream cycle was
  // dead on a machine that had working LOCAL inference available the whole time.
  //
  // `executeForRole` is the existing provider-agnostic path (resolve → unseal →
  // ModelRunner.buildTransportFromCredential → complete). Wrapping it in the
  // `messages.create` shape lets the plain-call extractor run unchanged: it
  // already asks for `{content: [{type:'text', text}]}`, which is what this
  // returns.
  try {
    const { executeForRole } = await import('../llm/role-executor.js');
    // Bounded: a provider whose credential is dead answers with retries, not
    // with an error. Left unbounded this probe stalls the whole consolidation
    // pass behind a chain that is never going to succeed — observed here as a
    // dream cycle that ran for over ten minutes without reaching step one.
    // A ping that cannot answer in DREAM_PROBE_TIMEOUT_MS is not a usable
    // provider for background work, whatever it eventually returns.
    const probe = await executeForRole('consolidation', 'ping', 'ping', {
      projectRoot,
      maxTokens: 16,
      signal: AbortSignal.timeout(DREAM_PROBE_TIMEOUT_MS),
    });
    // A null probe means the resolved provider has no usable credential. Do NOT
    // return here — the local tier below is the whole point of having one.
    if (probe) {
      const client = {
        messages: {
          create: async (body: {
            system?: string;
            messages: Array<{ role: string; content: string }>;
          }) => {
            const userContent = body.messages
              .filter((m) => m.role === 'user')
              .map((m) => m.content)
              .join('\n\n');
            const result = await executeForRole('consolidation', body.system ?? '', userContent, {
              projectRoot,
            });
            return { content: [{ type: 'text', text: result?.content ?? '' }] };
          },
        },
      } as unknown as Pick<Anthropic, 'messages'>;

      return { client, model: probe.model };
    }
  } catch {
    // fall through to the local tier
  }

  // T12082: last tier — a reachable LOCAL inference server.
  //
  // The auxiliary fallback chain exists so background work does not fail
  // silently when the primary provider is unavailable, but its default chain
  // (anthropic → openrouter → groq) is entirely cloud. When every cloud
  // credential is unusable the chain is exhausted and consolidation simply
  // stops — which is what happened here while an Ollama server sat running with
  // models loaded, one HTTP request away.
  //
  // A consolidation pass is exactly the workload that should degrade to a small
  // local model rather than stop: not latency-critical, not user-facing, and a
  // shallow synthesis is worth more than none. Detection is a 300 ms loopback
  // probe, so this costs nothing when no server is present.
  try {
    const { detectLocalInference } = await import('../llm/local-inference-probe.js');
    const local = await detectLocalInference();
    const model = local?.models[0];
    if (!local || model === undefined) return null;

    const { ModelRunner } = await import('../llm/model-runner.js');
    const transport = ModelRunner.buildTransportFromCredential(
      'openai',
      {
        provider: 'openai',
        label: `${local.name}-autodetected`,
        // Local servers accept any bearer value; the field is required by the
        // transport contract, not by the endpoint.
        token: 'local',
        authType: 'api_key',
        expiresAt: null,
        refreshToken: null,
        extraHeaders: {},
        // The compat form: this shim speaks `chat_completions`.
        baseUrl: local.openAiBaseUrl,
        awsProfile: null,
      },
      'chat_completions',
    );

    const client = {
      messages: {
        create: async (body: {
          max_tokens: number;
          system?: string;
          messages: Array<{ role: string; content: string }>;
        }) => {
          const response = await transport.complete({
            model,
            maxTokens: body.max_tokens,
            ...(body.system !== undefined ? { system: body.system } : {}),
            messages: body.messages.map((m) => ({
              role: m.role as 'user' | 'assistant',
              content: m.content,
            })),
          });
          return {
            content: [
              {
                type: 'text',
                text: Array.isArray(response.content)
                  ? response.content.map((c: { text?: string }) => c.text ?? '').join('')
                  : String(response.content ?? ''),
              },
            ],
          };
        },
      },
    } as unknown as Pick<Anthropic, 'messages'>;

    return { client, model };
  } catch {
    return null;
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
    // T12081: the provider-agnostic shim implements `create` only. Guard on
    // `parse` rather than letting an undefined call throw into the catch-all,
    // which would silently yield zero memories for every non-anthropic provider.
    const hasParse =
      typeof (client.messages as unknown as { parse?: unknown }).parse === 'function';
    if (format && hasParse) {
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
 * Why anthropic was excluded from provider selection, when it was.
 *
 * T12078: the interesting case is `skipped-consent`. CLEO deliberately will not
 * import another tool's credential without opt-in, so the `claude-code` seeder
 * refuses to read `~/.claude/.credentials.json` until
 * `auth.claudeCodeConsentGiven` is set. That is correct security design — but
 * it is invisible at the point of failure, and its symptom is identical to
 * "you have no credentials": the stored anthropic entries simply age out (here:
 * 2026-05-18 and 2026-07-12), refresh fails, the selector drops anthropic, and
 * every LLM-dependent feature dies quietly while a perfectly valid token sits
 * in a file CLEO has chosen not to read.
 *
 * Naming the consent flag turns a multi-hour investigation into one command.
 *
 * @returns a remedy sentence; never throws.
 *
 * @task T12078
 */
async function describeAnthropicExclusion(): Promise<string> {
  try {
    const { getCredentialPool } = await import('../llm/credential-pool.js');
    const pool = getCredentialPool();
    // Seeder status is populated by a seed pass; in a fresh process it is empty
    // until one runs. A non-forced seed honours the 60s cache, so this is cheap
    // and idempotent on the error path.
    await pool.seed().catch(() => undefined);
    const status = await pool.getSeederStatus();
    // 'claude-code' below is a credential SEEDER id, not a model literal — the
    // chokepoint rule's pattern cannot tell the two apart, hence the opt-out.
    const claudeCode = status.find((s) => s.sourceId === 'claude-code'); // llm-resolve-allowed: seeder id, not a model
    if (claudeCode?.lastResult === 'skipped-consent') {
      return (
        'Anthropic was excluded because its stored credentials are expired and the ' +
        'claude-code seeder is gated on consent (lastResult=skipped-consent), so the ' +
        'valid token in ~/.claude/.credentials.json is never imported. Fix with ' +
        'EITHER `cleo config set auth.claudeCodeConsentGiven true` (authorise CLEO to ' +
        'read Claude Code credentials) OR `cleo login anthropic`.'
      );
    }
    return (
      'Either configure llm.roles.consolidation for anthropic, or restore an ' +
      'anthropic credential (`cleo login anthropic`) so the cross-provider ' +
      'selector stops excluding it.'
    );
  } catch {
    return 'Run `cleo login anthropic` to restore an anthropic credential.';
  }
}

/**
 * One-line explanation of why {@link resolveDreamLlm} produced no client.
 *
 * Distinguishes "the role resolved to a provider this path cannot use" from
 * "no credential at all", because the remedies are different: the first needs
 * a role/config change or a provider-agnostic runner, the second needs a
 * login.
 *
 * Never throws — diagnostics must not break the caller's error path.
 *
 * @param projectRoot - project root used for resolution.
 * @returns a human-readable reason, always non-empty.
 *
 * @task T12078
 */
async function describeDreamLlmResolution(projectRoot: string): Promise<string> {
  try {
    const { resolveLLMForRole } = await import('../llm/role-resolver.js');
    const llm = await resolveLLMForRole('consolidation', { projectRoot });
    if (llm.provider !== 'anthropic') {
      const why = await describeAnthropicExclusion();
      return (
        `The 'consolidation' role resolved to provider '${llm.provider}' (model ` +
        `'${llm.model}'), but this path requires anthropic. ${why}`
      );
    }
    if (!llm.sealedCredential) {
      return 'Resolved provider anthropic, but no usable credential — run `cleo login anthropic`.';
    }
    return 'Resolved provider anthropic with a credential, but no client was constructed.';
  } catch (err) {
    return `LLM resolution failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

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

  // Step 2: resolve LLM client + model.
  // When options.client is explicitly provided (including null as "no client"), use it.
  // When options.client is undefined (not set), resolve from config + credentials
  // via `resolveLLMForRole('consolidation')` (T9255).
  let client: Pick<Anthropic, 'messages'> | null;
  let model: string;
  if ('client' in options) {
    // Caller explicitly provided a client (or null to signal "no key available in test").
    client = options.client ?? null;
    // Test path: also allow callers to skip configuration entirely. Fall back
    // to DREAM_DEFAULT_MODEL so the synthesise call has a non-empty model arg.
    model = DREAM_DEFAULT_MODEL;
  } else {
    const resolved = await resolveDreamLlm(projectRoot);
    client = resolved?.client ?? null;
    model = resolved?.model ?? DREAM_DEFAULT_MODEL;
  }

  if (!client) {
    // T12078: report WHY, not a guess.
    //
    // This message used to assert "No LLM API key found (checked
    // ANTHROPIC_API_KEY, ~/.claude/.credentials.json, ~/.cleo/config.json)".
    // That was frequently false, and its falseness hid a real outage: on this
    // machine a VALID Anthropic OAuth token sat in
    // `~/.claude/.credentials.json` while the dream cycle reported no key at
    // all. The actual chain was:
    //
    //   • CLEO's own credential store held two Anthropic OAuth entries, both
    //     long expired (2026-05-18, 2026-07-12), whose refresh failed;
    //   • `cross-provider-selector` therefore EXCLUDED anthropic and resolved
    //     the `consolidation` role to openai/gpt-5.5-pro;
    //   • `resolveAnthropicForRole` returns null for any non-anthropic
    //     provider, so this path saw `client === null`.
    //
    // Three different causes — no credential, an expired one, or a role
    // resolved to a provider this Anthropic-only path cannot use — all
    // collapsed into one message that named only the first. Naming the
    // resolved provider is what makes the difference visible.
    const resolvedProvider = await describeDreamLlmResolution(projectRoot);
    return {
      kind: 'no-api-key',
      detail: `Dream cycle skipped — no usable Anthropic client. ${resolvedProvider}`,
    };
  }

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
