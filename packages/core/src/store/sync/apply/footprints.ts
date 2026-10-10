/**
 * Declared footprints of guards and post-apply checks (journal spec §3.5
 * Rule 3, R7-6; T13193 R-4a).
 *
 * A scoped rebase rewinds only the unsequenced local transactions whose
 * footprint meets the incoming one's. The rows an op writes and references
 * are not enough: a guard trigger or a post-apply check also READS other
 * rows (a parent chain, the children of a retyped task, a dependency
 * closure), and a local transaction whose verdict depends on those rows must
 * be rewound and replayed around a foreign write that changes them, or the
 * replicas decide it differently. Every guard trigger and post-apply check
 * declares what it reads here; a Gate test fails on a guard without a
 * declaration and on a declaration for a guard that no longer exists.
 *
 * A UNIQUE index reads the rows sharing its key; those reads are derived
 * from the schema ({@link uniqueKeyFootprint}), not declared.
 *
 * @task T13193
 * @module store/sync/apply/footprints
 */

import type { DatabaseSync } from 'node:sqlite';
import type { LedgerOp, LedgerWireValue } from '@cleocode/contracts/ledger';
import { UID_COLUMN } from '../../row-identity-registry.js';
import { type CaptureTableDef, enc } from '../capture.js';
import { decodeEnc } from '../sealer-values.js';
import { resolveRef, uidOfKey } from './refs.js';

/**
 * What a guard or a check reads beyond the op's own row:
 * - `row`: the written row only (nothing beyond the base footprint);
 * - `refs`: the rows the op's references name (already in the base footprint);
 * - `parent-chain`: every ancestor of the row's new parent (tasks);
 * - `children`: the row's current children (tasks);
 * - `dependency-closure`: every task the new dependency's target reaches.
 */
export type FootprintRead = 'row' | 'refs' | 'parent-chain' | 'children' | 'dependency-closure';

/** A declared footprint: the table the guard or check fires on, and what it reads. */
export interface DeclaredFootprint {
  readonly table: string;
  readonly reads: readonly FootprintRead[];
}

/**
 * Every guard trigger's footprint (the owned guards of `trigger-classes.ts`).
 * The Gate test in `footprints.test.ts` keeps this in step with the store.
 */
export const GUARD_FOOTPRINTS: Readonly<Record<string, DeclaredFootprint>> = {
  tasks_tasks_parent_cycle_guard_insert: { table: 'tasks_tasks', reads: ['parent-chain'] },
  tasks_tasks_parent_cycle_guard_update: { table: 'tasks_tasks', reads: ['parent-chain'] },
  tasks_tasks_parent_type_matrix_insert: { table: 'tasks_tasks', reads: ['refs'] },
  tasks_tasks_parent_type_matrix_update: { table: 'tasks_tasks', reads: ['refs'] },
  trg_tasks_tasks_status_pipeline_insert: { table: 'tasks_tasks', reads: ['row'] },
  trg_tasks_tasks_status_pipeline_update: { table: 'tasks_tasks', reads: ['row'] },
  tasks_task_relations_non_containment_insert: { table: 'tasks_task_relations', reads: ['refs'] },
  tasks_task_relations_non_containment_update: { table: 'tasks_task_relations', reads: ['refs'] },
  tasks_task_acceptance_child_target_insert: {
    table: 'tasks_task_acceptance_criteria',
    reads: ['refs'],
  },
  tasks_task_acceptance_child_target_update: {
    table: 'tasks_task_acceptance_criteria',
    reads: ['refs'],
  },
  trg_tasks_session_handoff_no_update: { table: 'tasks_session_handoff_entries', reads: ['row'] },
  tasks_tasks_lease_iso_insert: { table: 'tasks_tasks', reads: ['row'] },
  tasks_tasks_lease_iso_update: { table: 'tasks_tasks', reads: ['row'] },
  tasks_task_dependencies_cycle_guard_insert: {
    table: 'tasks_task_dependencies',
    reads: ['dependency-closure'],
  },
  tasks_task_dependencies_cycle_guard_update: {
    table: 'tasks_task_dependencies',
    reads: ['dependency-closure'],
  },
};

/**
 * Every post-apply check the apply runs (`post-apply.ts`), by the `check`
 * name its violations carry.
 */
export const POST_APPLY_FOOTPRINTS: Readonly<Record<string, DeclaredFootprint>> = {
  'task.tree.shape': { table: 'tasks_tasks', reads: ['refs', 'parent-chain', 'children'] },
};

/** How deep a parent chain or dependency closure is followed (the tree depth bound). */
const MAX_WALK = 10_000;

/** The reads declared for ops on `table`, over every guard and check. */
function readsOf(table: string): ReadonlySet<FootprintRead> {
  const out = new Set<FootprintRead>();
  for (const f of [...Object.values(GUARD_FOOTPRINTS), ...Object.values(POST_APPLY_FOOTPRINTS)]) {
    if (f.table === table) for (const r of f.reads) out.add(r);
  }
  return out;
}

type Add = (table: string, uid: string) => void;

/** The local id and parent of the task with `uid`, or undefined. */
function taskByUid(db: DatabaseSync, uid: string) {
  return db.prepare('SELECT id, parent_id FROM main.tasks_tasks WHERE uid = ?').get(uid) as
    | { id: string; parent_id: string | null }
    | undefined;
}

/** Add every ancestor of the task with local id `start` (itself included). */
function addParentChain(db: DatabaseSync, start: string | null, add: Add): void {
  const step = db.prepare('SELECT uid, parent_id FROM main.tasks_tasks WHERE id = ?');
  const seen = new Set<string>();
  for (let cur = start; cur !== null && !seen.has(cur) && seen.size < MAX_WALK; ) {
    seen.add(cur);
    const t = step.get(cur) as { uid: string | null; parent_id: string | null } | undefined;
    if (!t) return;
    if (t.uid) add('tasks_tasks', t.uid);
    cur = t.parent_id;
  }
}

/** Add every task the task with local id `start` reaches through dependencies (itself included). */
function addDependencyClosure(db: DatabaseSync, start: string, add: Add): void {
  const next = db.prepare('SELECT depends_on FROM main.tasks_task_dependencies WHERE task_id = ?');
  const uidOf = db.prepare('SELECT uid FROM main.tasks_tasks WHERE id = ?');
  const seen = new Set<string>([start]);
  for (const queue = [start]; queue.length > 0 && seen.size < MAX_WALK; ) {
    const id = queue.shift() as string;
    const u = uidOf.get(id) as { uid: string | null } | undefined;
    if (u?.uid) add('tasks_tasks', u.uid);
    for (const r of next.all(id) as Array<{ depends_on: string }>) {
      if (!seen.has(r.depends_on)) {
        seen.add(r.depends_on);
        queue.push(r.depends_on);
      }
    }
  }
}

/** The local key (text) a reference column of `op` names now, or null. */
function refKey(db: DatabaseSync, def: CaptureTableDef, op: LedgerOp, col: string): string | null {
  const v = op.a?.[col];
  const target = def.refs.get(col);
  if (!target || typeof v !== 'string') return null;
  const ref = resolveRef(db, target, v);
  return ref.kind === 'row' && typeof ref.key === 'string' ? ref.key : null;
}

/**
 * Widen `ops`' footprint by what their guards and checks read (the declared
 * reads beyond rows written and referenced, which the caller adds).
 *
 * @param db - The store.
 * @param ops - The ops.
 * @param defs - Capture definitions by table.
 * @param add - Adds a row to the footprint.
 */
export function widenFootprint(
  db: DatabaseSync,
  ops: readonly LedgerOp[],
  defs: (table: string) => CaptureTableDef | null,
  add: Add,
): void {
  for (const op of ops) {
    const def = defs(op.t);
    if (!def) continue;
    const reads = readsOf(op.t);
    if (op.t === 'tasks_tasks') {
      const reparents = op.o === 'I' || op.o === 'K' || (op.a !== undefined && 'parent_id' in op.a);
      const retypes = op.o === 'I' || op.o === 'K' || (op.a !== undefined && 'type' in op.a);
      if (reads.has('parent-chain') && reparents) {
        const parent = op.a && 'parent_id' in op.a ? refKey(db, def, op, 'parent_id') : null;
        addParentChain(db, parent ?? taskByUid(db, op.u)?.parent_id ?? null, add);
      }
      if (reads.has('children') && retypes) {
        const self = taskByUid(db, op.o === 'K' && op.nu ? op.nu : op.u);
        if (self) {
          for (const k of db
            .prepare('SELECT uid FROM main.tasks_tasks WHERE parent_id = ? AND uid IS NOT NULL')
            .all(self.id) as Array<{ uid: string }>) {
            add('tasks_tasks', k.uid);
          }
        }
      }
    }
    if (op.t === 'tasks_task_dependencies' && reads.has('dependency-closure')) {
      const target = refKey(db, def, op, 'depends_on');
      if (target !== null) addDependencyClosure(db, target, add);
    }
    uniqueKeyFootprint(db, def, op, add);
  }
}

/** The UNIQUE indexes of each table beyond its identity, by column list (cached per connection). */
const uniqueCache = new WeakMap<DatabaseSync, Map<string, string[][]>>();

function uniqueIndexes(db: DatabaseSync, def: CaptureTableDef): string[][] {
  let byTable = uniqueCache.get(db);
  if (!byTable) {
    byTable = new Map();
    uniqueCache.set(db, byTable);
  }
  let out = byTable.get(def.table);
  if (!out) {
    out = [];
    const identity = new Set([...def.key, UID_COLUMN]);
    for (const ix of db
      .prepare('SELECT name FROM pragma_index_list(?) WHERE "unique" = 1')
      .all(def.table) as Array<{ name: string }>) {
      const cols = (
        db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(ix.name) as Array<{
          name: string | null;
        }>
      ).map((c) => c.name);
      // An expression index is skipped; the identity's own keys add nothing a uid does not.
      const named = cols.filter((c): c is string => c !== null);
      if (named.length !== cols.length || named.every((c) => identity.has(c))) continue;
      out.push(named);
    }
    byTable.set(def.table, out);
  }
  return out;
}

/**
 * A UNIQUE index reads every row sharing its key: a local insert and a
 * foreign insert with the same key collide, though their uids differ (for
 * tasks, `idempotency_key`; for evidence bindings, atom + AC + type). Each
 * key an op writes in full (an insert, or an update setting every column of
 * the key) is a pseudo-row of the footprint (`#<cols>=<values>`, in wire
 * values, so references compare as uids on every replica). A key with a NULL
 * part never collides and is skipped.
 */
function uniqueKeyFootprint(db: DatabaseSync, def: CaptureTableDef, op: LedgerOp, add: Add): void {
  if (op.o !== 'I' && op.o !== 'U') return;
  for (const cols of uniqueIndexes(db, def)) {
    // A U that sets part of the key: the rest is the row's current value (T13274).
    const missing = op.o === 'U' ? cols.filter((c) => !(op.a !== undefined && c in op.a)) : [];
    if (missing.length === cols.length) continue; // the key does not move
    const current = missing.length > 0 ? currentWire(db, def, op.u, missing) : {};
    const values = cols.map((c) => (op.a !== undefined && c in op.a ? op.a[c] : current[c]));
    if (values.some((v) => v === undefined || v === null)) continue;
    add(def.table, `#${cols.join(',')}=${JSON.stringify(values)}`);
  }
}

/**
 * `cols` of the row with `uid` as wire values, as an op carries them (stored
 * values through `enc()`, references as their target's uid).
 */
function currentWire(
  db: DatabaseSync,
  def: CaptureTableDef,
  uid: string,
  cols: readonly string[],
): Record<string, LedgerWireValue> {
  const row = db
    .prepare(
      `SELECT ${cols.map((c) => `${enc(ident(c))} AS ${ident(c)}`).join(', ')} FROM main.${ident(def.table)} WHERE ${ident(UID_COLUMN)} = ?`,
    )
    .get(uid) as Record<string, string> | undefined;
  const out: Record<string, LedgerWireValue> = {};
  if (!row) return out;
  for (const c of cols) {
    const v = decodeEnc(row[c] as string);
    const target = def.refs.get(c);
    out[c] = target && v !== null ? (uidOfKey(db, target, v) ?? v) : v;
  }
  return out;
}

/** Quote an SQL identifier. */
function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}
