/**
 * Explicit leaves of absorbing states (T12344; journal spec §3.6, inventory
 * §3.6.6 `task.status.absorbing`).
 *
 * An absorbing write (a task cancelled or done) overrides a newer ordinary
 * edit of its column, unless an explicit leave (a reopen, restore …) newer
 * than it produced the current value. Every replica must therefore know the
 * HLC of the latest explicit leave per (tbl, uid, col), whether the leave was
 * applied from the stream or authored here: row meta keeps only field HLCs,
 * so `_sync_field_leave` keeps the leaves.
 *
 * - The apply engine records the leave its merge decided (`FieldState.leave`).
 * - The sealer records a local leave: a sealed U whose `actor.op` is a leave
 *   op of the column's absorbing rule, moving it from an absorbing value
 *   to an ordinary one — the case in which a receiving replica's merge
 *   records the same leave.
 * - A delete clears the row's leaves with its fields.
 *
 * @module store/sync/field-leave
 * @task T12344
 */

import type { DatabaseSync } from 'node:sqlite';
import { LedgerActor, type LedgerWireValue } from '@cleocode/contracts/ledger';
import { SYNC_MERGE_RULES } from './merge/rules.js';

/** Column → encoded HLC of its latest explicit leave. */
export type FieldLeaves = Readonly<Record<string, string>>;

/**
 * The row's recorded leaves.
 *
 * @param db - The store (the journal schema applied).
 * @param tbl - Sync-set table.
 * @param uid - Row uid.
 * @returns Column → leave HLC; empty when none.
 */
export function readFieldLeaves(db: DatabaseSync, tbl: string, uid: string): FieldLeaves {
  const rows = db
    .prepare('SELECT col, hlc FROM _sync_field_leave WHERE tbl = ? AND uid = ?')
    .all(tbl, uid) as Array<{ col: string; hlc: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.col] = r.hlc;
  return out;
}

/**
 * Record leaves; a stored leave newer than the incoming one is kept.
 *
 * @param db - The store, inside the writer's transaction.
 * @param tbl - Sync-set table.
 * @param uid - Row uid.
 * @param leaves - Column → leave HLC.
 */
export function recordFieldLeaves(
  db: DatabaseSync,
  tbl: string,
  uid: string,
  leaves: FieldLeaves,
): void {
  const entries = Object.entries(leaves);
  if (entries.length === 0) return;
  const up = db.prepare(
    `INSERT INTO _sync_field_leave (tbl, uid, col, hlc) VALUES (?, ?, ?, ?)
     ON CONFLICT (tbl, uid, col) DO UPDATE SET hlc = excluded.hlc WHERE excluded.hlc > hlc`,
  );
  for (const [col, hlc] of entries) up.run(tbl, uid, col, hlc);
}

/**
 * Forget the row's leaves (its delete).
 *
 * @param db - The store, inside the writer's transaction.
 * @param tbl - Sync-set table.
 * @param uid - Row uid.
 */
export function clearFieldLeaves(db: DatabaseSync, tbl: string, uid: string): void {
  db.prepare('DELETE FROM _sync_field_leave WHERE tbl = ? AND uid = ?').run(tbl, uid);
}

/**
 * The explicit leaves a locally authored U op makes: per absorbing-rule
 * column, `actorOp` is one of the rule's leave ops and the column moves from
 * an absorbing value (`b`) to an ordinary one (`a`).
 *
 * @param tbl - Sync-set table.
 * @param op - The sealed op's changed values, before-image and HLC.
 * @param actorOp - The transaction's `actor.op`, or null.
 * @returns Column → `op.h` for every leave; empty when none.
 */
export function localLeaves(
  tbl: string,
  op: {
    readonly a?: Readonly<Record<string, LedgerWireValue>>;
    readonly b?: Readonly<Record<string, LedgerWireValue>>;
    readonly h: string;
  },
  actorOp: string | null,
): FieldLeaves {
  const rules = SYNC_MERGE_RULES[tbl]?.rules;
  if (!rules || actorOp === null) return {};
  const out: Record<string, string> = {};
  for (const [col, rule] of Object.entries(rules)) {
    if (rule.kind !== 'absorbing' || !rule.leaveOps.includes(actorOp)) continue;
    const before = op.b?.[col];
    const after = op.a?.[col];
    if (typeof before !== 'string' || after === undefined) continue;
    const afterAbsorbing = typeof after === 'string' && rule.states.includes(after);
    if (rule.states.includes(before) && !afterAbsorbing) out[col] = op.h;
  }
  return out;
}

/**
 * The `op` of a frame or transaction actor (JSON of a `LedgerActor`), or
 * null when the actor is absent, not JSON (a bare label such as
 * `fk_orphans`) or names no op.
 *
 * @param actor - The stored actor text.
 * @returns The actor's op, or null.
 */
export function actorOpOf(actor: string | null): string | null {
  if (actor === null || !actor.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(actor);
  } catch {
    return null;
  }
  const r = LedgerActor.safeParse(parsed);
  return r.success ? (r.data.op ?? null) : null;
}
