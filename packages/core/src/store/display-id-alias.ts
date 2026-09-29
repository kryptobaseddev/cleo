/**
 * Display ids, uid re-keys and their aliases (T12341).
 *
 * `T####` is a per-project DISPLAY id: unique inside one store at rest, typed
 * by people and agents, but allocated locally, so two offline stores can
 * allocate the same one for different work. The row's uid is its identity
 * (`store/row-identity.ts`). Spec: `cleo docs fetch t12341-uid-scheme` §9.
 *
 * ## Display-id collision: one authority re-mints
 *
 * Every replica agrees on the row that loses a display-id collision
 * ({@link collisionLoser}: the greater uid; for UUIDv7 the later birth). Only
 * ONE authority gives it a new number, so two replicas never allocate two
 * different numbers for one row (which could collide again, forever):
 *
 * - the sync server, when the project syncs to cloud;
 * - otherwise the replica that ORIGINATED the losing row.
 *
 * The authority calls {@link remintTaskDisplayId}, which allocates, rewrites
 * and returns a {@link RemintOp} to publish. Every other replica applies that
 * op with {@link applyRemintOp} and never allocates a number for a row it did
 * not originate. Until the op arrives it keeps the losing row under a
 * provisional local id ({@link provisionalDisplayId}), which the allocator
 * ignores.
 *
 * ## Aliases (ADR-094 pattern; team-lead decision)
 *
 * A displaced display id becomes an alias row carrying the origin replica and
 * the displacement HLC. Resolution ({@link resolveDisplayId}): a LIVE display
 * id always wins (the aliases come back as history); an alias resolves only
 * when no live row holds the id; several matching aliases are an ambiguity
 * error listing every candidate, never a guess.
 *
 * ## Uid collision: re-key
 *
 * Two rows with one uid and different birth fingerprints are a uid collision
 * (`classifyUidMatch`). The authority re-keys the loser
 * ({@link rekeyRowUid}: the greater birth fingerprint) to a new random uid and
 * records the old uid in `tasks_uid_aliases`, keyed with its birth
 * fingerprint so a reference to the old uid resolves to the right row.
 *
 * Re-minting rewrites the local key and every local reference to it: the
 * columns whose foreign key points at the key (from `PRAGMA
 * foreign_key_list`) plus the references declared in `ROW_IDENTITY`,
 * including JSON arrays of ids. Free text (descriptions, notes, evidence
 * atoms, branch names) is not rewritten; it resolves through the alias with
 * its displacement context.
 *
 * ## Gate 28
 *
 * A sanctioned writer (`scripts/lint-no-raw-table-writes.mjs` SANCTIONED): it
 * writes on the caller's chokepoint handle, inside the caller's transaction.
 *
 * @module
 * @task T12341
 * @epic T12323
 */

import type { DatabaseSync } from 'node:sqlite';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import {
  BIRTH_FP_COLUMN,
  fillTableUids,
  mintRowUid,
  naturalRowUid,
  ROW_IDENTITY,
  registerRowUidFunction,
  rowIdentitySpec,
  UID_COLUMN,
} from './row-identity.js';
import { advanceTaskIdSequence } from './sqlite-data-accessor.js';

/** Physical name of the display-id alias table. */
export const DISPLAY_ID_ALIAS_TABLE = 'tasks_display_id_aliases';

/** Physical name of the uid re-key alias table. */
export const UID_ALIAS_TABLE = 'tasks_uid_aliases';

/** Why a display id was displaced. */
export type DisplayIdAliasReason = 'collision-remint' | 'split-brain-import' | 'manual';

/** Where a displacement came from: the replica that authored it, and when (HLC). */
export interface Displacement {
  /** Replica that authored the displacement (the authority). */
  readonly origin?: string | null;
  /** HLC of the displacement (T12342); `null` until HLC exists. */
  readonly displacedHlc?: string | null;
  /** Wall-clock record time; defaults to now. */
  readonly now?: string;
}

/** A row that carries, or carried, a display id. */
export interface DisplayIdClaimant {
  /** Uid of the row (`null` for a live row whose uid is not filled yet). */
  readonly uid: string | null;
  /** Its display id today. */
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

/** Quote an identifier for SQL. */
function q(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The single-column display key of a declared display-id table. */
function displayKey(table: string): string {
  const spec = rowIdentitySpec('project', table);
  if (!spec?.displayId || spec.key.length !== 1) {
    throw new Error(`display id: ${table} has no declared display id`);
  }
  return spec.key[0] as string;
}

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

/**
 * The provisional local id under which a replica that is NOT the re-mint
 * authority keeps the losing row of a display-id collision until the
 * authority's {@link RemintOp} arrives. Not numeric, so the allocator ignores it.
 *
 * @param displayId - The contested display id.
 * @param uid - Uid of the losing row.
 * @returns E.g. `T100~019230ab`.
 */
export function provisionalDisplayId(displayId: string, uid: string): string {
  return `${displayId}~${uid.replaceAll('-', '').slice(0, 8)}`;
}

/**
 * Record that `displayId` used to name the row `entityUid`. Idempotent.
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
    readonly reason: DisplayIdAliasReason;
  },
): void {
  const uid = naturalRowUid('project', DISPLAY_ID_ALIAS_TABLE, [
    entry.table,
    entry.displayId,
    entry.entityUid,
  ]);
  db.prepare(
    `INSERT OR IGNORE INTO tasks_display_id_aliases
       (uid, entity_table, display_id, entity_uid, reason, origin, displaced_hlc, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uid,
    entry.table,
    entry.displayId,
    entry.entityUid,
    entry.reason,
    entry.origin ?? null,
    entry.displacedHlc ?? null,
    entry.now ?? new Date().toISOString(),
  );
}

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
  const key = displayKey(table);
  const live = db
    .prepare(`SELECT ${q(UID_COLUMN)} AS uid FROM main.${q(table)} WHERE ${q(key)} = ?`)
    .get(displayId) as { uid: string | null } | undefined;
  const aliases = (
    db
      .prepare(
        `SELECT a.entity_uid AS uid, t.${q(key)} AS currentId, a.origin AS origin,
                a.displaced_hlc AS displacedHlc
           FROM tasks_display_id_aliases a
           LEFT JOIN main.${q(table)} t ON t.${q(UID_COLUMN)} = a.entity_uid
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
 * authority allocates for a collision (module docs).
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

/**
 * The re-mint the authority publishes. Other replicas apply it verbatim
 * ({@link applyRemintOp}); they never recompute the number.
 */
export interface RemintOp {
  /** Uid of the re-minted task. */
  readonly uid: string;
  /** The contested display id it was displaced from. */
  readonly oldId: string;
  /** The display id the authority gave it. */
  readonly newId: string;
  /** The authority that re-minted. */
  readonly origin: string | null;
  /** HLC of the re-mint (T12342). */
  readonly displacedHlc: string | null;
}

/** Receipt of a local rename: the op plus what was rewritten here. */
export interface RemintReceipt extends RemintOp {
  /** Rows rewritten per `table.column`. */
  readonly rewritten: Readonly<Record<string, number>>;
}

/** Every local column that holds a task's display id, as (table, column, json array?). */
function taskReferenceColumns(
  db: DatabaseSync,
): Array<{ table: string; column: string; jsonArray: boolean }> {
  const found = new Map<string, { table: string; column: string; jsonArray: boolean }>();
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

/**
 * Rename a task's local display id and rewrite every local reference, in the
 * caller's savepoint with foreign keys deferred.
 */
function renameTask(db: DatabaseSync, uid: string, fromId: string, toId: string) {
  const rewritten: Record<string, number> = {};
  db.exec('PRAGMA defer_foreign_keys = ON');
  db.prepare('UPDATE tasks_tasks SET id = ? WHERE uid = ?').run(toId, uid);
  for (const ref of taskReferenceColumns(db)) {
    const table = `main.${q(ref.table)}`;
    const col = q(ref.column);
    const changes = ref.jsonArray
      ? db
          .prepare(
            `UPDATE ${table} SET ${col} = (
               SELECT json_group_array(CASE WHEN j.value = ? THEN ? ELSE j.value END)
                 FROM json_each(${table}.${col}) j)
             WHERE json_valid(${col}) AND EXISTS (
               SELECT 1 FROM json_each(${table}.${col}) j WHERE j.value = ?)`,
          )
          .run(fromId, toId, fromId).changes
      : db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(toId, fromId).changes;
    if (Number(changes) > 0) rewritten[`${ref.table}.${ref.column}`] = Number(changes);
  }
  return rewritten;
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

/** The uid of the task that holds `taskId` now, or throw NOT_FOUND. */
function taskUidOf(db: DatabaseSync, taskId: string): string {
  const row = db.prepare('SELECT uid FROM tasks_tasks WHERE id = ?').get(taskId) as
    | { uid: string | null }
    | undefined;
  if (!row?.uid) {
    throw new CleoError(ExitCode.NOT_FOUND, `No task ${taskId} with a uid`, {
      fix: 'Check the id with `cleo show`; a task written by an older build gets its uid at the next open.',
      details: { field: 'taskId', actual: taskId },
    });
  }
  return row.uid;
}

/**
 * AUTHORITY ONLY (the sync server, or the replica that originated the row):
 * give the losing task of a display-id collision a new display id. Allocates
 * the next `T####`, rewrites the key and every local reference, records the
 * contested id as an alias, and returns the op to publish.
 *
 * @param db - Connection on the project `cleo.db`.
 * @param taskId - Current local display id of the task to re-mint.
 * @param options - The contested id (default: `taskId`), why, and the displacement.
 * @returns The op to publish, with what was rewritten here.
 * @throws CleoError NOT_FOUND when the task does not exist or has no uid yet.
 */
export function remintTaskDisplayId(
  db: DatabaseSync,
  taskId: string,
  options: Displacement & {
    readonly reason: DisplayIdAliasReason;
    readonly contestedId?: string;
  },
): RemintReceipt {
  const uid = taskUidOf(db, taskId);
  const oldId = options.contestedId ?? taskId;
  return inSavepoint(db, 'remint', () => {
    const newId = allocateTaskDisplayId(db);
    const rewritten = renameTask(db, uid, taskId, newId);
    recordDisplayIdAlias(db, {
      ...options,
      table: 'tasks_tasks',
      displayId: oldId,
      entityUid: uid,
    });
    return {
      uid,
      oldId,
      newId,
      origin: options.origin ?? null,
      displacedHlc: options.displacedHlc ?? null,
      rewritten,
    };
  });
}

/** Outcome of {@link applyRemintOp}. */
export type ApplyRemintResult =
  | { readonly status: 'applied'; readonly receipt: RemintReceipt }
  | { readonly status: 'already-applied' }
  | { readonly status: 'unknown-row' }
  /** The new id is held here by another row: a NEW collision for its authority. */
  | { readonly status: 'conflict'; readonly holderUid: string | null };

/**
 * NON-AUTHORITY: apply a re-mint the authority published. Renames the row with
 * the op's uid (wherever it is now, e.g. under its provisional id) to the op's
 * new id and records the op's alias. Never allocates.
 *
 * @param db - Connection on the project `cleo.db`.
 * @param op - The published re-mint.
 * @returns What happened.
 */
export function applyRemintOp(db: DatabaseSync, op: RemintOp): ApplyRemintResult {
  const row = db.prepare('SELECT id FROM tasks_tasks WHERE uid = ?').get(op.uid) as
    | { id: string }
    | undefined;
  if (!row) return { status: 'unknown-row' };
  if (row.id === op.newId) return { status: 'already-applied' };
  const holder = db.prepare('SELECT uid FROM tasks_tasks WHERE id = ?').get(op.newId) as
    | { uid: string | null }
    | undefined;
  if (holder) return { status: 'conflict', holderUid: holder.uid };
  const receipt = inSavepoint(db, 'remint_apply', () => {
    const rewritten = renameTask(db, op.uid, row.id, op.newId);
    recordDisplayIdAlias(db, {
      table: 'tasks_tasks',
      displayId: op.oldId,
      entityUid: op.uid,
      reason: 'collision-remint',
      origin: op.origin,
      displacedHlc: op.displacedHlc,
    });
    return { ...op, rewritten };
  });
  return { status: 'applied', receipt };
}

/** Receipt of {@link rekeyRowUid}. */
export interface RekeyReceipt {
  /** Table of the re-keyed row. */
  readonly table: string;
  /** The colliding uid it carried. */
  readonly oldUid: string;
  /** Its birth fingerprint (unchanged; keys the alias). */
  readonly birthFp: string;
  /** The new random uid. */
  readonly newUid: string;
}

/**
 * AUTHORITY ONLY: re-key the loser of a uid collision (same uid, different
 * birth fingerprints; the loser is the greater fingerprint). The row gets a
 * new random UUIDv7; stored copies of its uid (`ac_uid`) follow; natural rows
 * keyed by it get their uid recomputed; `tasks_uid_aliases` records the old
 * uid with its fingerprint.
 *
 * @param db - Connection on the project `cleo.db`.
 * @param table - Minted table of the row.
 * @param uid - The colliding uid.
 * @param options - The displacement.
 * @returns The re-key to publish.
 */
export function rekeyRowUid(
  db: DatabaseSync,
  table: string,
  uid: string,
  options: Displacement = {},
): RekeyReceipt {
  const spec = rowIdentitySpec('project', table);
  if (spec?.kind !== 'minted') throw new Error(`rekey: ${table} is not a declared minted table`);
  const row = db
    .prepare(`SELECT ${q(BIRTH_FP_COLUMN)} AS fp FROM main.${q(table)} WHERE ${q(UID_COLUMN)} = ?`)
    .get(uid) as { fp: string | null } | undefined;
  if (!row?.fp) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `No ${table} row with uid ${uid} and a birth fingerprint`,
      {
        fix: 'Open the store with this build first: it fills uids and birth fingerprints.',
        details: { field: 'uid', actual: uid },
      },
    );
  }
  const birthFp = row.fp;
  return inSavepoint(db, 'rekey', () => {
    const newUid = mintRowUid();
    db.prepare(`UPDATE main.${q(table)} SET ${q(UID_COLUMN)} = ? WHERE ${q(UID_COLUMN)} = ?`).run(
      newUid,
      uid,
    );
    for (const other of ROW_IDENTITY.project) {
      for (const ref of other.storedRefUids ?? []) {
        if (ref.table !== table || (ref.source ?? 'uid') !== 'uid') continue;
        db.prepare(
          `UPDATE main.${q(other.table)} SET ${q(ref.column)} = ? WHERE ${q(ref.column)} = ?`,
        ).run(newUid, uid);
      }
      // Natural uids are pure functions of their endpoints' uids: recompute.
      const keyed = (other.keyRefs ?? []).filter((ref) => ref.table === table);
      if (other.kind === 'natural' && keyed.length > 0) {
        const where = keyed
          .map(
            (ref) =>
              `${q(ref.column)} = (SELECT ${q(spec.key[0] as string)} FROM main.${q(table)} WHERE ${q(UID_COLUMN)} = ?)`,
          )
          .join(' OR ');
        db.prepare(`UPDATE main.${q(other.table)} SET ${q(UID_COLUMN)} = NULL WHERE ${where}`).run(
          ...keyed.map(() => newUid),
        );
      }
    }
    registerRowUidFunction(db, 'project');
    for (const other of ROW_IDENTITY.project) {
      if (other.keyRefs?.some((ref) => ref.table === table))
        fillTableUids(db, 'project', other.table);
    }
    db.prepare(
      `INSERT OR IGNORE INTO tasks_uid_aliases
         (uid, entity_table, old_uid, old_birth_fp, new_uid, origin, displaced_hlc, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      naturalRowUid('project', UID_ALIAS_TABLE, [table, uid, birthFp]),
      table,
      uid,
      birthFp,
      newUid,
      options.origin ?? null,
      options.displacedHlc ?? null,
      options.now ?? new Date().toISOString(),
    );
    return { table, oldUid: uid, birthFp, newUid };
  });
}
