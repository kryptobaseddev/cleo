/**
 * One ranked recall list across the four BRAIN tables (T13948).
 *
 * FTS5 BM25 scores are per-index, so a decision's score and an observation's
 * score cannot be compared. The previous answer was a round-robin interleave:
 * every `memory find` came back D,P,L,O,D,P,L,O — a fixed per-type quota with
 * no notion of age or authorship, so a May LLM restatement held the same slot
 * as an October owner decision.
 *
 * Here each FTS hit scores `rankWeight × recencyWeight × sourceWeight`:
 *
 * - **rankWeight** `1 / (1 + rank)` keeps each table's BM25 order;
 * - **recencyWeight** decays from 1 to a floor of 0.5 with a
 *   {@link RECENCY_HALF_LIFE_DAYS}-day half-life, so old rows lose ties but are
 *   never buried outright;
 * - **sourceWeight** ranks provenance: owner > task outcome > agent >
 *   speculative ({@link SOURCE_WEIGHTS}).
 *
 * The result is the FTS source list for RRF fusion with the vector and graph
 * sources.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @module memory/recall-ranking
 * @task T13948
 */

import type { BrainMemorySearchResult, RrfHit } from './brain-search.js';

/** Days for the recency bonus to halve. */
export const RECENCY_HALF_LIFE_DAYS = 60;

/** Weight per `source_confidence` value; unknown values rank as `agent`. */
export const SOURCE_WEIGHTS: Readonly<Record<string, number>> = {
  owner: 1,
  'task-outcome': 0.85,
  agent: 0.7,
  speculative: 0.4,
};

const MS_PER_DAY = 86_400_000;

/**
 * Provenance and date fields a memory row may carry. FTS rows come from
 * `SELECT *`, so at runtime they carry the snake_case column names.
 */
export interface RankableRow {
  created_at?: string | null;
  extracted_at?: string | null;
  source_confidence?: string | null;
  decided_by?: string | null;
  createdAt?: string | null;
  extractedAt?: string | null;
  sourceConfidence?: string | null;
  decidedBy?: string | null;
}

/** An FTS hit with its cross-table score. */
export interface RankedFtsHit extends RrfHit {
  /** Row date (`created_at`, or `extracted_at` for patterns); empty when unknown. */
  date: string;
  /** `rankWeight × recencyWeight × sourceWeight`. */
  score: number;
}

/**
 * Recency multiplier in [0.5, 1].
 *
 * @param date - Stored SQLite or ISO date; unparseable or missing dates get the floor.
 * @param nowMs - Clock, injectable for tests.
 * @returns 1 for a row written now, halving its bonus every {@link RECENCY_HALF_LIFE_DAYS} days.
 * @example
 * ```ts
 * recencyWeight('2026-10-23 00:00:00', Date.parse('2026-10-23T00:00:00Z')); // 1
 * ```
 */
export function recencyWeight(date: string | null | undefined, nowMs: number): number {
  if (!date) return 0.5;
  const ms = Date.parse(date.includes('T') ? date : `${date.replace(' ', 'T')}Z`);
  if (Number.isNaN(ms)) return 0.5;
  const ageDays = Math.max(0, (nowMs - ms) / MS_PER_DAY);
  return 0.5 + 0.5 * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
}

/**
 * Provenance multiplier: an owner-decided decision counts as owner-sourced.
 *
 * @param row - Memory row with optional `source_confidence` / `decided_by`.
 * @returns A weight from {@link SOURCE_WEIGHTS}.
 * @example
 * ```ts
 * sourceWeight({ source_confidence: 'speculative' }); // 0.4
 * ```
 */
export function sourceWeight(row: RankableRow): number {
  if ((row.decided_by ?? row.decidedBy) === 'owner') return SOURCE_WEIGHTS.owner ?? 1;
  const source = row.source_confidence ?? row.sourceConfidence ?? 'agent';
  return SOURCE_WEIGHTS[source] ?? SOURCE_WEIGHTS.agent ?? 0.7;
}

/** Date of a memory row: `extracted_at` for patterns, `created_at` otherwise. */
function rowDate(row: RankableRow): string {
  return row.created_at ?? row.createdAt ?? row.extracted_at ?? row.extractedAt ?? '';
}

/**
 * Merge per-table FTS results into one list ranked by recency and source.
 *
 * @param fts - Per-table rows, each already BM25-ordered.
 * @param nowMs - Clock, injectable for tests.
 * @returns Every hit once, best first.
 * @example
 * ```ts
 * const ranked = rankFtsAcrossTables(await searchBrain(root, 'worktree'), Date.now());
 * ```
 */
export function rankFtsAcrossTables(
  fts: BrainMemorySearchResult,
  nowMs: number = Date.now(),
): RankedFtsHit[] {
  const lists: Array<Array<{ row: RankableRow; hit: RrfHit }>> = [
    fts.decisions.map((d) => ({
      row: d,
      hit: {
        id: d.id,
        type: 'decision',
        title: d.decision,
        text: `${d.decision} — ${d.rationale}`,
      },
    })),
    fts.patterns.map((p) => ({
      row: p,
      hit: { id: p.id, type: 'pattern', title: p.pattern, text: `${p.pattern} — ${p.context}` },
    })),
    fts.learnings.map((l) => ({
      row: l,
      hit: {
        id: l.id,
        type: 'learning',
        title: l.insight,
        text: `${l.insight} (source: ${l.source})`,
      },
    })),
    fts.observations.map((o) => ({
      row: o,
      hit: { id: o.id, type: 'observation', title: o.title, text: o.narrative ?? o.title },
    })),
  ];
  const ranked: RankedFtsHit[] = [];
  for (const list of lists) {
    for (const [rank, { row, hit }] of list.entries()) {
      const date = rowDate(row);
      ranked.push({
        ...hit,
        date,
        score: (1 / (1 + rank)) * recencyWeight(date, nowMs) * sourceWeight(row),
      });
    }
  }
  return ranked.sort((a, b) => b.score - a.score);
}
