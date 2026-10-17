/**
 * `cleo goal status` — the project's drafted goals, the CLEO tasks they serve,
 * and the live run (T13821).
 *
 * The live run comes only from `cleo-goal status --json` (versioned; an
 * unknown schema version is refused), never from the runtime's internal files.
 * The drafted goals come from their `goal.yaml`, the contract CLEO writes.
 * Read-only.
 *
 * @epic T13791
 * @task T13821
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EngineResult, GoalDraftEntry, GoalStatusReport } from '@cleocode/contracts';
import { engineSuccess } from '@cleocode/contracts/engine-result.js';
import { parse as parseYaml } from 'yaml';
import { getProjectRoot } from '../paths.js';
import { GOAL_INSTALL_COMMAND, readGoalStatus } from './runtime.js';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const record = (v: Json | undefined): v is { [key: string]: Json } =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The tasks a contract serves: `cleo.tasks` and every task a criterion `proves`. */
function contractTasks(contract: { [key: string]: Json }): string[] {
  const ids = new Set<string>();
  const cleo = contract.cleo;
  if (record(cleo) && Array.isArray(cleo.tasks)) {
    for (const t of cleo.tasks) {
      const id = typeof t === 'string' ? t : record(t) && typeof t.id === 'string' ? t.id : '';
      if (id) ids.add(id);
    }
  }
  for (const c of Array.isArray(contract.criteria) ? contract.criteria : []) {
    if (!record(c) || !Array.isArray(c.proves)) continue;
    for (const ref of c.proves) if (typeof ref === 'string') ids.add(ref.split('#')[0] ?? ref);
  }
  return [...ids].sort();
}

/**
 * The drafted goals of a project, from each `.opencode/goals/<slug>/goal.yaml`.
 *
 * @param projectRoot - Project root.
 * @returns One entry per goal directory holding a `goal.yaml`, by slug.
 */
export function draftedGoals(projectRoot: string): GoalDraftEntry[] {
  const dir = join(projectRoot, '.opencode', 'goals');
  if (!existsSync(dir)) return [];
  const entries: GoalDraftEntry[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const contractPath = join(dir, d.name, 'goal.yaml');
    if (!d.isDirectory() || !existsSync(contractPath)) continue;
    const entry: GoalDraftEntry = { slug: d.name, title: null, tasks: [] };
    try {
      const contract = parseYaml(readFileSync(contractPath, 'utf8')) as Json;
      if (record(contract)) {
        entry.title = typeof contract.title === 'string' ? contract.title : null;
        entry.tasks = contractTasks(contract);
      }
    } catch (err) {
      entry.problem = `goal.yaml does not parse: ${(err as Error).message}`;
    }
    entries.push(entry);
  }
  return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * The drafted goals and the live run. A missing CLEO Goal bin is a report
 * (`runtime: 'not-installed'` with the install commands), not a failure; an
 * unknown status schema or a failing bin is a failure.
 *
 * @param opts - Project root, a task to filter by, and the environment.
 * @returns The report, or the runtime's refusal.
 * @example
 * ```ts
 * const r = goalStatus({ taskId: 'T123' });
 * if (r.success) r.data.live?.status; // the live run, when there is one
 * ```
 */
export function goalStatus(
  opts: {
    projectRoot?: string;
    taskId?: string;
    env?: Readonly<Record<string, string | undefined>>;
  } = {},
): EngineResult<GoalStatusReport> {
  const root = opts.projectRoot ?? getProjectRoot();
  const goals = draftedGoals(root).filter((g) => !opts.taskId || g.tasks.includes(opts.taskId));
  const live = readGoalStatus(root, opts.env);
  if (!live.success) {
    if (live.error.code !== 'E_GOAL_RUNTIME_MISSING') return live;
    return engineSuccess({
      runtime: 'not-installed',
      install: [GOAL_INSTALL_COMMAND, 'cleo goal install --harness opencode'],
      live: null,
      goals,
    });
  }
  // With --task, the live run counts only when it is one of that task's goals.
  const relevant =
    !opts.taskId || (live.data.goal !== null && goals.some((g) => g.slug === live.data.goal));
  return engineSuccess({ runtime: 'installed', live: relevant ? live.data : null, goals });
}
