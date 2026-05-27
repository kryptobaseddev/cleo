/**
 * PostgresDataAccessor — interface stub for cloud-sync backend.
 *
 * SCAFFOLD ONLY (T9062). This file defines the type surface and namespacing
 * contract for the PostgreSQL-backed DataAccessor. Full implementation
 * (sync commands, migration, multi-tenant namespacing, auth) is deferred
 * to T9062 child tasks.
 *
 * Architecture overview (ADR-TBD — cloud-sync):
 *   - CLEO is local-first SQLite for portability and offline operation.
 *   - A PostgresDataAccessor provides an engine-neutral drop-in replacement
 *     for SqliteDataAccessor — same DataAccessor interface, different engine.
 *   - Multi-tenant namespacing: each CLEO project maps to a Postgres
 *     "tenant namespace" (schema or row-level tenant key) inside a shared
 *     cluster. Cross-tenant isolation is enforced at the DB layer.
 *   - Sync model: pull/push with last-write-wins per row (initial design).
 *     CRDT merge (cr-sqlite) is opt-in per ADR from T947.
 *   - Auth: each tenant identified by SignalDock identity (Ed25519 keypair).
 *     Push receipts signed with the same primitive as llmtxt/sdk receipts.
 *
 * Engine-neutral proof:
 *   The DataAccessor interface in @cleocode/contracts carries `engine: 'sqlite'`.
 *   PostgresDataAccessor will carry `engine: 'postgres'`. Both satisfy the
 *   same interface contract, proving the abstraction from T9050 is real.
 *
 * @task T9062
 * @epic T9048
 * @see packages/contracts/src/data-accessor.ts (DataAccessor interface)
 * @see packages/contracts/src/postgres-sync-spec.ts (sync semantics spec)
 * @see docs/adr/ (ADR-TBD: cloud-sync architecture — to be authored in T9062)
 */

import type { DataAccessor } from './data-accessor.js';

// ---------------------------------------------------------------------------
// Multi-tenant namespacing
// ---------------------------------------------------------------------------

/**
 * Strategy for isolating tenant data in a shared Postgres cluster.
 *
 * - `schema`:   Each project gets a dedicated Postgres schema
 *               (`cleo_<projectHash>`). Strongest isolation; higher overhead.
 * - `row-level`: All projects share tables; tenant key (`project_id`) filters
 *               every query. Simpler to manage; requires RLS enforcement.
 */
export type PostgresTenantStrategy = 'schema' | 'row-level';

/**
 * Identifies a CLEO project namespace inside the shared Postgres cluster.
 *
 * Generated deterministically from the project root hash (the same
 * `projectHash` used in worktree paths) to ensure stable cross-machine
 * identity without requiring a central registry lookup.
 */
export interface PostgresTenantNamespace {
  /**
   * Postgres-safe schema name (schema strategy) or tenant key (row-level).
   * Format: `cleo_<projectHash>` where projectHash is the 16-char hex used
   * in worktree directory names (e.g. `cleo_1e3146b7352ba279`).
   */
  readonly namespaceName: string;
  /** Original hex project hash. */
  readonly projectHash: string;
  /** Isolation strategy in use for this cluster. */
  readonly strategy: PostgresTenantStrategy;
}

// ---------------------------------------------------------------------------
// Connection options
// ---------------------------------------------------------------------------

/**
 * Connection options for the PostgresDataAccessor.
 *
 * All credentials are passed at construction time. The accessor never
 * reads environment variables directly — callers are responsible for
 * resolving the connection string from their config/secret store.
 */
export interface PostgresDataAccessorOptions {
  /**
   * PostgreSQL connection string (libpq format).
   * Example: `postgresql://user:pass@host:5432/cleo_sync`.
   */
  connectionString: string;
  /** Project namespace within the cluster. */
  namespace: PostgresTenantNamespace;
  /**
   * Optional connection pool size. Default: 5.
   * Keep small — CLI invocations are short-lived, not long-running servers.
   */
  poolSize?: number;
  /**
   * Optional Ed25519 signing keypair for authenticated push receipts.
   * When present, every push batch is signed with this key.
   * Aligns with llmtxt/sdk ContributionReceipt signing.
   */
  signingKeyHex?: string;
}

// ---------------------------------------------------------------------------
// Sync semantics
// ---------------------------------------------------------------------------

/**
 * Direction of a sync operation.
 *
 * - `push`: Write local SQLite state → Postgres.
 * - `pull`: Read Postgres state → update local SQLite.
 * - `bidirectional`: Pull then push (last-write-wins per row).
 */
export type PostgresSyncDirection = 'push' | 'pull' | 'bidirectional';

/**
 * Result from a sync operation.
 */
export interface SyncResult {
  /** Direction that was executed. */
  direction: PostgresSyncDirection;
  /** Number of rows written to Postgres (push) or read from Postgres (pull). */
  rowsSynced: number;
  /** Number of conflicts resolved (last-write-wins). */
  conflictsResolved: number;
  /** ISO-8601 timestamp of sync completion. */
  completedAt: string;
}

/**
 * Status report from `getStatus()`.
 */
export interface SyncStatus {
  /** Whether the Postgres connection is healthy. */
  connected: boolean;
  /** ISO-8601 timestamp of the last successful sync, or null if never synced. */
  lastSyncedAt: string | null;
  /** Number of local changes not yet pushed. */
  pendingPushCount: number;
  /** Whether the remote has changes not yet pulled. */
  remoteAhead: boolean;
}

// ---------------------------------------------------------------------------
// PostgresDataAccessor interface stub
// ---------------------------------------------------------------------------

/**
 * PostgresDataAccessor — Postgres-backed implementation of DataAccessor.
 *
 * INTERFACE STUB — full implementation deferred to T9062 child tasks.
 *
 * Extends the base DataAccessor interface with `engine: 'postgres'` and
 * adds cloud-sync-specific methods (sync, getStatus, close).
 *
 * All methods from DataAccessor are inherited and must be implemented
 * using Postgres queries (pg or postgres.js driver). The implementation
 * will live in @cleocode/core (NOT in @cleocode/cleo — CLI-layer only).
 *
 * @see DataAccessor for the full list of inherited methods.
 */
export interface PostgresDataAccessor extends Omit<DataAccessor, 'engine'> {
  /**
   * The storage engine backing this accessor.
   * Discriminates from SqliteDataAccessor at the type level.
   */
  readonly engine: 'postgres';

  /**
   * Sync local state with the Postgres backend.
   *
   * @param direction - Which direction(s) to sync.
   * @returns Summary of the sync operation.
   */
  sync(direction?: PostgresSyncDirection): Promise<SyncResult>;

  /**
   * Get the current sync status (connection health + divergence metrics).
   *
   * @returns Sync status report.
   */
  getStatus(): Promise<SyncStatus>;
}

// ---------------------------------------------------------------------------
// Factory signature (implementation deferred)
// ---------------------------------------------------------------------------

/**
 * Factory type for creating a PostgresDataAccessor.
 *
 * The concrete implementation (`createPostgresDataAccessor`) lives in
 * @cleocode/core and will be exported from @cleocode/core/internal once
 * the full implementation is complete (T9062 child tasks).
 *
 * @param options - Connection and namespace options.
 * @returns A fully initialized PostgresDataAccessor.
 */
export type CreatePostgresDataAccessorFn = (
  options: PostgresDataAccessorOptions,
) => Promise<PostgresDataAccessor>;
