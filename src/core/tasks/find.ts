/**
 * Fuzzy task search with minimal output.
 * @task T4460
 * @epic T4454
 */

import { readJsonRequired, readJson } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Task, TaskStatus, TodoFile } from '../../types/task.js';
import { getTodoPath, getArchivePath } from '../paths.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Minimal task info for search results. */
export interface FindResult {
  id: string;
  title: string;
  status: string;
  priority: string;
  type?: string;
  parentId?: string | null;
  score: number;
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
    if (words.some(w => w.startsWith(qw) || w.includes(qw))) {
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
 * Search tasks by fuzzy matching, ID prefix, or exact title.
 * Returns minimal fields only (context-efficient).
 * @task T4460
 */
export async function findTasks(options: FindTasksOptions, cwd?: string, accessor?: DataAccessor): Promise<FindTasksResult> {
  if (!options.query && !options.id) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Search query or --id is required');
  }

  const todoPath = getTodoPath(cwd);
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);

  let allTasks: Task[] = [...data.tasks];

  // Include archive if requested
  if (options.includeArchive) {
    if (accessor) {
      const archive = await accessor.loadArchive();
      if (archive?.archivedTasks) {
        allTasks = [...allTasks, ...archive.archivedTasks];
      }
    } else {
      const archivePath = getArchivePath(cwd);
      const archive = await readJson<{ archivedTasks: Task[] }>(archivePath);
      if (archive?.archivedTasks) {
        allTasks = [...allTasks, ...archive.archivedTasks];
      }
    }
  }

  // Apply status filter
  if (options.status) {
    allTasks = allTasks.filter(t => t.status === options.status);
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
      .filter(t => t.id.toUpperCase().startsWith(idQuery) || t.id.toUpperCase().includes(idQuery))
      .map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        type: t.type,
        parentId: t.parentId,
        score: t.id.toUpperCase() === idQuery ? 100 : t.id.toUpperCase().startsWith(idQuery) ? 80 : 50,
      }));
  } else if (options.exact) {
    // Exact title match
    searchType = 'exact';
    queryStr = options.query!;
    results = allTasks
      .filter(t => t.title === options.query)
      .map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        type: t.type,
        parentId: t.parentId,
        score: 100,
      }));
  } else {
    // Fuzzy search
    searchType = 'fuzzy';
    queryStr = options.query!;
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

  return {
    results,
    total,
    query: queryStr,
    searchType,
  };
}
