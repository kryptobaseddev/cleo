/**
 * Roadmap generation core module.
 * @task T4538
 * @epic T4454
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../../store/json.js';
import { getTodoPath } from '../paths.js';
import type { TodoFile } from '../../types/task.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Get roadmap from pending epics and CHANGELOG history. */
export async function getRoadmap(opts: {
  includeHistory?: boolean;
  upcomingOnly?: boolean;
  cwd?: string;
}, accessor?: DataAccessor): Promise<Record<string, unknown>> {
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJson<TodoFile>(getTodoPath(opts.cwd));
  const tasks = data?.tasks ?? [];

  // Get current version
  const versionPath = join(opts.cwd ?? process.cwd(), 'VERSION');
  const currentVersion = existsSync(versionPath)
    ? readFileSync(versionPath, 'utf-8').trim()
    : 'unknown';

  // Find epics (tasks that are parents of other tasks)
  const childParentIds = new Set(tasks.filter(t => t.parentId).map(t => t.parentId!));
  const epics = tasks.filter(t => childParentIds.has(t.id));

  // Group epics by status
  const pending = epics.filter(e => e.status !== 'done');
  const completed = epics.filter(e => e.status === 'done');

  // Parse CHANGELOG if requested
  let releaseHistory: Array<{ version: string; date: string }> = [];
  if (opts.includeHistory) {
    const changelogPath = join(opts.cwd ?? process.cwd(), 'CHANGELOG.md');
    if (existsSync(changelogPath)) {
      const content = readFileSync(changelogPath, 'utf-8');
      const versionRegex = /^##\s+\[?v?(\d+\.\d+\.\d+[^\]]*)\]?\s*[-\(]?\s*(\d{4}-\d{2}-\d{2})?/gm;
      let match;
      while ((match = versionRegex.exec(content)) !== null) {
        releaseHistory.push({
          version: match[1]!,
          date: match[2] ?? 'unknown',
        });
      }
    }
  }

  const upcoming = pending.map(e => ({
    id: e.id,
    title: e.title,
    status: e.status,
    priority: e.priority,
    phase: e.phase,
    childCount: tasks.filter(t => t.parentId === e.id).length,
    completedChildren: tasks.filter(t => t.parentId === e.id && t.status === 'done').length,
  }));

  return {
    currentVersion,
    upcoming,
    ...(opts.includeHistory && { releaseHistory }),
    ...(opts.includeHistory && { completedEpics: completed.length }),
    summary: {
      totalUpcoming: upcoming.length,
      totalTasks: tasks.length,
    },
  };
}
