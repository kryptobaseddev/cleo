/**
 * BRAIN-powered duplicate-task detection for `cleo add`.
 *
 * Before a new task is inserted, this module queries active tasks and computes
 * lexical similarity between the incoming title+description and each active
 * task's title+description. Vector-similarity via BRAIN is used when an
 * embedding provider is available; otherwise lexical Jaccard similarity over
 * normalised trigrams is used as a robust zero-dependency fallback.
 *
 * Thresholds (per task spec T1633):
 *   score >= 0.85 → warning emitted to stderr (non-blocking)
 *   score >= 0.92 → rejected with E_DUPLICATE_TASK_LIKELY
 *
 * @epic T1627
 * @task T1633
 */

import type { Task } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';

// ============================================================================
// Thresholds
// ============================================================================

/** Similarity score at which a non-blocking warning is emitted. */
export const DUPLICATE_WARN_THRESHOLD = 0.85;

/** Similarity score at which task creation is rejected. */
export const DUPLICATE_REJECT_THRESHOLD = 0.92;

/** Maximum active tasks to scan per invocation. Prevents runaway cost on huge task lists. */
const MAX_ACTIVE_TASKS_SCAN = 500;

/** Maximum number of candidates to surface in the warning/rejection message. */
export const MAX_CANDIDATES = 3;

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
}

// ============================================================================
// Similarity Primitives
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
 * and symmetrical.
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
// BRAIN-powered Vector Similarity (opportunistic)
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
// Main Check
// ============================================================================

/**
 * Check whether the incoming task's title and description are similar to any
 * active task in the database.
 *
 * Algorithm:
 * 1. Query active tasks (status: pending | active) limited to MAX_ACTIVE_TASKS_SCAN.
 * 2. For each candidate, compute similarity via:
 *    a. Vector cosine similarity if an embedding provider is registered (BRAIN).
 *    b. Lexical Jaccard trigram similarity as the always-available fallback.
 * 3. Collect candidates above DUPLICATE_WARN_THRESHOLD, sorted by score descending.
 * 4. Return a DuplicateCheckResult describing the overall outcome.
 *
 * @param title - Title of the task being added.
 * @param description - Description of the task being added (empty string if not provided).
 * @param accessor - DataAccessor instance to load active tasks from.
 * @returns Duplicate check result.
 */
export async function checkDuplicates(
  title: string,
  description: string,
  accessor: DataAccessor,
): Promise<DuplicateCheckResult> {
  // Load non-terminal tasks: pending, active, and blocked are all "active work"
  // that could duplicate the incoming task.
  const { tasks: activeTasks } = await accessor.queryTasks({
    status: ['pending', 'active', 'blocked'],
    limit: MAX_ACTIVE_TASKS_SCAN,
  });

  if (activeTasks.length === 0) {
    return { maxScore: 0, candidates: [], shouldReject: false, shouldWarn: false };
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

  const candidates: DuplicateCandidate[] = [];

  for (const task of activeTasks) {
    // Do not compare a task with itself (e.g. if being re-added after creation)
    if (task.title === title) {
      // Exact title match → treat as lexical 1.0 only when description also matches
      if ((task.description ?? '') === description) continue; // will be caught by findRecentDuplicate
    }

    const candidateBlob = buildSearchBlob(task.title, task.description ?? '');

    let score: number;
    if (embeddingEnabled) {
      const vecScore = await tryVectorSimilarity(incomingBlob, candidateBlob);
      score =
        vecScore ??
        computeLexicalSimilarity(title, description, task.title, task.description ?? '');
    } else {
      score = computeLexicalSimilarity(title, description, task.title, task.description ?? '');
    }

    if (score >= DUPLICATE_WARN_THRESHOLD) {
      candidates.push({ id: task.id, title: task.title, score });
    }
  }

  // Sort by score descending, keep top-N
  candidates.sort((a, b) => b.score - a.score);
  const topCandidates = candidates.slice(0, MAX_CANDIDATES);

  const maxScore = topCandidates.length > 0 ? (topCandidates[0]?.score ?? 0) : 0;
  const shouldReject = maxScore >= DUPLICATE_REJECT_THRESHOLD;
  const shouldWarn = maxScore >= DUPLICATE_WARN_THRESHOLD && !shouldReject;

  return { maxScore, candidates: topCandidates, shouldReject, shouldWarn };
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
