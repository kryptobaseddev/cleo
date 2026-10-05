/**
 * Typed-rule field state that row meta has no place for (T12344; journal spec
 * §3.6, inventory §3.6.6 `task.status.absorbing`, `task.pipeline-stage.max`).
 *
 * - **Leaves.** An absorbing write (a task cancelled or done) overrides a
 *   newer ordinary edit of its column, unless an explicit leave (a reopen …)
 *   newer than it produced the current value; a rank-max restore raises a
 *   floor below which writes are dead. Both are `FieldState.leave`.
 * - **Frontiers.** A rank-max column keeps its alive candidate writes
 *   (`FieldState.frontier`), so a later restore still finds the next best.
 *
 * Every replica must know both, whether applied from the stream or authored
 * here, so `_sync_field_leave` keeps them per (tbl, uid, col):
 * - the apply engine records what its merge decided;
 * - the sealer records a local leave: a sealed U whose `actor.op` is a leave
 *   op of the column's absorbing rule moving it off an absorbing value, or a
 *   restore op of its rank-max rule — the cases in which a receiving
 *   replica's merge records the same leave;
 * - a delete clears the row's state with its fields.
 *
 * @module store/sync/field-leave
 * @task T12344
 */

import type { DatabaseSync } from 'node:sqlite';
import { LedgerActor, LedgerWireValue } from '@cleocode/contracts/ledger';
import { z } from 'zod';
import { rankMaxFrontier } from './merge/engine.js';
import { SYNC_MERGE_RULES } from './merge/rules.js';
import { canonicalJson } from './sealer-values.js';

/** The stored frontier shape. */
const FrontierJson = z.array(z.object({ value: LedgerWireValue, hlc: z.string() }).strict());

/** Column → encoded HLC of its latest explicit leave. */
export type FieldLeaves = Readonly<Record<string, string>>;

/** A rank-max column's alive candidate writes, oldest first. */
export type FieldFrontier = ReadonlyArray<{
  readonly value: LedgerWireValue;
  readonly hlc: string;
}>;

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
    .prepare(
      'SELECT col, leave FROM _sync_field_leave WHERE tbl = ? AND uid = ? AND leave IS NOT NULL',
    )
    .all(tbl, uid) as Array<{ col: string; leave: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.col] = r.leave;
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
    `INSERT INTO _sync_field_leave (tbl, uid, col, leave) VALUES (?, ?, ?, ?)
     ON CONFLICT (tbl, uid, col) DO UPDATE SET leave = excluded.leave
     WHERE leave IS NULL OR excluded.leave > leave`,
  );
  for (const [col, hlc] of entries) up.run(tbl, uid, col, hlc);
}

/**
 * The row's rank-max frontiers.
 *
 * @param db - The store (the journal schema applied).
 * @param tbl - Sync-set table.
 * @param uid - Row uid.
 * @returns Column → frontier; empty when none.
 */
export function readFieldFrontiers(
  db: DatabaseSync,
  tbl: string,
  uid: string,
): Readonly<Record<string, FieldFrontier>> {
  const rows = db
    .prepare(
      'SELECT col, frontier FROM _sync_field_leave WHERE tbl = ? AND uid = ? AND frontier IS NOT NULL',
    )
    .all(tbl, uid) as Array<{ col: string; frontier: string }>;
  const out: Record<string, FieldFrontier> = {};
  for (const r of rows) {
    const parsed = FrontierJson.safeParse(JSON.parse(r.frontier));
    if (parsed.success) out[r.col] = parsed.data;
  }
  return out;
}

/**
 * Set rank-max frontiers as the merge left them; `null` clears one (the
 * current value is the only candidate again).
 *
 * @param db - The store, inside the writer's transaction.
 * @param tbl - Sync-set table.
 * @param uid - Row uid.
 * @param frontiers - Column → frontier, or null.
 */
export function setFieldFrontiers(
  db: DatabaseSync,
  tbl: string,
  uid: string,
  frontiers: Readonly<Record<string, FieldFrontier | null>>,
): void {
  const entries = Object.entries(frontiers);
  if (entries.length === 0) return;
  const up = db.prepare(
    `INSERT INTO _sync_field_leave (tbl, uid, col, frontier) VALUES (?, ?, ?, ?)
     ON CONFLICT (tbl, uid, col) DO UPDATE SET frontier = excluded.frontier`,
  );
  for (const [col, f] of entries) up.run(tbl, uid, col, f === null ? null : canonicalJson(f));
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
 * an absorbing value (`b`) to an ordinary one (`a`); per rank-max column the
 * op writes, `actorOp` is one of the rule's restore ops.
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
    if (rule.kind === 'rank-max') {
      // A restore raises the column's floor to its own HLC.
      if (rule.restoreOps.includes(actorOp) && op.a?.[col] !== undefined) out[col] = op.h;
      continue;
    }
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

/**
 * The stored rank-max frontiers a locally authored U op changes (T13232):
 * the local write joins each frontier the row already has, pruned exactly as
 * the merge prunes it, so the stored state stays the one every replica
 * folding the same writes holds. A frontier left with one candidate is
 * cleared (`null`). Columns without a stored frontier need nothing: the row's
 * own value is their only candidate.
 *
 * @param db - The store, inside the sealer's transaction.
 * @param tbl - Sync-set table.
 * @param uid - Row uid.
 * @param op - The sealed op's changed values and HLC.
 * @param leaves - The leaves this op records ({@link localLeaves}).
 * @returns Column → new frontier, or null to clear it.
 */
export function localFrontierUpdates(
  db: DatabaseSync,
  tbl: string,
  uid: string,
  op: { readonly a?: Readonly<Record<string, LedgerWireValue>>; readonly h: string },
  leaves: FieldLeaves,
): Record<string, FieldFrontier | null> {
  const rules = SYNC_MERGE_RULES[tbl]?.rules;
  if (!rules) return {};
  const out: Record<string, FieldFrontier | null> = {};
  let stored: Readonly<Record<string, FieldFrontier>> | undefined;
  let storedLeaves: FieldLeaves | undefined;
  for (const [col, rule] of Object.entries(rules)) {
    const value = op.a?.[col];
    if (rule.kind !== 'rank-max' || value === undefined) continue;
    stored ??= readFieldFrontiers(db, tbl, uid);
    const frontier = stored[col];
    if (!frontier) continue;
    storedLeaves ??= readFieldLeaves(db, tbl, uid);
    const floors = [storedLeaves[col], leaves[col]].filter((x): x is string => x !== undefined);
    const floor = floors.length > 0 ? floors.reduce((m, x) => (x > m ? x : m)) : undefined;
    const next = rankMaxFrontier(rule, { value, hlc: op.h, frontier }, { value, hlc: op.h }, floor);
    out[col] = next.length > 1 ? next : null;
  }
  return out;
}
