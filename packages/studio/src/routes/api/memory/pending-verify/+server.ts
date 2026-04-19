/**
 * Memory pending-verify queue API endpoint (T990 Wave 1D).
 *
 * GET /api/memory/pending-verify?minCitations=<n>&limit=<n>
 *
 * Surfaces unverified-but-cited entries across all four brain tables so
 * the owner can promote the highest-leverage memory to verified status.
 *
 * LAFS envelope: `{ success, data, error?, meta }`.
 *
 * @task T990
 * @wave 1D
 */

import { json } from '@sveltejs/kit';
import { getBrainDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

/** A single pending-verify row. */
export interface PendingEntry {
  id: string;
  title: string | null;
  sourceConfidence: string | null;
  citationCount: number;
  memoryTier: string | null;
  createdAt: string;
  table: 'observations' | 'decisions' | 'patterns' | 'learnings';
}

/** Envelope body. */
export interface PendingVerifyData {
  count: number;
  minCitations: number;
  items: PendingEntry[];
  hint: string;
}

interface PendingTableSpec {
  table: PendingEntry['table'];
  sql: string;
}

const TABLES: PendingTableSpec[] = [
  {
    table: 'observations',
    sql: `SELECT id, title, source_confidence AS sourceConfidence,
                 citation_count AS citationCount, memory_tier AS memoryTier,
                 created_at AS createdAt
          FROM brain_observations
          WHERE verified = 0
            AND invalid_at IS NULL
            AND citation_count >= ?
          ORDER BY citation_count DESC, created_at DESC
          LIMIT ?`,
  },
  {
    table: 'decisions',
    sql: `SELECT id, decision AS title, NULL AS sourceConfidence,
                 COALESCE(citation_count, 0) AS citationCount,
                 memory_tier AS memoryTier,
                 created_at AS createdAt
          FROM brain_decisions
          WHERE verified = 0
            AND invalid_at IS NULL
            AND COALESCE(citation_count, 0) >= ?
          ORDER BY citation_count DESC, created_at DESC
          LIMIT ?`,
  },
  {
    table: 'patterns',
    sql: `SELECT id, pattern AS title, NULL AS sourceConfidence,
                 citation_count AS citationCount, memory_tier AS memoryTier,
                 extracted_at AS createdAt
          FROM brain_patterns
          WHERE verified = 0
            AND invalid_at IS NULL
            AND citation_count >= ?
          ORDER BY citation_count DESC, extracted_at DESC
          LIMIT ?`,
  },
  {
    table: 'learnings',
    sql: `SELECT id, insight AS title, NULL AS sourceConfidence,
                 citation_count AS citationCount, memory_tier AS memoryTier,
                 created_at AS createdAt
          FROM brain_learnings
          WHERE verified = 0
            AND invalid_at IS NULL
            AND citation_count >= ?
          ORDER BY citation_count DESC, created_at DESC
          LIMIT ?`,
  },
];

function lafsOk(data: PendingVerifyData): Record<string, unknown> {
  return {
    success: true,
    data,
    meta: { at: new Date().toISOString() },
  };
}

function lafsErr(message: string): Record<string, unknown> {
  return {
    success: false,
    error: { code: 'E_MEMORY_PENDING_VERIFY', message },
    meta: { at: new Date().toISOString() },
  };
}

export const GET: RequestHandler = ({ locals, url }) => {
  const minRaw = url.searchParams.get('minCitations');
  const limRaw = url.searchParams.get('limit');
  const minCitations = Math.max(1, Number.parseInt(minRaw ?? '5', 10) || 5);
  const limit = Math.max(1, Math.min(200, Number.parseInt(limRaw ?? '50', 10) || 50));

  const db = getBrainDb(locals.projectCtx);
  if (!db) {
    return json(
      lafsOk({
        count: 0,
        minCitations,
        items: [],
        hint: 'brain.db not available; start a session to populate memory.',
      }),
    );
  }

  try {
    const items: PendingEntry[] = [];
    for (const spec of TABLES) {
      try {
        const rows = db.prepare(spec.sql).all(minCitations, limit) as Array<{
          id: string;
          title: string | null;
          sourceConfidence: string | null;
          citationCount: number;
          memoryTier: string | null;
          createdAt: string;
        }>;
        for (const r of rows) {
          items.push({
            id: r.id,
            title: r.title,
            sourceConfidence: r.sourceConfidence,
            citationCount: r.citationCount,
            memoryTier: r.memoryTier,
            createdAt: r.createdAt,
            table: spec.table,
          });
        }
      } catch {
        // Table missing or column drift — skip.
      }
    }

    items.sort((a, b) => b.citationCount - a.citationCount);
    const top = items.slice(0, limit);

    const hint =
      top.length === 0
        ? `No entries with ≥ ${minCitations} citations. Lower the threshold or wait for more retrievals.`
        : `Promote entries the system keeps citing — use the verify action to lock them to ground truth.`;

    return json(
      lafsOk({
        count: top.length,
        minCitations,
        items: top,
        hint,
      }),
    );
  } catch (e) {
    return json(lafsErr(e instanceof Error ? e.message : 'Query failed'), { status: 500 });
  }
};
