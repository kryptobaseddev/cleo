/**
 * Display ids, uid re-keys, their aliases, and the identity quarantine (T12341).
 *
 * `T####` is a per-project DISPLAY id: unique inside one store at rest, typed
 * by people and agents, but allocated locally, so two offline stores can
 * allocate the same one for different work. The row's uid is its identity
 * (`store/row-identity.ts`). Spec: `cleo docs fetch t12341-uid-scheme` §6.4, §9.
 *
 * ## Receiving a row: place it, or hold it
 *
 * An incoming row travels as a {@link WireRow}: its uid, its birth
 * fingerprint, its values, and every reference as the referenced row's
 * (uid, birth fingerprint) ({@link WireRef}). {@link receiveRow} places it in
 * its table, or HOLDS it in `tasks_identity_quarantine` (local-only) when it
 * cannot be placed yet:
 *
 * - `uid-collision`: a local row has its uid with a different birth
 *   fingerprint. Neither row is re-keyed here unless this replica is the
 *   authority ({@link rekeyRowUid}); the others wait for the published
 *   {@link RekeyReceipt} ({@link applyRekey}).
 * - `display-id-collision`: a local row holds its display id. The loser is
 *   re-numbered only by its authority ({@link remintTaskDisplayId}); the
 *   others wait for the {@link RemintOp} ({@link applyRemintOp}).
 * - `key-collision`: another local row holds its local key (a key derived
 *   from a local display id, such as an AC id); the merge engine re-derives
 *   the key (T12344).
 * - `ref-pending`: a reference does not resolve to a local row with the SAME
 *   birth fingerprint ({@link resolveWireRef}), e.g. it names the loser of a
 *   uid collision whose re-key has not arrived. It never resolves to the
 *   other row that shares the uid.
 *
 * Held rows never enter the task tables, so no validator, parser or command
 * ever sees an id that is not a `T####` (the round-1 provisional `prov-` ids
 * are gone). Every op that could unblock a held row re-tries the held rows
 * ({@link releaseHeld}).
 *
 * ## Display-id collision: one authority, ordered by HLC
 *
 * Every replica agrees on the loser ({@link collisionLoser}: the greater
 * uid). {@link remintAuthority} is a pure function of synced inputs (cloud
 * sync, the origin, replica membership with join / retire HLCs, the
 * collision's HLC) and a point in HLC time: the origin first, then each
 * active replica in turn for one takeover window, cycling, so a silent
 * authority is always taken over and nothing waits forever. Two authorities
 * may both re-mint around a window boundary: {@link applyRemintOp} keeps the
 * op with the greater HLC on every replica, whatever the arrival order, and
 * the other number becomes an alias.
 *
 * ## Uid collision: re-key the loser
 *
 * The loser is the greater birth fingerprint. {@link rekeyRowUid} asserts the
 * row it re-keys carries that fingerprint (a replica holding the winner never
 * re-keys it), gives it a random uid, and cascades from STORED identity:
 * minted children get {@link rekeyedChildUid} of their old uid and the new
 * owner uid, natural rows keyed by a re-keyed row are re-derived, stored uid
 * copies (`ac_uid`) and display-id aliases follow. The receipt lists every
 * value; receivers apply them ({@link applyRekey}) and never recompute.
 *
 * ## Gate 28
 *
 * Every write here goes through a chokepoint helper in
 * `sqlite-data-accessor.ts`; this module only reads and decides.
 *
 * @module
 * @task T12341
 * @task T12744
 * @task T12745
 * @task T12748
 * @task T12750
 * @epic T12323
 */

import type { DatabaseSync } from 'node:sqlite';
import { ExitCode, type RowIdentitySpec, type TaskClaimGuard } from '@cleocode/contracts';
import { getTableColumns } from 'drizzle-orm';
import { CleoError } from '../errors.js';
import {
  BIRTH_FP_COLUMN,
  fillTableUids,
  markRowIdentityShared,
  mintRowUid,
  naturalRowUid,
  ROW_IDENTITY,
  ROW_IDENTITY_META_TABLE,
  registerRowUidFunction,
  rekeyedChildUid,
  rowIdentitySpec,
  UID_COLUMN,
} from './row-identity.js';
import {
  advanceTaskIdSequence,
  clearRowUidNative,
  deleteDisplayIdAliasNative,
  deleteQuarantineNative,
  deleteRowIdentityMetaNative,
  insertDisplayIdAliasNative,
  insertIdentityRowNative,
  insertQuarantineNative,
  insertUidAliasNative,
  type QuarantineRow,
  rekeyQuarantineNative,
  renameTaskDisplayIdNative,
  rewriteStoredRefUidNative,
  setNaturalUidNative,
  setRowUidNative,
  type TaskReferenceColumn,
  writeRowIdentityMetaNative,
} from './sqlite-data-accessor.js';
import { tasks as tasksTable } from './tasks-schema.js';
import { insertTaskSchema } from './validation-schemas.js';

/** Physical name of the display-id alias table. */
export const DISPLAY_ID_ALIAS_TABLE = 'tasks_display_id_aliases';

/** Physical name of the uid re-key alias table. */
export const UID_ALIAS_TABLE = 'tasks_uid_aliases';

/** Physical name of the identity quarantine (local-only). */
export const QUARANTINE_TABLE = 'tasks_identity_quarantine';

/** Why a display id was displaced. */
export type DisplayIdAliasReason =
  | 'collision-remint'
  | 'superseded-remint'
  | 'split-brain-import'
  | 'manual';

// ---- HLC -------------------------------------------------------------------

/**
 * A hybrid logical clock value (T12342 owns the clock; this module needs only
 * its total order and its physical time). Encoded as
 * `<physical ms, 15 digits>.<counter, 6 digits>.<node>` so that string order
 * is HLC order.
 */
export interface Hlc {
  readonly physicalMs: number;
  readonly counter: number;
  readonly node: string;
}

const HLC_RE = /^(\d{15})\.(\d{6})\.(.+)$/;

/**
 * Encode an HLC value.
 *
 * @param hlc - The value.
 * @returns Its sortable string form.
 */
export function encodeHlc(hlc: Hlc): string {
  return `${String(hlc.physicalMs).padStart(15, '0')}.${String(hlc.counter).padStart(6, '0')}.${hlc.node}`;
}

/**
 * Parse an encoded HLC value.
 *
 * @param value - Encoded HLC.
 * @returns The value.
 * @throws Error when the value is not an encoded HLC.
 */
export function parseHlc(value: string): Hlc {
  const m = HLC_RE.exec(value);
  if (!m) throw new Error(`not an HLC value: ${value}`);
  return { physicalMs: Number(m[1]), counter: Number(m[2]), node: m[3] as string };
}

/**
 * Total order of two encoded HLC values.
 *
 * @param a - One value.
 * @param b - The other.
 * @returns Negative, zero or positive.
 */
export function compareHlc(a: string, b: string): number {
  const x = parseHlc(a);
  const y = parseHlc(b);
  if (x.physicalMs !== y.physicalMs) return x.physicalMs < y.physicalMs ? -1 : 1;
  if (x.counter !== y.counter) return x.counter < y.counter ? -1 : 1;
  return x.node < y.node ? -1 : x.node > y.node ? 1 : 0;
}

// ---- Shared helpers ---------------------------------------------------------

/** Quote an identifier for SQL. */
function q(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The declared project spec of `table`, or throw. */
function specOf(table: string): RowIdentitySpec {
  const spec = rowIdentitySpec('project', table);
  if (!spec) throw new Error(`row identity: ${table} is not a declared project table`);
  return spec;
}

/** The single-column key of a declared table. */
function keyOf(table: string): string {
  const spec = specOf(table);
  if (spec.key.length !== 1) throw new Error(`row identity: ${table} has a composite key`);
  return spec.key[0] as string;
}

/** Run `fn` in a uniquely named savepoint. */
function inSavepoint<T>(db: DatabaseSync, name: string, fn: () => T): T {
  const sp = `_cleo_${name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const out = fn();
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    return out;
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    throw error;
  }
}

/** A row-identity meta value. */
function readMeta(db: DatabaseSync, key: string): string | undefined {
  const row = db
    .prepare(`SELECT value FROM main.${q(ROW_IDENTITY_META_TABLE)} WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value;
}

/** The local row of a minted table with this uid AND birth fingerprint. */
function localRow(
  db: DatabaseSync,
  table: string,
  uid: string,
  birthFp: string,
): { key: string; rowid: number } | undefined {
  return db
    .prepare(
      `SELECT ${q(keyOf(table))} AS key, rowid AS rowid FROM main.${q(table)}
        WHERE ${q(UID_COLUMN)} = ? AND ${q(BIRTH_FP_COLUMN)} = ?`,
    )
    .get(uid, birthFp) as { key: string; rowid: number } | undefined;
}

// ---- Display-id collision: loser and authority -------------------------------

/**
 * Of two rows that carry the same display id, the one that must be re-minted:
 * the greater uid. Every replica picks the same one for the same pair, and for
 * UUIDv7 uids the older row keeps its id.
 *
 * @param a - Uid of one claimant.
 * @param b - Uid of the other.
 * @returns The uid to re-mint.
 */
export function collisionLoser(a: string, b: string): string {
  return a.toLowerCase() > b.toLowerCase() ? a : b;
}

/** A replica of the project, as the authority rule sees it (synced membership). */
export interface ProjectReplica {
  /** Replica id (T12342). */
  readonly id: string;
  /** HLC at which it joined the project. */
  readonly joinedHlc: string;
  /** HLC at which it was retired, when it was. */
  readonly retiredHlc?: string | null;
}

/** Why {@link remintAuthority} chose its authority. */
export type RemintAuthorityReason = 'server' | 'origin' | 'fallback';

/** Default length of one authority window (HLC physical time). */
export const REMINT_TAKEOVER_MS = 72 * 60 * 60 * 1000;

/** Inputs of {@link remintAuthority}: all synced, so every replica has the same. */
export interface RemintAuthorityInput {
  /** The project syncs to cloud: the server is the authority. */
  readonly cloudSynced: boolean;
  /** Replica that originated the losing row (`null`: backfilled before sync). */
  readonly origin: string | null;
  /** Project membership. */
  readonly replicas: readonly ProjectReplica[];
  /** When the collision came to exist: the later creation HLC of the two rows. */
  readonly collisionHlc: string;
  /** The HLC time to evaluate at (a replica's clock, or an op's HLC). */
  readonly atHlc: string;
  /** Window length; default {@link REMINT_TAKEOVER_MS}. */
  readonly takeoverAfterMs?: number;
}

/**
 * Which replica may re-mint the losing row of a display-id collision at HLC
 * time `atHlc` (spec §9.2). A pure function of synced inputs: every replica
 * evaluating the same time names the same authority.
 *
 * 1. The project syncs to cloud → the server.
 * 2. Else the origin, while it is an active member, for the first window
 *    after the collision.
 * 3. Else the FALLBACK CHAIN: the active members other than the origin,
 *    sorted, one window each, cycling. A fallback that stays silent loses its
 *    turn when its window ends, so a collision never waits forever.
 *
 * @param input - The facts every replica can see.
 * @returns The authority, the rule, and the window index (0 = origin).
 */
export function remintAuthority(input: RemintAuthorityInput): {
  readonly authority: string;
  readonly reason: RemintAuthorityReason;
  readonly slot: number;
} {
  if (input.cloudSynced) return { authority: 'server', reason: 'server', slot: 0 };
  const window = input.takeoverAfterMs ?? REMINT_TAKEOVER_MS;
  const elapsed = Math.max(
    0,
    parseHlc(input.atHlc).physicalMs - parseHlc(input.collisionHlc).physicalMs,
  );
  const active = input.replicas
    .filter(
      (r) =>
        compareHlc(r.joinedHlc, input.atHlc) <= 0 &&
        (r.retiredHlc == null || compareHlc(r.retiredHlc, input.atHlc) > 0),
    )
    .map((r) => r.id)
    .sort();
  if (active.length === 0) throw new Error('remint authority: the project has no active replica');
  const originLive = input.origin !== null && active.includes(input.origin);
  if (originLive && elapsed < window) {
    return { authority: input.origin as string, reason: 'origin', slot: 0 };
  }
  const others = active.filter((id) => id !== input.origin);
  const chain = others.length > 0 ? others : active;
  const turn = Math.floor(elapsed / window) - (originLive ? 1 : 0);
  return {
    authority: chain[turn % chain.length] as string,
    reason: 'fallback',
    slot: turn + 1,
  };
}

// ---- Display-id aliases -----------------------------------------------------

/** Where a displacement came from: the replica that authored it, and when (HLC). */
export interface Displacement {
  /** Replica that authored the displacement (the authority). */
  readonly origin?: string | null;
  /** HLC of the displacement. */
  readonly displacedHlc?: string | null;
  /** Wall-clock record time; defaults to now. */
  readonly now?: string;
}

/**
 * Record that `displayId` used to name the row (`entityUid`, `entityBirthFp`).
 * Idempotent.
 *
 * @param db - Connection on the project `cleo.db`.
 * @param entry - The displaced id, the row that carried it, and the displacement.
 */
export function recordDisplayIdAlias(
  db: DatabaseSync,
  entry: Displacement & {
    readonly table: string;
    readonly displayId: string;
    readonly entityUid: string;
    readonly entityBirthFp: string | null;
    readonly reason: DisplayIdAliasReason;
  },
): void {
  insertDisplayIdAliasNative(db, {
    uid: naturalRowUid('project', DISPLAY_ID_ALIAS_TABLE, [
      entry.table,
      entry.displayId,
      entry.entityUid,
    ]),
    entityTable: entry.table,
    displayId: entry.displayId,
    entityUid: entry.entityUid,
    entityBirthFp: entry.entityBirthFp,
    reason: entry.reason,
    origin: entry.origin ?? null,
    displacedHlc: entry.displacedHlc ?? null,
    createdAt: entry.now ?? new Date().toISOString(),
  });
}

/** A row that carries, or carried, a display id. */
export interface DisplayIdClaimant {
  /** Uid of the row (`null` for a live row whose uid is not filled yet). */
  readonly uid: string | null;
  /** Its display id today (`null`: the row is not placed here). */
  readonly currentId: string | null;
  /** `live` when it carries the id now, `alias` when it carried it before. */
  readonly via: 'live' | 'alias';
  /** Alias only: the replica that displaced it. */
  readonly origin?: string | null;
  /** Alias only: the HLC of the displacement. */
  readonly displacedHlc?: string | null;
}

/** Outcome of resolving a display id. */
export type DisplayIdResolution =
  | { readonly status: 'none' }
  | {
      readonly status: 'resolved';
      readonly claimant: DisplayIdClaimant;
      /** Rows that carried this id before (history; the live row still wins). */
      readonly alsoKnownAs: readonly DisplayIdClaimant[];
    }
  | { readonly status: 'ambiguous'; readonly candidates: readonly DisplayIdClaimant[] };

/**
 * Resolve a display id: a live row always wins (aliases come back as
 * history); with no live row, one alias resolves and several are ambiguous.
 *
 * @param db - Connection on the project `cleo.db`.
 * @param table - Display-id table (e.g. `tasks_tasks`).
 * @param displayId - The id to resolve.
 * @returns `resolved` (live, or the single alias), `ambiguous` with every
 *   candidate (callers report it as an error and never pick), or `none`.
 */
export function resolveDisplayId(
  db: DatabaseSync,
  table: string,
  displayId: string,
): DisplayIdResolution {
  const spec = specOf(table);
  if (!spec.displayId) throw new Error(`display id: ${table} has no declared display id`);
  const key = keyOf(table);
  const live = db
    .prepare(`SELECT ${q(UID_COLUMN)} AS uid FROM main.${q(table)} WHERE ${q(key)} = ?`)
    .get(displayId) as { uid: string | null } | undefined;
  const aliases = (
    db
      .prepare(
        `SELECT a.entity_uid AS uid, t.${q(key)} AS currentId, a.origin AS origin,
                a.displaced_hlc AS displacedHlc
           FROM ${DISPLAY_ID_ALIAS_TABLE} a
           LEFT JOIN main.${q(table)} t
             ON t.${q(UID_COLUMN)} = a.entity_uid
            AND (a.entity_birth_fp IS NULL OR t.${q(BIRTH_FP_COLUMN)} = a.entity_birth_fp)
          WHERE a.entity_table = ? AND a.display_id = ?
          ORDER BY a.displaced_hlc, a.entity_uid`,
      )
      .all(table, displayId) as {
      uid: string;
      currentId: string | null;
      origin: string | null;
      displacedHlc: string | null;
    }[]
  )
    .filter((a) => a.uid !== live?.uid)
    .map((a) => ({ ...a, via: 'alias' as const }));
  if (live) {
    return {
      status: 'resolved',
      claimant: { uid: live.uid, currentId: displayId, via: 'live' },
      alsoKnownAs: aliases,
    };
  }
  const [only] = aliases;
  if (!only) return { status: 'none' };
  if (aliases.length > 1) return { status: 'ambiguous', candidates: aliases };
  return { status: 'resolved', claimant: only, alsoKnownAs: [] };
}

/**
 * Allocate the next `T####` on the caller's handle, with the same lower bound
 * `allocateNextTaskId` uses (the highest stored numeric id). Only the re-mint
 * authority allocates for a collision.
 *
 * @param db - Connection on the project `cleo.db`.
 * @returns The new display id.
 */
export function allocateTaskDisplayId(db: DatabaseSync): string {
  const inventory = db
    .prepare(
      `SELECT COALESCE(MAX(CAST(substr(id, 2) AS INTEGER)), 0) AS maximum
         FROM tasks_tasks WHERE id GLOB 'T[0-9]*' AND substr(id, 2) NOT GLOB '*[^0-9]*'`,
    )
    .get() as { maximum: number };
  const counter = advanceTaskIdSequence(db, inventory.maximum);
  if (counter === undefined) {
    throw new CleoError(ExitCode.FILE_ERROR, 'Sequence counter not found during allocation', {
      fix: 'Run `cleo sequence repair` to re-seed the task-id sequence, then retry.',
    });
  }
  return `T${String(counter).padStart(3, '0')}`;
}

/** Every local column that holds a task's display id. */
function taskReferenceColumns(db: DatabaseSync): TaskReferenceColumn[] {
  const found = new Map<string, TaskReferenceColumn>();
  const add = (table: string, column: string, jsonArray: boolean) => {
    found.set(`${table}.${column}`, { table, column, jsonArray });
  };
  const fks = db
    .prepare(
      `SELECT m.name AS tbl, f."from" AS col
         FROM main.sqlite_master m, pragma_foreign_key_list(m.name) f
        WHERE m.type = 'table' AND f."table" = 'tasks_tasks'
          AND (f."to" IS NULL OR f."to" = 'id')`,
    )
    .all() as { tbl: string; col: string }[];
  for (const fk of fks) add(fk.tbl, fk.col, false);
  for (const spec of ROW_IDENTITY.project) {
    for (const ref of [...(spec.refs ?? []), ...(spec.keyRefs ?? []), ...(spec.owners ?? [])]) {
      if (ref.table === 'tasks_tasks') add(spec.table, ref.column, false);
    }
    for (const ref of spec.jsonArrayRefs ?? []) {
      if (ref.table === 'tasks_tasks') add(spec.table, ref.column, true);
    }
  }
  const tables = new Set(
    (
      db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[]
    ).map((r) => r.name),
  );
  return [...found.values()].filter((ref) => tables.has(ref.table));
}

// ---- Re-mint ops --------------------------------------------------------------

/**
 * The re-mint the authority publishes. Other replicas apply it verbatim
 * ({@link applyRemintOp}); they never recompute the number.
 */
export interface RemintOp {
  /** Uid of the re-minted task. */
  readonly uid: string;
  /** Its birth fingerprint (a uid can be shared by two rows during a uid collision). */
  readonly birthFp: string;
  /** The contested display id it was displaced from. */
  readonly oldId: string;
  /** The display id the authority gave it. */
  readonly newId: string;
  /** The authority that re-minted. */
  readonly origin: string | null;
  /** HLC of the re-mint: the greater HLC wins on every replica. */
  readonly hlc: string;
}

/** Receipt of a local re-mint: the op plus what was rewritten here. */
export interface RemintReceipt extends RemintOp {
  /** Rows rewritten per `table.column`. */
  readonly rewritten: Readonly<Record<string, number>>;
  /** Held rows placed because the re-mint freed their id. */
  readonly released: readonly HeldRowKey[];
}

/** The applied re-mint record of a row (meta key → JSON). */
interface RemintRecord {
  readonly newId: string;
  readonly hlc: string;
  readonly origin: string | null;
}

function remintKey(uid: string, birthFp: string): string {
  return `remint:tasks_tasks:${uid}:${birthFp}`;
}

function readRemint(db: DatabaseSync, uid: string, birthFp: string): RemintRecord | undefined {
  const raw = readMeta(db, remintKey(uid, birthFp));
  return raw === undefined ? undefined : (JSON.parse(raw) as RemintRecord);
}

function writeRemint(db: DatabaseSync, op: RemintOp): void {
  writeRowIdentityMetaNative(
    db,
    remintKey(op.uid, op.birthFp),
    JSON.stringify({ newId: op.newId, hlc: op.hlc, origin: op.origin } satisfies RemintRecord),
  );
}

/**
 * AUTHORITY ONLY ({@link remintAuthority}): give the losing task of a
 * display-id collision a new display id. Allocates the next `T####`, renames
 * through the chokepoint (version CAS, claim columns kept), records the
 * contested id as an alias and the op as the row's re-mint record, places any
 * held row the freed id unblocks, and returns the op to publish.
 *
 * @param db - Connection on the project `cleo.db`.
 * @param taskId - Current local display id of the task to re-mint.
 * @param options - The contested id (default: `taskId`), why, the authority,
 *   the op's HLC, and an optional version / claim guard for a manual rename.
 * @returns The op to publish, with what was rewritten here.
 * @throws CleoError NOT_FOUND when the task does not exist or has no identity yet.
 */
export function remintTaskDisplayId(
  db: DatabaseSync,
  taskId: string,
  options: {
    readonly reason: DisplayIdAliasReason;
    readonly origin: string | null;
    readonly hlc: string;
    readonly contestedId?: string;
    readonly now?: string;
    readonly guard?: { readonly expectedUpdatedAt?: string; readonly claim?: TaskClaimGuard };
  },
): RemintReceipt {
  const row = db
    .prepare('SELECT uid, birth_fp AS birthFp FROM tasks_tasks WHERE id = ?')
    .get(taskId) as { uid: string | null; birthFp: string | null } | undefined;
  if (!row?.uid || !row.birthFp) {
    throw new CleoError(ExitCode.NOT_FOUND, `No task ${taskId} with a uid and birth fingerprint`, {
      fix: 'Check the id with `cleo show`; row identity is filled when CLEO_ROW_UID_FILL=1.',
      details: { field: 'taskId', actual: taskId },
    });
  }
  const { uid, birthFp } = row;
  const oldId = options.contestedId ?? taskId;
  registerRowUidFunction(db, 'project');
  return inSavepoint(db, 'remint', () => {
    const newId = allocateTaskDisplayId(db);
    const { rewritten } = renameTaskDisplayIdNative(
      db,
      uid,
      newId,
      taskReferenceColumns(db),
      options.guard,
    );
    recordDisplayIdAlias(db, {
      table: 'tasks_tasks',
      displayId: oldId,
      entityUid: uid,
      entityBirthFp: birthFp,
      reason: options.reason,
      origin: options.origin,
      displacedHlc: options.hlc,
      now: options.now,
    });
    const op: RemintOp = { uid, birthFp, oldId, newId, origin: options.origin, hlc: options.hlc };
    writeRemint(db, op);
    const released = releaseHeldRows(db, [
      { table: 'tasks_tasks', key: taskId },
      { table: 'tasks_tasks', key: oldId },
    ]);
    return { ...op, rewritten, released };
  });
}

/** Outcome of {@link applyRemintOp}. */
export type ApplyRemintResult =
  | { readonly status: 'applied'; readonly receipt: RemintReceipt }
  /** The row is not placed here (held or not yet received): the op is recorded
   * and the row takes `newId` when it is placed. */
  | { readonly status: 'recorded'; readonly released: readonly HeldRowKey[] }
  | { readonly status: 'already-applied' }
  /** An op with a greater HLC was applied already; this one's number became an alias. */
  | { readonly status: 'superseded'; readonly winner: RemintRecord }
  /** The new id is held here by another row: a NEW collision for its authority. */
  | { readonly status: 'conflict'; readonly holderUid: string | null };

/**
 * NON-AUTHORITY: apply a re-mint an authority published. Of several ops for
 * one row, the one with the greatest HLC wins on every replica, whatever the
 * arrival order: a lesser op is recorded as an alias (`superseded`), a greater
 * one renames the row again and turns the previous number into an alias.
 * Never allocates.
 *
 * @param db - Connection on the project `cleo.db`.
 * @param op - The published re-mint.
 * @returns What happened.
 */
export function applyRemintOp(db: DatabaseSync, op: RemintOp): ApplyRemintResult {
  registerRowUidFunction(db, 'project');
  markRowIdentityShared(db, 'receive');
  const prior = readRemint(db, op.uid, op.birthFp);
  const alias = (displayId: string, reason: DisplayIdAliasReason) =>
    recordDisplayIdAlias(db, {
      table: 'tasks_tasks',
      displayId,
      entityUid: op.uid,
      entityBirthFp: op.birthFp,
      reason,
      origin: op.origin,
      displacedHlc: op.hlc,
    });
  if (prior) {
    const order = compareHlc(op.hlc, prior.hlc);
    if (order === 0) return { status: 'already-applied' };
    if (order < 0) {
      inSavepoint(db, 'remint_superseded', () => {
        alias(op.oldId, 'collision-remint');
        if (op.newId !== prior.newId) alias(op.newId, 'superseded-remint');
      });
      return { status: 'superseded', winner: prior };
    }
  }
  const live = localRow(db, 'tasks_tasks', op.uid, op.birthFp);
  if (live) {
    const holder = db.prepare('SELECT uid FROM tasks_tasks WHERE id = ?').get(op.newId) as
      | { uid: string | null }
      | undefined;
    if (holder && holder.uid !== op.uid) return { status: 'conflict', holderUid: holder.uid };
  }
  return inSavepoint(db, 'remint_apply', (): ApplyRemintResult => {
    alias(op.oldId, 'collision-remint');
    if (prior && prior.newId !== op.newId) alias(prior.newId, 'superseded-remint');
    writeRemint(db, op);
    if (!live) {
      const held = { entityTable: 'tasks_tasks', uid: op.uid, birthFp: op.birthFp };
      return {
        status: 'recorded',
        released: releaseHeldRows(db, [{ table: 'tasks_tasks', held }]),
      };
    }
    if (live.key === op.newId) return { status: 'already-applied' };
    const { rewritten } = renameTaskDisplayIdNative(db, op.uid, op.newId, taskReferenceColumns(db));
    return {
      status: 'applied',
      receipt: {
        ...op,
        rewritten,
        released: releaseHeldRows(db, [{ table: 'tasks_tasks', key: live.key }]),
      },
    };
  });
}

// ---- Wire rows, references and the quarantine --------------------------------

/** A value a wire row carries. */
export type WireValue = string | number | null;

/** A reference on the wire: the referenced row's uid and birth fingerprint. */
export interface WireRef {
  readonly uid: string;
  /** `null` for a natural target (its uid is a pure function; no fingerprint). */
  readonly birthFp: string | null;
}

/** An incoming row (the merge engine, T12344, builds these from the outbox). */
export interface WireRow {
  readonly table: string;
  readonly uid: string;
  /** Birth fingerprint (minted tables); `null` for natural rows. */
  readonly birthFp: string | null;
  /** Column values. Reference columns are replaced by resolving {@link refs}. */
  readonly values: Readonly<Record<string, WireValue>>;
  /** Reference column → the referenced row's identity, or `null` for NULL. */
  readonly refs?: Readonly<Record<string, WireRef | null>>;
}

/** Why a row is held. */
export type HoldReason = QuarantineRow['reason'];

/** The key of a held row. */
export interface HeldRowKey {
  readonly entityTable: string;
  readonly uid: string;
  readonly birthFp: string;
}

/** A uid collision found while receiving. */
export interface UidCollision {
  readonly kind: 'uid';
  readonly table: string;
  readonly uid: string;
  /** The smaller fingerprint keeps the uid. */
  readonly winnerBirthFp: string;
  /** The greater fingerprint is re-keyed by its authority. */
  readonly loserBirthFp: string;
  /** True when the local (placed) row is the loser. */
  readonly localIsLoser: boolean;
}

/** A display-id collision found while receiving. */
export interface DisplayIdCollision {
  readonly kind: 'display-id';
  readonly table: string;
  readonly displayId: string;
  readonly loserUid: string;
  readonly localIsLoser: boolean;
}

/** Outcome of {@link receiveRow}. */
export type ReceiveResult =
  | { readonly status: 'inserted'; readonly key: string; readonly uid: string }
  | { readonly status: 'duplicate'; readonly uid: string }
  | {
      readonly status: 'held';
      readonly reason: HoldReason;
      readonly collision?: UidCollision | DisplayIdCollision;
    };

/** Outcome of {@link resolveWireRef}. */
export type WireRefResolution =
  | { readonly status: 'row'; readonly key: string; readonly uid: string }
  | { readonly status: 'held' }
  | { readonly status: 'pending' };

/** Follow `tasks_uid_aliases` from (uid, birth fp) to the row's current uid. */
function followUidAlias(db: DatabaseSync, table: string, uid: string, birthFp: string): string {
  let current = uid;
  for (let hop = 0; hop < 32; hop++) {
    const alias = db
      .prepare(
        `SELECT new_uid AS uid FROM ${UID_ALIAS_TABLE}
          WHERE entity_table = ? AND old_uid = ? AND old_birth_fp = ?`,
      )
      .get(table, current, birthFp) as { uid: string } | undefined;
    if (!alias) break;
    current = alias.uid;
  }
  return current;
}

/**
 * Resolve a wire reference to a local row: the row with that uid AND that
 * birth fingerprint, following `tasks_uid_aliases` when the target was
 * re-keyed. A row that has the uid with ANOTHER fingerprint (the other side of
 * a uid collision) never matches: the reference is `held` (its target waits
 * in the quarantine) or `pending` (its target has not arrived, or its re-key
 * has not), and the referencing row waits too.
 *
 * @param db - Connection on the project `cleo.db`.
 * @param table - The referenced table.
 * @param ref - The reference.
 * @returns Where it points.
 */
export function resolveWireRef(db: DatabaseSync, table: string, ref: WireRef): WireRefResolution {
  const minted = specOf(table).kind === 'minted';
  const uid =
    minted && ref.birthFp !== null ? followUidAlias(db, table, ref.uid, ref.birthFp) : ref.uid;
  const row = db
    .prepare(
      `SELECT ${q(keyOf(table))} AS key, ${minted ? q(BIRTH_FP_COLUMN) : 'NULL'} AS fp
         FROM main.${q(table)} WHERE ${q(UID_COLUMN)} = ?`,
    )
    .get(uid) as { key: string; fp: string | null } | undefined;
  if (row && (!minted || ref.birthFp === null || row.fp === ref.birthFp)) {
    return { status: 'row', key: row.key, uid };
  }
  const held = db
    .prepare(
      `SELECT 1 AS x FROM ${QUARANTINE_TABLE} WHERE entity_table = ? AND uid = ? AND birth_fp = ?`,
    )
    .get(table, uid, ref.birthFp ?? '');
  return held ? { status: 'held' } : { status: 'pending' };
}

/** Reference column → referenced table, for a declared table. */
function refTargets(spec: RowIdentitySpec): Map<string, string> {
  const out = new Map<string, string>();
  for (const ref of [...(spec.refs ?? []), ...(spec.owners ?? []), ...(spec.keyRefs ?? [])]) {
    out.set(ref.column, ref.table);
  }
  return out;
}

/** Hold a row, keeping the time it was first held. */
function hold(
  db: DatabaseSync,
  wire: WireRow,
  reason: HoldReason,
  contestedId: string | null,
  previous: HeldRowKey | undefined,
): void {
  const key: HeldRowKey = { entityTable: wire.table, uid: wire.uid, birthFp: wire.birthFp ?? '' };
  const was = previous ?? key;
  const rowJson = JSON.stringify(wire);
  const first = db
    .prepare(
      `SELECT created_at AS createdAt, reason, contested_id AS contestedId, row_json AS rowJson
         FROM ${QUARANTINE_TABLE} WHERE entity_table = ? AND uid = ? AND birth_fp = ?`,
    )
    .get(was.entityTable, was.uid, was.birthFp) as
    | { createdAt: string; reason: string; contestedId: string | null; rowJson: string }
    | undefined;
  // A still-held row that is held for the same reason is never rewritten (T12801).
  if (
    first &&
    was === key &&
    first.reason === reason &&
    first.contestedId === contestedId &&
    first.rowJson === rowJson
  ) {
    return;
  }
  if (previous) deleteQuarantineNative(db, previous);
  insertQuarantineNative(db, {
    ...key,
    reason,
    contestedId,
    rowJson,
    receivedHlc: null,
    createdAt: first?.createdAt ?? new Date().toISOString(),
  });
}

/** Place one wire row, or hold it. Does not re-try other held rows. */
function placeRow(db: DatabaseSync, incoming: WireRow, heldAs?: HeldRowKey): ReceiveResult {
  const spec = specOf(incoming.table);
  const minted = spec.kind === 'minted';
  if (minted && !incoming.birthFp) {
    throw new Error(`receive: a ${incoming.table} row must carry its birth fingerprint`);
  }
  // A late copy of a row that was re-keyed: follow its uid alias.
  const wire: WireRow = minted
    ? {
        ...incoming,
        uid: followUidAlias(db, incoming.table, incoming.uid, incoming.birthFp as string),
      }
    : incoming;
  const done = () => {
    if (heldAs) deleteQuarantineNative(db, heldAs);
  };
  // A natural row is matched by its key AFTER its references resolve (below):
  // its wire uid hashes endpoint uids, and an endpoint under a uid collision
  // would make two different edges look like one.
  const same = minted
    ? (db
        .prepare(
          `SELECT ${q(BIRTH_FP_COLUMN)} AS fp FROM main.${q(wire.table)} WHERE ${q(UID_COLUMN)} = ?`,
        )
        .get(wire.uid) as { fp: string | null } | undefined)
    : undefined;
  if (same) {
    if (same.fp === wire.birthFp) {
      done();
      return { status: 'duplicate', uid: wire.uid };
    }
    const local = same.fp ?? '';
    const other = wire.birthFp as string;
    const localIsLoser = local > other;
    hold(db, wire, 'uid-collision', null, heldAs);
    return {
      status: 'held',
      reason: 'uid-collision',
      collision: {
        kind: 'uid',
        table: wire.table,
        uid: wire.uid,
        winnerBirthFp: localIsLoser ? other : local,
        loserBirthFp: localIsLoser ? local : other,
        localIsLoser,
      },
    };
  }
  const values: Record<string, WireValue> = { ...wire.values };
  const targets = refTargets(spec);
  for (const [column, ref] of Object.entries(wire.refs ?? {})) {
    const target = targets.get(column);
    if (!target) throw new Error(`receive: ${wire.table}.${column} is not a declared reference`);
    if (ref === null) {
      values[column] = null;
      continue;
    }
    const resolved = resolveWireRef(db, target, ref);
    if (resolved.status !== 'row') {
      hold(db, wire, 'ref-pending', null, heldAs);
      return { status: 'held', reason: 'ref-pending' };
    }
    values[column] = resolved.key;
  }
  if (spec.displayId && minted) {
    const key = keyOf(wire.table);
    const remint = readRemint(db, wire.uid, wire.birthFp as string);
    if (remint) values[key] = remint.newId;
    const holder = db
      .prepare(`SELECT ${q(UID_COLUMN)} AS uid FROM main.${q(wire.table)} WHERE ${q(key)} = ?`)
      .get(values[key] ?? null) as { uid: string | null } | undefined;
    if (holder) {
      const contested = String(values[key]);
      const loserUid = collisionLoser(holder.uid ?? '', wire.uid);
      hold(db, wire, 'display-id-collision', contested, heldAs);
      return {
        status: 'held',
        reason: 'display-id-collision',
        collision: {
          kind: 'display-id',
          table: wire.table,
          displayId: contested,
          loserUid,
          localIsLoser: loserUid === holder.uid,
        },
      };
    }
  }
  if (!minted) {
    const existing = db
      .prepare(
        `SELECT ${q(UID_COLUMN)} AS uid FROM main.${q(wire.table)}
          WHERE ${spec.key.map((k) => `${q(k)} = ?`).join(' AND ')}`,
      )
      .get(...spec.key.map((k) => values[k] ?? null)) as { uid: string | null } | undefined;
    if (existing) {
      done();
      return { status: 'duplicate', uid: existing.uid ?? wire.uid };
    }
  }
  const rowidKey = rowidKeyOf(db, wire.table);
  // An INTEGER PRIMARY KEY (AUTOINCREMENT) numbers from 1 on every device: the
  // sender's value means nothing here. Drop it; SQLite assigns a local one (T12799).
  if (rowidKey) delete values[rowidKey];
  if (!spec.displayId && spec.key.length === 1 && !rowidKey) {
    // A local key another row holds (keys such as AC ids derive from local
    // display ids): the merge engine re-derives it (T12344); held until then.
    const key = spec.key[0] as string;
    const taken = db
      .prepare(`SELECT 1 AS x FROM main.${q(wire.table)} WHERE ${q(key)} = ?`)
      .get(values[key] ?? null);
    if (taken) {
      hold(db, wire, 'key-collision', String(values[key]), heldAs);
      return { status: 'held', reason: 'key-collision' };
    }
  }
  // Validate like a local writer would (T12801): a received row is data from
  // another device, never trusted to satisfy this store's invariants.
  const invalid = validateReceived(wire.table, values);
  if (invalid) {
    hold(db, wire, 'invalid', invalid, heldAs);
    return { status: 'held', reason: 'invalid' };
  }
  try {
    inSavepoint(db, 'receive_insert', () => {
      if (minted) {
        insertIdentityRowNative(db, wire.table, {
          ...values,
          [UID_COLUMN]: wire.uid,
          [BIRTH_FP_COLUMN]: wire.birthFp,
        });
      } else {
        // A natural uid is a pure function of its endpoints: derive it here.
        insertIdentityRowNative(db, wire.table, { ...values, [UID_COLUMN]: null });
        fillTableUids(db, 'project', wire.table);
      }
    });
  } catch (error) {
    // The store's own guards refused it (hierarchy cycle and type-matrix
    // triggers, CHECK and NOT NULL constraints): hold it, never throw the
    // merge away, never insert it.
    const message = error instanceof Error ? error.message : String(error);
    if (!/constraint|E_[A-Z_]+|INVARIANT/i.test(message)) throw error;
    hold(db, wire, 'invalid', message.slice(0, 200), heldAs);
    return { status: 'held', reason: 'invalid' };
  }
  done();
  const key = rowidKey
    ? String(
        (
          db
            .prepare(
              `SELECT ${q(rowidKey)} AS k FROM main.${q(wire.table)} WHERE ${q(UID_COLUMN)} = ?`,
            )
            .get(wire.uid) as { k: number | string }
        ).k,
      )
    : spec.key.length === 1
      ? String(values[spec.key[0] as string])
      : wire.uid;
  return { status: 'inserted', key, uid: wire.uid };
}

/** The table's INTEGER PRIMARY KEY column (a rowid alias, locally numbered), if it has one. */
function rowidKeyOf(db: DatabaseSync, table: string): string | undefined {
  const pk = (
    db.prepare('SELECT name, type, pk FROM pragma_table_info(?)').all(table) as Array<{
      name: string;
      type: string;
      pk: number;
    }>
  ).filter((c) => c.pk > 0);
  const [only] = pk;
  return pk.length === 1 && only && only.type.toUpperCase() === 'INTEGER' ? only.name : undefined;
}

/** What may unblock held rows: a placed or re-keyed row, a freed key, or one held row. */
interface ReleaseTrigger {
  readonly table: string;
  /** A row with this uid exists now (or an alias now leads to it). */
  readonly uid?: string;
  /** This local key / display id is taken or freed now. */
  readonly key?: string;
  /** Re-try exactly this held row (its own op or re-key arrived). */
  readonly held?: HeldRowKey;
}

type HeldRecord = HeldRowKey & { rowJson: string };

/** Held rows a trigger may unblock (indexed lookups and a JSON text match, never a full retry). */
function candidatesFor(db: DatabaseSync, t: ReleaseTrigger): HeldRecord[] {
  const cols = `entity_table AS entityTable, uid, birth_fp AS birthFp, row_json AS rowJson`;
  const out: HeldRecord[] = [];
  if (t.held) {
    const row = db
      .prepare(
        `SELECT ${cols} FROM ${QUARANTINE_TABLE} WHERE entity_table = ? AND uid = ? AND birth_fp = ?`,
      )
      .get(t.held.entityTable, t.held.uid, t.held.birthFp) as HeldRecord | undefined;
    if (row) out.push(row);
  }
  if (t.key !== undefined) {
    out.push(
      ...(db
        .prepare(
          `SELECT ${cols} FROM ${QUARANTINE_TABLE} WHERE entity_table = ? AND contested_id = ?
            ORDER BY created_at, uid`,
        )
        .all(t.table, t.key) as unknown as HeldRecord[]),
    );
  }
  if (t.uid !== undefined) {
    // Rows waiting on a reference to this uid carry it in their wire form,
    // either as this uid or as an old uid a re-key led here.
    const uids = new Set([t.uid]);
    for (let frontier = [t.uid]; frontier.length > 0; ) {
      const older = db
        .prepare(
          `SELECT old_uid AS uid FROM ${UID_ALIAS_TABLE}
            WHERE entity_table = ? AND new_uid IN (${frontier.map(() => '?').join(', ')})`,
        )
        .all(t.table, ...frontier) as { uid: string }[];
      frontier = older.map((r) => r.uid).filter((u) => !uids.has(u));
      for (const u of frontier) uids.add(u);
    }
    const find = db.prepare(
      `SELECT ${cols} FROM ${QUARANTINE_TABLE} WHERE instr(row_json, ?) > 0 AND uid <> ?
        ORDER BY created_at, uid`,
    );
    for (const uid of uids) {
      out.push(...(find.all(`"${uid}"`, t.uid) as unknown as HeldRecord[]));
    }
  }
  return out;
}

/**
 * Re-try the held rows the triggers may unblock, then the rows each placement
 * unblocks in turn (a placed owner unblocks its children). A held row is only
 * re-tried when something it may wait on changed, and a row still held for
 * the same reason is not rewritten (T12801: no full re-scan per receive).
 * `'all'` re-tries every held row once (explicit {@link releaseHeld}).
 */
function releaseHeldRows(
  db: DatabaseSync,
  triggers: readonly ReleaseTrigger[] | 'all',
): HeldRowKey[] {
  const released: HeldRowKey[] = [];
  const work: ReleaseTrigger[] = [];
  const attempt = (h: HeldRecord) => {
    const key = { entityTable: h.entityTable, uid: h.uid, birthFp: h.birthFp };
    const result = placeRow(db, JSON.parse(h.rowJson) as WireRow, key);
    if (result.status === 'held') return;
    released.push(key);
    if (result.status === 'inserted') {
      work.push({ table: h.entityTable, uid: result.uid, key: result.key });
    }
  };
  if (triggers === 'all') {
    const held = db
      .prepare(
        `SELECT entity_table AS entityTable, uid, birth_fp AS birthFp, row_json AS rowJson
           FROM ${QUARANTINE_TABLE} ORDER BY created_at, entity_table, uid`,
      )
      .all() as unknown as HeldRecord[];
    for (const h of held) attempt(h);
  } else {
    work.push(...triggers);
  }
  for (let next = work.shift(); next !== undefined; next = work.shift()) {
    const seen = new Set<string>();
    for (const h of candidatesFor(db, next)) {
      const id = `${h.entityTable}\u0000${h.uid}\u0000${h.birthFp}`;
      if (seen.has(id)) continue;
      seen.add(id);
      attempt(h);
    }
  }
  return released;
}

/** Release triggers of a re-key receipt: its moved rows and the uids they left and took. */
function rekeyTriggers(receipt: RekeyReceipt): ReleaseTrigger[] {
  const out: ReleaseTrigger[] = [
    { table: receipt.table, uid: receipt.oldUid },
    { table: receipt.table, uid: receipt.newUid },
    {
      table: receipt.table,
      held: { entityTable: receipt.table, uid: receipt.newUid, birthFp: receipt.birthFp },
    },
  ];
  for (const child of receipt.cascaded) out.push(...rekeyTriggers(child));
  return out;
}

/**
 * Receive one row: place it, or hold it (module docs). The first receive
 * marks the store's identity values as shared, so the open pass never
 * clears them (T12746).
 *
 * @param db - Connection on the project `cleo.db`, inside the merge transaction.
 * @param wire - The incoming row.
 * @returns What happened; a `held` result carries the collision for the caller
 *   (the merge engine) to hand to its authority.
 */
export function receiveRow(db: DatabaseSync, wire: WireRow): ReceiveResult {
  registerRowUidFunction(db, 'project');
  return inSavepoint(db, 'receive', () => {
    markRowIdentityShared(db, 'receive');
    const result = placeRow(db, wire);
    if (result.status === 'inserted') {
      releaseHeldRows(db, [{ table: wire.table, uid: result.uid, key: result.key }]);
    }
    return result;
  });
}

/** The claim lease columns: local to the device that took the lease, never received. */
const CLAIM_COLUMNS = ['claimed_by_session', 'claimed_by_agent', 'claimed_at', 'lease_expires_at'];

/**
 * Per-table validation of a received row, in place (T12801). A task is checked
 * against `insertTaskSchema` (the schema every local task write satisfies) and
 * arrives without a claim lease: a lease belongs to the device and session
 * that took it. The store's triggers (containment cycle, type matrix, status
 * pipeline) then run on the insert itself.
 *
 * @returns Why the row is invalid, or `null`.
 */
function validateReceived(table: string, values: Record<string, WireValue>): string | null {
  if (table !== 'tasks_tasks') return null;
  for (const column of CLAIM_COLUMNS) {
    if (column in values) values[column] = null;
  }
  const byColumn = new Map(
    Object.entries(getTableColumns(tasksTable)).map(([prop, col]) => [col.name, prop]),
  );
  const candidate: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(values)) {
    const prop = byColumn.get(column);
    if (prop !== undefined && value !== null) candidate[prop] = value;
  }
  const parsed = insertTaskSchema.safeParse(candidate);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  return `invalid ${issue?.path.join('.') ?? 'row'}: ${issue?.message ?? 'rejected'}`.slice(0, 200);
}

/**
 * Re-try the held rows now (after an op this module did not apply).
 *
 * @param db - Connection on the project `cleo.db`.
 * @returns The rows placed.
 */
export function releaseHeld(db: DatabaseSync): HeldRowKey[] {
  registerRowUidFunction(db, 'project');
  return inSavepoint(db, 'release', () => releaseHeldRows(db, 'all'));
}

/** A held row, as `cleo doctor` and the merge status report it. */
export interface HeldRow extends HeldRowKey {
  readonly reason: HoldReason;
  readonly contestedId: string | null;
  readonly createdAt: string;
  readonly row: WireRow;
}

/**
 * Every held row (read-only: held rows are never edited in place).
 *
 * @param db - Connection on the project `cleo.db`.
 * @returns The held rows, oldest first.
 */
export function listHeldRows(db: DatabaseSync): HeldRow[] {
  return (
    db
      .prepare(
        `SELECT entity_table AS entityTable, uid, birth_fp AS birthFp, reason,
                contested_id AS contestedId, created_at AS createdAt, row_json AS rowJson
           FROM ${QUARANTINE_TABLE} ORDER BY created_at, entity_table, uid`,
      )
      .all() as unknown as Array<Omit<HeldRow, 'row'> & { rowJson: string }>
  ).map(({ rowJson, ...rest }) => ({ ...rest, row: JSON.parse(rowJson) as WireRow }));
}

/**
 * The wire form of a local row (what a sender publishes): values without the
 * identity columns, and every declared reference as the target's uid and
 * birth fingerprint.
 *
 * @param db - Connection on the project `cleo.db`.
 * @param table - Declared table.
 * @param uid - The row's uid.
 * @returns The wire row.
 */
export function wireRowOf(db: DatabaseSync, table: string, uid: string): WireRow {
  const spec = specOf(table);
  const row = db.prepare(`SELECT * FROM main.${q(table)} WHERE ${q(UID_COLUMN)} = ?`).get(uid) as
    | Record<string, WireValue>
    | undefined;
  if (!row) throw new Error(`wire: no ${table} row with uid ${uid}`);
  const values: Record<string, WireValue> = {};
  for (const [column, value] of Object.entries(row)) {
    if (column !== UID_COLUMN && column !== BIRTH_FP_COLUMN) values[column] = value;
  }
  const refs: Record<string, WireRef | null> = {};
  for (const [column, target] of refTargets(spec)) {
    const value = row[column];
    if (value === null || value === undefined) {
      refs[column] = null;
      continue;
    }
    const minted = specOf(target).kind === 'minted';
    const t = db
      .prepare(
        `SELECT ${q(UID_COLUMN)} AS uid, ${minted ? q(BIRTH_FP_COLUMN) : 'NULL'} AS fp
           FROM main.${q(target)} WHERE ${q(keyOf(target))} = ?`,
      )
      .get(value) as { uid: string; fp: string | null } | undefined;
    if (t) refs[column] = { uid: t.uid, birthFp: t.fp };
  }
  return {
    table,
    uid,
    birthFp: spec.kind === 'minted' ? ((row[BIRTH_FP_COLUMN] as string | null) ?? null) : null,
    values,
    refs,
  };
}

// ---- Uid collision: re-key ------------------------------------------------------

/** A natural row whose uid was re-derived because a re-keyed row is in its key. */
export interface NaturalRederive {
  readonly table: string;
  readonly oldUid: string;
  readonly newUid: string;
}

/** Receipt of {@link rekeyRowUid}: one re-keyed row and everything that followed. */
export interface RekeyReceipt {
  /** Table of the re-keyed row. */
  readonly table: string;
  /** The colliding uid it carried. */
  readonly oldUid: string;
  /** Its birth fingerprint (unchanged; keys the alias and every match). */
  readonly birthFp: string;
  /** The new uid. */
  readonly newUid: string;
  /** Natural rows re-derived (dependencies, relations, labels, display aliases). */
  readonly natural: readonly NaturalRederive[];
  /** Minted children re-keyed with it ({@link rekeyedChildUid}), recursively. */
  readonly cascaded: readonly RekeyReceipt[];
  /** The authority that re-keyed. */
  readonly origin: string | null;
  /** HLC of the re-key. */
  readonly hlc: string | null;
}

/** Stored-uid copies, display aliases, the re-mint record and the uid alias of a moved row. */
function followRow(
  db: DatabaseSync,
  table: string,
  key: string | null,
  oldUid: string,
  birthFp: string,
  newUid: string,
  options: Displacement,
): NaturalRederive[] {
  const moved: NaturalRederive[] = [];
  if (key !== null) {
    for (const other of ROW_IDENTITY.project) {
      for (const ref of other.storedRefUids ?? []) {
        if (ref.table !== table || (ref.source ?? 'uid') !== 'uid') continue;
        rewriteStoredRefUidNative(db, other.table, ref.column, ref.from, key, oldUid, newUid);
      }
    }
  }
  const aliases = db
    .prepare(
      `SELECT uid, display_id AS displayId, reason, origin, displaced_hlc AS displacedHlc,
              created_at AS createdAt
         FROM ${DISPLAY_ID_ALIAS_TABLE}
        WHERE entity_table = ? AND entity_uid = ? AND entity_birth_fp = ?`,
    )
    .all(table, oldUid, birthFp) as Array<{
    uid: string;
    displayId: string;
    reason: DisplayIdAliasReason;
    origin: string | null;
    displacedHlc: string | null;
    createdAt: string;
  }>;
  for (const a of aliases) {
    deleteDisplayIdAliasNative(db, a.uid);
    const uid = naturalRowUid('project', DISPLAY_ID_ALIAS_TABLE, [table, a.displayId, newUid]);
    insertDisplayIdAliasNative(db, {
      uid,
      entityTable: table,
      displayId: a.displayId,
      entityUid: newUid,
      entityBirthFp: birthFp,
      reason: a.reason,
      origin: a.origin,
      displacedHlc: a.displacedHlc,
      createdAt: a.createdAt,
    });
    moved.push({ table: DISPLAY_ID_ALIAS_TABLE, oldUid: a.uid, newUid: uid });
  }
  if (table === 'tasks_tasks') {
    const remint = readMeta(db, remintKey(oldUid, birthFp));
    if (remint !== undefined) {
      writeRowIdentityMetaNative(db, remintKey(newUid, birthFp), remint);
      deleteRowIdentityMetaNative(db, remintKey(oldUid, birthFp));
    }
  }
  insertUidAliasNative(db, {
    uid: naturalRowUid('project', UID_ALIAS_TABLE, [table, oldUid, birthFp]),
    entityTable: table,
    oldUid,
    oldBirthFp: birthFp,
    newUid,
    origin: options.origin ?? null,
    displacedHlc: options.displacedHlc ?? null,
    createdAt: options.now ?? new Date().toISOString(),
  });
  return moved;
}

/** Natural rows keyed by (`table`, `key`): their table, rowid and uid. */
function naturalRowsKeyedBy(
  db: DatabaseSync,
  table: string,
  key: string,
): Array<{ table: string; rowid: number; uid: string | null }> {
  const out: Array<{ table: string; rowid: number; uid: string | null }> = [];
  for (const other of ROW_IDENTITY.project) {
    if (other.kind !== 'natural') continue;
    const keyed = (other.keyRefs ?? []).filter((ref) => ref.table === table);
    if (keyed.length === 0) continue;
    const rows = db
      .prepare(
        `SELECT rowid AS rowid, ${q(UID_COLUMN)} AS uid FROM main.${q(other.table)}
          WHERE ${keyed.map((ref) => `${q(ref.column)} = ?`).join(' OR ')}`,
      )
      .all(...keyed.map(() => key)) as Array<{ rowid: number; uid: string | null }>;
    for (const r of rows) out.push({ table: other.table, ...r });
  }
  return out;
}

/** A minted row, by identity. */
interface MintedRef {
  readonly table: string;
  readonly uid: string;
  readonly birthFp: string;
}

/** Minted children of a placed row, found through their owner column. */
function localChildren(db: DatabaseSync, table: string, key: string): MintedRef[] {
  const out: MintedRef[] = [];
  for (const child of ROW_IDENTITY.project) {
    if (child.kind !== 'minted') continue;
    for (const owner of child.owners ?? []) {
      if (owner.table !== table) continue;
      const rows = db
        .prepare(
          `SELECT ${q(UID_COLUMN)} AS uid, ${q(BIRTH_FP_COLUMN)} AS birthFp
             FROM main.${q(child.table)}
            WHERE ${q(owner.column)} = ? AND ${q(UID_COLUMN)} IS NOT NULL
              AND ${q(BIRTH_FP_COLUMN)} IS NOT NULL
            ORDER BY ${q(UID_COLUMN)}`,
        )
        .all(key) as Array<{ uid: string; birthFp: string }>;
      for (const r of rows) out.push({ table: child.table, ...r });
    }
  }
  return out;
}

/** Held minted children of a held row, found through their wire owner ref. */
function heldChildren(db: DatabaseSync, table: string, uid: string, birthFp: string): MintedRef[] {
  const out: MintedRef[] = [];
  for (const h of listHeldRows(db)) {
    const spec = rowIdentitySpec('project', h.entityTable);
    if (spec?.kind !== 'minted') continue;
    for (const owner of spec.owners ?? []) {
      if (owner.table !== table) continue;
      const ref = h.row.refs?.[owner.column];
      if (ref && ref.uid === uid && ref.birthFp === birthFp) {
        out.push({ table: h.entityTable, uid: h.uid, birthFp: h.birthFp });
      }
    }
  }
  return out;
}

/** Re-key a held row's wire form. */
function rekeyHeldRow(db: DatabaseSync, key: HeldRowKey, newUid: string): void {
  const row = db
    .prepare(
      `SELECT row_json AS rowJson FROM ${QUARANTINE_TABLE}
        WHERE entity_table = ? AND uid = ? AND birth_fp = ?`,
    )
    .get(key.entityTable, key.uid, key.birthFp) as { rowJson: string };
  const wire = JSON.parse(row.rowJson) as WireRow;
  rekeyQuarantineNative(db, key, newUid, JSON.stringify({ ...wire, uid: newUid }));
}

/** Where a (table, uid, birth fp) row is on this replica. */
function locate(
  db: DatabaseSync,
  table: string,
  uid: string,
  birthFp: string,
): { where: 'local'; key: string } | { where: 'held' } | { where: 'absent' } {
  const local = localRow(db, table, uid, birthFp);
  if (local) return { where: 'local', key: local.key };
  const held = db
    .prepare(
      `SELECT 1 AS x FROM ${QUARANTINE_TABLE} WHERE entity_table = ? AND uid = ? AND birth_fp = ?`,
    )
    .get(table, uid, birthFp);
  return held ? { where: 'held' } : { where: 'absent' };
}

/** AUTHORITY: re-key one row wherever it is, derive its cascade, and return the receipt. */
function rekeyDerive(
  db: DatabaseSync,
  table: string,
  oldUid: string,
  birthFp: string,
  newUid: string,
  options: Displacement,
): RekeyReceipt {
  const at = locate(db, table, oldUid, birthFp);
  const natural: NaturalRederive[] = [];
  let children: MintedRef[];
  if (at.where === 'local') {
    children = localChildren(db, table, at.key);
    const keyed = naturalRowsKeyedBy(db, table, at.key);
    setRowUidNative(db, table, oldUid, birthFp, newUid);
    natural.push(...followRow(db, table, at.key, oldUid, birthFp, newUid, options));
    for (const n of keyed) clearRowUidNative(db, n.table, n.rowid);
    for (const t of new Set(keyed.map((n) => n.table))) fillTableUids(db, 'project', t);
    for (const n of keyed) {
      const now = db
        .prepare(`SELECT ${q(UID_COLUMN)} AS uid FROM main.${q(n.table)} WHERE rowid = ?`)
        .get(n.rowid) as { uid: string | null };
      if (n.uid && now.uid && n.uid !== now.uid) {
        natural.push({ table: n.table, oldUid: n.uid, newUid: now.uid });
      }
    }
  } else if (at.where === 'held') {
    children = heldChildren(db, table, oldUid, birthFp);
    rekeyHeldRow(db, { entityTable: table, uid: oldUid, birthFp }, newUid);
    followRow(db, table, null, oldUid, birthFp, newUid, options);
  } else {
    throw new CleoError(ExitCode.NOT_FOUND, `No ${table} row ${oldUid} with birth ${birthFp}`, {
      details: { field: 'uid', actual: oldUid },
    });
  }
  const cascaded = children.map((c) =>
    rekeyDerive(
      db,
      c.table,
      c.uid,
      c.birthFp,
      rekeyedChildUid('project', c.table, c.uid, newUid),
      options,
    ),
  );
  return {
    table,
    oldUid,
    birthFp,
    newUid,
    natural,
    cascaded,
    origin: options.origin ?? null,
    hlc: options.displacedHlc ?? null,
  };
}

/**
 * AUTHORITY ONLY: re-key the LOSER of a uid collision (same uid, different
 * birth fingerprints; the loser is the greater fingerprint). The caller names
 * the loser by its fingerprint and the call asserts it: the row re-keyed is
 * the one with `loserBirthFp`, wherever it is here (placed, or held because
 * the winner arrived first), and a fingerprint that is not the greater of the
 * pair is refused. The row gets a random uid; the cascade follows from stored
 * identity (module docs). Held rows the re-key unblocks are placed.
 *
 * @param db - Connection on the project `cleo.db`.
 * @param table - Minted table of the row.
 * @param uid - The colliding uid.
 * @param collision - The loser's and the winner's birth fingerprints (the
 *   winner must be the smaller; T12801).
 * @param options - The authority and the HLC of the re-key.
 * @returns The receipt to publish, with its cascade and natural uids.
 * @throws CleoError when this replica has no row (uid, loserBirthFp), or the
 *   fingerprint is not the loser's.
 */
export function rekeyRowUid(
  db: DatabaseSync,
  table: string,
  uid: string,
  collision: { readonly loserBirthFp: string; readonly winnerBirthFp: string },
  options: Displacement = {},
): RekeyReceipt {
  if (specOf(table).kind !== 'minted') {
    throw new Error(`rekey: ${table} is not a declared minted table`);
  }
  const { loserBirthFp, winnerBirthFp } = collision;
  // The loser is the greater fingerprint of the pair; the caller names both,
  // so a swapped or stale pair is refused rather than re-keying the winner.
  if (!(winnerBirthFp < loserBirthFp)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `rekey: ${loserBirthFp} is not the loser of the ${table} uid collision on ${uid} (the loser is the greater fingerprint; winner ${winnerBirthFp})`,
      {
        fix: 'Re-key the row with the greater birth fingerprint; the smaller one keeps the uid.',
        details: { field: 'loserBirthFp', actual: loserBirthFp, expected: winnerBirthFp },
      },
    );
  }
  const rivals = [
    ...(
      db
        .prepare(
          `SELECT ${q(BIRTH_FP_COLUMN)} AS fp FROM main.${q(table)} WHERE ${q(UID_COLUMN)} = ?`,
        )
        .all(uid) as { fp: string | null }[]
    ).map((r) => r.fp),
    ...(
      db
        .prepare(
          `SELECT birth_fp AS fp FROM ${QUARANTINE_TABLE} WHERE entity_table = ? AND uid = ?`,
        )
        .all(table, uid) as { fp: string }[]
    ).map((r) => r.fp),
  ].filter((fp): fp is string => fp !== null && fp !== loserBirthFp);
  const greater = rivals.find((fp) => fp > loserBirthFp || fp !== winnerBirthFp);
  if (greater !== undefined) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `rekey: ${loserBirthFp} is not the loser of the ${table} uid collision on ${uid}`,
      {
        fix: 'Re-key the row with the greater birth fingerprint; the smaller one keeps the uid.',
        details: { field: 'loserBirthFp', actual: loserBirthFp, expected: greater },
      },
    );
  }
  if (locate(db, table, uid, loserBirthFp).where === 'absent') {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `No ${table} row with uid ${uid} and birth fingerprint ${loserBirthFp} on this replica`,
      {
        fix: 'Only a replica that holds the loser re-keys it; the others apply the receipt.',
        details: { field: 'uid', actual: uid },
      },
    );
  }
  registerRowUidFunction(db, 'project');
  return inSavepoint(db, 'rekey', () => {
    const receipt = rekeyDerive(db, table, uid, loserBirthFp, mintRowUid(), options);
    releaseHeldRows(db, rekeyTriggers(receipt));
    return receipt;
  });
}

/** Outcome of {@link applyRekey} for one row of the receipt. */
export type RekeyApplyStatus = 'applied' | 'applied-held' | 'already-applied' | 'alias-only';

/** Apply one receipt entry, then its cascade. */
function applyEntry(
  db: DatabaseSync,
  e: RekeyReceipt,
  out: Array<{ table: string; oldUid: string; status: RekeyApplyStatus }>,
): void {
  const options: Displacement = { origin: e.origin, displacedHlc: e.hlc };
  const at = locate(db, e.table, e.oldUid, e.birthFp);
  let status: RekeyApplyStatus;
  if (at.where === 'local') {
    const keyed = naturalRowsKeyedBy(db, e.table, at.key);
    setRowUidNative(db, e.table, e.oldUid, e.birthFp, e.newUid);
    followRow(db, e.table, at.key, e.oldUid, e.birthFp, e.newUid, options);
    for (const n of e.natural) {
      if (n.table !== DISPLAY_ID_ALIAS_TABLE) setNaturalUidNative(db, n.table, n.oldUid, n.newUid);
    }
    // A natural row the authority did not have (an edge only this replica
    // holds) is re-derived here; for the published ones this is a no-op.
    for (const n of keyed) clearRowUidNative(db, n.table, n.rowid);
    for (const t of new Set(keyed.map((n) => n.table))) fillTableUids(db, 'project', t);
    status = 'applied';
  } else if (at.where === 'held') {
    rekeyHeldRow(db, { entityTable: e.table, uid: e.oldUid, birthFp: e.birthFp }, e.newUid);
    followRow(db, e.table, null, e.oldUid, e.birthFp, e.newUid, options);
    status = 'applied-held';
  } else {
    status =
      locate(db, e.table, e.newUid, e.birthFp).where === 'absent'
        ? 'alias-only'
        : 'already-applied';
    followRow(db, e.table, null, e.oldUid, e.birthFp, e.newUid, options);
  }
  out.push({ table: e.table, oldUid: e.oldUid, status });
  for (const child of e.cascaded) applyEntry(db, child, out);
}

/**
 * RECEIVER: apply a published {@link RekeyReceipt}. Every entry moves the row
 * with (old uid, birth fingerprint) to the published new uid, wherever it is
 * here: a placed row (with its stored copies, display aliases and the
 * published natural uids), a held row (its wire form), or nowhere (the uid
 * alias is recorded, so the row takes its new uid when it arrives). A row
 * with the old uid and ANOTHER fingerprint (the winner) is never touched.
 * Nothing is recomputed. Held rows the re-key unblocks are placed.
 *
 * @param db - Connection on the project `cleo.db`.
 * @param receipt - The published receipt.
 * @returns Per-row outcome, and the held rows placed.
 */
export function applyRekey(
  db: DatabaseSync,
  receipt: RekeyReceipt,
): {
  readonly rows: ReadonlyArray<{ table: string; oldUid: string; status: RekeyApplyStatus }>;
  readonly released: readonly HeldRowKey[];
} {
  registerRowUidFunction(db, 'project');
  return inSavepoint(db, 'rekey_apply', () => {
    markRowIdentityShared(db, 'receive');
    const rows: Array<{ table: string; oldUid: string; status: RekeyApplyStatus }> = [];
    applyEntry(db, receipt, rows);
    return { rows, released: releaseHeldRows(db, rekeyTriggers(receipt)) };
  });
}
