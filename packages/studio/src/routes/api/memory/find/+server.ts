/**
 * Memory cross-table search API endpoint (T990 Wave 1D).
 *
 * GET /api/memory/find?q=<query>&tables=<csv>&limit=<n>
 *
 * Performs a LIKE-based scan across observations, decisions, patterns,
 * and learnings. Lightweight and deterministic — the heavier RRF
 * fusion is owned by the CLEO core layer (memory.find CLI op) and will
 * be wired via a later sdk-backed endpoint; this surface exposes a
 * results-for-UI path without changing the brain package surface.
 *
 * Response shape is a flat, uniformly-typed hit list so the Svelte
 * search page can group by table without knowing the underlying schema.
 *
 * @task T990
 * @wave 1D
 */

import { json } from '@sveltejs/kit';
import { getBrainDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

/** A single search result row. */
export interface MemorySearchHit {
  /** Entry id. */
  id: string;
  /** Source table. */
  table: 'observations' | 'decisions' | 'patterns' | 'learnings';
  /** Display title. */
  title: string;
  /** Short preview string. */
  preview: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** Quality score [0..1] or null. */
  quality: number | null;
  /** Memory tier. */
  tier: string | null;
  /** Verified flag (0/1). */
  verified: number;
  /** Citation count. */
  citations: number;
}

/** Response shape for GET /api/memory/find. */
export interface MemoryFindResponse {
  query: string;
  hits: MemorySearchHit[];
  total: number;
}

const ALLOWED_TABLES = ['observations', 'decisions', 'patterns', 'learnings'] as const;
type Table = (typeof ALLOWED_TABLES)[number];

function truncate(s: string | null | undefined, n = 160): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export const GET: RequestHandler = ({ locals, url }) => {
  const q = (url.searchParams.get('q') ?? '').trim();
  const tablesParam = url.searchParams.get('tables');
  const limitRaw = url.searchParams.get('limit');
  const limit = Math.max(1, Math.min(100, Number.parseInt(limitRaw ?? '25', 10) || 25));

  const requestedTables: Table[] = tablesParam
    ? tablesParam
        .split(',')
        .map((t) => t.trim())
        .filter((t): t is Table => (ALLOWED_TABLES as readonly string[]).includes(t))
    : [...ALLOWED_TABLES];

  if (!q) {
    return json({ query: '', hits: [], total: 0 } satisfies MemoryFindResponse);
  }

  const db = getBrainDb(locals.projectCtx);
  if (!db) {
    return json({ query: q, hits: [], total: 0 } satisfies MemoryFindResponse);
  }

  const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const hits: MemorySearchHit[] = [];

  try {
    if (requestedTables.includes('observations')) {
      const rows = db
        .prepare(
          `SELECT id, title, narrative, quality_score, memory_tier, verified,
                  citation_count, created_at
           FROM brain_observations
           WHERE (title LIKE ? ESCAPE '\\' OR narrative LIKE ? ESCAPE '\\')
             AND invalid_at IS NULL
           ORDER BY citation_count DESC, created_at DESC
           LIMIT ?`,
        )
        .all(like, like, limit) as Array<{
        id: string;
        title: string | null;
        narrative: string | null;
        quality_score: number | null;
        memory_tier: string | null;
        verified: number;
        citation_count: number;
        created_at: string;
      }>;

      for (const r of rows) {
        hits.push({
          id: r.id,
          table: 'observations',
          title: r.title ?? '(untitled)',
          preview: truncate(r.narrative),
          createdAt: r.created_at,
          quality: r.quality_score,
          tier: r.memory_tier,
          verified: r.verified,
          citations: r.citation_count,
        });
      }
    }

    if (requestedTables.includes('decisions')) {
      const rows = db
        .prepare(
          `SELECT id, decision, rationale, quality_score, memory_tier, verified,
                  created_at
           FROM brain_decisions
           WHERE (decision LIKE ? ESCAPE '\\' OR rationale LIKE ? ESCAPE '\\')
             AND invalid_at IS NULL
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(like, like, limit) as Array<{
        id: string;
        decision: string;
        rationale: string;
        quality_score: number | null;
        memory_tier: string | null;
        verified: number;
        created_at: string;
      }>;

      for (const r of rows) {
        hits.push({
          id: r.id,
          table: 'decisions',
          title: truncate(r.decision, 100),
          preview: truncate(r.rationale),
          createdAt: r.created_at,
          quality: r.quality_score,
          tier: r.memory_tier,
          verified: r.verified,
          citations: 0,
        });
      }
    }

    if (requestedTables.includes('patterns')) {
      const rows = db
        .prepare(
          `SELECT id, pattern, context, quality_score, memory_tier, verified,
                  citation_count, extracted_at
           FROM brain_patterns
           WHERE (pattern LIKE ? ESCAPE '\\' OR context LIKE ? ESCAPE '\\')
             AND invalid_at IS NULL
           ORDER BY citation_count DESC, extracted_at DESC
           LIMIT ?`,
        )
        .all(like, like, limit) as Array<{
        id: string;
        pattern: string;
        context: string | null;
        quality_score: number | null;
        memory_tier: string | null;
        verified: number;
        citation_count: number;
        extracted_at: string;
      }>;

      for (const r of rows) {
        hits.push({
          id: r.id,
          table: 'patterns',
          title: truncate(r.pattern, 100),
          preview: truncate(r.context),
          createdAt: r.extracted_at,
          quality: r.quality_score,
          tier: r.memory_tier,
          verified: r.verified,
          citations: r.citation_count,
        });
      }
    }

    if (requestedTables.includes('learnings')) {
      const rows = db
        .prepare(
          `SELECT id, insight, source, quality_score, memory_tier, verified,
                  citation_count, created_at
           FROM brain_learnings
           WHERE (insight LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\')
             AND invalid_at IS NULL
           ORDER BY citation_count DESC, created_at DESC
           LIMIT ?`,
        )
        .all(like, like, limit) as Array<{
        id: string;
        insight: string;
        source: string | null;
        quality_score: number | null;
        memory_tier: string | null;
        verified: number;
        citation_count: number;
        created_at: string;
      }>;

      for (const r of rows) {
        hits.push({
          id: r.id,
          table: 'learnings',
          title: truncate(r.insight, 100),
          preview: truncate(r.source),
          createdAt: r.created_at,
          quality: r.quality_score,
          tier: r.memory_tier,
          verified: r.verified,
          citations: r.citation_count,
        });
      }
    }

    return json({ query: q, hits, total: hits.length } satisfies MemoryFindResponse);
  } catch {
    return json({ query: q, hits: [], total: 0 } satisfies MemoryFindResponse);
  }
};
