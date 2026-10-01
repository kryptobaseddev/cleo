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
 * Writes are atomic (temp file + rename). Nothing here is secret: keys and
 * tokens stay in the sealed device store.
 *
 * @task T12336
 * @epic T12322
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveNexusVaultStatePath } from '@cleocode/paths';
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
});

const accountStateSchema = z.looseObject({
  trust: trustStateSchema,
  /** This machine's replica id on the account's `home:` stream. */
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

/**
 * Read/modify/write access to the vault state file.
 */
export class NexusVaultState {
  /** Absolute path of the state file. */
  readonly path: string;

  /** @param filePath - Override for tests; defaults to {@link resolveNexusVaultStatePath}. */
  constructor(filePath?: string) {
    this.path = filePath ?? resolveNexusVaultStatePath();
  }

  private read(): VaultStateFile {
    let raw: string;
    try {
      raw = fs.readFileSync(this.path, 'utf8');
    } catch {
      return { version: 1, accounts: {} };
    }
    const parsed = stateSchema.safeParse(JSON.parse(raw));
    // An unreadable or newer file is never overwritten silently with less: start
    // from empty only when it is not ours to keep (a parse failure of v1 data).
    return parsed.success ? parsed.data : { version: 1, accounts: {} };
  }

  private write(state: VaultStateFile): void {
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.path);
  }

  private account(state: VaultStateFile, apiUrl: string, userId: string) {
    const k = accountKey(apiUrl, userId);
    state.accounts[k] ??= { trust: initialTrustState(), streams: {} };
    return state.accounts[k];
  }

  /** The account's persisted signer trust state. */
  trust(apiUrl: string, userId: string): TrustState {
    const s = this.read();
    return structuredClone(this.account(s, apiUrl, userId).trust);
  }

  /** Persist the trust state returned by `certifiedSigners`. */
  saveTrust(apiUrl: string, userId: string, trust: TrustState): void {
    const s = this.read();
    this.account(s, apiUrl, userId).trust = structuredClone(trust);
    this.write(s);
  }

  /** What `storeRoot` last synced with on `streamId`, or `null`. */
  stream(
    apiUrl: string,
    userId: string,
    streamId: string,
    storeRoot: string,
  ): VaultStreamState | null {
    const s = this.read();
    return this.account(s, apiUrl, userId).streams[vaultStreamKey(streamId, storeRoot)] ?? null;
  }

  /** Record that `storeRoot` now holds `checkpointId` on `streamId`. */
  saveStream(
    apiUrl: string,
    userId: string,
    streamId: string,
    storeRoot: string,
    value: { lastCheckpointId: string; lastCoversSeq: number },
  ): void {
    const s = this.read();
    this.account(s, apiUrl, userId).streams[vaultStreamKey(streamId, storeRoot)] = {
      ...value,
      updatedAt: new Date().toISOString(),
    };
    this.write(s);
  }
}
