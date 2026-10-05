/**
 * Replica identity: binding a store file to its replica, and rebinding a
 * copy (journal spec §1.5, H3, N5, N6).
 *
 * A replica is one physical store file, not a machine: a worktree copy or a
 * restored file is a separate replica. The binding is
 * `(st_ino, st_birthtime, nonce)` plus the stable device id and the device
 * registry's high-water mark. `st_dev` is NOT used: external volumes, OS
 * updates, overlay and network mounts renumber it.
 *
 * Birthtime (N5): a birthtime of 0, or one equal to the ctime at bind (the
 * libuv fallback where the filesystem has no birthtime), is stored as NULL,
 * and birthtimes are compared only when both are non-NULL.
 *
 * The open pass rebinds when:
 * - `file-identity`: the inode differs, or both birthtimes are known and
 *   differ (a copy, `VACUUM INTO` output, a restore to a new file);
 * - `foreign-device`: the store was bound on another device;
 * - `nonce-mismatch`: this device registered the replica id with another
 *   nonce;
 * - `rollback`: for some stream the store's persisted `replicaSeq` is below
 *   the registry's hwm (a restore into the same inode, e.g. `.backup()`).
 * A store missing from the registry is re-registered, never rebound for that
 * alone (N6). The server's "seq exists, hash differs" answer is the authority
 * behind that; S4 reports it through {@link rebindReplica}.
 *
 * A rebind retires the old row, mints a new replica id and nonce, carries the
 * clock forward, marks the old replica's live captures and sealed
 * transactions `inherited` (T12753, {@link markInheritedRows}), and runs the
 * registered {@link RebindHook}s in the same transaction. Discarding the pull
 * cursor, pausing push, the reconcile and the signed retire transaction
 * arrive with those tables (S4); they plug in as hooks.
 *
 * {@link syncOpenPass} is behind the store-level `sync.*` flags: with every
 * flag off it reads and writes nothing. The one exception is
 * {@link ensureProjectReplica}, which `cleo project link` calls to bind the
 * project store with every flag still off (device contract §3.7).
 *
 * @task T12342
 * @module store/sync/replica
 */

import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { uuidv7 } from '../../cloud/crypto.js';
import { getStableDeviceId } from '../../llm/stable-device-id.js';
import { healClock, loadClock, storeClock, withImmediateTransaction } from './clock-store.js';
import { anySyncFlagOn } from './flags.js';
import { encodeHlc } from './hlc.js';
import { markInheritedRows } from './inherit.js';
import { ReplicaRegistry, type ReplicaRegistryEntry } from './replica-registry.js';
import { ensureSyncSchema, hasTable } from './schema.js';

/** Which store a replica is. */
export type ReplicaScope = 'project' | 'global';

/**
 * How an open treats sync (§1.5). `off` for every non-canonical open
 * (backups, snapshots, scratch copies, bundle staging): nothing is read or
 * written. `live` for the canonical project and global stores. `test` for a
 * scratch-bound replica that must never touch the device registry: the
 * caller passes its own registry.
 */
export type SyncOpenMode = 'off' | 'live' | 'test';

/** Why a store was rebound. */
export type RebindReason =
  | 'file-identity'
  | 'foreign-device'
  | 'nonce-mismatch'
  | 'rollback'
  | 'server-seq-conflict'
  /**
   * The Nexus device that held this replica was revoked and the same user
   * re-enrolled this machine: the server never re-pins a replica, so the
   * store takes a new id (device contract §3.7, R6).
   */
  | 'device-reenrolled'
  /**
   * A vault restore or pull placed a snapshot at this store's path: a new
   * file holding another device's data, or this store rolled back (§1.5
   * rules 1 and 3). The old replica is retired at the same path, so it is a
   * retire candidate for S4, unlike a copy (T13109).
   */
  | 'vault-restore';

/** What `stat` reports about a store file, in nanoseconds. */
export interface FileStat {
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/** Reads a file's stat. Injectable so tests can simulate filesystems. */
export type StatFn = (path: string) => FileStat;

/** The part of a file's identity the binding compares. */
export interface FileIdentity {
  readonly ino: bigint;
  /** Birthtime in ns, or null when unknown (N5). */
  readonly birth: bigint | null;
}

/** A `_sync_replica` row. */
export interface ReplicaRow {
  readonly replicaId: string;
  readonly scope: ReplicaScope;
  readonly nonce: string;
  readonly deviceId: string;
  readonly fileIno: bigint;
  readonly fileBirth: bigint | null;
  readonly boundAt: string;
  readonly boundWhy: string;
  readonly retiredAt: string | null;
  readonly successor: string | null;
}

/** Context handed to a {@link RebindHook}. */
export interface RebindContext {
  readonly previous: ReplicaRow;
  readonly current: ReplicaRow;
  readonly reasons: readonly RebindReason[];
}

/**
 * Runs inside the rebind transaction, after the new replica is bound and the
 * old replica's outbox rows are marked inherited. S4 registers the hooks that
 * mark unpushed segments, discard the cursor and pause push. A throw rolls the
 * whole rebind back.
 */
export type RebindHook = (db: DatabaseSync, ctx: RebindContext) => void;

const rebindHooks: RebindHook[] = [];

/**
 * Register a hook that runs on every rebind.
 *
 * @returns A function that unregisters it.
 */
export function registerRebindHook(hook: RebindHook): () => void {
  rebindHooks.push(hook);
  return () => {
    const i = rebindHooks.indexOf(hook);
    if (i >= 0) rebindHooks.splice(i, 1);
  };
}

/** `fs.statSync` in bigint mode. */
export const defaultStat: StatFn = (path) => {
  const s = statSync(path, { bigint: true });
  return { ino: s.ino, birthtimeNs: s.birthtimeNs, ctimeNs: s.ctimeNs };
};

/**
 * The binding identity of a store file. A birthtime of 0 or equal to the
 * ctime is the filesystem saying "unknown", so it reads as null (N5).
 */
export function fileIdentity(path: string, stat: StatFn = defaultStat): FileIdentity {
  const s = stat(path);
  const birth = s.birthtimeNs === 0n || s.birthtimeNs === s.ctimeNs ? null : s.birthtimeNs;
  return { ino: s.ino, birth };
}

function rowFrom(r: Record<string, unknown>): ReplicaRow {
  return {
    replicaId: String(r.replica_id),
    scope: r.scope as ReplicaScope,
    nonce: String(r.nonce),
    deviceId: String(r.device_id),
    fileIno: BigInt(r.file_ino as bigint | number),
    fileBirth: r.file_birth === null ? null : BigInt(r.file_birth as bigint | number),
    boundAt: String(r.bound_at),
    boundWhy: String(r.bound_why),
    retiredAt: r.retired_at === null ? null : String(r.retired_at),
    successor: r.successor === null ? null : String(r.successor),
  };
}

/** The active (not retired) replica of a store, if bound. Read-only. */
export function activeReplica(db: DatabaseSync, scope: ReplicaScope): ReplicaRow | undefined {
  if (!hasTable(db, '_sync_replica')) return undefined;
  const stmt = db.prepare(
    'SELECT * FROM _sync_replica WHERE scope = ? AND retired_at IS NULL ORDER BY bound_at DESC LIMIT 1',
  );
  stmt.setReadBigInts(true);
  const r = stmt.get(scope) as Record<string, unknown> | undefined;
  return r ? rowFrom(r) : undefined;
}

/**
 * The active replica id of `scope` in the store at `dbPath`, read without
 * binding or migrating anything: a read-only open, `null` when the store or
 * its replica table does not exist yet (T12336: vault reads never write).
 *
 * @param dbPath - The `cleo.db` file.
 * @param scope - Which replica to read.
 * @returns The replica id, or `null`.
 */
export async function readActiveReplicaId(
  dbPath: string,
  scope: ReplicaScope,
): Promise<string | null> {
  if (!existsSync(dbPath)) return null;
  const { openNativeDatabase } = await import('../sqlite-native.js');
  const db = openNativeDatabase(dbPath, { readonly: true, enableWal: false });
  try {
    return activeReplica(db, scope)?.replicaId ?? null;
  } finally {
    db.close();
  }
}

/** Every replica row of a store, oldest first. Read-only. */
export function listReplicas(db: DatabaseSync): ReplicaRow[] {
  if (!hasTable(db, '_sync_replica')) return [];
  const stmt = db.prepare('SELECT * FROM _sync_replica ORDER BY bound_at, replica_id');
  stmt.setReadBigInts(true);
  return (stmt.all() as Array<Record<string, unknown>>).map(rowFrom);
}

const SEQ_PREFIX = 'seq:';

/**
 * The store-side high-water mark: the last `replicaSeq` this store persisted
 * per stream for a replica. Read-only.
 */
export function storeHwm(db: DatabaseSync, replicaId: string): Record<string, number> {
  if (!hasTable(db, '_sync_meta')) return {};
  const prefix = `${SEQ_PREFIX}${replicaId}:`;
  const rows = db
    .prepare('SELECT key, value FROM _sync_meta WHERE key >= ? AND key < ?')
    .all(prefix, `${prefix}￿`) as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key.slice(prefix.length), Number(r.value)]));
}

/**
 * Record, in the caller's transaction, that a segment with `seq` was
 * persisted for `stream`. S4 calls this in the segment-persist transaction,
 * then {@link ReplicaRegistry.advanceHwm} after it commits. The value only
 * moves up.
 */
export function persistStoreSeq(
  db: DatabaseSync,
  replicaId: string,
  stream: string,
  seq: number,
  now: Date = new Date(),
): void {
  // @sync-invariant none:local-only programming-error guard on this store's replica sequence
  if (!db.isTransaction) throw new Error('persistStoreSeq must run inside a transaction');
  // @sync-invariant none:local-only a malformed local replica sequence is refused; machine-local bookkeeping
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error(`invalid replicaSeq ${seq}`);
  db.prepare(
    'INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at ' +
      'WHERE CAST(excluded.value AS INTEGER) > CAST(_sync_meta.value AS INTEGER)',
  ).run(`${SEQ_PREFIX}${replicaId}:${stream}`, String(seq), now.toISOString());
}

/**
 * Why a bound store must rebind, if at all. Pure.
 *
 * @param row - The store's active replica row.
 * @param identity - The file's identity now.
 * @param deviceId - This device.
 * @param entry - This device's registry entry for the replica, if any.
 * @param hwm - The store-side hwm for the replica ({@link storeHwm}).
 */
export function rebindReasons(
  row: ReplicaRow,
  identity: FileIdentity,
  deviceId: string,
  entry: ReplicaRegistryEntry | undefined,
  hwm: Readonly<Record<string, number>>,
): RebindReason[] {
  const out: RebindReason[] = [];
  const birthDiffers =
    row.fileBirth !== null && identity.birth !== null && row.fileBirth !== identity.birth;
  if (row.fileIno !== identity.ino || birthDiffers) out.push('file-identity');
  if (row.deviceId !== deviceId) out.push('foreign-device');
  if (entry && entry.nonce !== row.nonce) out.push('nonce-mismatch');
  if (entry && Object.entries(entry.hwm).some(([stream, seq]) => (hwm[stream] ?? 0) < seq)) {
    out.push('rollback');
  }
  return out;
}

function insertReplica(db: DatabaseSync, row: ReplicaRow): void {
  db.prepare(
    'INSERT INTO _sync_replica (replica_id, scope, nonce, device_id, file_ino, file_birth, bound_at, bound_why) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.replicaId,
    row.scope,
    row.nonce,
    row.deviceId,
    row.fileIno,
    row.fileBirth,
    row.boundAt,
    row.boundWhy,
  );
}

function mintRow(
  scope: ReplicaScope,
  identity: FileIdentity,
  deviceId: string,
  why: string,
  now: Date,
): ReplicaRow {
  return {
    replicaId: uuidv7(now.getTime()),
    scope,
    nonce: randomBytes(16).toString('hex'),
    deviceId,
    fileIno: identity.ino,
    fileBirth: identity.birth,
    boundAt: now.toISOString(),
    boundWhy: why,
    retiredAt: null,
    successor: null,
  };
}

/**
 * Retire `previous` and bind a new replica in its place, in the caller's
 * transaction. The new replica's clock starts from the old one, so HLCs
 * issued by this store keep increasing. The old replica's live captures and
 * sealed transactions become `inherited`, so the new replica never seals or
 * sends them (§1.5 H3). Runs the rebind hooks.
 */
function rebindInTransaction(
  db: DatabaseSync,
  previous: ReplicaRow,
  identity: FileIdentity,
  deviceId: string,
  reasons: readonly RebindReason[],
  now: Date,
): ReplicaRow {
  const current = mintRow(previous.scope, identity, deviceId, `rebind:${reasons.join(',')}`, now);
  db.prepare('UPDATE _sync_replica SET retired_at = ?, successor = ? WHERE replica_id = ?').run(
    now.toISOString(),
    current.replicaId,
    previous.replicaId,
  );
  insertReplica(db, current);
  const old = healClock(db, previous.replicaId);
  storeClock(db, { phys: old.phys, ctr: old.ctr, replica: current.replicaId });
  const inherited = markInheritedRows(db);
  db.prepare(
    'INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(
    'rebind:last',
    JSON.stringify({ from: previous.replicaId, to: current.replicaId, reasons, inherited }),
    now.toISOString(),
  );
  const retired: ReplicaRow = {
    ...previous,
    retiredAt: now.toISOString(),
    successor: current.replicaId,
  };
  for (const hook of rebindHooks) hook(db, { previous: retired, current, reasons });
  return current;
}

/** Options for {@link syncOpenPass} and {@link rebindReplica}. */
export interface SyncOpenOptions {
  /** Path of the store file the handle has open. */
  readonly dbPath: string;
  readonly scope: ReplicaScope;
  readonly mode: SyncOpenMode;
  /** This device. Defaults to `getStableDeviceId()` (live mode only). */
  readonly deviceId?: string;
  /** The device registry. Required in `test` mode; defaults to the device's in `live` mode. */
  readonly registry?: ReplicaRegistry;
  readonly stat?: StatFn;
  readonly now?: () => Date;
  /** Sync schema folder override (tests). */
  readonly schemaRoot?: string;
}

/** What an open pass did. */
export type SyncOpenResult =
  | { readonly status: 'off' | 'disabled' }
  | {
      readonly status: 'bound' | 'rebound';
      readonly replicaId: string;
      readonly previousReplicaId?: string;
      readonly reasons: readonly RebindReason[];
      /** Whether the device registry file was written. */
      readonly registryWritten: boolean;
    };

function resolveContext(opts: SyncOpenOptions): { deviceId: string; registry: ReplicaRegistry } {
  if (opts.mode === 'test' && !opts.registry) {
    // @sync-invariant none:local-only test-mode guard: a test open never touches the device registry
    throw new Error("sync open mode 'test' needs an explicit registry; it never uses the device's");
  }
  const deviceId = opts.deviceId ?? opts.registry?.deviceId ?? getStableDeviceId();
  const registry = opts.registry ?? ReplicaRegistry.forDevice(deviceId);
  if (registry.deviceId !== deviceId) {
    // @sync-invariant none:local-only the registry passed in is another device's; machine-local bookkeeping
    throw new Error(`registry belongs to device ${registry.deviceId}, not ${deviceId}`);
  }
  return { deviceId, registry };
}

function register(
  registry: ReplicaRegistry,
  db: DatabaseSync,
  row: ReplicaRow,
  realpath: string,
  now: Date,
): boolean {
  return registry.upsert(
    row.replicaId,
    { nonce: row.nonce, scope: row.scope, dbRealpath: realpath, hwm: storeHwm(db, row.replicaId) },
    now,
  );
}

/**
 * The sync open pass for a canonical store open.
 *
 * With `mode: 'off'`, or with every `sync.*` flag off on the store, it reads
 * nothing beyond the flags and writes nothing. Otherwise, under
 * `BEGIN IMMEDIATE`: it binds an unbound store, rebinds a copy, a rolled-back
 * or a foreign store, and heals the clock. Then it brings the device registry
 * up to date (re-registering a store the registry lost, recording a rename).
 *
 * Not yet called by `openDualScopeDb`: the capture slice (S2) wires it in.
 */
export function syncOpenPass(db: DatabaseSync, opts: SyncOpenOptions): SyncOpenResult {
  if (opts.mode === 'off') return { status: 'off' };
  if (!anySyncFlagOn(db)) return { status: 'disabled' };
  return bindPass(db, opts);
}

/**
 * Bind the canonical project store to a replica if it has none, and return
 * the active replica id (device contract §3.7, the T12675 minimal slice used
 * by `cleo project link`).
 *
 * It applies the sync schema (local-only bookkeeping and capture-outbox
 * tables, no triggers) and runs the bind half of {@link syncOpenPass} under
 * `BEGIN IMMEDIATE`, with the same rebind rules, but sets NO `sync.*` flag:
 * capture, seal, push and pull stay off. Idempotent in effect: once bound it
 * keeps the same replica id, but every call still takes the write lock
 * (waiting on a busy store), may heal the clock row, and refreshes the
 * device replica registry file.
 *
 * @param db - The canonical project store handle (opened through the chokepoint).
 * @param opts - Store path and overrides; `scope` is always `project`, and
 *   `mode` `off` is refused because a link must bind.
 * @returns The active replica id, and the retired id when this call rebound a copy.
 * @throws {Error} With `mode: 'off'`.
 */
export function ensureProjectReplica(
  db: DatabaseSync,
  opts: Omit<SyncOpenOptions, 'scope'>,
): { replicaId: string; reboundFrom?: string } {
  // @sync-invariant none:local-only programming-error guard on binding this store's replica
  if (opts.mode === 'off') throw new Error('ensureProjectReplica needs a live or test open');
  const result = bindPass(db, { ...opts, scope: 'project' });
  if (result.status !== 'bound' && result.status !== 'rebound') {
    // @sync-invariant none:local-only the bind pass returned an unexpected status; machine-local bookkeeping
    throw new Error(`ensureProjectReplica: unexpected status ${result.status}`);
  }
  return {
    replicaId: result.replicaId,
    ...(result.previousReplicaId ? { reboundFrom: result.previousReplicaId } : {}),
  };
}

/**
 * {@link ensureProjectReplica} for the global store (`<cleoHome>/cleo.db`):
 * bind it to one global-scope replica, with no `sync.*` flag set (T12952).
 * The replica is what the account's `home:` stream knows this device's
 * global store (the main brain) by.
 *
 * @param db - The canonical global store handle (opened through the chokepoint).
 * @param opts - Store path and overrides; `scope` is always `global`.
 * @returns The active replica id, and the retired id when this call rebound a copy.
 * @throws {Error} With `mode: 'off'`.
 */
export function ensureGlobalReplica(
  db: DatabaseSync,
  opts: Omit<SyncOpenOptions, 'scope'>,
): { replicaId: string; reboundFrom?: string } {
  // @sync-invariant none:local-only programming-error guard on binding this store's replica
  if (opts.mode === 'off') throw new Error('ensureGlobalReplica needs a live or test open');
  const result = bindPass(db, { ...opts, scope: 'global' });
  if (result.status !== 'bound' && result.status !== 'rebound') {
    // @sync-invariant none:local-only the bind pass returned an unexpected status; machine-local bookkeeping
    throw new Error(`ensureGlobalReplica: unexpected status ${result.status}`);
  }
  return {
    replicaId: result.replicaId,
    ...(result.previousReplicaId ? { reboundFrom: result.previousReplicaId } : {}),
  };
}

/** The bind half of {@link syncOpenPass}: everything after the flag check. */
function bindPass(db: DatabaseSync, opts: SyncOpenOptions): SyncOpenResult {
  const now = opts.now?.() ?? new Date();
  const { deviceId, registry } = resolveContext(opts);
  ensureSyncSchema(db, { root: opts.schemaRoot, now });
  const identity = fileIdentity(opts.dbPath, opts.stat);
  const realpath = realpathSync(opts.dbPath);
  const known = registry.read().replicas;

  const outcome = withImmediateTransaction(db, () => {
    const row = activeReplica(db, opts.scope);
    if (!row) {
      const minted = mintRow(opts.scope, identity, deviceId, 'genesis', now);
      insertReplica(db, minted);
      healClock(db, minted.replicaId);
      return { row: minted, previous: undefined, reasons: [] as RebindReason[] };
    }
    const entry = Object.hasOwn(known, row.replicaId) ? known[row.replicaId] : undefined;
    const reasons = rebindReasons(row, identity, deviceId, entry, storeHwm(db, row.replicaId));
    if (reasons.length === 0) {
      healClock(db, row.replicaId);
      return { row, previous: undefined, reasons };
    }
    const current = rebindInTransaction(db, row, identity, deviceId, reasons, now);
    return { row: current, previous: row, reasons };
  });

  let registryWritten = false;
  if (outcome.previous && Object.hasOwn(known, outcome.previous.replicaId)) {
    const prev = known[outcome.previous.replicaId] as ReplicaRegistryEntry;
    // Only the device's own registration of the retired replica is marked; a
    // copy's original keeps its entry untouched when it lives elsewhere.
    if (prev.dbRealpath === realpath) {
      registryWritten =
        registry.upsert(
          outcome.previous.replicaId,
          {
            ...prev,
            retiredAt: now.toISOString(),
            successor: outcome.row.replicaId,
            retireReason: outcome.reasons.join(','),
          },
          now,
        ) || registryWritten;
    }
  }
  registryWritten = register(registry, db, outcome.row, realpath, now) || registryWritten;

  return {
    status: outcome.previous ? 'rebound' : 'bound',
    replicaId: outcome.row.replicaId,
    ...(outcome.previous ? { previousReplicaId: outcome.previous.replicaId } : {}),
    reasons: outcome.reasons,
    registryWritten,
  };
}

/** Options of {@link rebindReplica}. */
export interface RebindReplicaOptions {
  /**
   * Record the retired replica as a retire candidate in the device registry
   * (default `true`). Even then it is recorded only when it was this device's
   * own replica of this file: registered here at this path with this nonce,
   * or, when the registry lost it, bound by this device (T13109 review MED-1).
   */
  readonly recordRetirement?: boolean;
  /**
   * The caller proved the store file is the one this replica was bound to
   * (the vault compares the replaced file's identity), so a registry entry
   * at another path is this file after a rename: the nonce must still match,
   * the path need not, and the entry moves to this path (review LOW-A).
   */
  readonly identityProven?: boolean;
}

/**
 * Force a rebind of a bound store: the hook S4 uses when the server answers a
 * push with "seq exists, hash differs" (N6: the server hwm is authoritative).
 *
 * @throws {Error} When the store has no active replica.
 */
export function rebindReplica(
  db: DatabaseSync,
  opts: SyncOpenOptions,
  reason: RebindReason = 'server-seq-conflict',
  rebindOpts: RebindReplicaOptions = {},
): { replicaId: string; previousReplicaId: string } {
  const now = opts.now?.() ?? new Date();
  const { deviceId, registry } = resolveContext(opts);
  const identity = fileIdentity(opts.dbPath, opts.stat);
  const realpath = realpathSync(opts.dbPath);
  const { previous, current, hwm } = withImmediateTransaction(db, () => {
    const row = activeReplica(db, opts.scope);
    // @sync-invariant none:local-only no active replica to rebind; machine-local bookkeeping
    if (!row) throw new Error(`no active ${opts.scope} replica to rebind`);
    const persisted = storeHwm(db, row.replicaId);
    return {
      previous: row,
      hwm: persisted,
      current: rebindInTransaction(db, row, identity, deviceId, [reason], now),
    };
  });
  // The retired replica is a retire candidate (§1.5 "Retirement"; T13109) only
  // when it was this device's own replica of this file: registered here at
  // this path with this nonce, or, when the registry lost it, bound by this
  // device. A copy (another path) or another device's store retires nothing.
  const prev = registry.get(previous.replicaId);
  const own = prev
    ? (rebindOpts.identityProven === true || prev.dbRealpath === realpath) &&
      prev.nonce === previous.nonce
    : previous.deviceId === deviceId;
  if (own && rebindOpts.recordRetirement !== false) {
    registry.upsert(
      previous.replicaId,
      {
        ...(prev ?? { nonce: previous.nonce, scope: previous.scope, hwm }),
        dbRealpath: realpath,
        retiredAt: now.toISOString(),
        successor: current.replicaId,
        retireReason: reason,
      },
      now,
    );
  }
  register(registry, db, current, realpath, now);
  return { replicaId: current.replicaId, previousReplicaId: previous.replicaId };
}

/** What {@link rebindAfterVaultRestore} did. */
export interface VaultRestoreRebind {
  readonly replicaId: string;
  readonly previousReplicaId: string;
  /**
   * `vault-restore` when the retired replica was this device's replica of the
   * file the snapshot replaced (a retire candidate); otherwise the open-pass
   * reason the store carried anyway: `foreign-device` (another device bound
   * it) or `file-identity` (a copy, bound to another file).
   */
  readonly reason: Extract<RebindReason, 'vault-restore' | 'foreign-device' | 'file-identity'>;
}

/**
 * After a vault restore or pull placed a snapshot at `dbPath`, retire the
 * store's replica and bind a new one. The placed file is a new store instance
 * (another device's data, or this store rolled back), so it may not continue
 * the old replica's `replicaSeq` stream (§1.5 rules 1 and 3, N6). Rebinding
 * here, before any open pass sees the new inode, records why; the server keeps
 * the retired replica as history until S4 announces its retirement (T13109).
 *
 * The retired replica is recorded as `vault-restore` (a retire candidate) only
 * when it was bound to the file the snapshot replaced (`before`) by this
 * device. A store that was itself a copy (bound to another file) or came from
 * another device is rebound for that reason, `file-identity` or
 * `foreign-device`, and retires nothing (review MED-1).
 *
 * A store with no bound replica (a project restored onto this machine for the
 * first time) is left alone: its first link binds it.
 *
 * @param dbPath - The placed `cleo.db`.
 * @param scope - Which store it is.
 * @param before - The identity of the file at `dbPath` before the placement, or `null` when there was none.
 * @param opts - Device id, registry, stat and clock overrides (tests).
 * @returns What was rebound, or `null` when the store had no replica.
 */
export async function rebindAfterVaultRestore(
  dbPath: string,
  scope: ReplicaScope,
  before: FileIdentity | null,
  opts: Pick<SyncOpenOptions, 'deviceId' | 'registry' | 'stat' | 'now'> = {},
): Promise<VaultRestoreRebind | null> {
  if (!existsSync(dbPath)) return null;
  const { openNativeDatabase } = await import('../sqlite-native.js');
  const { installSchemaWriteGuard } = await import('../worktree-build-guard.js');
  const db = openNativeDatabase(dbPath);
  try {
    installSchemaWriteGuard(db); // T12687: the rebind is DML only
    const row = activeReplica(db, scope);
    if (!row) return null;
    const deviceId = opts.deviceId ?? opts.registry?.deviceId ?? getStableDeviceId();
    const boundHere =
      before !== null &&
      row.fileIno === before.ino &&
      (row.fileBirth === null || before.birth === null || row.fileBirth === before.birth);
    const reason: VaultRestoreRebind['reason'] =
      row.deviceId !== deviceId ? 'foreign-device' : boundHere ? 'vault-restore' : 'file-identity';
    const out = rebindReplica(db, { ...opts, deviceId, dbPath, scope, mode: 'live' }, reason, {
      recordRetirement: reason === 'vault-restore',
      identityProven: reason === 'vault-restore',
    });
    return { ...out, reason };
  } finally {
    db.close();
  }
}

/** The current clock of the store's active replica, for diagnostics. Read-only. */
export function currentClock(db: DatabaseSync, scope: ReplicaScope): string | undefined {
  const row = activeReplica(db, scope);
  if (!row || !hasTable(db, '_sync_clock')) return undefined;
  return encodeHlc(loadClock(db, row.replicaId));
}
