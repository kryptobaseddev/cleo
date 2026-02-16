/**
 * Semantic relationship discovery for CLEO tasks.
 * Discovers related tasks via shared labels, description keywords, files, and hierarchy.
 * Ported from lib/tasks/graph-rag.sh
 *
 * @epic T4454
 * @task T4529
 */

import type { Task } from '../../types/task.js';
import type { RelatesType, RelatesEntry } from './crossref-extract.js';

/** Discovery method. */
export type DiscoveryMethod = 'labels' | 'description' | 'files' | 'hierarchy' | 'auto';

/** A single discovery match. */
export interface DiscoveryMatch {
  taskId: string;
  type: RelatesType;
  reason: string;
  score: number;
  _hierarchyBoost?: number;
  _relationship?: string;
}

/** Common English stopwords for text comparison. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'must', 'shall', 'can',
  'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we',
  'they', 'what', 'which', 'who', 'when', 'where', 'why', 'how', 'all',
  'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'also', 'now', 'then', 'here', 'there', 'if', 'else', 'any',
]);

/**
 * Tokenize text: lowercase, remove punctuation, split, remove stopwords.
 */
function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/**
 * Calculate Jaccard similarity between two sets.
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }

  const union = new Set([...a, ...b]).size;
  if (union === 0) return 0;

  return intersection / union;
}

/**
 * Discover related tasks by shared labels.
 */
export function discoverByLabels(taskId: string, tasks: Task[]): DiscoveryMatch[] {
  const source = tasks.find((t) => t.id === taskId);
  if (!source?.labels?.length) return [];

  const sourceLabels = new Set(source.labels);
  const results: DiscoveryMatch[] = [];

  for (const task of tasks) {
    if (task.id === taskId) continue;
    if (!task.labels?.length) continue;

    const taskLabels = new Set(task.labels);
    const shared = [...sourceLabels].filter((l) => taskLabels.has(l));
    if (shared.length === 0) continue;

    const allLabels = new Set([...sourceLabels, ...taskLabels]);
    const score = shared.length / allLabels.size;

    results.push({
      taskId: task.id,
      type: 'relates-to',
      reason: `${shared.length} shared label(s): ${shared.join(', ')}`,
      score: Math.round(score * 100) / 100,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Discover related tasks by description similarity (keyword-based Jaccard).
 */
export function discoverByDescription(taskId: string, tasks: Task[]): DiscoveryMatch[] {
  const source = tasks.find((t) => t.id === taskId);
  if (!source) return [];

  const sourceText = `${source.title ?? ''} ${source.description ?? ''}`;
  const sourceTokens = tokenize(sourceText);
  if (sourceTokens.size === 0) return [];

  const results: DiscoveryMatch[] = [];

  for (const task of tasks) {
    if (task.id === taskId) continue;

    const text = `${task.title ?? ''} ${task.description ?? ''}`;
    const tokens = tokenize(text);
    if (tokens.size === 0) continue;

    const score = jaccardSimilarity(sourceTokens, tokens);
    if (score <= 0) continue;

    let sharedCount = 0;
    for (const t of sourceTokens) {
      if (tokens.has(t)) sharedCount++;
    }

    results.push({
      taskId: task.id,
      type: 'relates-to',
      reason: `${sharedCount} shared keyword(s)`,
      score: Math.round(score * 100) / 100,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Discover related tasks by shared files.
 */
export function discoverByFiles(taskId: string, tasks: Task[]): DiscoveryMatch[] {
  const source = tasks.find((t) => t.id === taskId);
  if (!source?.files?.length) return [];

  const sourceFiles = new Set(source.files);
  const results: DiscoveryMatch[] = [];

  for (const task of tasks) {
    if (task.id === taskId) continue;
    if (!task.files?.length) continue;

    const taskFiles = new Set(task.files);
    const shared = [...sourceFiles].filter((f) => taskFiles.has(f));
    if (shared.length === 0) continue;

    const allFiles = new Set([...sourceFiles, ...taskFiles]);
    const score = shared.length / allFiles.size;

    const preview = shared.slice(0, 3).join(', ');
    const suffix = shared.length > 3 ? '...' : '';

    results.push({
      taskId: task.id,
      type: 'relates-to',
      reason: `${shared.length} shared file(s): ${preview}${suffix}`,
      score: Math.round(score * 100) / 100,
    });
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Discover related tasks by hierarchical proximity (siblings and cousins).
 */
export function discoverByHierarchy(
  taskId: string,
  tasks: Task[],
  options?: { siblingBoost?: number; cousinBoost?: number },
): DiscoveryMatch[] {
  const { siblingBoost = 0.15, cousinBoost = 0.08 } = options ?? {};

  const source = tasks.find((t) => t.id === taskId);
  if (!source) return [];

  const results: DiscoveryMatch[] = [];

  // Find siblings (same parent)
  if (source.parentId) {
    const siblings = tasks.filter(
      (t) => t.parentId === source.parentId && t.id !== taskId,
    );
    for (const sib of siblings) {
      results.push({
        taskId: sib.id,
        type: 'relates-to',
        reason: `sibling (shared parent ${source.parentId})`,
        score: siblingBoost,
        _hierarchyBoost: siblingBoost,
        _relationship: 'sibling',
      });
    }

    // Find cousins (same grandparent, different parent)
    const parent = tasks.find((t) => t.id === source.parentId);
    if (parent?.parentId) {
      const auntsUncles = tasks.filter(
        (t) => t.parentId === parent.parentId && t.id !== source.parentId,
      );
      const auntUncleIds = new Set(auntsUncles.map((t) => t.id));
      const cousins = tasks.filter((t) => t.parentId && auntUncleIds.has(t.parentId));

      for (const cousin of cousins) {
        results.push({
          taskId: cousin.id,
          type: 'relates-to',
          reason: `cousin (shared grandparent ${parent.parentId})`,
          score: cousinBoost,
          _hierarchyBoost: cousinBoost,
          _relationship: 'cousin',
        });
      }
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/**
 * Discover related tasks using all methods combined.
 */
export function discoverRelatedTasks(
  taskId: string,
  tasks: Task[],
  method: DiscoveryMethod = 'auto',
): DiscoveryMatch[] {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return [];

  switch (method) {
    case 'labels':
      return discoverByLabels(taskId, tasks);
    case 'description':
      return discoverByDescription(taskId, tasks);
    case 'files':
      return discoverByFiles(taskId, tasks);
    case 'hierarchy':
      return discoverByHierarchy(taskId, tasks);
    case 'auto':
    default: {
      const labels = discoverByLabels(taskId, tasks);
      const description = discoverByDescription(taskId, tasks);
      const files = discoverByFiles(taskId, tasks);
      const hierarchy = discoverByHierarchy(taskId, tasks);

      // Merge: group by taskId, apply hierarchy boost
      const combined = new Map<string, DiscoveryMatch>();

      // Add base results (take highest score per taskId)
      for (const match of [...labels, ...description, ...files]) {
        const existing = combined.get(match.taskId);
        if (!existing || match.score > existing.score) {
          combined.set(match.taskId, { ...match });
        }
      }

      // Apply hierarchy boosts
      for (const hMatch of hierarchy) {
        const existing = combined.get(hMatch.taskId);
        if (existing) {
          existing.score = Math.min(existing.score + (hMatch._hierarchyBoost ?? 0), 1.0);
          existing._hierarchyBoost = hMatch._hierarchyBoost;
          existing._relationship = hMatch._relationship;
        } else {
          // Task only found via hierarchy
          combined.set(hMatch.taskId, { ...hMatch });
        }
      }

      return [...combined.values()].sort((a, b) => b.score - a.score);
    }
  }
}

/**
 * Suggest relates entries filtered by threshold.
 */
export function suggestRelates(
  taskId: string,
  tasks: Task[],
  threshold: number = 0.5,
): DiscoveryMatch[] {
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return [];

  const all = discoverRelatedTasks(taskId, tasks, 'auto');

  // Exclude already-related tasks
  const existingRelates = new Set<string>();
  // Tasks may have a `relates` field (not in the type but used at runtime)
  const taskAny = task as Task & { relates?: RelatesEntry[] };
  if (taskAny.relates) {
    for (const r of taskAny.relates) {
      existingRelates.add(r.taskId);
    }
  }

  return all.filter(
    (m) => m.score >= threshold && !existingRelates.has(m.taskId),
  );
}
