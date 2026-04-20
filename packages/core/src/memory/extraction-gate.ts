/**
 * Extraction Gate — Verification layer before BRAIN memory storage.
 *
 * Wraps all memory writes with three ordered checks:
 *   A. Content-hash deduplication (always runs — fast, no embedding needed)
 *   B. Cosine similarity deduplication (runs when embedding is available; skipped for trusted sources)
 *   C. Confidence threshold enforcement (always runs)
 *
 * Trusted sources (manual, owner) bypass Check B but still run A and C.
 *
 * Design goals:
 * - NEVER block the primary write path on error — all checks wrapped in try/catch
 * - Degrade gracefully to hash-only dedup when embedding is unavailable
 * - Contradiction detection uses a polarity-flip heuristic (no LLM required)
 *
 * @task T549 Wave 2-A
 * @epic T549
 */

import { createHash } from 'node:crypto';
import type {
  BrainCognitiveType,
  BrainMemoryTier,
  BrainSourceConfidence,
} from '../store/memory-schema.js';
import { isEmbeddingAvailable } from './brain-embedding.js';
import { searchSimilar } from './brain-similarity.js';
import { addGraphEdge } from './graph-auto-populate.js';

// ============================================================================
// Types
// ============================================================================

/**
 * A candidate memory entry produced by the extraction engine or supplied
 * directly by a trusted agent/owner.
 */
export interface MemoryCandidate {
  /** The main text content to store. */
  text: string;
  /** Human-readable label for the entry. Defaults to first 120 chars of text. */
  title?: string;
  /**
   * Cognitive type — determines which BRAIN table receives this entry.
   * Uses BRAIN_COGNITIVE_TYPES vocabulary (semantic/episodic/procedural).
   */
  memoryType: BrainCognitiveType;
  /** Storage tier — determines eviction policy. */
  tier: BrainMemoryTier;
  /**
   * Confidence 0.0–1.0.
   * Below MINIMUM_CONFIDENCE (0.40) sends entry to pending queue.
   */
  confidence: number;
  /** Source pipeline that produced this candidate. */
  source: 'transcript' | 'task-completion' | 'diff' | 'manual' | 'debrief';
  /** Session ID of the originating session (for graph linking). */
  sourceSessionId?: string;
  /**
   * Source reliability level for the memory entry.
   * Manual/owner sources skip similarity check (trusted bypass).
   */
  sourceConfidence?: BrainSourceConfidence;
  /**
   * When true, skip Checks A-B (similarity/contradiction) — only Check C applies.
   * Automatically set for 'manual' source and 'owner'/'task-outcome' sourceConfidence.
   */
  trusted?: boolean;
}

/** Result of passing a candidate through the verification gate. */
export interface GateResult {
  /** What the gate decided. */
  action: 'stored' | 'merged' | 'pending' | 'rejected';
  /**
   * ID of the stored or merged entry.
   * Null when action is 'pending' or 'rejected'.
   */
  id: string | null;
  /** Human-readable explanation of the decision. */
  reason: string;
  /** Cosine distance to the nearest match (when similarity check ran). */
  similarity?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Cosine distance below which two entries are considered exact duplicates. */
const DUPLICATE_THRESHOLD = 0.15;

/** Cosine distance below which two entries are considered closely related. */
const SIMILAR_THRESHOLD = 0.3;

/** Minimum confidence score required to store an entry. */
const MINIMUM_CONFIDENCE = 0.4;

/**
 * Title prefixes that identify known-noise entries (task lifecycle chatter,
 * session scaffolding, evidence bookkeeping, etc.).
 *
 * Check A0 in verifyCandidate rejects any candidate whose title starts with
 * one of these prefixes before any expensive hash/similarity work runs.
 *
 * Ported from brain-purge.ts:207-248 janitor classifier so this becomes the
 * single source of truth. brain-purge.ts should import this const if it needs
 * the same list (follow-on cleanup tracked separately).
 *
 * @task T993
 */
export const BRAIN_NOISE_PREFIXES: readonly string[] = [
  'Task start:',
  'Session note:',
  'Started work on:',
  'Fix evidence:',
  'Verified:',
  'Completed:',
  'Auto-generated:',
] as const;

/**
 * Negation markers used in polarity-flip contradiction detection.
 * A contradiction is signalled when exactly one of two related entries
 * contains one of these markers near shared keyword overlap.
 */
const NEGATION_MARKERS = [
  'not',
  'never',
  'no longer',
  'deprecated',
  'removed',
  'replaced',
  'broken',
  'avoid',
  'do not',
  "don't",
  'invalid',
  'obsolete',
];

// ============================================================================
// Helpers
// ============================================================================

/**
 * Compute a short SHA-256 prefix over the normalised text content.
 * Used for exact-duplicate detection without embedding.
 */
function contentHashPrefix(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * Polarity-flip contradiction heuristic.
 *
 * Returns true when exactly one of the two texts carries a negation marker
 * AND both texts share at least 3 meaningful keywords (>4 chars).
 *
 * This is intentionally approximate — false positives cause a supersede
 * write (safe), false negatives allow a duplicate (harmless, caught later
 * by cosine merge).
 */
function hasContradictingPolarity(existingText: string, newText: string): boolean {
  const existingLower = existingText.toLowerCase();
  const newLower = newText.toLowerCase();

  const existingNegated = NEGATION_MARKERS.some((m) => existingLower.includes(m));
  const newNegated = NEGATION_MARKERS.some((m) => newLower.includes(m));

  // Contradiction: exactly one of the two carries negation
  if (existingNegated === newNegated) return false;

  // Require at least 3 shared meaningful keywords
  const existingWords = new Set(existingLower.split(/\s+/).filter((w) => w.length > 4));
  const newWords = new Set(newLower.split(/\s+/).filter((w) => w.length > 4));
  const overlap = [...newWords].filter((w) => existingWords.has(w));

  return overlap.length >= 3;
}

/**
 * Mark an existing entry as invalid (superseded).
 * Sets the invalid_at column to now on whichever typed table owns the entry.
 *
 * Determined by ID prefix conventions:
 *   D...  → brain_decisions
 *   P...  → brain_patterns
 *   L...  → brain_learnings
 *   O... / CM-... → brain_observations
 */
async function invalidateEntry(projectRoot: string, entryId: string): Promise<void> {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  try {
    const { getBrainNativeDb, getBrainDb } = await import('../store/memory-sqlite.js');
    await getBrainDb(projectRoot);
    const nativeDb = getBrainNativeDb();
    if (!nativeDb) return;

    // Route by ID prefix to correct table
    if (entryId.startsWith('D-') || /^D\d/.test(entryId)) {
      nativeDb
        .prepare('UPDATE brain_decisions SET invalid_at = ? WHERE id = ? AND invalid_at IS NULL')
        .run(now, entryId);
    } else if (entryId.startsWith('P-') || /^P\d/.test(entryId)) {
      nativeDb
        .prepare('UPDATE brain_patterns SET invalid_at = ? WHERE id = ? AND invalid_at IS NULL')
        .run(now, entryId);
    } else if (entryId.startsWith('L-') || /^L\d/.test(entryId)) {
      nativeDb
        .prepare('UPDATE brain_learnings SET invalid_at = ? WHERE id = ? AND invalid_at IS NULL')
        .run(now, entryId);
    } else {
      // O-, O[base36], CM- → observations
      nativeDb
        .prepare('UPDATE brain_observations SET invalid_at = ? WHERE id = ? AND invalid_at IS NULL')
        .run(now, entryId);
    }
  } catch {
    // Best-effort — invalidation failure must not block the primary write
  }
}

/**
 * Increment the citation_count of an existing entry by 1.
 * Routes by the same ID-prefix convention as invalidateEntry.
 */
async function incrementCitationCount(projectRoot: string, entryId: string): Promise<void> {
  try {
    const { getBrainNativeDb, getBrainDb } = await import('../store/memory-sqlite.js');
    await getBrainDb(projectRoot);
    const nativeDb = getBrainNativeDb();
    if (!nativeDb) return;

    if (entryId.startsWith('D-') || /^D\d/.test(entryId)) {
      nativeDb
        .prepare('UPDATE brain_decisions SET citation_count = citation_count + 1 WHERE id = ?')
        .run(entryId);
    } else if (entryId.startsWith('P-') || /^P\d/.test(entryId)) {
      nativeDb
        .prepare('UPDATE brain_patterns SET citation_count = citation_count + 1 WHERE id = ?')
        .run(entryId);
    } else if (entryId.startsWith('L-') || /^L\d/.test(entryId)) {
      nativeDb
        .prepare('UPDATE brain_learnings SET citation_count = citation_count + 1 WHERE id = ?')
        .run(entryId);
    } else {
      nativeDb
        .prepare('UPDATE brain_observations SET citation_count = citation_count + 1 WHERE id = ?')
        .run(entryId);
    }
  } catch {
    // Best-effort
  }
}

/**
 * Tables that support SHA-256 content-hash deduplication (T726 T737).
 *
 * All four typed tables now have a `content_hash` column (added in migration
 * T726 Wave 1A). The table searched is selected by the caller based on the
 * memory type being stored.
 */
export type HashDedupTable =
  | 'brain_observations'
  | 'brain_decisions'
  | 'brain_patterns'
  | 'brain_learnings';

/**
 * Check A: SHA-256 content-hash deduplication for any of the four brain tables.
 *
 * Queries the specified table for a row with a matching content_hash that is
 * still valid (invalid_at IS NULL). When a match is found, returns 'merged'
 * so the caller avoids a duplicate insert and instead increments citation_count
 * on the existing row.
 *
 * T737: Extended from observations-only to all four typed tables. Each table
 * now has the content_hash column (migration 20260416000005_t726-dedup-tier-columns).
 *
 * @param projectRoot - Project root for brain.db access
 * @param table - Which typed table to search
 * @param text - Candidate content text (hashed internally)
 */
async function hashDedupCheck(
  projectRoot: string,
  text: string,
  table: HashDedupTable = 'brain_observations',
): Promise<{ matched: true; id: string } | { matched: false }> {
  try {
    const { getBrainNativeDb, getBrainDb } = await import('../store/memory-sqlite.js');
    await getBrainDb(projectRoot);
    const nativeDb = getBrainNativeDb();
    if (!nativeDb) return { matched: false };

    const hash = contentHashPrefix(text);
    // Permanent dedup — no time window. A hash match means exact duplicate regardless of age.
    const rows = nativeDb
      .prepare(`SELECT id FROM ${table} WHERE content_hash = ? AND invalid_at IS NULL LIMIT 1`)
      .all(hash) as Array<{ id: string }>;

    if (rows.length > 0) {
      return { matched: true, id: rows[0].id };
    }
  } catch {
    // Degrade gracefully — if dedup check fails, allow the write
  }
  return { matched: false };
}

/**
 * Determine whether the candidate is from a trusted source that bypasses
 * the similarity/contradiction checks (Checks B).
 *
 * Trusted: explicit candidate.trusted flag, source='manual', or
 * sourceConfidence='owner' or 'task-outcome'.
 */
function isTrustedSource(candidate: MemoryCandidate): boolean {
  if (candidate.trusted === true) return true;
  if (candidate.source === 'manual') return true;
  if (candidate.sourceConfidence === 'owner' || candidate.sourceConfidence === 'task-outcome') {
    return true;
  }
  return false;
}

/**
 * Public SHA-256 content-hash deduplication check.
 *
 * Exported for use by write paths (llm-extraction.ts, decisions.ts, patterns.ts)
 * that need to run hash dedup before an INSERT without going through the full
 * verifyCandidate gate (T736, T737).
 *
 * @param projectRoot - Project root for brain.db access
 * @param text - Candidate content text (hashed internally)
 * @param table - Which typed table to probe
 */
export async function checkHashDedup(
  projectRoot: string,
  text: string,
  table: HashDedupTable,
): Promise<{ matched: true; id: string } | { matched: false }> {
  return hashDedupCheck(projectRoot, text, table);
}

// ============================================================================
// Core Gate Logic
// ============================================================================

/**
 * Run a MemoryCandidate through the verification gate.
 *
 * Checks (in order):
 *   A0. Title-prefix blocklist (T993) — rejects known-noise titles before any DB work
 *   A. Content-hash deduplication (always; degrades to observations-only when DB unavailable)
 *   B. Cosine similarity deduplication + contradiction detection (skipped for trusted sources)
 *   C. Confidence threshold >= 0.40 (always)
 *
 * The gate NEVER stores the entry itself — it only decides whether the caller
 * should store, merge into an existing entry, queue as pending, or reject.
 *
 * To store after receiving action='stored', call the appropriate storage
 * function (observeBrain, storeLearning, storePattern, storeDecision).
 *
 * @param projectRoot - Project root for brain.db access
 * @param candidate - Candidate to verify
 * @returns GateResult describing what should happen
 */
export async function verifyCandidate(
  projectRoot: string,
  candidate: MemoryCandidate,
): Promise<GateResult> {
  try {
    // -----------------------------------------------------------------------
    // Check A0: Title-prefix blocklist (T993) — fastest possible rejection.
    // Rejects known-noise titles before any hash/similarity work runs.
    // -----------------------------------------------------------------------
    const candidateTitle = candidate.title ?? '';
    if (BRAIN_NOISE_PREFIXES.some((prefix) => candidateTitle.startsWith(prefix))) {
      return { action: 'rejected', id: null, reason: 'noise-prefix' };
    }

    // -----------------------------------------------------------------------
    // Check A: Content-hash dedup (always, fast)
    // T737: Route to the correct typed table based on the candidate's memory type.
    // -----------------------------------------------------------------------
    const dedupTable: HashDedupTable =
      candidate.memoryType === 'semantic'
        ? // semantic defaults to learnings unless the caller routes to decisions
          // (decisions bypass verifyCandidate and call storeDecision directly via
          //  llm-extraction storeExtracted — this branch covers learnings path)
          'brain_learnings'
        : candidate.memoryType === 'procedural'
          ? 'brain_patterns'
          : 'brain_observations'; // episodic → observations

    const hashCheck = await hashDedupCheck(projectRoot, candidate.text, dedupTable);
    if (hashCheck.matched) {
      // Bump citation count on the existing entry (fire-and-forget)
      incrementCitationCount(projectRoot, hashCheck.id).catch(() => undefined);
      return {
        action: 'merged',
        id: hashCheck.id,
        reason: `exact-duplicate (hash match) of ${hashCheck.id}`,
      };
    }

    // -----------------------------------------------------------------------
    // Check B: Cosine similarity + contradiction (skip for trusted sources)
    // -----------------------------------------------------------------------
    const trusted = isTrustedSource(candidate);

    if (!trusted && isEmbeddingAvailable()) {
      try {
        const similar = await searchSimilar(candidate.text, projectRoot, 5);

        if (similar.length > 0) {
          const nearest = similar[0];

          if (nearest.distance < DUPLICATE_THRESHOLD) {
            // Near-identical — merge into existing
            incrementCitationCount(projectRoot, nearest.id).catch(() => undefined);
            return {
              action: 'merged',
              id: nearest.id,
              reason: `near-duplicate of ${nearest.id} (cosine distance=${nearest.distance.toFixed(3)})`,
              similarity: nearest.distance,
            };
          }

          if (nearest.distance < SIMILAR_THRESHOLD) {
            // Related — check for contradiction
            if (hasContradictingPolarity(nearest.text, candidate.text)) {
              // New text supersedes old — invalidate old entry
              await invalidateEntry(projectRoot, nearest.id);

              // Record supersession graph edge (fire-and-forget)
              // Note: we don't have the new entry's ID yet so we'll skip the edge here.
              // The caller should add the supersedes edge after storage using the returned existingId.
              return {
                action: 'stored',
                id: null,
                reason: `contradiction-supersedes ${nearest.id}`,
                similarity: nearest.distance,
              };
            }

            // Similar but not contradicting — store as new (link will be added post-storage)
            return {
              action: 'stored',
              id: null,
              reason: `similar-but-distinct to ${nearest.id} (distance=${nearest.distance.toFixed(3)})`,
              similarity: nearest.distance,
            };
          }
        }
      } catch {
        // Embedding/similarity check failed — degrade to hash-only (already passed above)
      }
    }

    // -----------------------------------------------------------------------
    // Check C: Confidence threshold
    // -----------------------------------------------------------------------
    if (candidate.confidence < MINIMUM_CONFIDENCE) {
      return {
        action: 'pending',
        id: null,
        reason: `confidence ${candidate.confidence.toFixed(2)} below minimum ${MINIMUM_CONFIDENCE}`,
      };
    }

    // All checks passed — caller should store
    return {
      action: 'stored',
      id: null,
      reason: 'verified-new',
    };
  } catch (err) {
    // Safety net: gate errors must never block writes.
    // Log a warning and allow the store to proceed.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[extraction-gate] verifyCandidate error (allowing store): ${message}`);
    return {
      action: 'stored',
      id: null,
      reason: `gate-error-passthrough: ${message}`,
    };
  }
}

/**
 * Run a batch of candidates through the verification gate sequentially.
 *
 * Sequential (not parallel) so that a 'merged' action on an earlier candidate
 * is visible as an existing entry when later candidates run their similarity checks.
 *
 * @param projectRoot - Project root for brain.db access
 * @param candidates - Array of candidates to verify
 * @returns Array of GateResults in input order
 */
export async function verifyBatch(
  projectRoot: string,
  candidates: MemoryCandidate[],
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const candidate of candidates) {
    results.push(await verifyCandidate(projectRoot, candidate));
  }
  return results;
}

// ============================================================================
// Storage Routing
// ============================================================================

/**
 * Store a verified candidate in the appropriate BRAIN table based on memoryType.
 *
 * Routes:
 *   semantic    → brain_learnings  (storeLearning)
 *   episodic    → brain_observations (observeBrain)
 *   procedural  → brain_patterns   (storePattern)
 *
 * Called only after verifyCandidate returns action='stored'.
 *
 * @param projectRoot - Project root for brain.db access
 * @param candidate - Verified candidate to store
 * @returns ID of the newly created entry
 */
export async function storeVerifiedCandidate(
  projectRoot: string,
  candidate: MemoryCandidate,
): Promise<string> {
  const title = candidate.title ?? candidate.text.slice(0, 120);

  switch (candidate.memoryType) {
    case 'semantic': {
      const { storeLearning } = await import('./learnings.js');
      // T992: _skipGate=true prevents re-entry into verifyAndStore (gate already ran above).
      const row = await storeLearning(projectRoot, {
        insight: candidate.text,
        source: candidate.source,
        confidence: candidate.confidence,
        actionable: candidate.source === 'task-completion',
        _skipGate: true,
      });
      return row.id;
    }

    case 'episodic': {
      const { observeBrain } = await import('./brain-retrieval.js');
      // T992: _skipGate=true prevents re-entry into verifyAndStore (gate already ran above).
      const result = await observeBrain(projectRoot, {
        text: candidate.text,
        title,
        sourceSessionId: candidate.sourceSessionId,
        sourceType: candidate.source === 'manual' ? 'manual' : 'agent',
        _skipGate: true,
      });
      return result.id;
    }

    case 'procedural': {
      const { storePattern } = await import('./patterns.js');
      // T992: _skipGate=true prevents re-entry into verifyAndStore (gate already ran above).
      const row = await storePattern(projectRoot, {
        type: 'workflow',
        pattern: candidate.text,
        context: title,
        _skipGate: true,
      });
      return row.id;
    }

    default: {
      // Exhaustive fallback — should never reach here with correct types
      const { observeBrain } = await import('./brain-retrieval.js');
      // T992: _skipGate=true prevents re-entry into verifyAndStore (gate already ran above).
      const result = await observeBrain(projectRoot, {
        text: candidate.text,
        title,
        sourceSessionId: candidate.sourceSessionId,
        sourceType: candidate.source === 'manual' ? 'manual' : 'agent',
        _skipGate: true,
      });
      return result.id;
    }
  }
}

/**
 * Full gate-and-store pipeline for a single candidate.
 *
 * Runs verifyCandidate then calls storeVerifiedCandidate when action='stored'.
 * For 'merged', increments the existing entry's citation_count (already done inside verifyCandidate).
 * For 'pending' and 'rejected', returns the GateResult with no storage.
 *
 * After storage, adds a supersedes edge when the gate returned a contradiction reason.
 *
 * @param projectRoot - Project root for brain.db access
 * @param candidate - Candidate to verify and store
 * @returns Final GateResult with the stored/merged entry ID populated
 */
export async function verifyAndStore(
  projectRoot: string,
  candidate: MemoryCandidate,
): Promise<GateResult> {
  const gateResult = await verifyCandidate(projectRoot, candidate);

  if (gateResult.action !== 'stored') {
    return gateResult;
  }

  try {
    const newId = await storeVerifiedCandidate(projectRoot, candidate);

    // If this was a contradiction supersession, add a graph edge (best-effort)
    if (gateResult.reason.startsWith('contradiction-supersedes ')) {
      const oldId = gateResult.reason.replace('contradiction-supersedes ', '');
      addGraphEdge(
        projectRoot,
        `observation:${newId}`,
        `observation:${oldId}`,
        'supersedes',
        1.0,
        'extraction-gate',
      ).catch(() => undefined);
    }

    return { ...gateResult, id: newId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      action: 'rejected',
      id: null,
      reason: `storage-error: ${message}`,
    };
  }
}

/**
 * Full gate-and-store pipeline for a batch of candidates.
 *
 * Sequential execution ensures that earlier stores are visible to later similarity checks.
 *
 * @param projectRoot - Project root for brain.db access
 * @param candidates - Array of candidates to verify and store
 * @returns Array of final GateResults in input order
 */
export async function verifyAndStoreBatch(
  projectRoot: string,
  candidates: MemoryCandidate[],
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const candidate of candidates) {
    results.push(await verifyAndStore(projectRoot, candidate));
  }
  return results;
}
