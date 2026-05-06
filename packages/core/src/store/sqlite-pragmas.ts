/**
 * Centralized SQLite performance pragma application for all CLEO databases.
 *
 * Single source of truth for the pragma set applied to every node:sqlite
 * `DatabaseSync` handle opened across CLEO. Keeping this in one place avoids
 * the historical drift where some open sites (sqlite-native, conduit-sqlite)
 * carried tuned pragmas while others (backup-pack, agent-registry-accessor,
 * one-shot installers) opened raw connections that fell back to SQLite
 * defaults — silently penalizing every operation those code paths drove.
 *
 * The pragma set is tuned for CLEO's workload profile:
 *   - Multi-process CLI invocations against shared project DBs
 *     (tasks.db, brain.db, conduit.db) — expect concurrent readers + writer.
 *   - Read-heavy with bursty writes (find/show vs add/update/complete).
 *   - Local SSD or network-mounted project dirs (e.g. /mnt/projects).
 *   - Durable-on-commit but tolerant of last-transaction loss on power cut
 *     (CLI tasks, not financial ledgers).
 *
 * @remarks
 * Choices and rationale:
 *
 * - `journal_mode = WAL` — Enables concurrent reader+writer access. CLEO
 *   already required this; centralized here so non-`openNativeDatabase`
 *   sites get it consistently.
 * - `synchronous = NORMAL` — Safe with WAL: durable on commit, only the
 *   in-flight transaction is at risk on power cut. ~2-3× faster than the
 *   default `FULL` for write-heavy workloads. Recommended by SQLite docs
 *   for application-level use cases that don't require commit-equals-fsync.
 * - `busy_timeout = 5000` — Wait up to 5 s for a competing writer's lock
 *   before failing with SQLITE_BUSY. Without this, concurrent CLI
 *   invocations (verify + complete + tests) immediately error out;
 *   with this, they queue politely.
 * - `cache_size = -64000` — 64 MB page cache (negative = KB; positive =
 *   pages). The SQLite default of ~2 MB makes any non-trivial query
 *   thrash. 64 MB is a reasonable budget for a CLI process and brings
 *   query latency down sharply for the dispatch domain.
 * - `mmap_size = 268435456` — 256 MB memory-mapped read window. SQLite
 *   serves reads directly from the mmap region without copying through
 *   the page cache, eliminating syscalls on the read path. Especially
 *   beneficial for read-mostly tables (sessions, attachments, memory).
 *   Hard cap at 256 MB to avoid VM pressure on low-memory hosts.
 * - `temp_store = MEMORY` — Temp tables and intermediate query results
 *   live in RAM rather than spilling to disk. Cheap win for sort/join
 *   heavy queries.
 * - `wal_autocheckpoint = 1000` — Auto-checkpoint after 1000 frames
 *   (~4 MB at 4 KB pages). Default is 1000 already; setting explicitly
 *   guards against future SQLite default changes.
 *
 * @remarks
 * For read-only opens (`{ readOnly: true }` constructor option), most
 * pragmas still apply. Pragmas that require write access (e.g.
 * `journal_mode = WAL` if not already set) silently no-op on read-only
 * handles, which is fine — the writer set WAL when it created the DB.
 *
 * @task T-PERF-PRAGMAS
 */

import type { DatabaseSync } from 'node:sqlite';

/**
 * Configuration for `applyPerfPragmas`. All fields are optional — defaults
 * are tuned for the typical CLEO project DB.
 */
export interface PerfPragmaOptions {
  /**
   * Whether to set `PRAGMA journal_mode = WAL`. Set `false` for read-only
   * handles where WAL was already established by the writer. Default `true`.
   */
  enableWal?: boolean;
  /**
   * Whether to set `PRAGMA foreign_keys = ON`. Set `false` for vitest
   * environments where fixtures intentionally insert orphan refs.
   * Default: `true` outside vitest, `false` inside (auto-detected via
   * `process.env.VITEST`).
   */
  enableForeignKeys?: boolean;
  /**
   * Page cache size in KB (passed as the negative form to PRAGMA cache_size).
   * Default `64000` (64 MB).
   */
  cacheSizeKb?: number;
  /**
   * Memory-mapped I/O size in bytes. Default `268435456` (256 MB).
   * Set `0` to disable mmap entirely.
   */
  mmapSizeBytes?: number;
  /**
   * Busy timeout in milliseconds — how long writers wait for a competing
   * lock before SQLITE_BUSY. Default `5000`.
   */
  busyTimeoutMs?: number;
}

/**
 * Apply the canonical CLEO performance pragma set to a freshly-opened
 * SQLite connection.
 *
 * Pragmas are applied via `db.exec(...)` (not prepare/run) because they
 * are configuration, not queries — most return no rows and prepared
 * statement caching offers no benefit.
 *
 * Safe to call multiple times on the same handle: every pragma here is
 * idempotent. Safe to call on read-only handles: write-requiring pragmas
 * silently no-op.
 *
 * @param db - Open `node:sqlite` `DatabaseSync` handle.
 * @param options - Optional overrides for individual pragma values.
 */
export function applyPerfPragmas(db: DatabaseSync, options: PerfPragmaOptions = {}): void {
  const {
    enableWal = true,
    enableForeignKeys = !process.env.VITEST,
    cacheSizeKb = 64_000,
    mmapSizeBytes = 268_435_456,
    busyTimeoutMs = 5_000,
  } = options;

  // busy_timeout BEFORE any other pragma so concurrent writers wait politely
  // rather than failing immediately if the next pragma requires a write lock.
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);

  if (enableWal) {
    db.exec('PRAGMA journal_mode = WAL');
  }

  // synchronous = NORMAL is the WAL-recommended setting: durable on commit,
  // last-transaction loss possible on power cut, no corruption risk.
  db.exec('PRAGMA synchronous = NORMAL');

  if (enableForeignKeys) {
    db.exec('PRAGMA foreign_keys = ON');
  }

  // Negative cache_size = KB. Positive = pages. We use KB so the budget is
  // independent of page_size.
  db.exec(`PRAGMA cache_size = -${cacheSizeKb}`);

  if (mmapSizeBytes > 0) {
    db.exec(`PRAGMA mmap_size = ${mmapSizeBytes}`);
  }

  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA wal_autocheckpoint = 1000');
}

/**
 * Run `PRAGMA optimize` before closing a long-lived handle.
 *
 * SQLite collects table statistics opportunistically while a connection
 * is open. `PRAGMA optimize` flushes those stats so the next process
 * can use them for query planning. Cheap (~ms) and recommended by the
 * SQLite docs as the standard close-time pragma.
 *
 * Safe to call on read-only handles (no-op).
 *
 * @param db - Open `node:sqlite` `DatabaseSync` handle.
 */
export function optimizeBeforeClose(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA optimize');
  } catch {
    // optimize is best-effort — never block close on a stat collection failure.
  }
}
