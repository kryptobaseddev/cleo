/**
 * Lessons: the curated, one-line-per-rule index of what went wrong and what
 * to do instead (T13949, owner decision D11181).
 *
 * A lesson is an observation of type `lesson`: the title holds the one-line
 * rule and the narrative holds why (the incident). Process lessons default to
 * the global (main) brain so every project and device reads them. The index
 * lists current lessons newest first; an invalidated (superseded) lesson is
 * hidden.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @module memory/lessons
 * @task T13949
 */

import type { DatabaseSync } from 'node:sqlite';

/** Longest one-line rule a lesson title may hold. */
export const LESSON_RULE_MAX = 200;

/** Which store a lessons read covers. */
export type LessonScope = 'project' | 'global' | 'all';

/** One row of the lessons index. */
export interface LessonEntry {
  /** Observation id. */
  id: string;
  /** The one-line rule (the observation title). */
  rule: string;
  /** Why: the incident behind the rule (the observation narrative). */
  why: string;
  /** Creation time, SQLite `datetime` shape. */
  createdAt: string;
  /** Store the lesson lives in. */
  scope: 'project' | 'global';
}

/**
 * Validate the one-line rule of a lesson before it is stored.
 *
 * @param title - The proposed rule; required for a lesson.
 * @returns An error message, or `null` when the rule is acceptable.
 * @example
 * ```ts
 * lessonRuleError('Run biome on the exact changed files before push'); // null
 * ```
 */
export function lessonRuleError(title: string | undefined): string | null {
  const rule = title?.trim() ?? '';
  if (!rule) return 'A lesson needs --title: the one-line rule (the text is the why)';
  if (/[\r\n]/.test(rule)) return 'A lesson rule (--title) must be one line';
  if (rule.length > LESSON_RULE_MAX)
    return `A lesson rule (--title) must be at most ${LESSON_RULE_MAX} characters`;
  return null;
}

/** Read current lessons from one store, newest first. */
function readLessons(db: DatabaseSync, scope: 'project' | 'global', limit: number): LessonEntry[] {
  return db
    .prepare(
      `SELECT id, title, narrative, created_at FROM main.brain_observations
       WHERE type = 'lesson' AND invalid_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(limit)
    .map((row) => ({
      id: String(row.id),
      rule: String(row.title ?? ''),
      why: String(row.narrative ?? ''),
      createdAt: String(row.created_at ?? ''),
      scope,
    }));
}

/**
 * List current lessons, newest first, from the project brain, the global
 * (main) brain, or both.
 *
 * With scope `all` each store is read on its own: a store that fails is
 * reported to `onStoreError` and the other store's lessons are still listed.
 * Only when every store fails does the call throw.
 *
 * @param projectRoot - Project whose brain is read for `project` / `all`.
 * @param options - `scope` (default `all`), `limit` (default 50) and
 *   `onStoreError`, told which store failed under scope `all`.
 * @returns Lessons merged across the requested stores, newest first.
 * @example
 * ```ts
 * const lessons = await listLessons(root, { scope: 'all', limit: 20 });
 * ```
 */
export async function listLessons(
  projectRoot: string,
  options: {
    scope?: LessonScope;
    limit?: number;
    onStoreError?: (scope: 'project' | 'global', error: Error) => void;
  } = {},
): Promise<LessonEntry[]> {
  const scope = options.scope ?? 'all';
  const limit = options.limit ?? 50;
  const readers: Array<['project' | 'global', () => Promise<LessonEntry[]>]> = [];
  if (scope !== 'global') {
    readers.push([
      'project',
      async () => {
        const { getBrainDb, getBrainNativeDb } = await import('../store/memory-sqlite.js');
        await getBrainDb(projectRoot);
        const db = getBrainNativeDb(projectRoot);
        // @sync-invariant none:local-only a read that cannot open the brain writes nothing
        if (!db) throw new Error('BRAIN database unavailable while listing lessons');
        return readLessons(db, 'project', limit);
      },
    ]);
  }
  if (scope !== 'project') {
    readers.push([
      'global',
      async () => {
        const { getDualScopeNativeDb, openDualScopeDb } = await import('../store/dual-scope-db.js');
        return readLessons(getDualScopeNativeDb(await openDualScopeDb('global')), 'global', limit);
      },
    ]);
  }
  const lessons: LessonEntry[] = [];
  const errors: Error[] = [];
  for (const [store, read] of readers) {
    try {
      lessons.push(...(await read()));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (readers.length === 1) throw error;
      errors.push(error);
      options.onStoreError?.(store, error);
    }
  }
  // @sync-invariant none:local-only a read that reached no store writes nothing
  if (errors.length === readers.length) throw errors[0];
  return lessons
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, limit);
}
