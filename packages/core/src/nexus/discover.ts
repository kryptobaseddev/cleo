/**
 * Nexus Discovery — Cross-project task discovery and search business logic.
 *
 * Extracted from src/dispatch/engines/nexus-engine.ts so the engine
 * remains a thin wrapper and all business logic lives in src/core/.
 *
 * @task T5701
 * @epic T5701
 */

import type {
  NexusDiscoverHit,
  NexusDiscoverParams,
  NexusDiscoverResult,
  NexusSearchHit,
  NexusSearchParams,
  NexusSearchResult,
} from '@cleocode/contracts/operations/nexus';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getAccessor } from '../store/data-accessor.js';
import { parseQuery, resolveTask, validateSyntax } from './query.js';
import { readRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Stop-word set for keyword extraction
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'shall',
  'can',
  'need',
  'dare',
  'to',
  'of',
  'in',
  'for',
  'on',
  'with',
  'at',
  'by',
  'from',
  'as',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'and',
  'but',
  'or',
  'nor',
  'not',
  'so',
  'yet',
  'both',
  'either',
  'neither',
  'each',
  'every',
  'all',
  'any',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'only',
  'own',
  'same',
  'than',
  'too',
  'very',
  'just',
  'because',
  'if',
  'when',
  'this',
  'that',
  'these',
  'those',
  'it',
  'its',
]);

/**
 * Extract meaningful keywords from text (filters stop words and short tokens).
 */
export function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Discover tasks related to a given task query across projects.
 *
 * Returns a structured result or throws on unrecoverable errors.
 * Validation errors (bad syntax, wildcard) are returned as { error } objects
 * so callers can wrap them in an appropriate engine error response.
 */
export async function discoverRelated(
  _projectRoot: string,
  params: NexusDiscoverParams,
): Promise<NexusDiscoverResult | { error: { code: string; message: string } }>;
/** @deprecated Use `discoverRelated(projectRoot, params)` — ADR-057 D1 */
export async function discoverRelated(
  taskQuery: string,
  method?: string,
  limit?: number,
): Promise<NexusDiscoverResult | { error: { code: string; message: string } }>;
export async function discoverRelated(
  projectRootOrQuery: string,
  paramsOrMethod?: NexusDiscoverParams | string,
  limitArg?: number,
): Promise<NexusDiscoverResult | { error: { code: string; message: string } }> {
  let taskQuery: string;
  let method: string;
  let limit: number;
  if (paramsOrMethod !== undefined && typeof paramsOrMethod === 'object') {
    taskQuery = paramsOrMethod.query;
    method = paramsOrMethod.method ?? 'auto';
    limit = paramsOrMethod.limit ?? 10;
  } else {
    taskQuery = projectRootOrQuery;
    method = (paramsOrMethod as string | undefined) ?? 'auto';
    limit = limitArg ?? 10;
  }
  if (!validateSyntax(taskQuery)) {
    return {
      error: {
        code: 'E_INVALID_INPUT',
        message: `Invalid query syntax: ${taskQuery}. Expected: T001, project:T001, .:T001, or *:T001`,
      },
    };
  }

  const sourceTask = await resolveTask(taskQuery);
  if (Array.isArray(sourceTask)) {
    return {
      error: {
        code: 'E_INVALID_INPUT',
        message: 'Wildcard queries not supported for discovery. Specify a single task.',
      },
    };
  }

  const sourceLabels = new Set(sourceTask.labels ?? []);
  const sourceDesc = (sourceTask.description ?? '').toLowerCase();
  const sourceTitle = (sourceTask.title ?? '').toLowerCase();
  const sourceWords = extractKeywords(sourceTitle + ' ' + sourceDesc);
  const parsed = parseQuery(taskQuery);

  const registry = await readRegistry();
  if (!registry) {
    return { query: taskQuery, method, results: [], total: 0 };
  }

  const candidates: NexusDiscoverHit[] = [];

  for (const project of Object.values(registry.projects)) {
    let tasks: Array<{
      id: string;
      title: string;
      description?: string;
      labels?: string[];
      status: string;
    }>;
    try {
      const accessor = await getAccessor(project.path);
      const { tasks: projectTasks } = await accessor.queryTasks({});
      tasks = projectTasks;
    } catch {
      continue;
    }

    for (const task of tasks) {
      if (task.id === parsed.taskId && project.name === parsed.project) continue;

      let score = 0;
      let matchType = 'none';
      let reason = '';

      if (method === 'labels' || method === 'auto') {
        const taskLabels = task.labels ?? [];
        const overlap = taskLabels.filter((l) => sourceLabels.has(l));
        if (overlap.length > 0) {
          const labelScore = overlap.length / Math.max(sourceLabels.size, taskLabels.length, 1);
          if (method === 'labels' || labelScore > score) {
            score = Math.max(score, labelScore);
            matchType = 'labels';
            reason = `Shared labels: ${overlap.join(', ')}`;
          }
        }
      }

      if (method === 'description' || method === 'auto') {
        const taskDesc = ((task.description ?? '') + ' ' + (task.title ?? '')).toLowerCase();
        const taskWords = extractKeywords(taskDesc);
        const commonWords = sourceWords.filter((w) => taskWords.includes(w));
        if (commonWords.length > 0) {
          const descScore = commonWords.length / Math.max(sourceWords.length, taskWords.length, 1);
          if (descScore > score) {
            score = descScore;
            matchType = 'description';
            reason = `Keyword match: ${commonWords.slice(0, 5).join(', ')}`;
          }
        }
      }

      if (score > 0) {
        candidates.push({
          project: project.name,
          taskId: task.id,
          title: task.title,
          score: Math.round(score * 100) / 100,
          type: matchType,
          reason,
        });
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const results = candidates.slice(0, limit);
  return { query: taskQuery, method, results, total: results.length };
}

/**
 * Search for tasks across all registered projects.
 *
 * Returns a structured result or throws on unrecoverable errors.
 * Validation errors (bad pattern) are returned as { error } objects.
 */
export async function searchAcrossProjects(
  _projectRoot: string,
  params: NexusSearchParams,
): Promise<NexusSearchResult | { error: { code: string; message: string } }>;
/** @deprecated Use `searchAcrossProjects(projectRoot, params)` — ADR-057 D1 */
export async function searchAcrossProjects(
  pattern: string,
  projectFilter?: string,
  limit?: number,
): Promise<NexusSearchResult | { error: { code: string; message: string } }>;
export async function searchAcrossProjects(
  projectRootOrPattern: string,
  paramsOrProjectFilter?: NexusSearchParams | string,
  limitArg?: number,
): Promise<NexusSearchResult | { error: { code: string; message: string } }> {
  let pattern: string;
  let projectFilter: string | undefined;
  let limit: number;
  if (paramsOrProjectFilter !== undefined && typeof paramsOrProjectFilter === 'object') {
    pattern = paramsOrProjectFilter.pattern;
    projectFilter = paramsOrProjectFilter.project;
    limit = paramsOrProjectFilter.limit ?? 20;
  } else {
    pattern = projectRootOrPattern;
    projectFilter = paramsOrProjectFilter as string | undefined;
    limit = limitArg ?? 20;
  }
  // Handle wildcard query syntax (*:T001) - delegate to resolveTask
  if (/^\*:.+$/.test(pattern)) {
    try {
      const result = await resolveTask(pattern);
      const tasks = Array.isArray(result) ? result : [result];
      const results = tasks.slice(0, limit).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority,
        description: t.description,
        _project: t._project,
      }));
      return { pattern, results, resultCount: results.length };
    } catch {
      // Fall through to pattern search if resolveTask fails
    }
  }

  const registry = await readRegistry();
  if (!registry) {
    return { pattern, results: [], resultCount: 0 };
  }

  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const regexPattern = escaped.replace(/\*/g, '.*');
  let regex: RegExp;
  try {
    regex = new RegExp(regexPattern, 'i');
  } catch {
    return {
      error: {
        code: 'E_INVALID_INPUT',
        message: `Invalid search pattern: ${pattern}`,
      },
    };
  }

  const results: NexusSearchHit[] = [];
  const projectEntries = projectFilter
    ? Object.values(registry.projects).filter((p) => p.name === projectFilter)
    : Object.values(registry.projects);

  if (projectFilter && projectEntries.length === 0) {
    return {
      error: {
        code: 'E_NOT_FOUND',
        message: `Project not found in registry: ${projectFilter}`,
      },
    };
  }

  for (const project of projectEntries) {
    let tasks: Array<{
      id: string;
      title: string;
      description?: string;
      status: string;
      priority?: string;
    }>;
    try {
      const accessor = await getAccessor(project.path);
      const { tasks: projectTasks } = await accessor.queryTasks({});
      tasks = projectTasks;
    } catch {
      continue;
    }

    for (const task of tasks) {
      const matchesId = regex.test(task.id);
      const matchesTitle = regex.test(task.title);
      const matchesDesc = regex.test(task.description ?? '');

      if (matchesId || matchesTitle || matchesDesc) {
        results.push({
          id: task.id,
          title: task.title,
          status: task.status,
          priority: task.priority,
          description: task.description,
          _project: project.name,
        });
      }
    }
  }

  const sliced = results.slice(0, limit);
  return { pattern, results: sliced, resultCount: sliced.length };
}

// ---------------------------------------------------------------------------
// EngineResult-returning wrappers (T1569 / ADR-057 / ADR-058)
// ---------------------------------------------------------------------------

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusDiscover(
  taskQuery: string,
  method: string = 'auto',
  limit: number = 10,
): Promise<
  EngineResult<{
    query: string;
    method: string;
    results: Array<{
      project: string;
      taskId: string;
      title: string;
      score: number;
      type: string;
      reason: string;
    }>;
    total: number;
  }>
> {
  try {
    const result = await discoverRelated('', { query: taskQuery, method, limit });
    if ('error' in result) {
      return engineError(result.error.code as 'E_INVALID_INPUT', result.error.message);
    }
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusSearch(
  pattern: string,
  projectFilter?: string,
  limit: number = 20,
): Promise<
  EngineResult<{
    pattern: string;
    results: Array<{
      id: string;
      title: string;
      status: string;
      priority?: string;
      description?: string;
      _project: string;
    }>;
    resultCount: number;
  }>
> {
  try {
    const result = await searchAcrossProjects('', { pattern, project: projectFilter, limit });
    if ('error' in result) {
      return engineError(
        result.error.code as 'E_INVALID_INPUT' | 'E_NOT_FOUND',
        result.error.message,
      );
    }
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}
