/**
 * One-time local scrub of secrets already written to audit rows (T13857).
 *
 * Before T13855 the dispatch audit middleware stored mutation params verbatim
 * (`service connect --token`, `config set` values). T13855 redacts every new
 * write at the column; this pass rewrites the rows written before it, on each
 * device, with the same per-column transforms the column and the sync apply
 * path use ({@link COLUMN_TRANSFORMS}).
 *
 * - Local only: runs with the capture and side-effect triggers suspended, so
 *   no change is captured and peers never receive an op the `audit.immutable`
 *   merge rule would refuse (design note `t13857-audit-secret-scrub-design`).
 * - Runs once per store under {@link AUDIT_SCRUB_MARKER} in the scope's
 *   local-only meta table. A restore does not carry the key, so a restored
 *   store is scrubbed again on its next open.
 * - Rewrites only rows whose value changes; clean rows stay byte for byte.
 *
 * Loaded lazily by the store open pass, only when the marker is absent
 * ({@link auditScrubPending} in `schema.ts`).
 *
 * @module store/sync/audit-scrub
 * @task T13857
 * @epic T12323
 */

import type { DatabaseSync } from 'node:sqlite';
import { COLUMN_TRANSFORMS } from '../schema/schema-utils.js';
import { withImmediateTransaction } from './clock-store.js';
import {
  AUDIT_SCRUB_MARKER,
  auditScrubMarkerTable,
  auditScrubPending,
  hasTable,
} from './schema.js';
import { hasTriggerSuspendTable, withTriggersSuspended } from './trigger-classes.js';

/** What {@link scrubAuditSecrets} did. */
export type AuditScrubReport =
  | { readonly status: 'done'; readonly rewritten: Readonly<Record<string, number>> }
  | { readonly status: 'already' }
  | { readonly status: 'skipped'; readonly reason: string };

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  const info = db.prepare(`PRAGMA main.table_info(${q(table)})`).all() as Array<{ name: string }>;
  return new Set(info.map((c) => c.name));
}

/**
 * The one-time scrub: every text value its {@link COLUMN_TRANSFORMS} entry
 * changes is rewritten, in one `BEGIN IMMEDIATE` (or
 * the caller's transaction) with capture and side-effect triggers suspended,
 * then the marker is recorded.
 *
 * @param db - The store, after its migrations.
 * @returns What the scrub did.
 */
export function scrubAuditSecrets(db: DatabaseSync): AuditScrubReport {
  const markerTable = auditScrubMarkerTable(db);
  if (markerTable === null) return { status: 'skipped', reason: 'no local meta table' };
  // A store without the C2 flag table cannot suspend capture (and holds no
  // capture trigger, which reads it).
  if (!hasTriggerSuspendTable(db)) {
    return { status: 'skipped', reason: 'cleo_trigger_suspend is absent' };
  }
  const run = (): AuditScrubReport => {
    if (!auditScrubPending(db)) return { status: 'already' };
    const rewritten: Record<string, number> = {};
    withTriggersSuspended(db, ['capture', 'side-effect'], 'forward', () => {
      for (const [table, transforms] of Object.entries(COLUMN_TRANSFORMS)) {
        if (!hasTable(db, table)) continue;
        const present = columnsOf(db, table);
        for (const [col, transform] of Object.entries(transforms)) {
          if (!present.has(col)) continue;
          const rows = db
            .prepare(
              `SELECT rowid AS rid, ${q(col)} AS v FROM ${q(table)} WHERE typeof(${q(col)}) = 'text'`,
            )
            .all() as Array<{ rid: number; v: string }>;
          const update = db.prepare(`UPDATE ${q(table)} SET ${q(col)} = ? WHERE rowid = ?`);
          for (const { rid, v } of rows) {
            const clean = transform(v);
            if (clean === v) continue;
            update.run(clean, rid);
            const key = `${table}.${col}`;
            rewritten[key] = (rewritten[key] ?? 0) + 1;
          }
        }
      }
    });
    if (markerTable === '_sync_meta') {
      db.prepare('INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?)').run(
        AUDIT_SCRUB_MARKER,
        'done',
        new Date().toISOString(),
      );
    } else {
      db.prepare(`INSERT INTO ${q(markerTable)} (key, value) VALUES (?, ?)`).run(
        AUDIT_SCRUB_MARKER,
        'done',
      );
    }
    return { status: 'done', rewritten };
  };
  return db.isTransaction ? run() : withImmediateTransaction(db, run);
}
