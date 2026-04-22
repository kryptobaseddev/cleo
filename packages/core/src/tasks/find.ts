/**
 * Fuzzy task search with minimal output.
 * @task T4460
 * @epic T4454
 */

import type { Task, TaskQueryFilters, TaskRole, TaskStatus } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import type { NextDirectives } from '../mvi-helpers.js';
import { taskListItemNext } from '../mvi-helpers.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';

/** Minimal task info for search results. */
export interface FindResult {
  id: string;
  title: string;
  status: string;
  priority: string;
  type?: string;
  parentId?: string | null;
  /** Dependency IDs — essential for agents to determine task readiness. @task T091 */
  depends?: string[];
  /** Scope size estimate. @task T091 */
  size?: string;
  score: number;
  /** Progressive disclosure directives for follow-up operations. */
  _next?: NextDirectives;
}

/** Options for finding tasks. */
export interface FindTasksOptions {
  query?: string;
  id?: string;
  exact?: boolean;
  status?: TaskStatus;
  field?: string;
  includeArchive?: boolean;
  limit?: number;
  offset?: number;
  /**
   * Filter by task role axis. Accepts any valid {@link TaskRole} value.
   * @task T944
   */
  role?: TaskRole;
}

/** Result of finding tasks. */
export interface FindTasksResult {
  results: FindResult[];
  total: number;
  query: string;
  searchType: 'fuzzy' | 'id' | 'exact';
}

/**
 * Calculate fuzzy match score between query and text.
 * Higher score = better match. 0 = no match.
 * @task T4460
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Exact match
  if (t === q) return 100;

  // Contains full query
  if (t.includes(q)) return 80;

  // Word-boundary match
  const words = t.split(/\s+/);
  const queryWords = q.split(/\s+/);
  let wordMatchCount = 0;
  for (const qw of queryWords) {
    if (words.some((w) => w.startsWith(qw) || w.includes(qw))) {
      wordMatchCount++;
    }
  }
  if (wordMatchCount > 0) {
    return 40 + (wordMatchCount / queryWords.length) * 40;
  }

  // Character sequence match
  let qIdx = 0;
  let matched = 0;
  for (let tIdx = 0; tIdx < t.length && qIdx < q.length; tIdx++) {
    if (t[tIdx] === q[qIdx]) {
      matched++;
      qIdx++;
    }
  }
  if (qIdx === q.length) {
    return 10 + (matched / t.length) * 20;
  }

  return 0;
}

/**
 * Parse `status:value` / `role:value` / `priority:value` tokens embedded in
 * a fuzzy query string and lift them into the filter options.
 *
 * Users naturally type `cleo find "status:pending"` expecting it to filter
 * rather than fuzzy-match against title/description. This helper rewrites
 * the options so the filter lifts out of the query token and only the
 * remaining words stay in the free-text search.
 *
 * Recognised fields: `status`, `role`, `priority`, `type`, `id`.
 * Unrecognised `key:value` tokens pass through as-is (treated as fuzzy
 * text) to preserve user intent.
 *
 * @param options - The raw find options supplied by the caller.
 * @returns A new options object with filters lifted and the fuzzy `query`
 *   reduced to the non-filter tokens, or the same object if nothing
 *   changed.
 *
 * @task T1187-followup / v2026.4.114
 */
export function extractInlineFilters(options: FindTasksOptions): FindTasksOptions {
  if (!options.query) return options;
  const tokens = options.query.split(/\s+/);
  const remaining: string[] = [];
  const next: FindTasksOptions = { ...options };
  for (const tok of tokens) {
    const m = tok.match(/^(status|role|priority|type|id):(.+)$/i);
    if (!m) {
      remaining.push(tok);
      continue;
    }
    const [, key, value] = m;
    switch (key.toLowerCase()) {
      case 'status':
        if (!next.status) next.status = value as TaskStatus;
        break;
      case 'role':
        if (!next.role) next.role = value as TaskRole;
        break;
      case 'id':
        if (!next.id) next.id = value;
        break;
      default:
        // priority/type aren't in FindTasksOptions today — pass through.
        remaining.push(tok);
        break;
    }
  }
  const newQuery = remaining.join(' ').trim();
  next.query = newQuery || undefined;
  return next;
}

/**
 * Search tasks by fuzzy matching, ID prefix, exact title, or filter-only.
 * Returns minimal fields only (context-efficient).
 *
 * Accepts any of:
 *   - positional `query` for fuzzy title/description search
 *   - `id` prefix
 *   - `status` / `role` filter (any of these alone is sufficient — no
 *     query required, returns all matches)
 *   - inline `key:value` tokens in `query` (e.g. `status:pending`)
 *     auto-lifted into the corresponding filter
 *
 * @task T4460
 * @task T1187-followup / v2026.4.114 — filter-only mode + inline key:value parsing
 */
export async function findTasks(
  rawOptions: FindTasksOptions,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<FindTasksResult> {
  const options = extractInlineFilters(rawOptions);
  const hasFilter = Boolean(options.status || options.role);

  if (options.query == null && !options.id && !hasFilter) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      'Search query, --id, or at least one filter (--status, --role) is required',
      {
        fix: 'cleo find "<query>"  OR  cleo find --status pending  OR  cleo find --id T123',
        details: { field: 'query' },
      },
    );
  }

  const acc = accessor ?? (await getAccessor(cwd));

  // Use targeted query with status filter when available
  const filters: TaskQueryFilters = {};
  if (options.status) {
    filters.status = options.status;
  }
  const queryResult = await acc.queryTasks(filters);
  let allTasks: Task[] = [...queryResult.tasks];

  // Include archive if requested
  if (options.includeArchive) {
    const archive = await acc.loadArchive();
    if (archive?.archivedTasks) {
      let archivedTasks = archive.archivedTasks as Task[];
      if (options.status) {
        archivedTasks = archivedTasks.filter((t) => t.status === options.status);
      }
      allTasks = [...allTasks, ...archivedTasks];
    }
  }

  // T944: role filter — applied after status/archive resolution
  if (options.role) {
    allTasks = allTasks.filter((t) => t.role === options.role);
  }

  let results: FindResult[];
  let searchType: FindTasksResult['searchType'];
  let queryStr: string;

  if (options.id) {
    // ID prefix search
    searchType = 'id';
    queryStr = options.id;
    const idQuery = options.id.toUpperCase();
    results = allTasks
      .filter((t) => t.id.toUpperCase().startsWith(idQuery) || t.id.toUpperCase().includes(idQuery))
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        type: t.type,
        parentId: t.parentId,
        depends: t.depends ?? [],
        size: t.size ?? undefined,
        score:
          t.id.toUpperCase() === idQuery ? 100 : t.id.toUpperCase().startsWith(idQuery) ? 80 : 50,
      }));
  } else if (options.exact) {
    // Exact title match
    searchType = 'exact';
    queryStr = options.query!;
    results = allTasks
      .filter((t) => t.title === options.query)
      .map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        type: t.type,
        parentId: t.parentId,
        depends: t.depends ?? [],
        size: t.size ?? undefined,
        score: 100,
      }));
  } else if (options.query == null) {
    // Filter-only mode — return every task the status/role filter already
    // matched. All-equal score=50 so pagination is stable. T1187-followup.
    searchType = 'fuzzy';
    queryStr = '';
    results = allTasks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      type: t.type,
      parentId: t.parentId,
      depends: t.depends ?? [],
      size: t.size ?? undefined,
      score: 50,
    }));
  } else {
    // Fuzzy search
    searchType = 'fuzzy';
    queryStr = options.query;
    const scored: FindResult[] = [];

    for (const t of allTasks) {
      const titleScore = fuzzyScore(queryStr, t.title);
      const descScore = t.description ? fuzzyScore(queryStr, t.description) * 0.7 : 0;
      const score = Math.max(titleScore, descScore);

      if (score > 0) {
        scored.push({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          type: t.type,
          parentId: t.parentId,
          depends: t.depends ?? [],
          size: t.size ?? undefined,
          score: Math.round(score),
        });
      }
    }

    results = scored.sort((a, b) => b.score - a.score);
  }

  const total = results.length;

  // Apply pagination
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  results = results.slice(offset, offset + limit);

  // Enrich each result with _next progressive disclosure directives
  const enrichedResults = results.map((r) => ({
    ...r,
    _next: taskListItemNext(r.id),
  }));

  return {
    results: enrichedResults,
    total,
    query: queryStr,
    searchType,
  };
}
