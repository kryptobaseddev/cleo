/**
 * BRAIN-powered tiered duplicate-task detection for `cleo add`.
 *
 * Before a new task is inserted, this module queries active tasks and computes
 * similarity between the incoming title+description and each active task.
 *
 * Three-tier escalation (T1681):
 *
 *   Tier 1 — lexical OR vector similarity. NOT BM25, despite the historical
 *     naming: there is no IDF, no term frequency and no length normalisation.
 *     Two implementations, selected at runtime (see `runDuplicateCheck`):
 *       - lexical: Jaccard over CHARACTER TRIGRAMS of a title-2x-weighted blob
 *       - vector:  cosine over embeddings, when an embedding provider is loaded
 *     score >= 0.92 → reject (clear match)
 *     score <  0.50 → insert (clear different)
 *     score in [0.50, 0.92) → escalate to Tier 2
 *
 *   Tier 2 — Jaccard on word-level n-grams (title+description+labels):
 *     score >= 0.85 → reject
 *     score <  0.40 → insert
 *     score in [0.40, 0.85) → escalate to Tier 3 (LLM, paid)
 *
 *   Tier 3 — one batched System One decision (T12492), then the optional
 *     generative LLM tier:
 *     - System One: ONE `decide()` request carrying up to {@link MAX_CANDIDATES}
 *       noul questions ("is the new task the same work as candidate cN?"),
 *       bounded by {@link DUPLICATE_DECISION_BUDGET_MS} end to end. Mode comes
 *       from `decide.sites.duplicateDetection` (`off | shadow | on`): `shadow`
 *       (the default once a provider is configured) records the heuristic and
 *       decision answers side by side in `.cleo/audit/decisions.jsonl` and acts
 *       on the heuristic; `on` acts on the decision when one arrives. No
 *       provider configured → `off`, and no network call is made at all.
 *     - Generative LLM (T1681, max 1 call): OPT-IN via
 *       `decide.generativeFallback.duplicateDetection: true`. Off by default,
 *       so `cleo add` no longer pays its 15 s timeout.
 *     Fallback on every failure: the Tier-1-only decision (never block on error).
 *
 * Thresholds (original T1633 behavior preserved for the Tier-1 clear-match path):
 *   Tier-1 score >= 0.85 → warning emitted to stderr (non-blocking)
 *   Tier-1 score >= 0.92 → rejected with E_DUPLICATE_TASK_LIKELY
 *
 * @epic T1627
 * @task T1633
 * @task T1681
 */

import type { DecisionAnswer, DecisionQuestion, DecisionRequest, Task } from '@cleocode/contracts';
import { z } from 'zod';
import type { DecideOptions } from '../decide/client.js';
import type { DataAccessor } from '../store/data-accessor.js';

// ============================================================================
// Thresholds
// ============================================================================

/** Tier-1 score at which a non-blocking warning is emitted. (Name kept: exported API.) */
export const DUPLICATE_WARN_THRESHOLD = 0.85;

/** Tier-1 score at which creation is rejected (clear match). (Name kept: exported API.) */
export const DUPLICATE_REJECT_THRESHOLD = 0.92;

/**
 * Tier-1 lower bound for the ambiguous range.
 * Scores below this are considered clear-different and skip Jaccard + LLM.
 */
const TIER1_ESCALATE_LOW = 0.5;

/**
 * Jaccard reject threshold.
 * Scores >= this after Tier-2 escalation cause rejection without calling LLM.
 */
const JACCARD_REJECT_THRESHOLD = 0.85;

/**
 * Jaccard lower bound for the ambiguous range.
 * Scores below this after Tier-2 escalation are considered clear-different.
 */
const JACCARD_ESCALATE_LOW = 0.4;

/** Maximum active tasks to scan per invocation. Prevents runaway cost on huge task lists. */
const MAX_ACTIVE_TASKS_SCAN = 500;

/** Maximum number of candidates to surface in the warning/rejection message. */
export const MAX_CANDIDATES = 3;

/** LLM call timeout in milliseconds (opt-in generative tier only). */
const LLM_TIMEOUT_MS = 15_000;

/**
 * End-to-end budget for the System One duplicate decision, in milliseconds:
 * module load, settings, redaction, the shared request budget and the HTTP
 * round trip (connection setup included) all fit inside it.
 *
 * @task T12492
 */
export const DUPLICATE_DECISION_BUDGET_MS = 300;

/** Call-site id for the duplicate decision; keys the audit line. */
export const DUPLICATE_DECISION_SITE = 'tasks.duplicate-detection';

/** Config key selecting the System One mode for duplicate detection. */
export const DUPLICATE_DECISION_MODE_KEY = 'decide.sites.duplicateDetection';

/** Config key opting in to the generative LLM tier (T1681). Default `false`. */
export const DUPLICATE_LLM_TIER_KEY = 'decide.generativeFallback.duplicateDetection';

/**
 * Per-field character caps for the decision state. Four tasks (the new one
 * plus three candidates) stay near 3 KB of text — inside the ~1024 tokens the
 * decision model reads.
 */
const DECISION_TITLE_MAX_CHARS = 160;
const DECISION_DESCRIPTION_MAX_CHARS = 440;

/**
 * Maximum candidates that may be scored with local embeddings (T12117).
 *
 * The vector tier used to run inside the per-candidate loop with no bound, so
 * `cleo add` performed one local model inference **per active task** before
 * committing the row — O(active tasks) inferences on the write path. In a
 * project with ~1,000 active tasks that is thousands of inferences to create
 * one row, which is why `cleo add` was observed taking 180-280 s and failing
 * outright on a memory-constrained host (issue #1244).
 *
 * Candidates beyond this budget fall back to the lexical score, which is the
 * same fallback already used whenever embeddings are unavailable — so this
 * bounds cost without introducing a new code path.
 */
const MAX_VECTOR_CANDIDATES = 25;

/**
 * Wall-clock budget for the whole vector-scoring phase, in milliseconds.
 *
 * A second bound beside {@link MAX_VECTOR_CANDIDATES} because the count cap
 * assumes each inference is fast, and a cold model load is not. Whichever
 * bound trips first ends the phase.
 */
const VECTOR_PHASE_BUDGET_MS = 5_000;

// ============================================================================
// Types
// ============================================================================

/** A candidate active task that scored above the warning threshold. */
export interface DuplicateCandidate {
  /** The matching active task ID. */
  id: string;
  /** The matching active task title. */
  title: string;
  /** Similarity score in [0, 1]. */
  score: number;
}

/** Result returned by {@link checkDuplicates}. */
export interface DuplicateCheckResult {
  /**
   * Maximum similarity score across all active tasks.
   * 0 when no active tasks are found or all scores are below warning threshold.
   */
  maxScore: number;
  /** Top-N candidates sorted by score descending (above warning threshold only). */
  candidates: DuplicateCandidate[];
  /** Whether any candidate exceeds the reject threshold. */
  shouldReject: boolean;
  /** Whether any candidate exceeds the warn threshold (but not the reject threshold). */
  shouldWarn: boolean;
  /**
   * Which tier produced the final decision.
   * @task T1681
   */
  /**
   * Which tier produced the decision.
   *
   * `'bm25'` is a HISTORICAL label for the Tier-1 measure, kept because it is
   * emitted in the envelope and renaming it would break consumers. Tier 1 is
   * not BM25 — see the module docblock. Reporting WHICH Tier-1 implementation
   * ran (lexical vs vector) is tracked separately.
   */
  tier?: 'bm25' | 'jaccard' | 'llm' | 'decision';
}

/**
 * System One mode for duplicate detection (T12492).
 *
 * - `off`    — no decision request.
 * - `shadow` — ask, audit both answers, act on the heuristic.
 * - `on`     — ask, act on the decision; the heuristic acts on any fallback.
 */
export type DuplicateDecisionMode = 'off' | 'shadow' | 'on';

/** Optional wiring for {@link checkDuplicates}. Every field defaults from config. */
export interface DuplicateCheckOptions {
  /** Force a mode instead of reading {@link DUPLICATE_DECISION_MODE_KEY}. Still `off` when unconfigured. */
  mode?: DuplicateDecisionMode;
  /** Force the generative LLM tier on/off instead of reading {@link DUPLICATE_LLM_TIER_KEY}. */
  llmTier?: boolean;
  /** Provider, connection, budget, cache and audit wiring forwarded to `decide()`. Tests inject a stub here. */
  decide?: DecideOptions;
}

// ============================================================================
// LLM structured-output schema (Tier 3)
// ============================================================================

/**
 * Structured output schema for the LLM duplicate-reasoning call.
 * @task T1681
 */
export const DuplicateReasoningSchema = z.object({
  /** Whether the two tasks are semantic duplicates. */
  are_duplicate: z.boolean(),
  /** Confidence in [0, 1]. */
  confidence: z.number().min(0).max(1),
  /**
   * What makes them distinct (non-null when are_duplicate=false).
   * Null when they are duplicates.
   */
  distinction: z.string().nullable(),
  /** Recommended action. */
  suggestion: z.enum(['merge', 'keep-both', 'block-new']),
});

/** Inferred type for the LLM reasoning result. */
export type DuplicateReasoning = z.infer<typeof DuplicateReasoningSchema>;

// ============================================================================
// Similarity Primitives — Tier 1 (lexical: character-trigram Jaccard)
// ============================================================================

/**
 * Normalise text for comparison: lowercase, collapse whitespace,
 * strip punctuation (except hyphens which carry semantic meaning).
 *
 * @param text - Raw text to normalise.
 * @returns Normalised string.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a Set of character trigrams from normalised text.
 * Trigrams capture local character patterns and are robust to
 * word-order variation and minor phrasing differences.
 *
 * @param text - Normalised text.
 * @returns Set of 3-character substrings.
 */
function trigrams(text: string): Set<string> {
  const result = new Set<string>();
  if (text.length < 3) {
    if (text.length > 0) result.add(text.padEnd(3, ' '));
    return result;
  }
  for (let i = 0; i <= text.length - 3; i++) {
    result.add(text.slice(i, i + 3));
  }
  return result;
}

/**
 * Jaccard similarity between two Sets: |A ∩ B| / |A ∪ B|.
 * Returns 0 when both sets are empty.
 *
 * @param a - First set.
 * @param b - Second set.
 * @returns Jaccard score in [0, 1].
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const v of a) {
    if (b.has(v)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Build a weighted search blob from title and description.
 * Title is given 2× weight by repetition to reflect higher semantic importance.
 *
 * @param title - Task title.
 * @param description - Task description (may be empty).
 * @returns A single normalised string for trigram hashing.
 */
function buildSearchBlob(title: string, description: string): string {
  // Repeat title twice to increase its weight relative to the description
  return normalise(`${title} ${title} ${description}`);
}

/**
 * Compute lexical similarity between two (title, description) pairs.
 *
 * Uses Jaccard similarity over character trigrams of a weighted blob
 * (title 2×, description 1×). This is zero-dependency, deterministic,
 * and symmetrical. This is the LEXICAL Tier-1 measure — it is not BM25.
 *
 * @param titleA - First title.
 * @param descA - First description.
 * @param titleB - Second title.
 * @param descB - Second description.
 * @returns Similarity score in [0, 1].
 */
export function computeLexicalSimilarity(
  titleA: string,
  descA: string,
  titleB: string,
  descB: string,
): number {
  const blobA = buildSearchBlob(titleA, descA);
  const blobB = buildSearchBlob(titleB, descB);

  // Fast-path: exact blobs
  if (blobA === blobB) return 1.0;

  const tA = trigrams(blobA);
  const tB = trigrams(blobB);

  return jaccard(tA, tB);
}

// ============================================================================
// Similarity Primitives — Tier 2 (Jaccard word n-grams with labels)
// ============================================================================

/**
 * Build word unigrams and bigrams from a token list.
 * Includes labels as additional tokens to capture tag-level similarity.
 *
 * @param tokens - Array of normalised word tokens.
 * @returns Set of word n-grams (unigrams + bigrams).
 */
function wordNgrams(tokens: string[]): Set<string> {
  const result = new Set<string>();
  for (const tok of tokens) {
    result.add(tok);
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    result.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return result;
}

/**
 * Tokenise a string into normalised word tokens.
 *
 * @param text - Raw text.
 * @returns Array of lowercase non-empty word tokens.
 */
function tokenise(text: string): string[] {
  return normalise(text)
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Build word-level n-gram set from title + description + labels.
 * This differs from the Tier-1 lexical blob (character trigrams, no labels).
 *
 * @param title - Task title.
 * @param description - Task description.
 * @param labels - Task labels (empty array if none).
 * @returns Set of word unigrams + bigrams.
 */
function buildWordNgramSet(title: string, description: string, labels: string[]): Set<string> {
  // Title carries 2x weight via repetition (matches the Tier-1 blob weighting)
  const titleTokens = tokenise(title);
  const descTokens = tokenise(description);
  const labelTokens = labels.flatMap((l) => tokenise(l));

  const allTokens = [...titleTokens, ...titleTokens, ...descTokens, ...labelTokens];
  return wordNgrams(allTokens);
}

/**
 * Compute Jaccard similarity over word-level n-grams including labels.
 * Used as Tier-2 discriminator when the Tier-1 score is ambiguous.
 *
 * @param titleA - First title.
 * @param descA - First description.
 * @param labelsA - First task labels.
 * @param titleB - Second title.
 * @param descB - Second description.
 * @param labelsB - Second task labels.
 * @returns Jaccard score in [0, 1].
 */
export function computeJaccardWordSimilarity(
  titleA: string,
  descA: string,
  labelsA: string[],
  titleB: string,
  descB: string,
  labelsB: string[],
): number {
  const setA = buildWordNgramSet(titleA, descA, labelsA);
  const setB = buildWordNgramSet(titleB, descB, labelsB);
  return jaccard(setA, setB);
}

// ============================================================================
// BRAIN-powered Vector Similarity (opportunistic, Tier 1)
// ============================================================================

/**
 * Embed the incoming search blob ONCE for the whole duplicate check.
 *
 * Returns `null` when embedding is unavailable, which makes the caller fall
 * back to the lexical (trigram) measure for every candidate.
 *
 * @param incomingBlob - Normalised search blob for the new task.
 * @returns The incoming embedding, or `null` when embedding is unavailable.
 */
async function embedIncomingOnce(incomingBlob: string): Promise<Float32Array | null> {
  try {
    const { isEmbeddingAvailable, embedText } = await import('../memory/brain-embedding.js');
    if (!isEmbeddingAvailable()) return null;
    return (await embedText(incomingBlob)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Cosine similarity between a PRE-COMPUTED incoming vector and a candidate blob.
 *
 * The incoming vector is computed once per duplicate check by
 * {@link embedIncomingOnce} and passed in. It used to be embedded inside this
 * function, which ran once per candidate — so a store with 1,126 active tasks
 * embedded the same incoming text 1,126 times per `cleo add`. Only the candidate
 * is embedded here.
 *
 * @param incomingVec - Pre-computed embedding of the incoming blob.
 * @param candidateBlob - Candidate search blob to embed and compare.
 * @returns Cosine similarity in [0, 1], or `null` when embedding is unavailable.
 */
async function tryVectorSimilarity(
  incomingVec: Float32Array,
  candidateBlob: string,
): Promise<number | null> {
  try {
    const { isEmbeddingAvailable, embedText } = await import('../memory/brain-embedding.js');
    if (!isEmbeddingAvailable()) return null;

    const vecA = incomingVec;
    const vecB = await embedText(candidateBlob);
    if (!vecA || !vecB || vecA.length !== vecB.length) return null;

    // Cosine similarity (assumes unit-norm vectors from embedding model)
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < vecA.length; i++) {
      dot += (vecA[i] ?? 0) * (vecB[i] ?? 0);
      normA += (vecA[i] ?? 0) ** 2;
      normB += (vecB[i] ?? 0) ** 2;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom === 0) return null;
    return Math.max(0, Math.min(1, dot / denom));
  } catch {
    return null;
  }
}

// ============================================================================
// LLM Tier 3 — structured reasoning
// ============================================================================

/**
 * Build the system prompt for the LLM duplicate-detection call.
 */
function buildDuplicateSystemPrompt(): string {
  return [
    'You are a task-management assistant determining whether two software tasks are semantic duplicates.',
    'Respond ONLY with valid JSON matching this schema:',
    '{ "are_duplicate": boolean, "confidence": number (0-1), "distinction": string|null, "suggestion": "merge"|"keep-both"|"block-new" }',
    '',
    'Rules:',
    '- are_duplicate=true when both tasks describe the SAME work deliverable (even if worded differently)',
    '- are_duplicate=false when they target different deliverables, different scopes, or different problem domains',
    '- distinction must be non-null when are_duplicate=false (explain what makes them different)',
    '- suggestion: "merge"=consolidate into one task, "keep-both"=distinct tasks worth tracking separately, "block-new"=new task is redundant',
    '- Do NOT add any explanation outside the JSON object.',
  ].join('\n');
}

/**
 * Build the user prompt for the LLM duplicate-detection call.
 */
function buildDuplicateUserPrompt(
  incomingTitle: string,
  incomingDescription: string,
  candidateTitle: string,
  candidateDescription: string,
  candidateId: string,
): string {
  return [
    `Task A (NEW — being added now):`,
    `  Title: ${incomingTitle}`,
    `  Description: ${incomingDescription || '(no description provided)'}`,
    '',
    `Task B (EXISTING — ${candidateId}):`,
    `  Title: ${candidateTitle}`,
    `  Description: ${candidateDescription || '(no description)'}`,
    '',
    'Are these the same task (semantic duplicate)? Respond with JSON only.',
  ].join('\n');
}

/**
 * Call the daemon LLM to determine whether two tasks are semantic duplicates.
 *
 * Cost cap: max 1 call per `cleo add` invocation (enforced by the caller via
 * a `llmCallMade` flag). Never throws — returns null on error/timeout so the
 * caller can fall back to a Tier-1-only decision.
 *
 * @param incomingTitle - Title of the task being added.
 * @param incomingDescription - Description of the task being added.
 * @param candidate - Best-scoring candidate from Tier 1/2.
 * @param cwd - Project root for credential + config resolution.
 * @returns Structured reasoning result, or null when the call fails/times out.
 * @task T1681
 */
export async function callLlmDuplicateReasoning(
  incomingTitle: string,
  incomingDescription: string,
  candidate: DuplicateCandidate & { description?: string },
  cwd?: string,
): Promise<DuplicateReasoning | null> {
  try {
    const { authHeadersFromSealed } = await import('../llm/credentials.js');
    const { resolveLLMForRole } = await import('../llm/role-resolver.js');

    // T9255: route through the role-based resolver. Duplicate-detection is a
    // consolidation-tier call (LLM acts as the tie-breaker between Tier 1 and
    // Jaccard tiers). The resolver walks `llm.roles.consolidation` →
    // `llm.default` → `llm.daemon` → implicit fallback, preserving the
    // prior `config.llm.daemon.*` defaulting behaviour.
    const llm = await resolveLLMForRole('consolidation', { projectRoot: cwd });
    if (!llm.sealedCredential || !llm.credential) {
      // No credentials — skip LLM tier silently
      return null;
    }

    const systemPrompt = buildDuplicateSystemPrompt();
    const userPrompt = buildDuplicateUserPrompt(
      incomingTitle,
      incomingDescription,
      candidate.title,
      candidate.description ?? '',
      candidate.id,
    );

    // E10 (T11754 · AC2): build the OAuth wire headers DIRECTLY from the sealed
    // handle — `authHeadersFromSealed` invokes fetch() internally and the
    // plaintext never escapes it. The SDK `apiKey` field (the sanctioned
    // SDK-client path) still needs the materialized token, taken once here and
    // let go out of scope after the call.
    // For OAuth credentials, attach the Bearer headers via extraHeaders so the
    // registry constructs the SDK with `authToken` instead of `apiKey` (avoids
    // the 401 from `x-api-key`).
    const modelConfig = {
      transport: llm.provider,
      model: llm.model,
      apiKey: (await llm.sealedCredential.fetch()).value,
      extraHeaders:
        llm.credential.authType === 'oauth'
          ? await authHeadersFromSealed(llm.sealedCredential, llm.credential.authType)
          : undefined,
    };

    const { cleoLlmCall } = await import('../llm/api.js');

    // Race against timeout to prevent blocking cleo add
    const callPromise = cleoLlmCall({
      modelConfig,
      prompt: userPrompt,
      maxTokens: 256,
      jsonMode: true,
      temperature: 0,
      enableRetry: false,
      messages: [{ role: 'system', content: systemPrompt }],
    });

    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), LLM_TIMEOUT_MS);
    });

    const result = await Promise.race([callPromise, timeoutPromise]);
    if (!result) return null;

    // Extract content from the response
    const responseContent =
      typeof result === 'object' && result !== null && 'content' in result
        ? (result as { content: unknown }).content
        : null;

    if (!responseContent) return null;

    // Parse JSON response
    let parsed: unknown;
    if (typeof responseContent === 'string') {
      try {
        parsed = JSON.parse(responseContent);
      } catch {
        // Try to extract JSON from the response
        const jsonMatch = /\{[\s\S]*\}/.exec(responseContent);
        if (!jsonMatch) return null;
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {
          return null;
        }
      }
    } else if (typeof responseContent === 'object') {
      parsed = responseContent;
    } else {
      return null;
    }

    const validation = DuplicateReasoningSchema.safeParse(parsed);
    if (!validation.success) return null;

    return validation.data;
  } catch {
    // LLM call errors always fall back to a Tier-1-only decision
    return null;
  }
}

// ============================================================================
// Tier 3 — batched System One decision (T12492)
// ============================================================================

/** One Tier-2-ambiguous candidate offered to the decision. */
interface DecisionCandidate {
  /** The candidate task. */
  task: Task;
  /** Tier-1 score (the one the heuristic fallback acts on). */
  tier1Score: number;
  /** Tier-2 word-Jaccard score. */
  jaccardScore: number;
}

/** Resolved System One settings for one check. */
interface DuplicateDecisionSettings {
  mode: DuplicateDecisionMode;
  llmTier: boolean;
}

/** The decision's verdict, when a provider (or its cache) answered. */
interface DuplicateDecisionVerdict {
  /** Candidates the decision judged to be duplicates, highest probability first. */
  duplicates: DuplicateCandidate[];
  /** Highest duplicate probability across all candidates. */
  maxProbability: number;
}

/** Clip `text` to `max` characters, marking the cut. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function isDecisionMode(value: unknown): value is DuplicateDecisionMode {
  return value === 'off' || value === 'shadow' || value === 'on';
}

/**
 * Resolve the System One mode and the generative-tier opt-in.
 *
 * Unconfigured (no explicit provider/connection and nothing stored by
 * `cleo decide config`) always resolves to `off`, whatever the config says,
 * so an unconfigured `cleo add` never opens a socket.
 */
async function resolveDuplicateDecisionSettings(
  opts: DuplicateCheckOptions,
  cwd: string | undefined,
): Promise<DuplicateDecisionSettings> {
  const wiring = opts.decide ?? {};
  let configured: boolean;
  if (wiring.provider) {
    configured = true;
  } else if (wiring.connection !== undefined) {
    configured = wiring.connection !== null && wiring.connection.apiKey.trim() !== '';
  } else {
    try {
      const { loadDecideConnection } = await import('../decide/credentials.js');
      configured = loadDecideConnection() !== null;
    } catch {
      configured = false;
    }
  }

  const needConfig = (configured && opts.mode === undefined) || opts.llmTier === undefined;
  let configMode: unknown;
  let configLlmTier: unknown;
  if (needConfig) {
    try {
      const { getConfigValue } = await import('../config/registry.js');
      const { getProjectRoot } = await import('../paths.js');
      const projectRoot = cwd ?? getProjectRoot();
      [configMode, configLlmTier] = await Promise.all([
        getConfigValue(DUPLICATE_DECISION_MODE_KEY, { projectRoot }),
        getConfigValue(DUPLICATE_LLM_TIER_KEY, { projectRoot }),
      ]);
    } catch {
      // Unreadable config → defaults.
    }
  }

  const mode: DuplicateDecisionMode = !configured
    ? 'off'
    : (opts.mode ?? (isDecisionMode(configMode) ? configMode : 'shadow'));
  return { mode, llmTier: opts.llmTier ?? configLlmTier === true };
}

/** Question name for the candidate at `index` (0-based). */
function questionName(index: number): string {
  return `c${index + 1}`;
}

/**
 * Build ONE decision request: the new task plus up to {@link MAX_CANDIDATES}
 * candidates as structured state, and one noul question per candidate.
 */
function buildDuplicateDecisionRequest(
  title: string,
  description: string,
  candidates: readonly DecisionCandidate[],
): DecisionRequest {
  const state: Record<string, { id?: string; title: string; description: string }> = {
    new: {
      title: clip(title, DECISION_TITLE_MAX_CHARS),
      description: clip(description, DECISION_DESCRIPTION_MAX_CHARS),
    },
  };
  const questions: Record<string, DecisionQuestion> = {};
  candidates.forEach((c, i) => {
    const name = questionName(i);
    state[name] = {
      id: c.task.id,
      title: clip(c.task.title, DECISION_TITLE_MAX_CHARS),
      description: clip(c.task.description ?? '', DECISION_DESCRIPTION_MAX_CHARS),
    };
    questions[name] = {
      type: 'noul',
      criteria: `The "new" task describes the same work deliverable as task "${name}" (a semantic duplicate, even if worded differently), not a different scope, deliverable or problem.`,
    };
  });
  return { state, questions };
}

/**
 * The heuristic's answer for one candidate, as a noul answer.
 *
 * The Tier-1 score is rescaled so {@link DUPLICATE_REJECT_THRESHOLD} maps to
 * probability 0.5 — `value` is then exactly "the heuristic would reject".
 * Confidence is a flat 0.5: the heuristic carries no calibration of its own.
 */
function heuristicAnswer(c: DecisionCandidate): DecisionAnswer {
  const probability = Math.min(1, (c.tier1Score * 0.5) / DUPLICATE_REJECT_THRESHOLD);
  return { type: 'noul', value: probability >= 0.5, probability, confidence: 0.5 };
}

/**
 * Ask System One whether any candidate duplicates the new task.
 *
 * Never throws and never waits longer than {@link DUPLICATE_DECISION_BUDGET_MS}
 * (`decide()` enforces the remaining budget as its deadline). The audit line
 * carries the heuristic answers and verdict next to the decision answers.
 *
 * @returns The decision verdict, or `null` when the heuristic answered (fallback).
 */
async function askDuplicateDecision(
  title: string,
  description: string,
  candidates: readonly DecisionCandidate[],
  heuristicVerdict: string,
  mode: 'shadow' | 'on',
  opts: DuplicateCheckOptions,
  cwd: string | undefined,
): Promise<DuplicateDecisionVerdict | null> {
  const started = performance.now();
  const deadline = AbortSignal.timeout(DUPLICATE_DECISION_BUDGET_MS);
  try {
    const { decide } = await import('../decide/client.js');
    const { auditAnswers, createJsonlDecisionAudit } = await import('../decide/audit.js');

    const req = buildDuplicateDecisionRequest(title, description, candidates);
    const heuristicAnswers: Record<string, DecisionAnswer> = {};
    const subjects: Record<string, string> = {};
    candidates.forEach((c, i) => {
      heuristicAnswers[questionName(i)] = heuristicAnswer(c);
      subjects[questionName(i)] = c.task.id;
    });
    const heuristicAudit = auditAnswers({
      answers: heuristicAnswers,
      source: 'fallback',
      latencyMs: 0,
    });

    const wiring = opts.decide ?? {};
    let sink = wiring.audit;
    if (sink === undefined) {
      try {
        const { getProjectRoot } = await import('../paths.js');
        sink = createJsonlDecisionAudit(wiring.projectRoot ?? cwd ?? getProjectRoot());
      } catch {
        sink = null;
      }
    }
    const base = sink;
    const audit = base
      ? {
          write: (entry: Parameters<typeof base.write>[0]): void => {
            const answered = entry.source !== 'fallback';
            base.write({
              ...entry,
              shadow: {
                mode,
                acted: mode === 'on' && answered ? 'decision' : 'heuristic',
                heuristicVerdict,
                heuristicAnswers: heuristicAudit,
                agree: answered
                  ? Object.entries(entry.answers).every(
                      ([name, a]) => a.value === heuristicAnswers[name]?.value,
                    )
                  : null,
                subjects,
              },
            });
          },
        }
      : null;

    // `decide()` starts its own deadline only after its setup (connection,
    // redaction, validation). The abort signal pins the budget to THIS
    // function's start, so that setup is inside it too.
    const remaining = Math.max(0, DUPLICATE_DECISION_BUDGET_MS - (performance.now() - started));
    const outcome = await decide(DUPLICATE_DECISION_SITE, req, () => heuristicAnswers, {
      ...wiring,
      audit,
      timeoutMs: Math.min(wiring.timeoutMs ?? remaining, remaining),
      signal: wiring.signal ? AbortSignal.any([wiring.signal, deadline]) : deadline,
    });
    if (outcome.source === 'fallback') return null;

    const duplicates: DuplicateCandidate[] = [];
    let maxProbability = 0;
    candidates.forEach((c, i) => {
      const answer = outcome.answers[questionName(i)];
      if (answer?.type !== 'noul') return;
      maxProbability = Math.max(maxProbability, answer.probability);
      if (answer.value) {
        duplicates.push({ id: c.task.id, title: c.task.title, score: answer.probability });
      }
    });
    duplicates.sort((a, b) => b.score - a.score);
    return { duplicates, maxProbability };
  } catch {
    return null;
  }
}

// ============================================================================
// Main Check
// ============================================================================

/**
 * Check whether the incoming task's title and description are similar to any
 * active task in the database using three-tier escalation (T1681).
 *
 * Algorithm:
 *
 * Tier 1 — lexical or vector similarity (per candidate):
 *   For each active task, compute vector cosine similarity (if embedding is available)
 *   Jaccard over character trigrams, or cosine over embeddings when a provider is loaded.
 *   - score >= DUPLICATE_REJECT_THRESHOLD (0.92): clear match → reject immediately.
 *   - score < TIER1_ESCALATE_LOW (0.50): clear different → skip Tier 2 + 3 for this candidate.
 *   - score in [0.50, 0.92): ambiguous → collect for Tier-2 Jaccard evaluation.
 *
 * Tier 2 — Jaccard word n-grams (title+description+labels):
 *   For candidates that were ambiguous in Tier 1, compute Jaccard over word-level n-grams.
 *   Labels are included to surface tag-level similarity that character trigrams miss.
 *   - score >= JACCARD_REJECT_THRESHOLD (0.85): reject.
 *   - score < JACCARD_ESCALATE_LOW (0.40): clear different → skip LLM.
 *   - score in [0.40, 0.85): ambiguous → escalate to LLM (cost cap: 1 call per invocation).
 *
 * Tier 3 — System One, then the opt-in generative LLM (T12492):
 *   One `decide()` request with up to 3 candidates as noul questions, bounded by
 *   DUPLICATE_DECISION_BUDGET_MS. `shadow` audits it and acts on the heuristic; `on`
 *   acts on it. Then, only when `decide.generativeFallback.duplicateDetection` is true,
 *   the T1681 LLM call (max 1). On any failure: the Tier-1 decision (never block).
 *
 * @param title - Title of the task being added.
 * @param description - Description of the task being added (empty string if not provided).
 * @param accessor - DataAccessor instance to load active tasks from.
 * @param labels - Labels of the task being added (empty array if not provided).
 * @param cwd - Project root for LLM credential resolution (Tier 3).
 * @param options - System One mode, generative-tier opt-in and `decide()` wiring (T12492).
 * @returns Duplicate check result with tier provenance.
 * @task T1633
 * @task T1681
 * @task T12492
 */
export async function checkDuplicates(
  title: string,
  description: string,
  accessor: DataAccessor,
  labels?: string[],
  cwd?: string,
  options: DuplicateCheckOptions = {},
): Promise<DuplicateCheckResult> {
  const incomingLabels = labels ?? [];

  // Load non-terminal tasks: pending, active, and blocked are all "active work"
  // that could duplicate the incoming task.
  const { tasks: activeTasks } = await accessor.queryTasks({
    status: ['pending', 'active', 'blocked'],
    limit: MAX_ACTIVE_TASKS_SCAN,
  });

  if (activeTasks.length === 0) {
    return { maxScore: 0, candidates: [], shouldReject: false, shouldWarn: false, tier: 'bm25' };
  }

  const incomingBlob = buildSearchBlob(title, description);
  const embeddingEnabled = await (async () => {
    try {
      const { isEmbeddingAvailable } = await import('../memory/brain-embedding.js');
      return isEmbeddingAvailable();
    } catch {
      return false;
    }
  })();

  // Embed the incoming blob ONCE for the whole check. This used to happen inside
  // `tryVectorSimilarity`, which runs once per candidate — so a store with 1,126
  // active tasks embedded the same incoming text 1,126 times per `cleo add`.
  // `null` here simply means every candidate uses the lexical measure.
  const incomingVec = embeddingEnabled ? await embedIncomingOnce(incomingBlob) : null;

  // ---- Tier 1: lexical or vector --------------------------------------------
  // Candidates that need Tier-2 Jaccard evaluation (Tier-1 ambiguous range).
  // Map: candidate → tier1Score
  const tier1Ambiguous: Array<{ task: Task; tier1Score: number }> = [];

  // Clear-match candidates (tier1 >= DUPLICATE_REJECT_THRESHOLD or >= DUPLICATE_WARN_THRESHOLD)
  const clearMatchCandidates: DuplicateCandidate[] = [];

  // T12117: bound the vector tier. Exceeding either budget degrades the
  // remaining candidates to the lexical score — the same path taken when
  // embeddings are unavailable — rather than extending the write.
  let vectorBudget = MAX_VECTOR_CANDIDATES;
  const vectorDeadline = Date.now() + VECTOR_PHASE_BUDGET_MS;

  for (const task of activeTasks) {
    // Do not compare a task with itself (e.g. if being re-added after creation)
    if (task.title === title) {
      // Exact title match → treat as lexical 1.0 only when description also matches
      if ((task.description ?? '') === description) continue; // will be caught by findRecentDuplicate
    }

    const candidateBlob = buildSearchBlob(task.title, task.description ?? '');

    let tier1Score: number;
    // Both bounds apply. #1258 caps the vector phase by COUNT and DEADLINE so a
    // large store cannot stall a write; this branch additionally passes the
    // PRE-COMPUTED incoming vector, so the incoming blob is embedded once for
    // the whole check rather than once per candidate. `incomingVec` is non-null
    // only when embedding is available, so it subsumes the old
    // `embeddingEnabled` test.
    if (incomingVec && vectorBudget > 0 && Date.now() < vectorDeadline) {
      vectorBudget--;
      const vecScore = await tryVectorSimilarity(incomingVec, candidateBlob);
      tier1Score =
        vecScore ??
        computeLexicalSimilarity(title, description, task.title, task.description ?? '');
    } else {
      tier1Score = computeLexicalSimilarity(title, description, task.title, task.description ?? '');
    }

    if (tier1Score >= DUPLICATE_REJECT_THRESHOLD) {
      // Clear match — reject without escalating
      clearMatchCandidates.push({ id: task.id, title: task.title, score: tier1Score });
    } else if (tier1Score >= TIER1_ESCALATE_LOW) {
      // Ambiguous — collect for Tier 2
      tier1Ambiguous.push({ task, tier1Score });
      // Also surface in warn range (>= DUPLICATE_WARN_THRESHOLD) even before Tier 2
      if (tier1Score >= DUPLICATE_WARN_THRESHOLD) {
        clearMatchCandidates.push({ id: task.id, title: task.title, score: tier1Score });
      }
    }
    // tier1Score < TIER1_ESCALATE_LOW → clear different, skip
  }

  // If we already have a clear-match reject, return immediately (Tier-1-only path).
  if (clearMatchCandidates.some((c) => c.score >= DUPLICATE_REJECT_THRESHOLD)) {
    const sorted = clearMatchCandidates
      .filter((c) => c.score >= DUPLICATE_REJECT_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CANDIDATES);
    return {
      maxScore: sorted[0]?.score ?? 0,
      candidates: sorted,
      shouldReject: true,
      shouldWarn: false,
      tier: 'bm25',
    };
  }

  // ---- Tier 2: Jaccard word n-grams -----------------------------------------
  // For each Tier-1 ambiguous candidate, compute Jaccard with labels.
  // Candidates that are still ambiguous after Tier 2 collect for LLM escalation.

  const tier2Ambiguous: Array<{ task: Task; jaccardScore: number }> = [];
  const tier2Candidates: DuplicateCandidate[] = [];

  for (const { task, tier1Score: _tier1 } of tier1Ambiguous) {
    const jScore = computeJaccardWordSimilarity(
      title,
      description,
      incomingLabels,
      task.title,
      task.description ?? '',
      task.labels ?? [],
    );

    if (jScore >= JACCARD_REJECT_THRESHOLD) {
      // Jaccard says: reject
      tier2Candidates.push({ id: task.id, title: task.title, score: jScore });
    } else if (jScore >= JACCARD_ESCALATE_LOW) {
      // Jaccard also ambiguous — collect for LLM
      tier2Ambiguous.push({ task, jaccardScore: jScore });
    }
    // jScore < JACCARD_ESCALATE_LOW → clear different, skip
  }

  // If Tier 2 produced a reject, return immediately.
  if (tier2Candidates.length > 0) {
    const sorted = tier2Candidates.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
    const maxScore = sorted[0]?.score ?? 0;
    return {
      maxScore,
      candidates: sorted,
      shouldReject: true,
      shouldWarn: false,
      tier: 'jaccard',
    };
  }

  // ---- Tier 3: System One decision, then the opt-in generative LLM ---------
  // Riskiest candidates first. The heuristic verdict below is what the
  // existing path does when no model answers: warn on a Tier-1 warn-zone
  // score, otherwise insert. It is what `shadow` acts on.

  if (tier2Ambiguous.length > 0) {
    tier2Ambiguous.sort((a, b) => b.jaccardScore - a.jaccardScore);
    const tier1Of = (id: string): number | undefined =>
      tier1Ambiguous.find((e) => e.task.id === id)?.tier1Score;
    const decisionCandidates: DecisionCandidate[] = tier2Ambiguous
      .slice(0, MAX_CANDIDATES)
      .map(({ task, jaccardScore }) => ({
        task,
        jaccardScore,
        tier1Score: tier1Of(task.id) ?? jaccardScore,
      }));
    const topCandidate = tier2Ambiguous[0]!;

    // Tier-1-only fallback for the top candidate. The Tier-1 score is in
    // [0.5, 0.92), so it warns only when >= DUPLICATE_WARN_THRESHOLD.
    const fallbackScore = tier1Of(topCandidate.task.id) ?? topCandidate.jaccardScore;
    const heuristicResult: DuplicateCheckResult | null =
      fallbackScore >= DUPLICATE_WARN_THRESHOLD
        ? {
            maxScore: fallbackScore,
            candidates: [
              { id: topCandidate.task.id, title: topCandidate.task.title, score: fallbackScore },
            ],
            shouldReject: false,
            shouldWarn: true,
            tier: 'bm25',
          }
        : null;

    const settings = await resolveDuplicateDecisionSettings(options, cwd);

    if (settings.mode !== 'off') {
      const verdict = await askDuplicateDecision(
        title,
        description,
        decisionCandidates,
        heuristicResult ? 'warn' : 'insert',
        settings.mode,
        options,
        cwd,
      );
      if (settings.mode === 'on' && verdict !== null) {
        if (verdict.duplicates.length > 0) {
          return {
            maxScore: verdict.duplicates[0]?.score ?? 0,
            candidates: verdict.duplicates,
            shouldReject: true,
            shouldWarn: false,
            tier: 'decision',
          };
        }
        return {
          maxScore: topCandidate.jaccardScore,
          candidates: [],
          shouldReject: false,
          shouldWarn: false,
          tier: 'decision',
        };
      }
    }

    // Generative LLM tier (T1681) — opt-in, max 1 call per invocation.
    if (settings.llmTier) {
      const reasoning = await callLlmDuplicateReasoning(
        title,
        description,
        {
          id: topCandidate.task.id,
          title: topCandidate.task.title,
          score: topCandidate.jaccardScore,
          description: topCandidate.task.description ?? '',
        },
        cwd,
      );

      if (reasoning !== null) {
        if (reasoning.are_duplicate) {
          const candidate: DuplicateCandidate = {
            id: topCandidate.task.id,
            title: topCandidate.task.title,
            score: reasoning.confidence,
          };
          return {
            maxScore: reasoning.confidence,
            candidates: [candidate],
            shouldReject: true,
            shouldWarn: false,
            tier: 'llm',
          };
        }
        // LLM says not duplicate — insert without rejection
        return {
          maxScore: topCandidate.jaccardScore,
          candidates: [],
          shouldReject: false,
          shouldWarn: false,
          tier: 'llm',
        };
      }
    }

    // No model answer acted on — the Tier-1-only decision.
    if (heuristicResult) return heuristicResult;
  }

  // ---- Collect any Tier-1 warn-zone candidates (non-rejecting) --------------
  const warnCandidates = clearMatchCandidates
    .filter((c) => c.score >= DUPLICATE_WARN_THRESHOLD && c.score < DUPLICATE_REJECT_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES);

  if (warnCandidates.length > 0) {
    return {
      maxScore: warnCandidates[0]?.score ?? 0,
      candidates: warnCandidates,
      shouldReject: false,
      shouldWarn: true,
      tier: 'bm25',
    };
  }

  return { maxScore: 0, candidates: [], shouldReject: false, shouldWarn: false, tier: 'bm25' };
}

/**
 * Format a human-readable candidate list for warning/rejection messages.
 *
 * @param candidates - Array of duplicate candidates.
 * @returns Formatted multi-line string listing candidates.
 */
export function formatCandidateList(candidates: DuplicateCandidate[]): string {
  return candidates
    .map((c) => `  • ${c.id}: "${c.title}" (similarity: ${(c.score * 100).toFixed(0)}%)`)
    .join('\n');
}

/**
 * Build a warning message for candidates above the warn threshold.
 *
 * @param candidates - Candidates to include in the message.
 * @returns Warning string (no newline at end).
 */
export function buildWarnMessage(candidates: DuplicateCandidate[]): string {
  return (
    `[BRAIN duplicate-check] Similar active tasks found (score >= ${Math.round(DUPLICATE_WARN_THRESHOLD * 100)}%):\n` +
    formatCandidateList(candidates) +
    `\nUse --force-duplicate to bypass this warning if the task is intentionally different.`
  );
}

/**
 * Build a rejection message for candidates above the reject threshold.
 *
 * @param candidates - Candidates to include in the message.
 * @returns Rejection string (no newline at end).
 */
export function buildRejectMessage(candidates: DuplicateCandidate[]): string {
  return (
    `[BRAIN duplicate-check] Task creation REJECTED — very similar active tasks found (score >= ${Math.round(DUPLICATE_REJECT_THRESHOLD * 100)}%):\n` +
    formatCandidateList(candidates) +
    `\nRun with --force-duplicate to bypass (audited to .cleo/audit/duplicate-bypass.jsonl).`
  );
}

/**
 * Load active tasks from the data accessor, restricted to non-terminal statuses.
 * Exported for testing purposes.
 *
 * @param accessor - DataAccessor to query.
 * @returns Array of non-terminal tasks (pending, active, blocked).
 */
export async function loadActiveTasks(accessor: DataAccessor): Promise<Task[]> {
  const { tasks } = await accessor.queryTasks({
    status: ['pending', 'active', 'blocked'],
    limit: MAX_ACTIVE_TASKS_SCAN,
  });
  return tasks;
}

/**
 * Total wall-clock budget for duplicate detection on the write path, in ms.
 *
 * Detection is three tiers deep and two of them can call out of process (local
 * embeddings, then an LLM). Each has its own bound, but "bounded individually"
 * is not "bounded in aggregate" — and this runs BEFORE the row is inserted.
 */
const DUPLICATE_CHECK_BUDGET_MS = 20_000;

/** Env var overriding {@link DUPLICATE_CHECK_BUDGET_MS}. */
export const DUPLICATE_CHECK_BUDGET_ENV = 'CLEO_DUPLICATE_CHECK_BUDGET_MS';

/**
 * Resolve the duplicate-detection budget, honouring an operator override.
 *
 * @param env - environment to read the override from.
 * @returns budget in ms; the default when unset or malformed.
 */
export function resolveDuplicateCheckBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env[DUPLICATE_CHECK_BUDGET_ENV] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DUPLICATE_CHECK_BUDGET_MS;
}

/**
 * {@link checkDuplicates} with a hard deadline and a fail-OPEN result.
 *
 * ## Why fail open (T12117 · issue #1244)
 *
 * Duplicate detection runs before the insert, so anything that stalls it
 * doesn't slow the write down — it *loses* it. Reported from the field: three
 * `cleo add` attempts at 280 s each, none of which created a row, on a host
 * under memory pressure. No error, no id, no task. A silent write failure is
 * the worst failure mode a task tracker has, because the agent that filed the
 * task believes the work is recorded.
 *
 * It is also silent in the dangerous direction relative to CLEO's documented
 * recovery advice. A killed mutation is supposed to mean "query before
 * retrying — the write has usually landed", which was independently confirmed
 * true for a timeout-killed write. But these writes had NOT landed, and nothing
 * in the output distinguishes the two cases. An agent following the contract
 * correctly reaches the wrong conclusion in one direction or the other.
 *
 * So: the row is the product, detection is enrichment. When the budget is
 * blown, report that on stderr and let the insert proceed. A duplicate that
 * slips through is recoverable by a human in seconds; a task that was never
 * created is lost work nobody knows to look for.
 *
 * @param args - forwarded verbatim to {@link checkDuplicates}.
 * @returns the real verdict, or a permissive one when the budget was exceeded.
 *
 * @task T12117
 */
export async function checkDuplicatesBounded(
  ...args: Parameters<typeof checkDuplicates>
): Promise<DuplicateCheckResult & { timedOut: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const budgetMs = resolveDuplicateCheckBudgetMs();

  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
    // Must not hold the CLI's event loop open on its own.
    timer.unref();
  });

  try {
    const verdict = await Promise.race([checkDuplicates(...args), timeout]);

    if (verdict === null) {
      process.stderr.write(
        `cleo: duplicate detection exceeded ${budgetMs}ms and was skipped; ` +
          `creating the task anyway. Run 'cleo find' to check for duplicates.\n`,
      );
      return {
        maxScore: 0,
        candidates: [],
        shouldReject: false,
        shouldWarn: false,
        tier: 'bm25',
        timedOut: true,
      };
    }

    return { ...verdict, timedOut: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
