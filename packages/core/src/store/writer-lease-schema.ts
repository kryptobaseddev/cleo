/**
 * Drizzle ORM schema for the **DbWriterLease** arbitration tables (T11627 ST-2).
 *
 * Two operational tables co-located inside EACH scope's consolidated `cleo.db`
 * (project + global), migrated via the existing `drizzle-cleo-project` /
 * `drizzle-cleo-global` migration sets so lease state lives next to the data it
 * guards and is auto-split by the dual-cleo.db boundary
 * ({@link resolveDualScopeDbPath}). They are NOT part of the exodus target shape
 * under `schema/cleo-project/` — they are pure runtime infrastructure that the
 * lease engine ({@link withWriterLease}) reads and writes via `BEGIN IMMEDIATE`.
 *
 * ## `_writer_leases` — exactly ONE active row per (scope, lane)
 *
 * AC1 (one writer per scope/lane) is enforced by a **partial UNIQUE index**
 * `WHERE active = 1`. drizzle-orm does **not** surface partial-`WHERE` indexes in
 * its typed schema API (cf. `conduit-schema.ts:339` `project_agent_refs.enabled`,
 * `agent-registry-schema.ts`), so the index is emitted as **raw SQL in the lease
 * baseline migration** — this module declares only the full-column table. This is
 * the established repo pattern, not a deviation. The runtime bootstrap asserts the
 * index exists via {@link assertWriterLeaseActiveIndexPresent} so a missing index
 * (e.g. a migration that never ran) fails loudly instead of silently allowing two
 * active rows.
 *
 * ## `_writer_queue` — FIFO + priority waiters
 *
 * Ordered `priority ASC, ticket ASC` (priority-then-FIFO). The full (non-partial)
 * ordering index IS expressible in drizzle and is declared inline here; only the
 * partial-unique active-row index requires raw SQL.
 *
 * @module
 * @task T11627
 * @epic T11625
 * @see ./writer-lease.ts — the engine that arbitrates over these tables
 * @see ../../migrations/drizzle-cleo-project — project lease migration (raw partial index)
 * @see ../../migrations/drizzle-cleo-global — global lease migration (raw partial index)
 */

import type { DatabaseSync } from 'node:sqlite';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The physical name of the lease table. Exported so the engine, the bootstrap
 * assertion, and tests all reference the single source of truth.
 */
export const WRITER_LEASES_TABLE = '_writer_leases' as const;

/**
 * The physical name of the lease waiter-queue table.
 */
export const WRITER_QUEUE_TABLE = '_writer_queue' as const;

/**
 * The physical name of the partial-UNIQUE active-row index. Asserted present at
 * bootstrap because drizzle cannot emit it (raw SQL in the baseline migration).
 */
export const WRITER_LEASES_ACTIVE_INDEX = 'ux_writer_leases_active' as const;

/**
 * `_writer_leases` — at most ONE active row per `(scope, lane)`.
 *
 * The single-active invariant is enforced by the raw-SQL partial-UNIQUE index
 * `ux_writer_leases_active ON _writer_leases (scope, lane) WHERE active = 1`
 * (emitted in the baseline migration — drizzle cannot model partial `WHERE`).
 * This declaration intentionally carries only the full-column table; do NOT add
 * a `.unique()` here (it would emit a NON-partial unique that wrongly forbids a
 * second released row for the same lane).
 */
export const writerLeases = sqliteTable(WRITER_LEASES_TABLE, {
  /** Surrogate primary key (autoincrement via INTEGER PRIMARY KEY rowid alias). */
  id: integer('id').primaryKey(),
  /** The cleo.db scope — `'project'` | `'global'`. */
  scope: text('scope').notNull(),
  /** The write lane — `'tasks'` | `'brain'` | `'bulk'`. */
  lane: text('lane').notNull(),
  /** Process+lane holder identity (e.g. `pid-42:tasks`). */
  holderId: text('holder_id').notNull(),
  /** OS process id of the holder, used for stale-holder pid-liveness reclaim. */
  holderPid: integer('holder_pid').notNull(),
  /** Monotonic fence, bumped on reclaim; epoch-CAS rejects a stale holder's write. */
  epoch: integer('epoch').notNull(),
  /** Acquisition timestamp (epoch ms). */
  acquiredAt: integer('acquired_at').notNull(),
  /** Last heartbeat timestamp (epoch ms), advanced by renew. */
  heartbeatAt: integer('heartbeat_at').notNull(),
  /** Lease time-to-live in milliseconds. */
  ttlMs: integer('ttl_ms').notNull(),
  /** Re-entrancy depth — the durable refcount; row freed when it returns to 0. */
  reentrancyDepth: integer('reentrancy_depth').notNull().default(1),
  /** `1` while held, `0` once released. The partial-unique index keys on `active = 1`. */
  active: integer('active').notNull().default(1),
});

/**
 * `_writer_queue` — FIFO + priority waiters per `(scope, lane)`.
 *
 * Grant order is `priority ASC, ticket ASC` (priority-then-FIFO). The ordering
 * index below is a normal multi-column index — fully expressible in drizzle.
 */
export const writerQueue = sqliteTable(
  WRITER_QUEUE_TABLE,
  {
    /** Monotonic ticket (AUTOINCREMENT) — the FIFO tiebreak within a priority. */
    ticket: integer('ticket').primaryKey({ autoIncrement: true }),
    /** The cleo.db scope being queued for. */
    scope: text('scope').notNull(),
    /** The write lane being queued for. */
    lane: text('lane').notNull(),
    /** The waiter's holder identity. */
    holderId: text('holder_id').notNull(),
    /** Advisory priority — lower acquires sooner. `0` = highest. */
    priority: integer('priority').notNull().default(100),
    /** Enqueue timestamp (epoch ms). */
    enqueuedAt: integer('enqueued_at').notNull(),
    /** Aging-promotion target (epoch ms) — a waiter past this is promoted to `0`. */
    deadlineAt: integer('deadline_at').notNull(),
  },
  (table) => [
    index('ix_writer_queue_order').on(table.scope, table.lane, table.priority, table.ticket),
  ],
);

/**
 * Assert that the raw-SQL partial-UNIQUE active-row index is physically present
 * on the given native `cleo.db` handle.
 *
 * Because drizzle cannot emit a partial-`WHERE` index, AC1 enforcement depends
 * entirely on the hand-written baseline migration having run. This check makes a
 * missing index a loud, immediate failure at bootstrap (or in T8) rather than a
 * silent loss of the single-active-writer invariant.
 *
 * @param nativeDb - The native `DatabaseSync` handle for a scope's `cleo.db`.
 * @throws {Error} `E_WRITER_LEASE_INDEX_MISSING` if `ux_writer_leases_active` is
 *   absent (the lease migration did not run, or the partial index was dropped).
 *
 * @example
 * ```ts
 * const nativeDb = (handle.db as { $client: DatabaseSync }).$client;
 * assertWriterLeaseActiveIndexPresent(nativeDb); // throws if AC1 index missing
 * ```
 *
 * @task T11627
 */
export function assertWriterLeaseActiveIndexPresent(nativeDb: DatabaseSync): void {
  const row = nativeDb
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(WRITER_LEASES_ACTIVE_INDEX) as { name: string } | undefined;
  if (!row) {
    throw new Error(
      `E_WRITER_LEASE_INDEX_MISSING: partial-unique active-row index ` +
        `"${WRITER_LEASES_ACTIVE_INDEX}" is absent from this cleo.db. The lease ` +
        `baseline migration (drizzle-cleo-{project,global}/…_t11891-writer-leases) ` +
        `did not run, so the single-active-writer invariant (AC1) is unenforced.`,
    );
  }
}
