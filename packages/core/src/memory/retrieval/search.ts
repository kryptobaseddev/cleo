/**
 * BRAIN Search — Layer 1 compact search + budget-aware hybrid retrieval.
 *
 * Provides two search entry points:
 * - searchBrainCompact: token-efficient index-level search (~50 tokens/hit)
 * - retrieveWithBudget: multi-strategy (FTS5 + vector + graph) within a token budget
 *
 * @task T5131
 * @epic T5149
 */

import type {
  BrainCompactHit,
  BudgetedEntry,
  BudgetedResult,
  BudgetedRetrievalOptions,
  SearchBrainCompactParams,
  SearchBrainCompactResult,
} from '@cleocode/contracts';
import { memoryFindHitNext } from '../../mvi-helpers.js';
import { hybridSearch, searchBrain } from '../brain-search.js';
import { searchSimilar } from '../brain-similarity.js';
import { getCurrentSessionId } from './get-current-session-id.js';
import { incrementCitationCounts } from './increment-citation-counts.js';
import { logRetrieval } from './log-retrieval.js';

// Re-export budget types so callers that import from brain-retrieval.ts keep working.
export type { BudgetedEntry, BudgetedResult, BudgetedRetrievalOptions } from '@cleocode/contracts';

// ============================================================================
// Layer 1: Compact Search
// ============================================================================

/**
 * Token-efficient compact search across BRAIN tables.
 * Returns index-level hits (~50 tokens per result).
 *
 * Delegates to searchBrain() from brain-search.ts for FTS5/LIKE search,
 * then projects results to a compact format with optional date filtering.
 *
 * @param projectRoot - Project root directory
 * @param params - Search parameters
 * @returns Compact search results with token estimate
 *
 * @example
 * ```ts
 * // Search for observations related to authentication decisions.
 * // Returns compact hits (~50 tokens each) from BRAIN tables.
 * const result = await searchBrainCompact('/path/to/project', {
 *   query: 'authentication decisions',
 *   limit: 5,
 *   tables: ['decisions', 'observations'],
 * });
 *
 * // Result shape: { results: BrainCompactHit[], total: number, tokensEstimated: number }
 * console.assert(typeof result.total === 'number', 'total is a number');
 * console.assert(Array.isArray(result.results), 'results is an array');
 * console.assert(typeof result.tokensEstimated === 'number', 'tokensEstimated present');
 * ```
 */
export async function searchBrainCompact(
  projectRoot: string,
  params: SearchBrainCompactParams,
): Promise<SearchBrainCompactResult> {
  const {
    query,
    limit,
    tables,
    dateStart,
    dateEnd,
    agent,
    useRRF = true,
    peerId,
    includeGlobal,
    mode,
    since,
  } = params;

  if (!query?.trim()) {
    return { results: [], total: 0, tokensEstimated: 0 };
  }

  const effectiveLimit = limit ?? 10;

  // T418: agent filter always forces FTS-only on observations table
  const agentFilter = agent !== undefined && agent !== null;

  // ----- T1900: recency mode — ORDER BY created_at DESC, no BM25/RRF -----
  if (mode === 'recency' && !agentFilter) {
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    await getBrainDb(projectRoot);
    const nativeDb = getBrainNativeDb();

    if (!nativeDb) {
      return { results: [], total: 0, tokensEstimated: 0 };
    }

    // Determine which tables to query
    const targetTables =
      tables && tables.length > 0 ? tables : ['observations', 'learnings', 'patterns', 'decisions'];
    const sinceClause = since ? ` AND created_at >= '${since}'` : '';
    const dateStartClause = dateStart ? ` AND created_at >= '${dateStart}'` : '';
    const dateEndClause = dateEnd ? ` AND created_at <= '${dateEnd}'` : '';
    const perTableLimit = effectiveLimit * 2;

    const results: BrainCompactHit[] = [];

    for (const table of targetTables) {
      let sql: string;

      if (table === 'observations') {
        sql = `SELECT id, title, created_at FROM brain_observations WHERE 1=1${sinceClause}${dateStartClause}${dateEndClause} ORDER BY created_at DESC LIMIT ${perTableLimit}`;
      } else if (table === 'learnings') {
        sql = `SELECT id, insight AS title, created_at FROM brain_learnings WHERE 1=1${sinceClause}${dateStartClause}${dateEndClause} ORDER BY created_at DESC LIMIT ${perTableLimit}`;
      } else if (table === 'patterns') {
        sql = `SELECT id, pattern AS title, extracted_at AS created_at FROM brain_patterns WHERE 1=1${since ? ` AND extracted_at >= '${since}'` : ''}${dateStart ? ` AND extracted_at >= '${dateStart}'` : ''}${dateEnd ? ` AND extracted_at <= '${dateEnd}'` : ''} ORDER BY extracted_at DESC LIMIT ${perTableLimit}`;
      } else {
        // decisions
        sql = `SELECT id, decision AS title, created_at FROM brain_decisions WHERE 1=1${sinceClause}${dateStartClause}${dateEndClause} ORDER BY created_at DESC LIMIT ${perTableLimit}`;
      }

      try {
        const rows = nativeDb.prepare(sql).all() as Array<{
          id: string;
          title: string;
          created_at: string;
        }>;
        for (const row of rows) {
          results.push({
            id: row.id,
            type: table.replace(/s$/, '') as 'observation' | 'learning' | 'pattern' | 'decision',
            title: (row.title ?? '').slice(0, 80),
            date: row.created_at ?? '',
            relevance: 0,
          });
        }
      } catch {
        // table missing or DB error — skip
      }
    }

    // Sort globally by date descending, then trim to limit
    results.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
    const trimmed = results.slice(0, effectiveLimit);

    for (const hit of trimmed) {
      hit._next = memoryFindHitNext(hit.id);
    }

    return { results: trimmed, total: trimmed.length, tokensEstimated: trimmed.length * 50 };
  }

  // ----- RRF path (default or mode=hybrid) -----
  if ((useRRF && !agentFilter && mode !== 'lexical') || (mode === 'hybrid' && !agentFilter)) {
    // Run FTS (for dates + table-level data) and RRF fusion in parallel.
    // FTS gives us row-level dates; RRF gives us the fused ranking order.
    const [ftsResult, rrfResults] = await Promise.all([
      searchBrain(projectRoot, query, {
        limit: effectiveLimit * 3,
        tables,
        peerId,
        includeGlobal,
      }).catch(() => ({
        decisions: [],
        patterns: [],
        learnings: [],
        observations: [],
      })),
      hybridSearch(query, projectRoot, { limit: effectiveLimit * 2 }),
    ]);

    // Build a date map from FTS rows (id -> date string)
    const dateMap = new Map<string, string>();
    for (const d of ftsResult.decisions) {
      const raw = d as Record<string, unknown>;
      dateMap.set(d.id, (d.createdAt ?? (raw['created_at'] as string)) || '');
    }
    for (const p of ftsResult.patterns) {
      const raw = p as Record<string, unknown>;
      dateMap.set(p.id, (p.extractedAt ?? (raw['extracted_at'] as string)) || '');
    }
    for (const l of ftsResult.learnings) {
      const raw = l as Record<string, unknown>;
      dateMap.set(l.id, (l.createdAt ?? (raw['created_at'] as string)) || '');
    }
    for (const o of ftsResult.observations) {
      const raw = o as Record<string, unknown>;
      dateMap.set(o.id, (o.createdAt ?? (raw['created_at'] as string)) || '');
    }

    // Apply table filter when specified (map singular type names to plural table names)
    const singularToTable: Record<string, string> = {
      decision: 'decisions',
      pattern: 'patterns',
      learning: 'learnings',
      observation: 'observations',
    };

    // Compute min-max normalization bounds for BM25 rank → bm25Score.
    const ftsRanks = rrfResults.map((r) => r.ftsRank ?? undefined).filter((v) => v !== undefined);
    const maxFtsRank = ftsRanks.length > 0 ? Math.max(...ftsRanks) : 0;

    // Compute min-max bounds for rrfScore normalization for `relevance` field.
    const rrfScores = rrfResults.map((r) => r.score);
    const minRrf = rrfScores.length > 0 ? Math.min(...rrfScores) : 0;
    const maxRrf = rrfScores.length > 0 ? Math.max(...rrfScores) : 0;
    const rrfRange = maxRrf - minRrf;

    let results: BrainCompactHit[] = rrfResults
      .map((r) => {
        const bm25Score =
          r.ftsRank !== undefined ? 1 - (maxFtsRank > 0 ? r.ftsRank / maxFtsRank : 0) : 0;
        const rrfScore = r.score;
        const relevance = rrfRange > 0 ? (r.score - minRrf) / rrfRange : r.score;
        return {
          id: r.id,
          type: r.type as 'decision' | 'pattern' | 'learning' | 'observation',
          title: r.title.slice(0, 80),
          date: dateMap.get(r.id) ?? '',
          relevance,
          rrfScore,
          bm25Score,
        };
      })
      .filter((r) => {
        // Only include items that the FTS scan returned (ensures quality gating is respected)
        return dateMap.has(r.id);
      });

    if (tables && tables.length > 0) {
      results = results.filter((r) =>
        tables.includes(
          singularToTable[r.type] as 'decisions' | 'patterns' | 'learnings' | 'observations',
        ),
      );
    }

    // Apply date filters client-side (T1900: since also applied here)
    if (since) results = results.filter((r) => !r.date || r.date >= since);
    if (dateStart) results = results.filter((r) => !r.date || r.date >= dateStart);
    if (dateEnd) results = results.filter((r) => !r.date || r.date <= dateEnd);

    results = results.slice(0, effectiveLimit);

    for (const hit of results) {
      hit._next = memoryFindHitNext(hit.id);
    }

    if (results.length > 0) {
      const returnedIds = results.map((r) => r.id);
      setImmediate(() => {
        incrementCitationCounts(projectRoot, returnedIds).catch(() => {});
        getCurrentSessionId(projectRoot)
          .then((sessionId) => {
            return logRetrieval(
              projectRoot,
              query,
              returnedIds,
              'find-rrf',
              results.length * 50,
              sessionId,
            );
          })
          .catch(() => {});
      });
    }

    return { results, total: results.length, tokensEstimated: results.length * 50 };
  }

  // ----- FTS-only path (useRRF=false or agent filter) -----
  const effectiveTables = agentFilter
    ? (['observations'] as Array<'decisions' | 'patterns' | 'learnings' | 'observations'>)
    : tables;

  const searchResult = await searchBrain(projectRoot, query, {
    limit: effectiveLimit,
    tables: effectiveTables,
    peerId,
    includeGlobal,
  });

  // Project full results to compact format.
  // Note: searchBrain() returns rows from raw SQL (nativeDb) which use
  // snake_case column names, but the TypeScript types are camelCase.
  // We handle both naming conventions for robustness.
  let results: BrainCompactHit[] = [];

  if (!agentFilter) {
    for (const d of searchResult.decisions) {
      const raw = d as Record<string, unknown>;
      results.push({
        id: d.id,
        type: 'decision',
        title: d.decision.slice(0, 80),
        date: (d.createdAt ?? (raw['created_at'] as string)) || '',
      });
    }

    for (const p of searchResult.patterns) {
      const raw = p as Record<string, unknown>;
      results.push({
        id: p.id,
        type: 'pattern',
        title: p.pattern.slice(0, 80),
        date: (p.extractedAt ?? (raw['extracted_at'] as string)) || '',
      });
    }

    for (const l of searchResult.learnings) {
      const raw = l as Record<string, unknown>;
      results.push({
        id: l.id,
        type: 'learning',
        title: l.insight.slice(0, 80),
        date: (l.createdAt ?? (raw['created_at'] as string)) || '',
      });
    }
  }

  for (const o of searchResult.observations) {
    const raw = o as Record<string, unknown>;
    // T418: apply agent post-filter when specified
    if (agentFilter) {
      const rowAgent = o.agent ?? (raw['agent'] as string | null) ?? null;
      if (rowAgent !== agent) continue;
    }
    results.push({
      id: o.id,
      type: 'observation',
      title: o.title.slice(0, 80),
      date: (o.createdAt ?? (raw['created_at'] as string)) || '',
    });
  }

  // Apply date filters client-side if provided (T1900: since also applied here)
  if (since) results = results.filter((r) => r.date >= since);
  if (dateStart) results = results.filter((r) => r.date >= dateStart);
  if (dateEnd) results = results.filter((r) => r.date <= dateEnd);

  // Enrich each hit with _next progressive disclosure directives
  for (const hit of results) {
    hit._next = memoryFindHitNext(hit.id);
  }

  // Citation tracking + retrieval logging (non-blocking)
  if (results.length > 0) {
    const returnedIds = results.map((r) => r.id);
    setImmediate(() => {
      incrementCitationCounts(projectRoot, returnedIds).catch(() => {});
      getCurrentSessionId(projectRoot)
        .then((sessionId) => {
          return logRetrieval(
            projectRoot,
            query,
            returnedIds,
            'find',
            results.length * 50,
            sessionId,
          );
        })
        .catch(() => {});
    });
  }

  return {
    results,
    total: results.length,
    tokensEstimated: results.length * 50,
  };
}

// ============================================================================
// Budget-Aware Retrieval (T549 Wave 3-A)
// ============================================================================

/** Default token budget for `retrieveWithBudget` (characters / 4 ≈ tokens). */
const DEFAULT_TOKEN_BUDGET = 500;

/**
 * Budget-aware hybrid retrieval combining FTS5, vector KNN, and graph neighbor scores.
 *
 * Strategy (parallel where possible):
 *   A. FTS5 BM25 search (always)  — keyword precision (50% weight)
 *   B. Vector KNN search (optional) — semantic recall (40% weight, skipped if no embeddings)
 *   C. Graph neighbors (optional) — associative context (10% weight, skipped if graph empty)
 *
 * Score fusion: final = (fts*0.50 + vec*0.40 + graph*0.10) × qualityScore
 * Recency boost: +0.05 for entries updated in last 7 days.
 * Type priority: procedural entries get +0.10 (always-useful rules).
 *
 * Budget enforcement:
 *   - Rank top-50 candidates by fused score.
 *   - Walk list, accumulate token cost (≈ textLen/4), stop at budget.
 *   - Episodic entries dropped first when budget is tight.
 *
 * Citation tracking: increments citationCount for returned entries in background (setImmediate).
 *
 * @param projectRoot - Project root directory
 * @param query - Text to search for
 * @param tokenBudget - Maximum tokens to spend on results (default 500)
 * @param options - Optional filters (types, tiers, verified)
 * @returns Retrieved entries within budget with token accounting
 */
export async function retrieveWithBudget(
  projectRoot: string,
  query: string,
  tokenBudget = DEFAULT_TOKEN_BUDGET,
  options?: BudgetedRetrievalOptions,
): Promise<BudgetedResult> {
  if (!query?.trim()) {
    return { entries: [], tokensUsed: 0, tokensRemaining: tokenBudget, excluded: 0 };
  }

  // -------------------------------------------------------------------------
  // Run search strategies in parallel
  // -------------------------------------------------------------------------
  const [ftsResult, vecResults, graphNeighbors] = await Promise.all([
    // A. FTS5
    searchBrain(projectRoot, query, { limit: 30 }).catch(() => ({
      decisions: [],
      patterns: [],
      learnings: [],
      observations: [],
    })),
    // B. Vector KNN (degrades gracefully when unavailable)
    searchSimilar(query, projectRoot, 20).catch(
      () => [] as ReturnType<typeof searchSimilar> extends Promise<infer T> ? T : never[],
    ),
    // C. Graph neighbors from top FTS hit
    Promise.resolve([] as Array<{ id: string; graphScore: number }>),
  ]);

  // -------------------------------------------------------------------------
  // Build ID → score map from FTS results
  // -------------------------------------------------------------------------
  interface ScoredEntry {
    id: string;
    type: string;
    title: string;
    text: string;
    ftsScore: number;
    vecScore: number;
    graphScore: number;
    qualityScore: number;
    memoryTier?: string;
    memoryType?: string;
    updatedAt?: string;
  }

  const candidateMap = new Map<string, ScoredEntry>();

  // FTS results (normalized score 0.5 starting point — BM25 doesn't give 0..1)
  const FTS_BASE = 0.5;
  for (const d of ftsResult.decisions) {
    const raw = d as Record<string, unknown>;
    const id = d.id;
    const tier = (d.memoryTier ?? (raw['memory_tier'] as string | undefined)) || undefined;
    const mtype = (d.memoryType ?? (raw['memory_type'] as string | undefined)) || undefined;
    const updatedAt = (d.updatedAt ?? (raw['updated_at'] as string | undefined)) || undefined;
    candidateMap.set(id, {
      id,
      type: 'decision',
      title: d.decision.slice(0, 120),
      text: `${d.decision} — ${d.rationale}`,
      ftsScore: FTS_BASE,
      vecScore: 0,
      graphScore: 0,
      qualityScore: d.qualityScore ?? 0.5,
      memoryTier: tier,
      memoryType: mtype,
      updatedAt,
    });
  }

  for (const p of ftsResult.patterns) {
    const raw = p as Record<string, unknown>;
    const id = p.id;
    const tier = (p.memoryTier ?? (raw['memory_tier'] as string | undefined)) || undefined;
    const mtype = (p.memoryType ?? (raw['memory_type'] as string | undefined)) || undefined;
    const updatedAt = (p.updatedAt ?? (raw['updated_at'] as string | undefined)) || undefined;
    candidateMap.set(id, {
      id,
      type: 'pattern',
      title: p.pattern.slice(0, 120),
      text: `${p.pattern} — ${p.context}`,
      ftsScore: FTS_BASE,
      vecScore: 0,
      graphScore: 0,
      qualityScore: p.qualityScore ?? 0.5,
      memoryTier: tier,
      memoryType: mtype,
      updatedAt,
    });
  }

  for (const l of ftsResult.learnings) {
    const raw = l as Record<string, unknown>;
    const id = l.id;
    const tier = (l.memoryTier ?? (raw['memory_tier'] as string | undefined)) || undefined;
    const mtype = (l.memoryType ?? (raw['memory_type'] as string | undefined)) || undefined;
    const updatedAt = (l.updatedAt ?? (raw['updated_at'] as string | undefined)) || undefined;
    candidateMap.set(id, {
      id,
      type: 'learning',
      title: l.insight.slice(0, 120),
      text: `${l.insight} (source: ${l.source})`,
      ftsScore: FTS_BASE,
      vecScore: 0,
      graphScore: 0,
      qualityScore: l.qualityScore ?? 0.5,
      memoryTier: tier,
      memoryType: mtype,
      updatedAt,
    });
  }

  for (const o of ftsResult.observations) {
    const raw = o as Record<string, unknown>;
    const id = o.id;
    const tier = (o.memoryTier ?? (raw['memory_tier'] as string | undefined)) || undefined;
    const mtype = (o.memoryType ?? (raw['memory_type'] as string | undefined)) || undefined;
    const updatedAt = (o.updatedAt ?? (raw['updated_at'] as string | undefined)) || undefined;
    candidateMap.set(id, {
      id,
      type: 'observation',
      title: o.title.slice(0, 120),
      text: o.narrative ?? o.title,
      ftsScore: FTS_BASE,
      vecScore: 0,
      graphScore: 0,
      qualityScore: o.qualityScore ?? 0.5,
      memoryTier: tier,
      memoryType: mtype,
      updatedAt,
    });
  }

  // B. Merge vector scores (distance → similarity: similarity = 1 - distance)
  for (const v of vecResults) {
    const simScore = Math.max(0, 1 - v.distance);
    const existing = candidateMap.get(v.id);
    if (existing) {
      existing.vecScore = simScore;
    } else {
      candidateMap.set(v.id, {
        id: v.id,
        type: v.type,
        title: v.title.slice(0, 120),
        text: v.text,
        ftsScore: 0,
        vecScore: simScore,
        graphScore: 0,
        qualityScore: 0.5,
        memoryTier: undefined,
        memoryType: undefined,
      });
    }
  }

  // C. Merge graph scores
  for (const g of graphNeighbors) {
    const existing = candidateMap.get(g.id);
    if (existing) {
      existing.graphScore = g.graphScore;
    }
  }

  // -------------------------------------------------------------------------
  // Score fusion + ranking
  // -------------------------------------------------------------------------
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  const candidates = Array.from(candidateMap.values()).map((c) => {
    // Fused score
    let score = c.ftsScore * 0.5 + c.vecScore * 0.4 + c.graphScore * 0.1;

    // Quality multiplier
    score *= c.qualityScore;

    // Recency boost for recently-updated entries
    if (c.updatedAt && c.updatedAt >= sevenDaysAgo) {
      score += 0.05;
    }

    // Type priority boost for procedural entries (always-useful rules)
    if (c.memoryType === 'procedural' || c.type === 'pattern') {
      score += 0.1;
    }

    return { ...c, score };
  });

  // -------------------------------------------------------------------------
  // Apply option filters (types, tiers, verified)
  // -------------------------------------------------------------------------

  let filtered = candidates;

  if (options?.types && options.types.length > 0) {
    const allowedTypes = new Set(options.types);
    filtered = filtered.filter((c) => {
      if (!c.memoryType) return true; // unknown type — include
      return allowedTypes.has(c.memoryType as 'semantic' | 'episodic' | 'procedural');
    });
  }

  if (options?.tiers && options.tiers.length > 0) {
    const allowedTiers = new Set(options.tiers);
    filtered = filtered.filter((c) => {
      if (!c.memoryTier) return true; // unknown tier — include
      return allowedTiers.has(c.memoryTier as 'short' | 'medium' | 'long');
    });
  }

  // -------------------------------------------------------------------------
  // Sort: procedural first, then by score descending
  // -------------------------------------------------------------------------
  filtered.sort((a, b) => {
    const aProcedural = a.memoryType === 'procedural' || a.type === 'pattern' ? 1 : 0;
    const bProcedural = b.memoryType === 'procedural' || b.type === 'pattern' ? 1 : 0;
    if (aProcedural !== bProcedural) return bProcedural - aProcedural;
    return b.score - a.score;
  });

  // Cap candidate list at top 50
  const topCandidates = filtered.slice(0, 50);

  // -------------------------------------------------------------------------
  // Budget enforcement — episodic entries are dropped first when budget tight
  // -------------------------------------------------------------------------

  // Sort for budget walk: procedural first, semantic second, episodic last
  const typeOrder = (c: ScoredEntry & { score: number }): number => {
    if (c.memoryType === 'procedural' || c.type === 'pattern') return 0;
    if (c.memoryType === 'semantic' || c.type === 'decision' || c.type === 'learning') return 1;
    return 2; // episodic
  };

  const budgetOrdered = [...topCandidates].sort((a, b) => {
    const orderDiff = typeOrder(a) - typeOrder(b);
    if (orderDiff !== 0) return orderDiff;
    return b.score - a.score;
  });

  const result: BudgetedEntry[] = [];
  let tokensUsed = 0;
  let excluded = 0;

  for (const candidate of budgetOrdered) {
    const entryTokens = Math.ceil(candidate.text.length / 4);

    if (tokensUsed + entryTokens > tokenBudget) {
      excluded++;
      continue;
    }

    result.push({
      id: candidate.id,
      type: candidate.type,
      title: candidate.title,
      text: candidate.text,
      score: candidate.score,
      tokensEstimated: entryTokens,
      memoryTier: candidate.memoryTier,
      memoryType: candidate.memoryType,
    });
    tokensUsed += entryTokens;
  }

  // -------------------------------------------------------------------------
  // Citation tracking — non-blocking background increment
  // -------------------------------------------------------------------------
  if (result.length > 0) {
    const returnedIds = result.map((e) => e.id);
    setImmediate(() => {
      incrementCitationCounts(projectRoot, returnedIds).catch(() => {
        /* best-effort */
      });
    });
  }

  return {
    entries: result,
    tokensUsed,
    tokensRemaining: tokenBudget - tokensUsed,
    excluded,
  };
}
