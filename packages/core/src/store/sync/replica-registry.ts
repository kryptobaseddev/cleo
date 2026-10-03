/**
 * The device's replica registry (journal spec §1.5, N6).
 *
 * A JSON file of device state, never inside a store and never synced: its
 * path comes from `@cleocode/paths` ({@link resolveSyncReplicaRegistryPath}),
 * in the machine-local state dir, keyed by the stable device id. Per replica
 * id it records the store's nonce, where the store lives, and the device-side
 * high-water mark (`hwm`): the last `replicaSeq` this device persisted per
 * stream. A store whose own persisted sequence is BELOW the hwm was rolled
 * back (restored into the same file), which the open pass turns into a
 * rebind.
 *
 * Losing the file (a new device, a wiped state dir) or finding it unreadable
 * is treated as an empty registry: the open pass re-registers the store and
 * does not rebind for that alone. The server's sequence check (S4) is the
 * authority that catches what a lost registry cannot.
 *
 * Writes use the file-then-rename pattern, so a crash leaves the old or the
 * new file, never a torn one.
 *
 * A replica this device retired at the same path (a replaced or rolled-back
 * file; a copy retires nothing) keeps its entry with `retiredAt`, `successor`,
 * the rebind reason and its hwm: those entries are the retire candidates the
 * signed `retire` transaction of S4 announces (§1.5 "Retirement"; T13109).
 *
 * @task T12342
 * @task T13109
 * @module store/sync/replica-registry
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveStableDeviceIdPath, resolveSyncReplicaRegistryPath } from '@cleocode/paths';

/** One replica this device has bound. */
export interface ReplicaRegistryEntry {
  /** The nonce minted with the replica and stored in its `_sync_replica` row. */
  readonly nonce: string;
  /** `project` or `global`. */
  readonly scope: string;
  /** Real path of the store file when last opened here. */
  readonly dbRealpath: string;
  /** Last persisted `replicaSeq` per stream. */
  readonly hwm: Readonly<Record<string, number>>;
  /** When this replica was retired on this device, if it was. */
  readonly retiredAt?: string;
  /** The replica that replaced it. */
  readonly successor?: string;
  /** Why it was retired: the rebind reason(s), e.g. `vault-restore` or `file-identity`. */
  readonly retireReason?: string;
  /** When S4's signed `retire` transaction announced it; unset while it is still a candidate. */
  readonly retireAnnouncedAt?: string;
  readonly updatedAt: string;
}

/** A replica this device retired, as the registry records it. */
export interface RetiredReplica {
  readonly replicaId: string;
  /** `project` or `global`. */
  readonly scope: string;
  /** Real path of the store file it named. */
  readonly dbRealpath: string;
  /** The replica that replaced it. */
  readonly successor: string;
  readonly retiredAt: string;
  /** The rebind reason(s), or `null` for an entry retired before reasons were recorded. */
  readonly reason: string | null;
  /** Its last persisted `replicaSeq` per stream: what a `retire` transaction names. */
  readonly lastReplicaSeq: Readonly<Record<string, number>>;
  /** When S4 announced it, or `null` while it is a candidate. */
  readonly announcedAt: string | null;
}

/** The registry file. */
export interface ReplicaRegistryFile {
  readonly version: 1;
  readonly deviceId: string;
  readonly replicas: Readonly<Record<string, ReplicaRegistryEntry>>;
}

/** Reads and writes one device's registry file. */
export class ReplicaRegistry {
  /**
   * @param path - The registry file.
   * @param deviceId - The device the file belongs to.
   */
  constructor(
    readonly path: string,
    readonly deviceId: string,
  ) {}

  /** The registry at its canonical path for `deviceId`. */
  static forDevice(deviceId: string): ReplicaRegistry {
    return new ReplicaRegistry(resolveSyncReplicaRegistryPath(deviceId), deviceId);
  }

  private empty(): ReplicaRegistryFile {
    return { version: 1, deviceId: this.deviceId, replicas: {} };
  }

  /**
   * The registry contents. A missing, unreadable or foreign file (another
   * device id) reads as empty.
   */
  read(): ReplicaRegistryFile {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return this.empty();
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ReplicaRegistryFile>;
      if (
        parsed.version !== 1 ||
        parsed.deviceId !== this.deviceId ||
        typeof parsed.replicas !== 'object' ||
        parsed.replicas === null
      ) {
        return this.empty();
      }
      return { version: 1, deviceId: this.deviceId, replicas: parsed.replicas };
    } catch {
      return this.empty();
    }
  }

  /** One replica's entry, if registered. */
  get(replicaId: string): ReplicaRegistryEntry | undefined {
    const replicas = this.read().replicas;
    return Object.hasOwn(replicas, replicaId) ? replicas[replicaId] : undefined;
  }

  /** Replace the whole file (file-then-rename). */
  write(file: ReplicaRegistryFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  /**
   * Insert or update one replica's entry. The hwm only moves up.
   *
   * @returns Whether the file changed.
   */
  upsert(
    replicaId: string,
    patch: Omit<ReplicaRegistryEntry, 'updatedAt' | 'hwm'> & {
      hwm?: Readonly<Record<string, number>>;
    },
    now: Date = new Date(),
  ): boolean {
    const file = this.read();
    const prev = Object.hasOwn(file.replicas, replicaId) ? file.replicas[replicaId] : undefined;
    const hwm: Record<string, number> = { ...(prev?.hwm ?? {}) };
    for (const [stream, seq] of Object.entries(patch.hwm ?? {})) {
      hwm[stream] = Math.max(hwm[stream] ?? 0, seq);
    }
    const next: ReplicaRegistryEntry = {
      nonce: patch.nonce,
      scope: patch.scope,
      dbRealpath: patch.dbRealpath,
      hwm,
      ...(patch.retiredAt !== undefined ? { retiredAt: patch.retiredAt } : {}),
      ...(patch.successor !== undefined ? { successor: patch.successor } : {}),
      ...(patch.retireReason !== undefined ? { retireReason: patch.retireReason } : {}),
      ...(patch.retireAnnouncedAt !== undefined
        ? { retireAnnouncedAt: patch.retireAnnouncedAt }
        : {}),
      updatedAt: prev?.updatedAt ?? now.toISOString(),
    };
    if (prev && sameEntry(prev, next)) return false;
    this.write({
      ...file,
      replicas: { ...file.replicas, [replicaId]: { ...next, updatedAt: now.toISOString() } },
    });
    return true;
  }

  /**
   * Advance a replica's hwm for one stream after a segment persist committed
   * (S4 calls this right after the store transaction, §2.8). If the process
   * dies in between, the store is ahead of the registry, which is the safe
   * direction: only a store BEHIND the registry rebinds.
   *
   * @returns Whether the file changed.
   */
  advanceHwm(replicaId: string, stream: string, seq: number, now: Date = new Date()): boolean {
    const prev = this.get(replicaId);
    if (!prev) {
      throw new Error(`replica ${replicaId} is not registered on device ${this.deviceId}`);
    }
    return this.upsert(replicaId, { ...prev, hwm: { [stream]: seq } }, now);
  }

  /**
   * The replicas this device retired, newest first, optionally only those of
   * one store file or scope.
   *
   * @param filter - Store real path and/or scope to keep.
   * @returns The retired entries.
   */
  retired(filter: { dbRealpath?: string; scope?: string } = {}): RetiredReplica[] {
    const out: RetiredReplica[] = [];
    for (const [replicaId, e] of Object.entries(this.read().replicas)) {
      if (!e.retiredAt || !e.successor) continue;
      if (filter.dbRealpath !== undefined && e.dbRealpath !== filter.dbRealpath) continue;
      if (filter.scope !== undefined && e.scope !== filter.scope) continue;
      out.push({
        replicaId,
        scope: e.scope,
        dbRealpath: e.dbRealpath,
        successor: e.successor,
        retiredAt: e.retiredAt,
        reason: e.retireReason ?? null,
        lastReplicaSeq: e.hwm,
        announcedAt: e.retireAnnouncedAt ?? null,
      });
    }
    return out.sort((a, b) => (a.retiredAt < b.retiredAt ? 1 : a.retiredAt > b.retiredAt ? -1 : 0));
  }

  /**
   * The retire candidates: retired replicas no `retire` transaction has
   * announced yet. S4's emitter announces each (retired id, successor, last
   * `replicaSeq`) and records `retireAnnouncedAt` (§1.5 "Retirement").
   *
   * @returns The candidates, newest first.
   */
  retireCandidates(): RetiredReplica[] {
    return this.retired().filter((r) => r.announcedAt === null);
  }
}

/**
 * This device's registry for reading only: `null` when the machine has no
 * stable device id yet. Unlike `getStableDeviceId`, it never mints one, so a
 * read-only command writes nothing.
 *
 * @returns The registry, or `null`.
 */
export function readDeviceRegistry(): ReplicaRegistry | null {
  let deviceId: string;
  try {
    deviceId = readFileSync(resolveStableDeviceIdPath(), 'utf8').trim();
  } catch {
    return null;
  }
  return deviceId.length > 0 ? ReplicaRegistry.forDevice(deviceId) : null;
}

function sameEntry(a: ReplicaRegistryEntry, b: ReplicaRegistryEntry): boolean {
  const keys = new Set([...Object.keys(a.hwm), ...Object.keys(b.hwm)]);
  for (const k of keys) if (a.hwm[k] !== b.hwm[k]) return false;
  return (
    a.nonce === b.nonce &&
    a.scope === b.scope &&
    a.dbRealpath === b.dbRealpath &&
    a.retiredAt === b.retiredAt &&
    a.successor === b.successor &&
    a.retireReason === b.retireReason &&
    a.retireAnnouncedAt === b.retireAnnouncedAt
  );
}
