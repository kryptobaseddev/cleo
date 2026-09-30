/**
 * Dependency-cycle guard support for `tasks_task_dependencies` (T12886).
 *
 * The guard itself is the pair of BEFORE triggers created by the
 * `drizzle-cleo-project/20260930160000_t12886-dependency-cycle-guard`
 * migration: every writer, raw SQL included, is refused with
 * {@link DEPENDENCY_CYCLE_CODE}. A trigger message must be a literal, so it
 * cannot say WHICH cycle. This module supplies that part:
 *
 * - {@link rethrowDependencyCycle} turns the trigger abort into a
 *   {@link CleoError} that names the cycle (`T1 → T2 → T3 → T1`) and says
 *   how to fix it. The write chokepoints call it.
 * - {@link detectDependencyCycles} finds cycles already stored (edges written
 *   before the guard existed) and proposes the edges to remove, for
 *   `cleo doctor dep-cycles`. It never writes.
 *
 * An edge `{ taskId, dependsOn }` means "taskId depends on dependsOn"; a cycle
 * is printed in that direction, each arrow reading "depends on".
 *
 * @module
 * @task T12886
 */

import { ExitCode } from '@cleocode/contracts';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { CleoError } from '../errors.js';
import * as schema from './tasks-schema.js';

/** Stable error code raised by the dependency-cycle triggers. */
export const DEPENDENCY_CYCLE_CODE = 'E_TASK_DEPENDENCY_CYCLE';

/** One dependency edge: `taskId` depends on `dependsOn`. */
export interface DependencyEdge {
  /** The dependent task. */
  readonly taskId: string;
  /** The task it waits for. */
  readonly dependsOn: string;
}

/** A proposed repair: remove this edge. */
export interface DependencyCycleRepair {
  /** The edge to remove. */
  readonly edge: DependencyEdge;
  /** The command that removes it. */
  readonly command: string;
  /** The cycle this removal breaks, in "depends on" order, first id repeated last. */
  readonly breaks: readonly string[];
}

/** One strongly connected component of the dependency graph that contains a cycle. */
export interface DependencyCycleComponent {
  /** Every task in the component, sorted. */
  readonly tasks: readonly string[];
  /** One cycle through the component, first id repeated last. */
  readonly cycle: readonly string[];
}

/** Result of {@link detectDependencyCycles}. */
export interface DependencyCycleReport {
  /** Edges examined. */
  readonly edgeCount: number;
  /** Components that contain at least one cycle (self-dependencies included). */
  readonly components: readonly DependencyCycleComponent[];
  /**
   * Edges whose removal leaves the graph acyclic: the back edges of one
   * depth-first traversal. Not guaranteed minimal (that problem is NP-hard);
   * review before applying.
   */
  readonly repairPlan: readonly DependencyCycleRepair[];
}

/** Render a cycle as `T1 → T2 → T1`. */
export function formatDependencyCycle(cycle: readonly string[]): string {
  return cycle.join(' → ');
}

function buildAdjacency(edges: Iterable<DependencyEdge>): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const { taskId, dependsOn } of edges) {
    const next = adjacency.get(taskId);
    if (next) next.push(dependsOn);
    else adjacency.set(taskId, [dependsOn]);
  }
  for (const next of adjacency.values()) next.sort();
  return adjacency;
}

/**
 * Shortest dependency path from `from` to `to` (breadth-first), or `null`.
 * Each task is visited once, so the walk is bounded by the number of tasks.
 */
function shortestPath(
  adjacency: ReadonlyMap<string, readonly string[]>,
  from: string,
  to: string,
): string[] | null {
  if (from === to) return [from];
  const previous = new Map<string, string>([[from, from]]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head] as string;
    for (const next of adjacency.get(id) ?? []) {
      if (previous.has(next)) continue;
      previous.set(next, id);
      if (next === to) {
        const path = [to];
        let cursor = id;
        while (cursor !== from) {
          path.push(cursor);
          cursor = previous.get(cursor) as string;
        }
        path.push(from);
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

/**
 * The cycle that `edge` would close over `existing`, or `null` when it closes none.
 *
 * @param existing - Edges already stored.
 * @param edge - The edge being added.
 * @returns The cycle in "depends on" order, starting and ending at `edge.taskId`.
 *
 * @example
 * ```ts
 * findClosedCycle([{ taskId: 'T2', dependsOn: 'T1' }], { taskId: 'T1', dependsOn: 'T2' });
 * // => ['T1', 'T2', 'T1']
 * ```
 */
export function findClosedCycle(
  existing: Iterable<DependencyEdge>,
  edge: DependencyEdge,
): string[] | null {
  if (edge.taskId === edge.dependsOn) return [edge.taskId, edge.taskId];
  const path = shortestPath(buildAdjacency(existing), edge.dependsOn, edge.taskId);
  return path ? [edge.taskId, ...path] : null;
}

/**
 * Build the error for an edge that closes `cycle`.
 *
 * @param edge - The refused edge.
 * @param cycle - The cycle it closes, from {@link findClosedCycle}.
 * @returns A {@link CleoError} naming the cycle, with a fix hint.
 */
export function dependencyCycleError(edge: DependencyEdge, cycle: readonly string[]): CleoError {
  const self = edge.taskId === edge.dependsOn;
  const message = self
    ? `${DEPENDENCY_CYCLE_CODE}: task ${edge.taskId} cannot depend on itself`
    : `${DEPENDENCY_CYCLE_CODE}: ${edge.taskId} depends on ${edge.dependsOn} would close a dependency cycle: ${formatDependencyCycle(cycle)}`;
  // The last existing edge of the cycle, the one that points back at taskId.
  const closing = cycle.length >= 3 ? cycle[cycle.length - 2] : undefined;
  const fix = self
    ? `Drop ${edge.taskId} from its own --depends list`
    : `Drop this dependency, or first remove another edge of the cycle, e.g. ` +
      `cleo update ${closing} --remove-depends ${edge.taskId}`;
  return new CleoError(ExitCode.CIRCULAR_REFERENCE, message, {
    fix,
    details: {
      field: 'depends',
      actual: edge.dependsOn,
      taskId: edge.taskId,
      cycle: [...cycle],
    },
  });
}

/**
 * True when `err` is the dependency-cycle trigger abort. Drizzle wraps the
 * SQLite error in a `DrizzleQueryError` whose own message is the failed SQL,
 * so the `cause` chain is searched too.
 */
export function isDependencyCycleAbort(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 8; depth++) {
    if (e.message.includes(DEPENDENCY_CYCLE_CODE)) return true;
    e = e.cause;
  }
  return false;
}

/**
 * Read every stored dependency edge.
 *
 * @param db - Drizzle handle on the project store.
 * @returns All rows of `tasks_task_dependencies`.
 */
export function readDependencyEdges(db: NodeSQLiteDatabase): DependencyEdge[] {
  return db
    .select({
      taskId: schema.taskDependencies.taskId,
      dependsOn: schema.taskDependencies.dependsOn,
    })
    .from(schema.taskDependencies)
    .all();
}

/**
 * Rethrow a write error, naming the cycle when it is the cycle-guard abort.
 *
 * Call it from the catch of a statement that inserted `attempted`. SQLite
 * rolls back the aborted statement, so the stored edges are the state before
 * it; the attempted edges are replayed over them in order to find the one
 * that closes a cycle.
 *
 * @param db - Drizzle handle the statement ran on.
 * @param err - The caught error.
 * @param attempted - The edges the statement tried to insert, in order.
 * @returns Never; always throws.
 */
export function rethrowDependencyCycle(
  db: NodeSQLiteDatabase,
  err: unknown,
  attempted: readonly DependencyEdge[],
): never {
  if (!isDependencyCycleAbort(err)) throw err;
  const edges = readDependencyEdges(db);
  for (const edge of attempted) {
    const cycle = findClosedCycle(edges, edge);
    if (cycle) throw dependencyCycleError(edge, cycle);
    edges.push(edge);
  }
  throw err;
}

/**
 * Find every stored dependency cycle and a repair plan. Pure: never writes.
 *
 * Tarjan's algorithm (iterative, so a long chain cannot overflow the stack)
 * finds the strongly connected components; any component with more than one
 * task, or a task that depends on itself, holds a cycle. The repair plan is
 * the back edges of a depth-first traversal, whose removal leaves the graph
 * acyclic.
 *
 * @param edges - The stored edges.
 * @returns Cyclic components and the edges to remove.
 *
 * @example
 * ```ts
 * const report = detectDependencyCycles(readDependencyEdges(db));
 * for (const r of report.repairPlan) console.log(r.command);
 * ```
 */
export function detectDependencyCycles(edges: readonly DependencyEdge[]): DependencyCycleReport {
  const adjacency = buildAdjacency(edges);
  const nodes = [...new Set(edges.flatMap((e) => [e.taskId, e.dependsOn]))].sort();

  // Tarjan SCC, iterative.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const frames: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as { id: string; next: number };
      const successors = adjacency.get(frame.id) ?? [];
      if (frame.next < successors.length) {
        const w = successors[frame.next++] as string;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          frames.push({ id: w, next: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.id, Math.min(low.get(frame.id) as number, index.get(w) as number));
        }
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) {
        low.set(parent.id, Math.min(low.get(parent.id) as number, low.get(frame.id) as number));
      }
      if (low.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop() as string;
          onStack.delete(w);
          component.push(w);
        } while (w !== frame.id);
        components.push(component.sort());
      }
    }
  }

  const cyclic = components.filter(
    (c) => c.length > 1 || (adjacency.get(c[0] as string) ?? []).includes(c[0] as string),
  );

  const reported: DependencyCycleComponent[] = cyclic
    .map((tasks) => {
      const start = tasks[0] as string;
      const members = new Set(tasks);
      const inside = new Map(
        tasks.map((t) => [t, (adjacency.get(t) ?? []).filter((n) => members.has(n))]),
      );
      // A cycle through `start`: shortest path from a successor back to it.
      let cycle: string[] = [start, start];
      for (const next of inside.get(start) ?? []) {
        const back = shortestPath(inside, next, start);
        if (back) {
          cycle = [start, ...back];
          break;
        }
      }
      return { tasks, cycle };
    })
    .sort((a, b) => (a.tasks[0] as string).localeCompare(b.tasks[0] as string));

  // Repair plan: back edges of one DFS over the cyclic components.
  const repairPlan: DependencyCycleRepair[] = [];
  const state = new Map<string, 'active' | 'done'>();
  for (const { tasks } of reported) {
    const members = new Set(tasks);
    for (const root of tasks) {
      if (state.has(root)) continue;
      const frames: Array<{ id: string; next: number }> = [{ id: root, next: 0 }];
      const path: string[] = [root];
      state.set(root, 'active');
      while (frames.length > 0) {
        const frame = frames[frames.length - 1] as { id: string; next: number };
        const successors = (adjacency.get(frame.id) ?? []).filter((n) => members.has(n));
        if (frame.next < successors.length) {
          const w = successors[frame.next++] as string;
          const seen = state.get(w);
          if (seen === undefined) {
            state.set(w, 'active');
            frames.push({ id: w, next: 0 });
            path.push(w);
          } else if (seen === 'active') {
            repairPlan.push({
              edge: { taskId: frame.id, dependsOn: w },
              command: `cleo update ${frame.id} --remove-depends ${w}`,
              breaks: [...path.slice(path.indexOf(w)), w],
            });
          }
          continue;
        }
        state.set(frame.id, 'done');
        frames.pop();
        path.pop();
      }
    }
  }

  return { edgeCount: edges.length, components: reported, repairPlan };
}
