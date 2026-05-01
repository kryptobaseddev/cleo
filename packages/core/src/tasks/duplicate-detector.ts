/**
 * BRAIN-powered tiered duplicate-task detection for `cleo add`.
 *
 * Before a new task is inserted, this module queries active tasks and computes
 * similarity between the incoming title+description and each active task.
 *
 * Three-tier escalation (T1681):
 *
 *   Tier 1 — BM25 / vector similarity (current: Jaccard trigrams or cosine):
 *     score >= 0.92 → reject (clear match)
 *     score <  0.50 → insert (clear different)
 *     score in [0.50, 0.92) → escalate to Tier 2
 *
 *   Tier 2 — Jaccard on word-level n-grams (title+description+labels):
 *     score >= 0.85 → reject
 *     score <  0.40 → insert
 *     score in [0.40, 0.85) → escalate to Tier 3 (LLM, paid)
 *
 *   Tier 3 — LLM reasoning (max 1 call per cleo add):
 *     are_duplicate=true  → reject
 *     are_duplicate=false → insert
 *     LLM error / timeout → fall back to BM25-only decision (never block on error)
 *
 * Thresholds (original T1633 behavior preserved for BM25 clear-match path):
 *   BM25 score >= 0.85 → warning emitted to stderr (non-blocking)
 *   BM25 score >= 0.92 → rejected with E_DUPLICATE_TASK_LIKELY
 *
 * @epic T1627
 * @task T1633
 * @task T1681
 */

import type { Task } from '@cleocode/contracts';
import { z } from 'zod';
import type { DataAccessor } from '../store/data-accessor.js';

// ============================================================================
// Thresholds
// ============================================================================

/** BM25 score at which a non-blocking warning is emitted. */
export const DUPLICATE_WARN_THRESHOLD = 0.85;

/** BM25 score at which task creation is rejected (clear match — no escalation). */
export const DUPLICATE_REJECT_THRESHOLD = 0.92;

/**
 * BM25 lower bound for the ambiguous range.
 * Scores below this are considered clear-different and skip Jaccard + LLM.
 */
const BM25_ESCALATE_LOW = 0.5;

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

/** LLM call timeout in milliseconds. */
const LLM_TIMEOUT_MS = 15_000;

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
  tier?: 'bm25' | 'jaccard' | 'llm';
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
// Similarity Primitives — Tier 1 (BM25 proxy)
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
 * and symmetrical. Used as the BM25 proxy in Tier 1.
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
 * This differs from the BM25 blob (which uses character trigrams, no labels).
 *
 * @param title - Task title.
 * @param description - Task description.
 * @param labels - Task labels (empty array if none).
 * @returns Set of word unigrams + bigrams.
 */
function buildWordNgramSet(title: string, description: string, labels: string[]): Set<string> {
  // Title carries 2× weight via repetition (matches BM25 weighting)
  const titleTokens = tokenise(title);
  const descTokens = tokenise(description);
  const labelTokens = labels.flatMap((l) => tokenise(l));

  const allTokens = [...titleTokens, ...titleTokens, ...descTokens, ...labelTokens];
  return wordNgrams(allTokens);
}

/**
 * Compute Jaccard similarity over word-level n-grams including labels.
 * Used as Tier-2 discriminator when BM25 is ambiguous.
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
 * Attempt to compute vector-based similarity for a single active task.
 *
 * Embeds the incoming blob and the candidate task's blob, then computes
 * cosine similarity from the dot product (assuming unit-norm vectors from
 * standard embedding models).
 *
 * Returns `null` when embedding is unavailable (triggers lexical fallback).
 *
 * @param incomingBlob - Normalised search blob for the new task.
 * @param candidateBlob - Normalised search blob for the candidate task.
 * @returns Cosine similarity in [0, 1], or null when unavailable.
 */
async function tryVectorSimilarity(
  incomingBlob: string,
  candidateBlob: string,
): Promise<number | null> {
  try {
    const { isEmbeddingAvailable, embedText } = await import('../memory/brain-embedding.js');
    if (!isEmbeddingAvailable()) return null;

    const [vecA, vecB] = await Promise.all([embedText(incomingBlob), embedText(candidateBlob)]);
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
 * caller can fall back to BM25-only decision.
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
    const { loadConfig } = await import('../config.js');
    const config = await loadConfig(cwd).catch(() => null);

    const daemonProvider = config?.llm?.daemon?.provider ?? 'anthropic';
    const daemonModel = config?.llm?.daemon?.model ?? 'claude-haiku-4-5-20251001';

    const { resolveCredentials } = await import('../llm/credentials.js');
    const cred = resolveCredentials(daemonProvider, {
      projectRoot: cwd,
    });

    if (!cred.apiKey) {
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

    // Build ModelConfig for the daemon provider
    const modelConfig = {
      transport: daemonProvider,
      model: daemonModel,
      apiKey: cred.apiKey,
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
    // LLM call errors always fall back to BM25-only decision
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
 * Tier 1 — BM25 / vector similarity (per candidate):
 *   For each active task, compute vector cosine similarity (if embedding is available)
 *   or Jaccard character-trigram similarity as a proxy. This produces a BM25-like score.
 *   - score >= DUPLICATE_REJECT_THRESHOLD (0.92): clear match → reject immediately.
 *   - score < BM25_ESCALATE_LOW (0.50): clear different → skip Tier 2 + 3 for this candidate.
 *   - score in [0.50, 0.92): ambiguous → collect for Tier-2 Jaccard evaluation.
 *
 * Tier 2 — Jaccard word n-grams (title+description+labels):
 *   For candidates that were ambiguous in Tier 1, compute Jaccard over word-level n-grams.
 *   Labels are included to surface tag-level similarity that character trigrams miss.
 *   - score >= JACCARD_REJECT_THRESHOLD (0.85): reject.
 *   - score < JACCARD_ESCALATE_LOW (0.40): clear different → skip LLM.
 *   - score in [0.40, 0.85): ambiguous → escalate to LLM (cost cap: 1 call per invocation).
 *
 * Tier 3 — LLM reasoning (max 1 call per `cleo add`):
 *   Call the daemon provider with both task descriptions and the structured-output schema.
 *   On error/timeout: fall back to Tier-1 BM25 decision for the candidate (never block).
 *
 * @param title - Title of the task being added.
 * @param description - Description of the task being added (empty string if not provided).
 * @param accessor - DataAccessor instance to load active tasks from.
 * @param labels - Labels of the task being added (empty array if not provided).
 * @param cwd - Project root for LLM credential resolution (Tier 3).
 * @returns Duplicate check result with tier provenance.
 * @task T1633
 * @task T1681
 */
export async function checkDuplicates(
  title: string,
  description: string,
  accessor: DataAccessor,
  labels?: string[],
  cwd?: string,
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

  // ---- Tier 1: BM25 / vector ------------------------------------------------
  // Candidates that need Tier-2 Jaccard evaluation (BM25 ambiguous range).
  // Map: candidate → bm25Score
  const tier1Ambiguous: Array<{ task: Task; bm25Score: number }> = [];

  // Clear-match candidates (bm25 >= DUPLICATE_REJECT_THRESHOLD or >= DUPLICATE_WARN_THRESHOLD)
  const clearMatchCandidates: DuplicateCandidate[] = [];

  for (const task of activeTasks) {
    // Do not compare a task with itself (e.g. if being re-added after creation)
    if (task.title === title) {
      // Exact title match → treat as lexical 1.0 only when description also matches
      if ((task.description ?? '') === description) continue; // will be caught by findRecentDuplicate
    }

    const candidateBlob = buildSearchBlob(task.title, task.description ?? '');

    let bm25Score: number;
    if (embeddingEnabled) {
      const vecScore = await tryVectorSimilarity(incomingBlob, candidateBlob);
      bm25Score =
        vecScore ??
        computeLexicalSimilarity(title, description, task.title, task.description ?? '');
    } else {
      bm25Score = computeLexicalSimilarity(title, description, task.title, task.description ?? '');
    }

    if (bm25Score >= DUPLICATE_REJECT_THRESHOLD) {
      // Clear match — reject without escalating
      clearMatchCandidates.push({ id: task.id, title: task.title, score: bm25Score });
    } else if (bm25Score >= BM25_ESCALATE_LOW) {
      // Ambiguous — collect for Tier 2
      tier1Ambiguous.push({ task, bm25Score });
      // Also surface in warn range (>= DUPLICATE_WARN_THRESHOLD) even before Tier 2
      if (bm25Score >= DUPLICATE_WARN_THRESHOLD) {
        clearMatchCandidates.push({ id: task.id, title: task.title, score: bm25Score });
      }
    }
    // bm25Score < BM25_ESCALATE_LOW → clear different, skip
  }

  // If we already have a clear-match reject, return immediately (BM25-only path).
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

  for (const { task, bm25Score: _bm25 } of tier1Ambiguous) {
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

  // ---- Tier 3: LLM reasoning (max 1 call per invocation) --------------------
  // Pick the single highest-Jaccard ambiguous candidate for the LLM call.
  // Cost cap: only 1 LLM call per `cleo add` invocation.

  if (tier2Ambiguous.length > 0) {
    // Sort by jaccard score descending to pick the riskiest candidate
    tier2Ambiguous.sort((a, b) => b.jaccardScore - a.jaccardScore);
    const topCandidate = tier2Ambiguous[0]!;

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
      // LLM made a decision
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

    // LLM failed/timed out — fall back to BM25-only decision.
    // The BM25 score for the top candidate is in [0.5, 0.92), which means
    // it's in the warn zone only if >= DUPLICATE_WARN_THRESHOLD.
    const bm25Entry = tier1Ambiguous.find((e) => e.task.id === topCandidate.task.id);
    const fallbackScore = bm25Entry?.bm25Score ?? topCandidate.jaccardScore;
    if (fallbackScore >= DUPLICATE_WARN_THRESHOLD) {
      const candidate: DuplicateCandidate = {
        id: topCandidate.task.id,
        title: topCandidate.task.title,
        score: fallbackScore,
      };
      return {
        maxScore: fallbackScore,
        candidates: [candidate],
        shouldReject: false,
        shouldWarn: true,
        tier: 'bm25',
      };
    }
  }

  // ---- Collect any BM25 warn-zone candidates (non-rejecting) ----------------
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
