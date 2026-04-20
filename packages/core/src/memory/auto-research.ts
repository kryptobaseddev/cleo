/**
 * Auto-research mining from ingested transcripts (T1002).
 *
 * Analyses rows in brain_transcript_events to:
 *  1. Detect thrash patterns — recurring failure messages across sessions.
 *  2. Identify golden-path patterns — sequences that consistently precede
 *     successful outcomes.
 *  3. Flag top-N topics as candidates for observation promotion.
 *
 * This module does NOT write to brain_observations or brain_patterns directly.
 * It returns structured findings for the caller (transcript-ingestor.ts) to
 * decide what to promote via Lead B's T1001 promotion pattern.
 *
 * @task T1002
 * @epic T1000
 */

import type { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A recurring failure pattern detected across sessions. */
export interface ThrashPattern {
  /** Normalised error message or topic that recurs. */
  topic: string;
  /** Number of sessions in which this topic appeared. */
  sessionCount: number;
  /** Total occurrences across all sessions. */
  totalOccurrences: number;
}

/** A topic that appears frequently and may be worth promoting to brain_observations. */
export interface ResearchCandidate {
  /** Normalised topic string. */
  topic: string;
  /** How many transcript events reference this topic. */
  referenceCount: number;
  /** Session IDs that contain this topic. */
  sessions: string[];
}

/** Full result from a mining pass. */
export interface AutoResearchResult {
  thrashPatterns: ThrashPattern[];
  promotionCandidates: ResearchCandidate[];
  analyzedEventCount: number;
}

// ---------------------------------------------------------------------------
// Error-signal keywords for thrash detection
// ---------------------------------------------------------------------------

const THRASH_SIGNALS = [
  'error:',
  'exception:',
  'failed:',
  'failure:',
  'E_',
  'ENOENT',
  'EACCES',
  'TypeError',
  'ReferenceError',
  'SyntaxError',
  'tsc --',
  'biome check',
  'test failed',
  'tests failed',
  'assertion failed',
] as const;

// ---------------------------------------------------------------------------
// Topic extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract the first sentence or a 100-char prefix from content for
 * topic normalisation (avoids persisting huge strings as map keys).
 */
function normaliseTopicKey(raw: string): string {
  const trimmed = raw.trim().slice(0, 200);
  const firstLine = trimmed.split('\n')[0] ?? trimmed;
  return firstLine.slice(0, 100).trim();
}

/**
 * Return the thrash-signal prefix if content starts with or contains one of
 * the known error signals, otherwise null.
 */
function extractThrashSignal(content: string): string | null {
  const lower = content.toLowerCase();
  for (const signal of THRASH_SIGNALS) {
    if (lower.includes(signal.toLowerCase())) {
      return signal;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main mining function
// ---------------------------------------------------------------------------

/**
 * Mine a set of recently-ingested transcript events for thrash patterns
 * and promotion candidates.
 *
 * @param nativeDb  - Open brain.db DatabaseSync connection.
 * @param sessionIds - Session IDs to analyse (typically the just-ingested batch).
 * @param topN       - How many promotion candidates to return (default 5).
 * @returns AutoResearchResult with thrash patterns + promotion candidates.
 */
export function mineTranscripts(
  nativeDb: DatabaseSync,
  sessionIds: string[],
  topN = 5,
): AutoResearchResult {
  if (sessionIds.length === 0) {
    return { thrashPatterns: [], promotionCandidates: [], analyzedEventCount: 0 };
  }

  const placeholders = sessionIds.map(() => '?').join(',');
  const rows = nativeDb
    .prepare(
      `SELECT session_id, block_type, content
         FROM brain_transcript_events
        WHERE session_id IN (${placeholders})
        ORDER BY session_id, seq`,
    )
    .all(...sessionIds) as Array<{ session_id: string; block_type: string; content: string }>;

  if (rows.length === 0) {
    return { thrashPatterns: [], promotionCandidates: [], analyzedEventCount: 0 };
  }

  // --- Thrash detection ---
  // Map: normalised-signal → { sessions: Set<string>, total: number }
  const thrashMap = new Map<string, { sessions: Set<string>; total: number }>();

  // --- Topic frequency ---
  // Map: normalised-topic → { sessions: Set<string>, count: number }
  const topicMap = new Map<string, { sessions: Set<string>; count: number }>();

  for (const row of rows) {
    const { session_id, content } = row;
    const topic = normaliseTopicKey(content);
    if (!topic) continue;

    // Thrash detection
    const signal = extractThrashSignal(content);
    if (signal) {
      const key = `${signal}: ${topic}`;
      const existing = thrashMap.get(key) ?? { sessions: new Set<string>(), total: 0 };
      existing.sessions.add(session_id);
      existing.total += 1;
      thrashMap.set(key, existing);
    }

    // Topic frequency
    const existing = topicMap.get(topic) ?? { sessions: new Set<string>(), count: 0 };
    existing.sessions.add(session_id);
    existing.count += 1;
    topicMap.set(topic, existing);
  }

  // Build thrash patterns — must appear in ≥ 3 sessions or ≥ 5 total occurrences
  const thrashPatterns: ThrashPattern[] = [];
  for (const [topic, data] of thrashMap) {
    if (data.sessions.size >= 3 || data.total >= 5) {
      thrashPatterns.push({
        topic,
        sessionCount: data.sessions.size,
        totalOccurrences: data.total,
      });
    }
  }
  thrashPatterns.sort((a, b) => b.totalOccurrences - a.totalOccurrences);

  // Build promotion candidates — top-N by reference count
  const candidates: ResearchCandidate[] = [];
  for (const [topic, data] of topicMap) {
    candidates.push({
      topic,
      referenceCount: data.count,
      sessions: [...data.sessions],
    });
  }
  candidates.sort((a, b) => b.referenceCount - a.referenceCount);
  const promotionCandidates = candidates.slice(0, topN);

  return {
    thrashPatterns,
    promotionCandidates,
    analyzedEventCount: rows.length,
  };
}
