/**
 * Next-task selection logic — coreTaskNext.
 * @task T10064
 * @epic T9834
 */

import type { ProjectMeta, Task } from '@cleocode/contracts';
import { getTaskAccessor } from '../store/data-accessor.js';
import { depsReady } from './deps-ready.js';

/** Task record shape expected from the data layer. */
type TaskRecord = Task;

const PRIORITY_SCORE: Record<string, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
};

async function loadAllTasks(projectRoot: string): Promise<TaskRecord[]> {
  const accessor = await getTaskAccessor(projectRoot);
  const { tasks } = await accessor.queryTasks({});
  return tasks;
}

/**
 * Suggest next task to work on based on priority, phase, age, and deps.
 *
 * @param projectRoot - Absolute path to the CLEO project root directory
 * @param params - Optional scoring configuration
 * @param params.count - Number of suggestions to return (default: 1)
 * @param params.explain - When true, include scoring reasons in each suggestion
 * @returns Ranked suggestions with scores and the total number of eligible candidates
 *
 * @remarks
 * Scoring considers priority weight, current phase alignment, dependency readiness,
 * task age, and brain success/failure pattern matches. Results are sorted descending by score.
 *
 * @example
 * ```typescript
 * const { suggestions } = await coreTaskNext('/project', { count: 3, explain: true });
 * console.log(suggestions[0].id, suggestions[0].score);
 * ```
 *
 * @task T4790
 */
export async function coreTaskNext(
  projectRoot: string,
  params?: { count?: number; explain?: boolean },
): Promise<{
  suggestions: Array<{
    id: string;
    title: string;
    priority: string;
    phase: string | null;
    score: number;
    reasons?: string[];
  }>;
  totalCandidates: number;
}> {
  const accessor = await getTaskAccessor(projectRoot);
  const allTasks = await loadAllTasks(projectRoot);
  const taskMap = new Map(allTasks.map((t) => [t.id, t]));

  const projectMeta = await accessor.getMetaValue<ProjectMeta>('project_meta');
  const currentPhase = projectMeta?.currentPhase ?? null;

  const candidates = allTasks.filter(
    (t) => t.status === 'pending' && !t.cancelledAt && depsReady(t.depends, taskMap),
  );

  if (candidates.length === 0) {
    return { suggestions: [], totalCandidates: 0 };
  }

  const scored = candidates
    .map((task) => {
      const reasons: string[] = [];
      let score = 0;

      score += PRIORITY_SCORE[task.priority] ?? 50;
      reasons.push(`priority: ${task.priority} (+${PRIORITY_SCORE[task.priority] ?? 50})`);

      if (currentPhase && task.phase === currentPhase) {
        score += 20;
        reasons.push(`phase alignment: ${currentPhase} (+20)`);
      }

      if (depsReady(task.depends, taskMap)) {
        score += 10;
        reasons.push('all dependencies satisfied (+10)');
      }

      if (task.createdAt) {
        const ageMs = Date.now() - new Date(task.createdAt).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays > 7) {
          const ageBonus = Math.min(15, Math.floor(ageDays / 7));
          score += ageBonus;
          reasons.push(`age: ${Math.floor(ageDays)} days (+${ageBonus})`);
        }
      }

      return { task, score, reasons };
    })
    .sort((a, b) => b.score - a.score);

  // Brain pattern scoring (best-effort)
  try {
    const { searchPatterns } = await import('../memory/patterns.js');
    const [successPatterns, failurePatterns] = await Promise.all([
      searchPatterns(projectRoot, { type: 'success', limit: 20 }),
      searchPatterns(projectRoot, { type: 'failure', limit: 20 }),
    ]);

    if (successPatterns.length > 0 || failurePatterns.length > 0) {
      for (const item of scored) {
        const titleLower = item.task.title.toLowerCase();
        const labels = (item.task.labels ?? []).map((l: string) => l.toLowerCase());
        const matchText = [titleLower, ...labels].join(' ');

        for (const sp of successPatterns) {
          if (matchText.includes(sp.pattern.toLowerCase())) {
            item.score += 10;
            item.reasons.push(`brain: success pattern match "${sp.pattern}" (+10)`);
            break;
          }
        }
        for (const fp of failurePatterns) {
          if (matchText.includes(fp.pattern.toLowerCase())) {
            item.score -= 5;
            item.reasons.push(`brain: failure pattern match "${fp.pattern}" (-5)`);
            break;
          }
        }
      }
      scored.sort((a, b) => b.score - a.score);
    }
  } catch {
    // Brain pattern scoring is best-effort
  }

  const count = Math.min(params?.count || 1, scored.length);
  const explain = params?.explain ?? false;

  const suggestions = scored.slice(0, count).map(({ task, score, reasons }) => ({
    id: task.id,
    title: task.title,
    priority: task.priority,
    phase: task.phase ?? null,
    score,
    ...(explain && { reasons }),
  }));

  return { suggestions, totalCandidates: candidates.length };
}
