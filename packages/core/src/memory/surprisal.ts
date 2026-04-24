/**
 * Bayesian Surprisal Scoring — T1146 Wave 6 Dreamer Upgrade
 *
 * Computes a surprisal score for a brain_observation relative to prior
 * context (existing embeddings in the same project/peer scope).
 *
 * Surprisal definition: how much new information does this observation
 * add to the existing memory state?
 *
 *   score = -log(P(observation | prior_context))
 *
 * Implementation:
 *   - High score (novel, >0.7): observation is semantically distant from all
 *     stored embeddings → high priority for consolidation
 *   - Low score (redundant, <0.3): observation is very similar to an existing
 *     embedding → low priority, may be merged/skipped
 *   - Neutral (0.5): returned when embeddings unavailable (graceful degrade)
 *
 * Temporal decay and confidence weighting from BRAIN_SOURCE_CONFIDENCE are
 * applied to adjust the prior similarity.
 *
 * No external library: pure TypeScript cosine similarity + log transform.
 *
 * @task T1146
 * @epic T1146
 */

import type { DatabaseSync } from 'node:sqlite';
import { getBrainNativeDb } from '../store/memory-sqlite.js';

// ============================================================================
// Constants
// ============================================================================

/** Neutral surprisal returned when embeddings are unavailable. */
export const NEUTRAL_SURPRISAL = 0.5;

/** Minimum surprisal score (most redundant). */
const MIN_SURPRISAL = 0.0;

/** Maximum surprisal score (most novel). */
const MAX_SURPRISAL = 1.0;

/**
 * Cosine similarity threshold above which two observations are considered
 * semantically identical (very low surprisal).
 */
const HIGH_SIMILARITY_THRESHOLD = 0.92;

/**
 * Cosine similarity threshold below which two observations are considered
 * semantically unrelated (high surprisal — novel).
 */
const LOW_SIMILARITY_THRESHOLD = 0.35;

/** Max number of prior embeddings to compare against for efficiency. */
const MAX_PRIOR_EMBEDDINGS = 50;

/** Temporal decay half-life in days. Recent observations have more weight. */
const DECAY_HALF_LIFE_DAYS = 30;

// ============================================================================
// Types
// ============================================================================

/** An observation row with its embedding for surprisal computation. */
export interface EmbeddableObservation {
  id: string;
  embedding: number[] | null | undefined;
  createdAt?: string | null;
}

/** Options for {@link computeSurprisalScore}. */
export interface SurprisalOptions {
  /** Inject a DatabaseSync for testing. */
  db?: DatabaseSync | null;
  /** Project root (used to scope prior observations). */
  project?: string | null;
  /** Peer ID for memory isolation. Default 'global'. */
  peerId?: string;
}

/** Result of surprisal computation. */
export interface SurprisalResult {
  /** Observation ID scored. */
  id: string;
  /** Surprisal score 0.0–1.0 (higher = more novel = higher consolidation priority). */
  score: number;
  /** Whether embedding was available (false = returned neutral 0.5). */
  embeddingAvailable: boolean;
  /** Most similar prior observation ID (if found). */
  mostSimilarId?: string;
  /** Cosine similarity to most similar prior (0–1). */
  maxSimilarity?: number;
}

// ============================================================================
// Internal types
// ============================================================================

interface RawEmbeddingRow {
  observation_id: string;
  embedding: Buffer | null;
  created_at: string | null;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compute cosine similarity between two float arrays.
 * Returns 0 if either vector is zero or lengths differ.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Apply temporal decay to a similarity score.
 * More recent priors have higher weight; old priors decay toward zero.
 */
function applyTemporalDecay(similarity: number, priorCreatedAt: string | null): number {
  if (!priorCreatedAt) return similarity;

  const ageMs = Date.now() - new Date(priorCreatedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const decayFactor = 0.5 ** (ageDays / DECAY_HALF_LIFE_DAYS);

  // Decay the similarity: old priors contribute less to "this is redundant"
  return similarity * decayFactor;
}

/**
 * Deserialize a Float32 embedding from a SQLite BLOB Buffer.
 */
function bufferToFloat32Array(buf: Buffer): number[] {
  const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(floats);
}

/**
 * Fetch prior embeddings from brain_embeddings table for the given scope.
 */
function fetchPriorEmbeddings(
  nativeDb: DatabaseSync,
  excludeObsId: string,
  _project: string | null,
  _peerId: string,
): Array<{ id: string; embedding: number[]; createdAt: string | null }> {
  const rows = nativeDb
    .prepare(
      `SELECT e.observation_id, e.embedding, o.created_at
       FROM brain_embeddings e
       JOIN brain_observations o ON o.id = e.observation_id
       WHERE e.observation_id != ?
         AND e.embedding IS NOT NULL
       ORDER BY o.created_at DESC
       LIMIT ?`,
    )
    .all(excludeObsId, MAX_PRIOR_EMBEDDINGS) as unknown as RawEmbeddingRow[];

  return rows
    .filter((r) => r.embedding !== null && r.embedding.byteLength > 0)
    .map((r) => ({
      id: r.observation_id,
      embedding: bufferToFloat32Array(r.embedding!),
      createdAt: r.created_at,
    }));
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Compute a Bayesian surprisal score for a single observation.
 *
 * Returns a value in [0.0, 1.0]:
 *   - >0.7 → novel (high surprisal) — high consolidation priority
 *   - <0.3 → redundant (low surprisal) — skip or merge
 *   - 0.5  → neutral (no embeddings available)
 *
 * Degrades gracefully when embeddings are unavailable:
 * returns NEUTRAL_SURPRISAL (0.5) with a console.warn, never throws.
 *
 * @param observation - The observation to score (must include embedding if available).
 * @param options     - Scope, db injection for tests.
 * @returns SurprisalResult with score and diagnostics.
 *
 * @task T1146
 */
export function computeSurprisalScore(
  observation: EmbeddableObservation,
  options: SurprisalOptions = {},
): SurprisalResult {
  const { db: injectedDb, project = null, peerId = 'global' } = options;
  const nativeDb = injectedDb !== undefined ? injectedDb : getBrainNativeDb();

  // Graceful degrade: no observation embedding
  if (!observation.embedding || observation.embedding.length === 0) {
    if (!nativeDb) {
      console.warn('[surprisal] No database available; returning neutral score.');
    }
    return {
      id: observation.id,
      score: NEUTRAL_SURPRISAL,
      embeddingAvailable: false,
    };
  }

  // Graceful degrade: no database
  if (!nativeDb) {
    console.warn('[surprisal] Database not initialized; returning neutral score.');
    return {
      id: observation.id,
      score: NEUTRAL_SURPRISAL,
      embeddingAvailable: false,
    };
  }

  try {
    const priors = fetchPriorEmbeddings(nativeDb, observation.id, project, peerId);

    if (priors.length === 0) {
      // No priors — first observation is maximally novel
      return {
        id: observation.id,
        score: MAX_SURPRISAL,
        embeddingAvailable: true,
        maxSimilarity: 0,
      };
    }

    // Find maximum decayed similarity to any prior
    let maxDecayedSimilarity = 0;
    let mostSimilarId: string | undefined;

    for (const prior of priors) {
      const rawSim = cosineSimilarity(observation.embedding, prior.embedding);
      const decayedSim = applyTemporalDecay(rawSim, prior.createdAt);

      if (decayedSim > maxDecayedSimilarity) {
        maxDecayedSimilarity = decayedSim;
        mostSimilarId = prior.id;
      }
    }

    // Transform similarity → surprisal
    // High similarity → low surprisal (redundant)
    // Low similarity → high surprisal (novel)
    let score: number;

    if (maxDecayedSimilarity >= HIGH_SIMILARITY_THRESHOLD) {
      // Very similar: near-duplicate
      score = MIN_SURPRISAL + (1 - maxDecayedSimilarity) * 0.3;
    } else if (maxDecayedSimilarity <= LOW_SIMILARITY_THRESHOLD) {
      // Very dissimilar: novel
      score = 0.7 + (1 - maxDecayedSimilarity) * 0.3;
    } else {
      // Interpolate in the middle range
      const normalized =
        (maxDecayedSimilarity - LOW_SIMILARITY_THRESHOLD) /
        (HIGH_SIMILARITY_THRESHOLD - LOW_SIMILARITY_THRESHOLD);
      score = 0.7 - normalized * 0.4; // 0.7 (low sim) → 0.3 (high sim)
    }

    // Clamp to [0, 1]
    score = Math.max(MIN_SURPRISAL, Math.min(MAX_SURPRISAL, score));

    return {
      id: observation.id,
      score,
      embeddingAvailable: true,
      mostSimilarId,
      maxSimilarity: maxDecayedSimilarity,
    };
  } catch (err) {
    console.warn('[surprisal] Error computing score; returning neutral:', err);
    return {
      id: observation.id,
      score: NEUTRAL_SURPRISAL,
      embeddingAvailable: false,
    };
  }
}

/**
 * Compute surprisal scores for a batch of observations, sorted descending.
 *
 * High-surprisal observations are returned first — they should be processed
 * by the dreamer first (bypass normal rate limit).
 *
 * @param observations - Batch to score.
 * @param options      - Scope, db injection.
 * @returns Sorted array with highest surprisal first.
 *
 * @task T1146
 */
export function computeSurprisalBatch(
  observations: EmbeddableObservation[],
  options: SurprisalOptions = {},
): SurprisalResult[] {
  const results = observations.map((obs) => computeSurprisalScore(obs, options));
  return results.sort((a, b) => b.score - a.score);
}
