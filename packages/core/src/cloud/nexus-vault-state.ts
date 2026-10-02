/**
 * This machine's cloud vault state (`<cleoHome>/nexus-vault.json`):
 * secret-free, machine-local bookkeeping the vault needs between runs.
 *
 * - Per account: the signer {@link TrustState} learned from
 *   `certifiedSigners` (trust only tightens, so it must survive restarts).
 * - Per (stream, local store): the snapshot this store last pushed or
 *   restored, which decides "behind" (another device pushed since) and
 *   "pending changes" (this store changed since).
 *
 * Every read-modify-write runs under a lock file and writes atomically (temp
 * file + rename). A file this version cannot read (truncated, invalid, or
 * written by a newer CLEO) is moved aside with a warning, never reset in
 * place, so a downgrade or a torn write cannot silently discard the signer
 * pins. Nothing here is secret: keys and tokens stay in the sealed device
 * store.
 *
 * @task T12336
 * @epic T12322
 */

import fs from 'node:fs';
import path from 'node:path';
import type { CloudWarning } from '@cleocode/contracts';
import { resolveNexusVaultStatePath } from '@cleocode/paths';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { initialTrustState, type TrustState } from './keys.js';

const trustStateSchema = z.object({
  keyVersion: z.number().int().nonnegative(),
  pins: z.record(
    z.string(),
    z.object({
      replicas: z.record(z.string(), z.number().int().nonnegative()),
      checkpoints: z.record(z.string(), z.number().int().nonnegative()),
    }),
  ),
  revoked: z.array(z.string()),
});

const streamStateSchema = z.looseObject({
  /** The snapshot this store last pushed or restored. */
  lastCheckpointId: z.string().nullable(),
  /** Its coversSeq: an older snapshot is never restored over it without `--checkpoint`. */
  lastCoversSeq: z.number().int().nonnegative(),
  updatedAt: z.string(),
  /**
   * A push from this store that had not recorded its snapshot yet: the parent it
   * pushed over (T13007). Cleared when the snapshot is recorded.
   */
  pushInFlight: z.object({ parentCheckpointId: z.string().nullable(), at: z.string() }).optional(),
  /**
   * Paths (relative to the section root) the last synced snapshot marks as
   * git-tracked: git's job, so they are left out of every file comparison
   * with it, and a machine without git carries the marks on (T13019).
   */
  gitTracked: z.array(z.string()).optional(),
  /**
   * The last synced snapshot's plain files, path to digest (a prefix of the
   * vault file digest), so a later comparison judges each file on its own,
   * whatever either side's git tracks (T13038).
   */
  files: z.record(z.string(), z.string()).optional(),
});

const accountStateSchema = z.looseObject({
  trust: trustStateSchema,
  streams: z.record(z.string(), streamStateSchema).default({}),
});

const stateSchema = z.looseObject({
  version: z.literal(1),
  accounts: z.record(z.string(), accountStateSchema).default({}),
});

type VaultStateFile = z.infer<typeof stateSchema>;

/** What a store last synced with on a stream. */
export type VaultStreamState = z.infer<typeof streamStateSchema>;

/** Key of one account in the state file. */
const accountKey = (apiUrl: string, userId: string) => `${apiUrl} ${userId}`;

/** Key of one local store on one stream. */
export const vaultStreamKey = (streamId: string, storeRoot: string) =>
  `${streamId}|${path.resolve(storeRoot)}`;

/** How long a state access waits for another process's lock. */
const LOCK_WAIT_MS = 15_000;

/** Age after which a lock whose holder stopped refreshing it may be taken over. */
const LOCK_STALE_MS = 10_000;

/** Warning code: the state file was unreadable or newer, and was moved aside. */
export const W_NEXUS_VAULT_STATE_MOVED = 'W_NEXUS_VAULT_STATE_MOVED';

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read/modify/write access to the vault state file.
 */
export class NexusVaultState {
  /** Absolute path of the state file. */
  readonly path: string;
  private warnings: CloudWarning[] = [];

  /** @param filePath - Override for tests; defaults to {@link resolveNexusVaultStatePath}. */
  constructor(filePath?: string) {
    this.path = filePath ?? resolveNexusVaultStatePath();
  }

  /** Warnings raised since the last call (a moved-aside file), for the command's result. */
  drainWarnings(): CloudWarning[] {
    const out = this.warnings;
    this.warnings = [];
    return out;
  }

  /** Run `fn` holding the state file's lock. */
  private locked<T>(fn: () => T): T {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    let release: () => void;
    for (;;) {
      try {
        release = lockfile.lockSync(this.path, { realpath: false, stale: LOCK_STALE_MS });
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ELOCKED' || Date.now() > deadline) {
          throw new Error(
            `cannot lock the cloud vault state ${this.path}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        sleepSync(25);
      }
    }
    try {
      return fn();
    } finally {
      release();
    }
  }

  /** Move an unusable file aside (never overwrite it) and start empty. */
  private moveAside(why: 'unreadable' | 'newer'): VaultStateFile {
    const aside = `${this.path}.${why}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(this.path, aside);
    this.warnings.push({
      code: W_NEXUS_VAULT_STATE_MOVED,
      message:
        why === 'newer'
          ? `the cloud vault state was written by a newer CLEO; it was moved to ${aside} and this machine starts with empty vault state (re-run with the newer CLEO, or restore that file after upgrading)`
          : `the cloud vault state could not be read; it was moved to ${aside} and this machine starts with empty vault state (signer trust is re-learned on the next command; the next push or pull resyncs)`,
    });
    return { version: 1, accounts: {} };
  }

  private read(): VaultStateFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, accounts: {} };
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return this.moveAside('unreadable');
    }
    const version =
      json !== null && typeof json === 'object' ? (json as { version?: unknown }).version : null;
    if (typeof version === 'number' && version > 1) return this.moveAside('newer');
    const parsed = stateSchema.safeParse(json);
    return parsed.success ? parsed.data : this.moveAside('unreadable');
  }

  private write(state: VaultStateFile): void {
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.path);
  }

  /** Read, let `fn` change the state, and write it back, all under the lock. */
  private update<T>(fn: (state: VaultStateFile) => T): T {
    return this.locked(() => {
      const state = this.read();
      const out = fn(state);
      this.write(state);
      return out;
    });
  }

  /** Read under the lock (moving an unusable file aside). */
  private snapshot(): VaultStateFile {
    return this.locked(() => this.read());
  }

  private account(state: VaultStateFile, apiUrl: string, userId: string) {
    const k = accountKey(apiUrl, userId);
    state.accounts[k] ??= { trust: initialTrustState(), streams: {} };
    return state.accounts[k];
  }

  /** The account's persisted signer trust state. */
  trust(apiUrl: string, userId: string): TrustState {
    const s = this.snapshot();
    return structuredClone(this.account(s, apiUrl, userId).trust);
  }

  /** Persist the trust state returned by `certifiedSigners`. */
  saveTrust(apiUrl: string, userId: string, trust: TrustState): void {
    this.update((s) => {
      this.account(s, apiUrl, userId).trust = structuredClone(trust);
    });
  }

  /**
   * Read the account's trust state, let `fn` evaluate it, and persist the
   * trust it returns, all under one lock.
   *
   * @param apiUrl - Account API URL.
   * @param userId - Account user id.
   * @param fn - Receives the current trust; returns the trust to store and a result.
   * @returns `fn`'s result.
   */
  updateTrust<T>(
    apiUrl: string,
    userId: string,
    fn: (current: TrustState) => { trust: TrustState; result: T },
  ): T {
    return this.update((s) => {
      const a = this.account(s, apiUrl, userId);
      const { trust, result } = fn(structuredClone(a.trust));
      a.trust = structuredClone(trust);
      return result;
    });
  }

  /** What `storeRoot` last synced with on `streamId`, or `null`. */
  stream(
    apiUrl: string,
    userId: string,
    streamId: string,
    storeRoot: string,
  ): VaultStreamState | null {
    const s = this.snapshot();
    return this.account(s, apiUrl, userId).streams[vaultStreamKey(streamId, storeRoot)] ?? null;
  }

  /**
   * Record that a push from `storeRoot` is about to create a snapshot over
   * `parentCheckpointId` (T13007). {@link saveStream} clears the mark; when a
   * crash loses that write, the mark tells the next command that the head
   * this device and replica pushed over that parent is this store's own.
   */
  markPushInFlight(
    apiUrl: string,
    userId: string,
    streamId: string,
    storeRoot: string,
    parentCheckpointId: string | null,
  ): void {
    this.update((s) => {
      const streams = this.account(s, apiUrl, userId).streams;
      const key = vaultStreamKey(streamId, storeRoot);
      const prior = streams[key];
      streams[key] = {
        ...prior,
        lastCheckpointId: prior?.lastCheckpointId ?? null,
        lastCoversSeq: prior?.lastCoversSeq ?? 0,
        // Never synced: any fork is news to this store.
        updatedAt: prior?.updatedAt ?? new Date(0).toISOString(),
        pushInFlight: { parentCheckpointId, at: new Date().toISOString() },
      };
    });
  }

  /** Record that `storeRoot` now holds `checkpointId` on `streamId`. */
  saveStream(
    apiUrl: string,
    userId: string,
    streamId: string,
    storeRoot: string,
    value: {
      lastCheckpointId: string;
      lastCoversSeq: number;
      gitTracked?: readonly string[];
      files?: Readonly<Record<string, string>>;
    },
  ): void {
    const { gitTracked, files, ...rest } = value;
    this.update((s) => {
      // In the schema's key order, so a later read-modify-write keeps the bytes.
      this.account(s, apiUrl, userId).streams[vaultStreamKey(streamId, storeRoot)] = {
        ...rest,
        updatedAt: new Date().toISOString(),
        ...(gitTracked !== undefined && gitTracked.length > 0
          ? { gitTracked: [...gitTracked].sort() }
          : {}),
        ...(files !== undefined ? { files: { ...files } } : {}),
      };
    });
  }
}
