/**
 * Gate C post-apply checks (T12344 PR-5; journal spec §3.6 "post-apply-check",
 * §3.5 Rule 3).
 *
 * The apply writes through the write API, never the TypeScript write paths,
 * so a merge of two ops each valid on its own device can produce a state the
 * CLI would refuse while no trigger notices. A post-apply check evaluates one
 * multi-row invariant over the transaction's page (the rows it wrote, plus
 * the footprint the invariant declares) after the transaction's ops applied,
 * inside the same frame. A violation rolls the whole transaction back: it
 * becomes a revivable void plus one `post-apply` conflict per violation.
 *
 * Implemented here, on the tables that sync today:
 * - PAC-01 `task.tree.shape` ({@link checkTaskTreeShape});
 * - PAC-15 `apply.preconditions` ({@link checkApplyPreconditions}), which is
 *   checked before a pass, not per transaction.
 * PAC-03 `task.dependency.graph` is trigger-covered since T12886
 * (`tasks_task_dependencies_cycle_guard_*`): a cycle-closing edge is a guard
 * conflict. The other families stay pending in the write-invariant registry
 * until their tables join the sync set.
 *
 * Read-only.
 *
 * @module store/sync/apply/post-apply
 * @task T12344
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TaskType } from '@cleocode/contracts';
import { isAllowedWorkGraphParentType } from '@cleocode/contracts/workgraph.js';
import { twinCollapseFailureOf } from '../../twin-collapse.js';

/** A row the transaction wrote. */
export interface PageRow {
  readonly table: string;
  readonly uid: string;
}

/** One broken invariant. */
export interface PostApplyViolation {
  /** The write-invariant registry id (e.g. `task.tree.shape`). */
  readonly check: string;
  readonly table: string;
  readonly uid: string;
  readonly message: string;
}

/** The deepest ancestor chain walked before a cycle is assumed. */
const MAX_TREE_DEPTH = 64;
const TASK_TYPES: ReadonlySet<string> = new Set(['saga', 'epic', 'task', 'subtask']);
const isTaskType = (t: string | null): t is TaskType => t !== null && TASK_TYPES.has(t);
const asTaskType = (t: string | null): TaskType | null => (isTaskType(t) ? t : null);

type TaskNode = { id: string; uid: string | null; parent_id: string | null; type: string | null };

function taskByUid(db: DatabaseSync, uid: string): TaskNode | undefined {
  return db
    .prepare('SELECT id, uid, parent_id, type FROM main.tasks_tasks WHERE uid = ?')
    .get(uid) as TaskNode | undefined;
}

function taskById(db: DatabaseSync, id: string): TaskNode | undefined {
  return db.prepare('SELECT id, uid, parent_id, type FROM main.tasks_tasks WHERE id = ?').get(id) as
    | TaskNode
    | undefined;
}

/**
 * PAC-01 `task.tree.shape` over the page: for every task the transaction
 * wrote, no self-parent, no ancestor cycle, a parent whose type may contain
 * it (saga → epic → task → subtask), and every child still allowed under its
 * (possibly changed) type. Root rules are left to the domain write paths.
 *
 * @param db - The store, inside the apply frame.
 * @param page - The rows the transaction wrote.
 * @returns The violations; empty when the shape holds.
 */
export function checkTaskTreeShape(
  db: DatabaseSync,
  page: readonly PageRow[],
): PostApplyViolation[] {
  const out: PostApplyViolation[] = [];
  const v = (uid: string, message: string): void => {
    out.push({ check: 'task.tree.shape', table: 'tasks_tasks', uid, message });
  };
  for (const row of page) {
    if (row.table !== 'tasks_tasks') continue;
    const t = taskByUid(db, row.uid);
    if (!t) continue;
    if (t.parent_id !== null && t.parent_id === t.id) {
      v(row.uid, `${t.id} is its own parent`);
      continue;
    }
    // Ancestor chain: no cycle.
    const seen = new Set<string>([t.id]);
    let cur = t.parent_id;
    for (let depth = 0; cur !== null; depth++) {
      if (seen.has(cur) || depth > MAX_TREE_DEPTH) {
        v(row.uid, `${t.id} is in a parent cycle`);
        break;
      }
      seen.add(cur);
      cur = taskById(db, cur)?.parent_id ?? null;
    }
    // Its parent may contain it.
    const type = asTaskType(t.type);
    if (t.parent_id !== null && type !== null) {
      const parentType = asTaskType(taskById(db, t.parent_id)?.type ?? null);
      if (parentType !== null && !isAllowedWorkGraphParentType(type, parentType)) {
        v(row.uid, `a ${parentType} cannot contain the ${type} ${t.id}`);
      }
    }
    // Its children are still allowed under its type (the trigger never re-checks them).
    if (type !== null) {
      const kids = db
        .prepare('SELECT id, uid, type FROM main.tasks_tasks WHERE parent_id = ?')
        .all(t.id) as Array<{ id: string; uid: string | null; type: string | null }>;
      for (const k of kids) {
        const kt = asTaskType(k.type);
        if (kt !== null && !isAllowedWorkGraphParentType(kt, type)) {
          v(row.uid, `the ${type} ${t.id} cannot contain its ${kt} ${k.id}`);
        }
      }
    }
  }
  return out;
}

/**
 * PAC-15 `apply.preconditions`: why no transaction may apply to this store
 * now, or null. A store whose twin collapse failed refuses every write
 * (T12535), so applying would half-write the stream.
 *
 * @param db - The store.
 * @returns The reason, or null.
 */
export function checkApplyPreconditions(db: DatabaseSync): string | null {
  const failure = twinCollapseFailureOf(db);
  return failure
    ? `twin collapse failed (${failure.tables.join(', ')}): no apply until it is repaired`
    : null;
}
