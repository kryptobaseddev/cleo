/**
 * `cleo doctor dep-cycles` — dependency cycles already stored.
 *
 * Since T12886 the `tasks_task_dependencies_cycle_guard_*` triggers refuse
 * every new edge that closes a cycle. Edges written before the guard existed
 * (or copied verbatim from a legacy store by exodus) can still form one, and
 * a cycle stalls every task on it: `cleo next`, ready waves and orchestration
 * wait for a blocker that waits for them.
 *
 * This check is READ-ONLY. It reports each cyclic component with one cycle
 * through it, and a repair plan: the edges whose removal leaves the graph
 * acyclic, each with the `cleo update … --remove-depends …` command. It never
 * removes an edge; the owner decides which dependency is wrong.
 *
 * @module
 * @task T12886
 */

import {
  type DependencyCycleReport,
  detectDependencyCycles,
  readDependencyEdges,
} from '../store/dependency-cycles.js';
import { getDb } from '../store/sqlite.js';

/** Outcome of {@link scanDependencyCycles}. */
export interface DependencyCyclesDoctorReport extends DependencyCycleReport {
  /** Number of cyclic components found. */
  readonly cycleCount: number;
  /** Always `true`: the check never writes. */
  readonly readOnly: true;
}

/**
 * Find stored dependency cycles and propose the edges to remove.
 *
 * @param cwd - Project root.
 * @returns The cyclic components and the repair plan; nothing is written.
 *
 * @example
 * ```ts
 * const report = await scanDependencyCycles(projectRoot);
 * for (const step of report.repairPlan) console.log(step.command);
 * ```
 *
 * @task T12886
 */
export async function scanDependencyCycles(cwd: string): Promise<DependencyCyclesDoctorReport> {
  const db = await getDb(cwd);
  const report = detectDependencyCycles(readDependencyEdges(db));
  return { ...report, cycleCount: report.components.length, readOnly: true };
}
