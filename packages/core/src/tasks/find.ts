/**
 * Fuzzy task search with minimal output.
 * @task T4460
 * @epic T4454
 */

import type {
  MinimalTaskRecord,
  Task,
  TaskKind,
  TaskQueryFilters,
  TaskRecord,
  TaskStatus,
} from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { type EngineResult, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { cleoErrorToEngineResult } from '../errors-to-engine.js';
import type { NextDirectives } from '../mvi-helpers.js';
import { taskListItemNext } from '../mvi-helpers.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { taskToRecord } from './engine-converters.js';

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
  /**
   * Bug severity axis — P0|P1|P2|P3, or null/undefined when unset.
   * Surfaced so the unified urgency surface (T9905) can identify P0/P1 tasks
   * without a follow-up `cleo show` per row.
   * @task T9905
   */
  severity?: string | null;
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
   * Filter by task kind axis. Accepts any valid {@link TaskKind} value.
   * @task T944
   * @task T9072
   */
  kind?: TaskKind;
  /**
   * Unified urgency surface (T9905).
   *
   * When `true`, the predicate is
   *
   *   `priority IN ('critical','high') OR severity IN ('P0','P1')`
   *
   * combining the two orthogonal urgency axes (priority + severity) into a
   * single filter so agents don't have to query each axis separately.
   * Composes with other filters via AND (e.g. `--urgent --status pending`).
   *
   * @task T9905
   */
  urgent?: boolean;
}

/** Result of finding tasks. */
export interface FindTasksResult {
  results: FindResult[];
  total: number;
  query: string;
  searchType: 'fuzzy' | 'id' | 'exact';
}

/**
 * Predicate for the unified urgency surface (T9905).
 *
 * Returns `true` when the task satisfies the disjunctive predicate
 *
 *   `priority IN ('critical','high') OR severity IN ('P0','P1')`
 *
 * Exported for reuse by `coreTaskNext` (scoring boost) and the briefing
 * computation so the three callers share a single definition of "urgent".
 *
 * @task T9905
 */
export function isUrgentTask(task: {
  priority?: string | null;
  severity?: string | null;
}): boolean {
  const p = task.priority ?? '';
  const s = task.severity ?? '';
  return p === 'critical' || p === 'high' || s === 'P0' || s === 'P1';
}

/**
 * Calculate fuzzy match score between query and text.
 * Higher score = better match. 0 = no match.
 * @task T4460
 *
 * @example
 * ```ts
 * // Exact match returns the maximum score (100)
 * const exact = fuzzyScore('auth', 'auth');
 * console.assert(exact === 100, 'exact match → 100');
 *
 * // Substring match returns a high score (80)
 * const contains = fuzzyScore('auth', 'authentication module');
 * console.assert(contains === 80, 'substring match → 80');
 *
 * // No match at all returns 0
 * const none = fuzzyScore('xyz', 'authentication');
 * console.assert(none === 0, 'no match → 0');
 *
 * // Scores are comparable — substring beats partial character match
 * const partial = fuzzyScore('athn', 'authentication');
 * console.assert(partial < contains, 'partial < full-substring');
 * ```
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
 * Parse `status:value` / `kind:value` / `priority:value` tokens embedded in
 * a fuzzy query string and lift them into the filter options.
 *
 * Users naturally type `cleo find "status:pending"` expecting it to filter
 * rather than fuzzy-match against title/description. This helper rewrites
 * the options so the filter lifts out of the query token and only the
 * remaining words stay in the free-text search.
 *
 * Recognised fields: `status`, `kind`, `priority`, `type`, `id`.
 * Unrecognised `key:value` tokens pass through as-is (treated as fuzzy
 * text) to preserve user intent.
 *
 * @param options - The raw find options supplied by the caller.
 * @returns A new options object with filters lifted and the fuzzy `query`
 *   reduced to the non-filter tokens, or the same object if nothing
 *   changed.
 *
 * @task T1187-followup / v2026.4.114
 * @task T9072
 *
 * @example
 * ```ts
 * // Inline status token is lifted; remaining text stays as query
 * const result = extractInlineFilters({ query: 'status:pending auth flow' });
 * console.assert(result.status === 'pending', 'status lifted from query');
 * console.assert(result.query === 'auth flow', 'remaining text preserved as query');
 *
 * // Kind token lifted similarly
 * const result2 = extractInlineFilters({ query: 'kind:bug login crash' });
 * console.assert(result2.kind === 'bug', 'kind lifted from query');
 * console.assert(result2.query === 'login crash', 'remaining text preserved');
 *
 * // No inline tokens — options returned unchanged
 * const result3 = extractInlineFilters({ query: 'auth module' });
 * console.assert(result3.query === 'auth module', 'plain query unchanged');
 * console.assert(result3.status === undefined, 'status remains undefined');
 * ```
 */
export function extractInlineFilters(options: FindTasksOptions): FindTasksOptions {
  if (!options.query) return options;
  const tokens = options.query.split(/\s+/);
  const remaining: string[] = [];
  const next: FindTasksOptions = { ...options };
  for (const tok of tokens) {
    const m = tok.match(/^(status|kind|priority|type|id):(.+)$/i);
    if (!m) {
      remaining.push(tok);
      continue;
    }
    const [, key, value] = m;
    switch (key.toLowerCase()) {
      case 'status':
        if (!next.status) next.status = value as TaskStatus;
        break;
      case 'kind':
        if (!next.kind) next.kind = value as TaskKind;
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
 *   - `status` / `kind` filter (any of these alone is sufficient — no
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
  const hasFilter = Boolean(options.status || options.kind || options.urgent);

  if (options.query == null && !options.id && !hasFilter) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      'Search query, --id, or at least one filter (--status, --kind, --urgent) is required',
      {
        fix: 'cleo find "<query>"  OR  cleo find --urgent  OR  cleo find --status pending  OR  cleo find --id T123',
        details: { field: 'query' },
      },
    );
  }

  const acc = accessor ?? (await getTaskAccessor(cwd));

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

  // T944/T9072: kind filter — applied after status/archive resolution
  if (options.kind) {
    allTasks = allTasks.filter((t) => t.kind === options.kind);
  }

  // T9905: unified urgency filter. Disjunctive across the two orthogonal axes:
  //   priority IN ('critical','high') OR severity IN ('P0','P1')
  if (options.urgent) {
    allTasks = allTasks.filter((t) => isUrgentTask(t));
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
        severity: t.severity ?? undefined,
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
        severity: t.severity ?? undefined,
        score: 100,
      }));
  } else if (options.query == null) {
    // Filter-only mode — return every task the status/kind filter already
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
      severity: t.severity ?? undefined,
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
          severity: t.severity ?? undefined,
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

// ---------------------------------------------------------------------------
// EngineResult-returning wrapper (T1568 / ADR-057 / ADR-058)
// ---------------------------------------------------------------------------

/**
 * Fuzzy search tasks by title/description/ID, wrapped in EngineResult.
 *
 * @param projectRoot - Absolute path to the project root
 * @param query - Search string to match against title, description, or ID
 * @param limit - Maximum number of results (defaults to 20)
 * @param options - Additional search options
 * @returns EngineResult with matching tasks and total count
 *
 * @task T1568
 * @epic T1566
 */
export async function taskFind(
  projectRoot: string,
  query: string,
  limit?: number,
  options?: {
    id?: string;
    exact?: boolean;
    status?: string;
    includeArchive?: boolean;
    offset?: number;
    fields?: string;
    verbose?: boolean;
    kind?: string;
    /** Unified urgency surface — see {@link FindTasksOptions.urgent}. @task T9905 */
    urgent?: boolean;
  },
): Promise<EngineResult<{ results: (MinimalTaskRecord | TaskRecord)[]; total: number }>> {
  try {
    const accessor = await getTaskAccessor(projectRoot);
    const findResult = await findTasks(
      {
        query,
        id: options?.id,
        exact: options?.exact,
        status: options?.status as TaskStatus | undefined,
        includeArchive: options?.includeArchive,
        limit: limit ?? 20,
        offset: options?.offset,
        kind: options?.kind as TaskKind | undefined,
        urgent: options?.urgent,
      },
      projectRoot,
      accessor,
    );

    if (options?.verbose || options?.fields) {
      const fullResults: TaskRecord[] = [];
      for (const r of findResult.results) {
        const task = await accessor.loadSingleTask(r.id);
        if (task) fullResults.push(taskToRecord(task));
      }
      return engineSuccess({ results: fullResults, total: findResult.total });
    }

    const results: MinimalTaskRecord[] = findResult.results.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      parentId: r.parentId,
      depends: r.depends,
      type: r.type,
      size: r.size,
      // T9905: surface severity in the minimal projection so agents calling
      // `cleo find --urgent` see the second urgency axis without a follow-up
      // `cleo show` per row.
      ...(r.severity != null ? { severity: r.severity } : {}),
    }));

    return engineSuccess({ results, total: findResult.total });
  } catch (err: unknown) {
    // T9940: preserve CleoError LAFS codes; non-CleoError → E_INTERNAL,
    // never the misleading E_NOT_INITIALIZED blanket label.
    return cleoErrorToEngineResult(err, 'E_INTERNAL', 'Failed to search tasks');
  }
}
