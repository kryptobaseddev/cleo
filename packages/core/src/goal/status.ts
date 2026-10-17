/**
 * `cleo goal status` — the goal/v1 runs of a project and the CLEO tasks they
 * serve, read-only (T13821).
 *
 * OpenCode-Goal keeps one directory per goal under `.opencode/goals/<slug>/`:
 * the contract (`goal.yaml`) and, once started, the run state (`run.json`).
 * OCG has no status CLI verb, so this reads those two files and writes
 * nothing; a file that does not parse is reported, never repaired.
 *
 * @epic T13791
 * @task T13821
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GoalRunSummary, GoalStatusEntry } from '@cleocode/contracts';
import { parse as parseYaml } from 'yaml';
import { getProjectRoot } from '../paths.js';

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

/** The run summary of an OCG `run.json`. */
function runSummary(run: { [key: string]: Json }): GoalRunSummary {
  const counts = { pass: 0, fail: 0, claimed: 0, unknown: 0 };
  if (record(run.criteria)) {
    for (const c of Object.values(run.criteria)) {
      const s = record(c) ? c.status : undefined;
      if (s === 'pass' || s === 'fail' || s === 'claimed') counts[s] += 1;
      else counts.unknown += 1;
    }
  }
  return {
    status: typeof run.status === 'string' ? run.status : 'unknown',
    turn: typeof run.turn === 'number' ? run.turn : 0,
    ...(typeof run.updatedAt === 'number' ? { updatedAt: run.updatedAt } : {}),
    criteria: counts,
  };
}

/**
 * The goals of a project, each with its tasks and run. Read-only.
 *
 * @param opts - Project root, and a task to filter by.
 * @returns One entry per goal directory holding a `goal.yaml`, by slug.
 * @example
 * ```ts
 * goalStatus({ taskId: 'T123' }); // the goals serving T123 and their runs
 * ```
 */
export function goalStatus(
  opts: { projectRoot?: string; taskId?: string } = {},
): GoalStatusEntry[] {
  const dir = join(opts.projectRoot ?? getProjectRoot(), '.opencode', 'goals');
  if (!existsSync(dir)) return [];
  const entries: GoalStatusEntry[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const contractPath = join(dir, d.name, 'goal.yaml');
    if (!d.isDirectory() || !existsSync(contractPath)) continue;
    const entry: GoalStatusEntry = { slug: d.name, title: null, tasks: [], run: null };
    try {
      const contract = parseYaml(readFileSync(contractPath, 'utf8')) as Json;
      if (record(contract)) {
        entry.title = typeof contract.title === 'string' ? contract.title : null;
        entry.tasks = contractTasks(contract);
      }
    } catch (err) {
      entry.problem = `goal.yaml does not parse: ${(err as Error).message}`;
    }
    const runPath = join(dir, d.name, 'run.json');
    if (existsSync(runPath)) {
      try {
        const run = JSON.parse(readFileSync(runPath, 'utf8')) as Json;
        if (record(run)) entry.run = runSummary(run);
      } catch (err) {
        entry.problem = `run.json does not parse: ${(err as Error).message}`;
      }
    }
    if (!opts.taskId || entry.tasks.includes(opts.taskId)) entries.push(entry);
  }
  return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}
