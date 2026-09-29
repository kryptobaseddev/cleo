/**
 * Display ids and their aliases (T12341).
 *
 * `T####` is a per-project DISPLAY id: unique inside one store at rest, typed
 * by people and agents, but allocated locally, so two offline stores can
 * allocate the same one for different work. The row's uid is its identity
 * (`store/row-identity.ts`). When a merge brings two rows with one display id,
 * the row with the greater uid is re-minted ({@link collisionLoser}; for
 * UUIDv7 uids that is the later birth), and its old display id becomes an
 * alias row, so the id it carried keeps resolving.
 *
 * The alias table follows the ADR-094 `nexus_project_id_aliases` pattern: a
 * display id claimed by more than one row (the live holder plus an alias, or
 * two aliases) is AMBIGUOUS and never resolves; every claimant is reported
 * ({@link resolveDisplayId}).
 *
 * Re-minting rewrites the local key and every local reference to it: the
 * columns whose foreign key points at the key (from `PRAGMA
 * foreign_key_list`) plus the references declared in `ROW_IDENTITY`,
 * including JSON arrays of ids. Free text (descriptions, notes, evidence
 * atoms) is not rewritten; it resolves through the alias.
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
import { naturalRowUid, ROW_IDENTITY, rowIdentitySpec, UID_COLUMN } from './row-identity.js';
import { advanceTaskIdSequence } from './sqlite-data-accessor.js';

/** Physical name of the alias table. */
export const DISPLAY_ID_ALIAS_TABLE = 'tasks_display_id_aliases';

/** Why a display id was displaced. */
export type DisplayIdAliasReason = 'collision-remint' | 'split-brain-import' | 'manual';

/** One row that claims a display id. */
export interface DisplayIdClaimant {
  /** Uid of the row (`null` for a live row whose uid is not filled yet). */
  readonly uid: string | null;
  /** Its display id today. */
  readonly currentId: string | null;
  /** `live` when it carries the id now, `alias` when it carried it before. */
  readonly via: 'live' | 'alias';
}

/** Outcome of resolving a display id. */
export type DisplayIdResolution =
  | { readonly status: 'none' }
  | { readonly status: 'resolved'; readonly claimant: DisplayIdClaimant }
  | { readonly status: 'ambiguous'; readonly claimants: readonly DisplayIdClaimant[] };

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
 * Record that `displayId` used to name the row `entityUid`. Idempotent.
 *
 * @param db - Connection on the project `cleo.db`.
 * @param entry - The displaced id and the row that carried it.
 */
export function recordDisplayIdAlias(
  db: DatabaseSync,
  entry: {
    readonly table: string;
    readonly displayId: string;
    readonly entityUid: string;
    readonly reason: DisplayIdAliasReason;
    readonly origin?: string | null;
    readonly now?: string;
  },
): void {
  const uid = naturalRowUid('project', DISPLAY_ID_ALIAS_TABLE, [
    entry.table,
    entry.displayId,
    entry.entityUid,
  ]);
  db.prepare(
    `INSERT OR IGNORE INTO tasks_display_id_aliases
       (uid, entity_table, display_id, entity_uid, reason, origin, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    uid,
    entry.table,
    entry.displayId,
    entry.entityUid,
    entry.reason,
    entry.origin ?? null,
    entry.now ?? new Date().toISOString(),
  );
}

/**
 * Resolve a display id to the row it names, refusing an ambiguous one.
 *
 * @param db - Connection on the project `cleo.db`.
 * @param table - Display-id table (e.g. `tasks_tasks`).
 * @param displayId - The id to resolve.
 * @returns `resolved` with the one claimant, `ambiguous` with all of them, or `none`.
 */
export function resolveDisplayId(
  db: DatabaseSync,
  table: string,
  displayId: string,
): DisplayIdResolution {
  const key = displayKey(table);
  const claimants: DisplayIdClaimant[] = [];
  const live = db
    .prepare(`SELECT ${q(UID_COLUMN)} AS uid FROM main.${q(table)} WHERE ${q(key)} = ?`)
    .get(displayId) as { uid: string | null } | undefined;
  if (live) claimants.push({ uid: live.uid, currentId: displayId, via: 'live' });
  const aliases = db
    .prepare(
      `SELECT a.entity_uid AS uid, t.${q(key)} AS currentId
         FROM tasks_display_id_aliases a
         LEFT JOIN main.${q(table)} t ON t.${q(UID_COLUMN)} = a.entity_uid
        WHERE a.entity_table = ? AND a.display_id = ?
        ORDER BY a.entity_uid`,
    )
    .all(table, displayId) as { uid: string; currentId: string | null }[];
  for (const alias of aliases) {
    if (claimants.some((c) => c.uid === alias.uid)) continue;
    claimants.push({ uid: alias.uid, currentId: alias.currentId, via: 'alias' });
  }
  const [only] = claimants;
  if (!only) return { status: 'none' };
  return claimants.length === 1 && only
    ? { status: 'resolved', claimant: only }
    : { status: 'ambiguous', claimants };
}

/**
 * Allocate the next `T####` on the caller's handle, with the same lower bound
 * `allocateNextTaskId` uses (the highest stored numeric id). For a merge that
 * places an incoming row under a new id; run it inside the merge transaction.
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

/** Receipt of {@link remintTaskDisplayId}. */
export interface RemintReceipt {
  /** Uid of the re-minted task. */
  readonly uid: string;
  /** Display id it carried. */
  readonly oldId: string;
  /** Display id it carries now. */
  readonly newId: string;
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
 * Give a task a new display id: allocate the next `T####`, rewrite the key and
 * every local reference to it, and record the old id as an alias. Runs in one
 * savepoint with foreign keys deferred to its commit; the caller normally
 * holds the merge transaction.
 *
 * @param db - Connection on the project `cleo.db`.
 * @param taskId - Current display id of the task to re-mint.
 * @param options - Why, and which replica authored the displacement.
 * @returns What was rewritten.
 * @throws CleoError NOT_FOUND when the task does not exist or has no uid yet.
 */
export function remintTaskDisplayId(
  db: DatabaseSync,
  taskId: string,
  options: {
    readonly reason: DisplayIdAliasReason;
    readonly origin?: string | null;
    readonly now?: string;
  },
): RemintReceipt {
  const row = db.prepare('SELECT uid FROM tasks_tasks WHERE id = ?').get(taskId) as
    | { uid: string | null }
    | undefined;
  if (!row?.uid) {
    throw new CleoError(ExitCode.NOT_FOUND, `Cannot re-mint ${taskId}: no such task with a uid`, {
      fix: 'Check the id with `cleo show`; a task written by an older build gets its uid at the next open.',
      details: { field: 'taskId', actual: taskId },
    });
  }
  const uid = row.uid;
  const rewritten: Record<string, number> = {};
  const sp = `_cleo_remint_${Date.now()}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    db.exec('PRAGMA defer_foreign_keys = ON');
    const newId = allocateTaskDisplayId(db);
    db.prepare('UPDATE tasks_tasks SET id = ? WHERE uid = ?').run(newId, uid);
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
            .run(taskId, newId, taskId).changes
        : db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(newId, taskId).changes;
      if (Number(changes) > 0) rewritten[`${ref.table}.${ref.column}`] = Number(changes);
    }
    recordDisplayIdAlias(db, {
      table: 'tasks_tasks',
      displayId: taskId,
      entityUid: uid,
      reason: options.reason,
      origin: options.origin ?? null,
      now: options.now,
    });
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    return { uid, oldId: taskId, newId, rewritten };
  } catch (error) {
    db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    throw error;
  }
}
