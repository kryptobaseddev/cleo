/**
 * Cleo Nexus device store: `<cleoHome>/nexus-device.json`.
 *
 * One file per CLEO home holds every Nexus device identity of that home, keyed
 * by API origin and then by user id (cleo-nexus device contract §2.2, §2.4,
 * §2.5, §3.1, §3.5). Each entry carries:
 *
 * - `deviceId`, the client-minted UUIDv7 (§3.1);
 * - `keys`, the device's X25519 and Ed25519 key pairs, local-only (§2.4);
 * - `current`, the device credential in use (`cnx_d1_…`, §2.2);
 * - `pending`, a client-minted rotation credential not yet confirmed (§2.5);
 * - `pendingSignOut` and `pendingRevoke`, credentials kept only to retry an
 *   unconfirmed sign-out (E9) or revoke (E10) (§3.5, M3).
 *
 * The file is separate from `nexus-credentials.json`, which stays format
 * version 1 so a downgraded CLI can read it and never touches this file
 * (finding 8).
 *
 * Safety rules, all enforced here:
 *
 * - **Owner-only.** The file is created 0600 (`O_EXCL | O_NOFOLLOW`) in a 0700
 *   directory. A file with a wider mode or another owner is refused on every
 *   read, with the `chmod 600` fix in the error. A symlink is never followed.
 * - **Locked, re-read, atomic.** Every mutation runs through
 *   {@link NexusDeviceStore.update}: it takes the cross-process lock, re-reads
 *   the file **after** acquiring it (M6, N1), applies the change, and writes a
 *   temp file that is fsynced and renamed over the original, then fsyncs the
 *   directory. No rotated backups are ever made, and any found are purged (L3).
 * - **No downgrade.** A file whose `version` is newer than this CLI knows is
 *   refused, never read as empty and never rewritten. A malformed file is
 *   refused the same way. Unknown fields in a known version are kept on
 *   rewrite, so an older writer never drops a newer writer's data.
 * - **Sealed reads.** {@link NexusDeviceStore.get} returns a
 *   {@link SealedNexusDevice}: tokens and private keys sit in a private field,
 *   and `JSON.stringify`, `util.inspect` and template strings show masked
 *   previews only. {@link redactNexusDeviceSecrets} masks credentials in any
 *   diagnostic text.
 *
 * Dormant: nothing calls this module yet. Behaviour that uses it ships behind
 * `CLEO_NEXUS_DEVICE=1` ({@link isNexusDeviceEnabled}) in T12868–T12871.
 *
 * @task T12867
 * @epic T12323
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  type statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { inspect } from 'node:util';
import { resolveNexusDevicePath } from '@cleocode/paths';
import { z } from 'zod';
import { withFileLock } from '../store/file-utils.js';
import { nexusOriginKey } from './nexus-credentials.js';

/** File name of the store, directly under the CLEO home. */
export const NEXUS_DEVICE_FILE = 'nexus-device.json';

/** The file format version this CLI reads and writes. A newer version is refused. */
export const NEXUS_DEVICE_FILE_VERSION = 1;

/** Environment switch that turns on the device-credential behaviour (T12867–T12871). */
export const NEXUS_DEVICE_ENV = 'CLEO_NEXUS_DEVICE';

/**
 * The device credential format (contract §2.2, `DEVICE_CREDENTIAL` in §4.1):
 * `cnx_d1_` followed by 43 base64url characters (32 random bytes).
 */
export const NEXUS_DEVICE_CREDENTIAL_PATTERN = /^cnx_d1_[A-Za-z0-9_-]{43}$/;

/** Every scope a device credential can carry (contract §2.3, `DeviceScope`). */
export const NEXUS_DEVICE_SCOPES = [
  'account:read',
  'devices:read',
  'projects:read',
  'projects:write',
  'sync:read',
  'sync:write',
  'keys:read',
  'keys:write',
] as const;

/** Credential profiles (contract §2.3, `DeviceProfile`). */
export const NEXUS_DEVICE_PROFILES = ['device', 'read-only'] as const;

/** `O_NOFOLLOW` where the platform has it (not on Windows). */
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** Matches a device credential, or a truncated/suffixed fragment of one, anywhere in text. */
const CREDENTIAL_IN_TEXT = /cnx_d1_[A-Za-z0-9_-]+/g;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const isoTime = z.iso.datetime();
const token = z
  .string()
  .regex(NEXUS_DEVICE_CREDENTIAL_PATTERN, 'expected a cnx_d1_ device credential');
const base64Key = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'expected a base64 32-byte key');

const keyPairSchema = z.object({ publicKey: base64Key, privateKey: base64Key });

const deviceKeysSchema = z.object({
  /** X25519: wraps and unwraps the account master key grant. */
  encryption: keyPairSchema,
  /** Ed25519: signs segments, enrolment proofs and revocations. */
  signing: keyPairSchema,
});

const currentCredentialSchema = z.object({
  credentialId: uuid,
  token,
  profile: z.enum(NEXUS_DEVICE_PROFILES),
  scopes: z.array(z.enum(NEXUS_DEVICE_SCOPES)),
  createdAt: isoTime,
});

const pendingCredentialSchema = z.object({
  /** Server id of the new credential; `null` until E8 answers (the client minted the token). */
  credentialId: uuid.nullable(),
  token,
  createdAt: isoTime,
});

const slotCredentialSchema = z.object({ credentialId: uuid.nullable(), token });

const pendingEndSchema = z.object({
  /** Credentials to retry with, newest first (`pending` before `current`, M3). */
  credentials: z.array(slotCredentialSchema).min(1).max(4),
  requestedAt: isoTime,
});

const entrySchema = z.looseObject({
  deviceId: uuid,
  createdAt: isoTime,
  keys: deviceKeysSchema.nullable(),
  current: currentCredentialSchema.nullable(),
  pending: pendingCredentialSchema.nullable(),
  pendingSignOut: pendingEndSchema.nullable(),
  pendingRevoke: pendingEndSchema.nullable(),
});

const fileSchema = z.looseObject({
  version: z.literal(NEXUS_DEVICE_FILE_VERSION),
  devices: z.record(z.string(), z.record(z.string(), entrySchema)),
});

/** A stored key pair, base64 (32 raw bytes each). */
export type NexusDeviceKeyPair = z.infer<typeof keyPairSchema>;
/** The device's two key pairs (contract §2.4). */
export type NexusDeviceKeys = z.infer<typeof deviceKeysSchema>;
/** The credential in use, as issued by E1 or promoted from `pending`. */
export type NexusDeviceCurrentCredential = z.infer<typeof currentCredentialSchema>;
/** A client-minted rotation credential awaiting confirmation (contract §2.5). */
export type NexusDevicePendingCredential = z.infer<typeof pendingCredentialSchema>;
/** One credential kept in a sign-out or revoke slot. */
export type NexusDeviceSlotCredential = z.infer<typeof slotCredentialSchema>;
/** A `pendingSignOut` or `pendingRevoke` slot (contract §3.5). */
export type NexusDevicePendingEnd = z.infer<typeof pendingEndSchema>;
/** One (origin, user) entry of the device file. */
export type NexusDeviceEntry = z.infer<typeof entrySchema>;
/** The whole device file. */
export type NexusDeviceFile = z.infer<typeof fileSchema>;
/** A device credential profile. */
export type NexusDeviceProfile = (typeof NEXUS_DEVICE_PROFILES)[number];
/** A device credential scope. */
export type NexusDeviceScope = (typeof NEXUS_DEVICE_SCOPES)[number];

/** Codes carried by {@link NexusDeviceStoreError}. */
export type NexusDeviceStoreErrorCode =
  | 'E_NEXUS_DEVICE_FILE_PERMISSIONS'
  | 'E_NEXUS_DEVICE_FILE_SYMLINK'
  | 'E_NEXUS_DEVICE_FILE_NEWER'
  | 'E_NEXUS_DEVICE_FILE_INVALID'
  | 'E_NEXUS_DEVICE_ENTRY_INVALID'
  | 'E_NEXUS_DEVICE_PENDING_EXISTS';

/** Thrown when the device file cannot be read or written safely. Never carries a secret. */
export class NexusDeviceStoreError extends Error {
  /** Machine-readable reason. */
  readonly code: NexusDeviceStoreErrorCode;

  /**
   * @param code - Machine-readable reason.
   * @param message - Human-readable message; passed through {@link redactNexusDeviceSecrets}.
   */
  constructor(code: NexusDeviceStoreErrorCode, message: string) {
    super(redactNexusDeviceSecrets(message));
    this.name = 'NexusDeviceStoreError';
    this.code = code;
  }
}

/**
 * Whether the device-credential behaviour is switched on (`CLEO_NEXUS_DEVICE=1`).
 *
 * @param env - Environment to read; defaults to `process.env`.
 * @returns `true` only for the exact value `1`.
 */
export function isNexusDeviceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[NEXUS_DEVICE_ENV] === '1';
}

/**
 * Absolute path of the device store.
 *
 * @returns `<cleoHome>/nexus-device.json`, through `@cleocode/paths` (arch gate 2).
 */
export function nexusDevicePath(): string {
  return resolveNexusDevicePath();
}

/**
 * Mask a device credential down to a safe preview.
 *
 * @param value - Plaintext credential (read transiently, not retained).
 * @returns `cnx_d1_…` plus the last 4 characters, or `…` for anything shorter.
 */
export function maskNexusDeviceCredential(value: string): string {
  return value.startsWith('cnx_d1_') && value.length > 16 ? `cnx_d1_…${value.slice(-4)}` : '…';
}

/**
 * Replace every device credential in `text` with its masked preview. Use on
 * any diagnostic string (errors, logs, envelopes) that might hold one.
 *
 * @param text - Arbitrary text.
 * @returns The text with every `cnx_d1_…` credential masked.
 */
export function redactNexusDeviceSecrets(text: string): string {
  return text.replace(CREDENTIAL_IN_TEXT, (match) => maskNexusDeviceCredential(match));
}

/** Secret-free view of one credential. */
export interface NexusDeviceCredentialView {
  /** Server credential id, or `null` for a pending credential not yet confirmed. */
  readonly credentialId: string | null;
  /** Masked token preview. */
  readonly tokenPreview: string;
}

/** Secret-free view of a sign-out or revoke slot. */
export interface NexusDevicePendingEndView {
  /** Credentials held for the retry, newest first. */
  readonly credentials: readonly NexusDeviceCredentialView[];
  /** ISO time the sign-out or revoke was requested. */
  readonly requestedAt: string;
}

/**
 * Secret-free diagnostic view of one entry. Public keys are shown; private
 * keys and tokens never are.
 *
 * @param entry - A stored entry.
 * @returns A view safe to print, log or put in an envelope.
 */
export function redactNexusDeviceEntry(entry: NexusDeviceEntry): Record<string, unknown> {
  const view = (c: { credentialId: string | null; token: string }): NexusDeviceCredentialView => ({
    credentialId: c.credentialId,
    tokenPreview: maskNexusDeviceCredential(c.token),
  });
  const end = (slot: NexusDevicePendingEnd | null): NexusDevicePendingEndView | null =>
    slot ? { credentials: slot.credentials.map(view), requestedAt: slot.requestedAt } : null;
  return {
    deviceId: entry.deviceId,
    createdAt: entry.createdAt,
    publicKeys: entry.keys
      ? {
          encryption: entry.keys.encryption.publicKey,
          signing: entry.keys.signing.publicKey,
        }
      : null,
    current: entry.current
      ? {
          ...view(entry.current),
          profile: entry.current.profile,
          scopes: entry.current.scopes,
          createdAt: entry.current.createdAt,
        }
      : null,
    pending: entry.pending ? { ...view(entry.pending), createdAt: entry.pending.createdAt } : null,
    pendingSignOut: end(entry.pendingSignOut),
    pendingRevoke: end(entry.pendingRevoke),
  };
}

/**
 * Opaque read handle to one entry. Tokens and private keys are held in a
 * private field; serialising or inspecting the handle yields
 * {@link redactNexusDeviceEntry} only. The accessors are for the code that
 * builds an `Authorization` header or signs with the device key.
 */
export class SealedNexusDevice {
  /** API origin. */
  readonly origin: string;
  /** Nexus user id. */
  readonly userId: string;
  /** Nexus device id (UUIDv7). */
  readonly deviceId: string;
  readonly #entry: NexusDeviceEntry;

  /**
   * @param origin - API origin.
   * @param userId - Nexus user id.
   * @param entry - Stored entry; captured privately as a copy.
   */
  constructor(origin: string, userId: string, entry: NexusDeviceEntry) {
    this.origin = origin;
    this.userId = userId;
    this.deviceId = entry.deviceId;
    this.#entry = structuredClone(entry);
  }

  /** The current credential's token, or `null`. Call only where the request is built. */
  currentBearer(): string | null {
    return this.#entry.current?.token ?? null;
  }

  /** The pending rotation credential's token, or `null` (§2.5: try it before `current`). */
  pendingBearer(): string | null {
    return this.#entry.pending?.token ?? null;
  }

  /** A copy of the whole entry, secrets included. For the flows that must act on them. */
  unseal(): NexusDeviceEntry {
    return structuredClone(this.#entry);
  }

  /** Secret-free JSON form. */
  toJSON(): Record<string, unknown> {
    return { origin: this.origin, userId: this.userId, ...redactNexusDeviceEntry(this.#entry) };
  }

  /** Secret-free string form. */
  toString(): string {
    return `SealedNexusDevice(${this.origin}, user ${this.userId}, device ${this.deviceId})`;
  }

  /** Secret-free `util.inspect` form. */
  [inspect.custom](): string {
    return this.toString();
  }
}

// ---------- slot transitions (pure; run them inside NexusDeviceStore.update) ----------

/** What E1 returned, as stored (contract §3.3 step 7). */
export interface NexusDeviceEnrolment {
  /** The device id that was enrolled. */
  readonly deviceId: string;
  /** The device keys, when this enrolment created or confirmed them. */
  readonly keys: NexusDeviceKeys | null;
  /** The credential E1 issued. */
  readonly credential: NexusDeviceCurrentCredential;
}

/**
 * Record a successful E1 (M6): store the new credential, and clear `pending`
 * and `pendingSignOut`, because E1 revoked every older credential of the
 * device on the server. `pendingRevoke` is kept: only E10 settles it.
 *
 * @param entry - The entry read under the lock, or `null` for a new identity.
 * @param enrolment - E1's result.
 * @param now - Clock, for `createdAt` of a new entry.
 * @returns The updated entry.
 */
export function applyEnrolment(
  entry: NexusDeviceEntry | null,
  enrolment: NexusDeviceEnrolment,
  now: Date = new Date(),
): NexusDeviceEntry {
  const sameDevice = entry !== null && entry.deviceId === enrolment.deviceId;
  return {
    ...(sameDevice ? entry : {}),
    deviceId: enrolment.deviceId,
    createdAt: sameDevice ? entry.createdAt : now.toISOString(),
    keys: enrolment.keys ?? (sameDevice ? entry.keys : null),
    current: enrolment.credential,
    pending: null,
    pendingSignOut: null,
    pendingRevoke: sameDevice ? entry.pendingRevoke : null,
  };
}

/**
 * Store a freshly minted rotation credential as `pending` (§2.5 step 3). A
 * second pending credential is never minted: when one exists the caller must
 * replay it instead.
 *
 * @param entry - The entry read under the lock.
 * @param newToken - The client-minted `cnx_d1_…` token.
 * @param now - Clock.
 * @returns The updated entry.
 * @throws {NexusDeviceStoreError} `E_NEXUS_DEVICE_PENDING_EXISTS` when `pending` is already set.
 */
export function applyPendingRotation(
  entry: NexusDeviceEntry,
  newToken: string,
  now: Date = new Date(),
): NexusDeviceEntry {
  if (entry.pending) {
    throw new NexusDeviceStoreError(
      'E_NEXUS_DEVICE_PENDING_EXISTS',
      'a pending rotation credential already exists; replay it instead of minting another',
    );
  }
  return {
    ...entry,
    pending: pendingCredentialSchema.parse({
      credentialId: null,
      token: newToken,
      createdAt: now.toISOString(),
    }),
  };
}

/**
 * Promote `pending` to `current` (§2.5 step 5, or its first successful use).
 * The profile and scopes carry over: E8 issues the new credential with the
 * same profile and scopes as the one it replaced.
 *
 * @param entry - The entry read under the lock.
 * @param credentialId - The server id of the promoted credential.
 * @returns The updated entry, or the entry unchanged when there is nothing to promote.
 */
export function applyPromotePending(
  entry: NexusDeviceEntry,
  credentialId: string,
): NexusDeviceEntry {
  if (!entry.pending || !entry.current) return entry;
  return {
    ...entry,
    current: currentCredentialSchema.parse({
      credentialId,
      token: entry.pending.token,
      profile: entry.current.profile,
      scopes: entry.current.scopes,
      createdAt: entry.pending.createdAt,
    }),
    pending: null,
  };
}

/**
 * CAS-drop `pending`: only when it still holds `expectedToken` (§2.5).
 *
 * @param entry - The entry read under the lock.
 * @param expectedToken - The pending token the caller saw fail.
 * @returns The updated entry, or the entry unchanged when `pending` moved on.
 */
export function applyDropPending(entry: NexusDeviceEntry, expectedToken: string): NexusDeviceEntry {
  if (!entry.pending || entry.pending.token !== expectedToken) return entry;
  return { ...entry, pending: null };
}

/** The live credentials of an entry, newest first: `pending`, then `current`. */
function liveCredentials(entry: NexusDeviceEntry): NexusDeviceSlotCredential[] {
  const out: NexusDeviceSlotCredential[] = [];
  if (entry.pending)
    out.push({ credentialId: entry.pending.credentialId, token: entry.pending.token });
  if (entry.current)
    out.push({ credentialId: entry.current.credentialId, token: entry.current.token });
  return out;
}

/** Merge credential lists, keeping order and dropping repeated tokens. */
function mergeCredentials(
  ...lists: readonly NexusDeviceSlotCredential[][]
): NexusDeviceSlotCredential[] {
  const seen = new Set<string>();
  const out: NexusDeviceSlotCredential[] = [];
  for (const c of lists.flat()) {
    if (seen.has(c.token)) continue;
    seen.add(c.token);
    out.push(c);
  }
  return out.slice(0, 4);
}

/**
 * Begin `cleo logout nexus` (§3.5, M3): move the live credentials into
 * `pendingSignOut`, newest first, so they are used for nothing but the E9
 * retry. The device keys stay.
 *
 * @param entry - The entry read under the lock.
 * @param now - Clock.
 * @returns The updated entry, unchanged when it holds no credential at all.
 */
export function applyBeginSignOut(
  entry: NexusDeviceEntry,
  now: Date = new Date(),
): NexusDeviceEntry {
  const credentials = mergeCredentials(
    liveCredentials(entry),
    entry.pendingSignOut?.credentials ?? [],
  );
  if (credentials.length === 0) return entry;
  return {
    ...entry,
    current: null,
    pending: null,
    pendingSignOut: {
      credentials,
      requestedAt: entry.pendingSignOut?.requestedAt ?? now.toISOString(),
    },
  };
}

/**
 * Begin `cleo logout nexus --revoke` (§3.5, M3): move every credential the
 * entry holds, including an unsettled sign-out's, into `pendingRevoke`. The
 * entry, and its keys, stay until E10 is confirmed.
 *
 * @param entry - The entry read under the lock.
 * @param now - Clock.
 * @returns The updated entry, unchanged when it holds no credential at all.
 */
export function applyBeginRevoke(
  entry: NexusDeviceEntry,
  now: Date = new Date(),
): NexusDeviceEntry {
  const credentials = mergeCredentials(
    entry.pendingRevoke?.credentials ?? [],
    liveCredentials(entry),
    entry.pendingSignOut?.credentials ?? [],
  );
  if (credentials.length === 0) return entry;
  return {
    ...entry,
    current: null,
    pending: null,
    pendingSignOut: null,
    pendingRevoke: {
      credentials,
      requestedAt: entry.pendingRevoke?.requestedAt ?? now.toISOString(),
    },
  };
}

/**
 * Settle a confirmed sign-out (E9 answered 200, or 401 `device-signed-out` or
 * `device-revoked`): clear `pendingSignOut`.
 *
 * @param entry - The entry read under the lock.
 * @returns The updated entry.
 */
export function applySignOutConfirmed(entry: NexusDeviceEntry): NexusDeviceEntry {
  return { ...entry, pendingSignOut: null };
}

// ---------- the store ----------

/** Read and write access to the file, valid only inside {@link NexusDeviceStore.update}. */
export interface NexusDeviceTransaction {
  /**
   * The entry for (origin of `apiUrl`, `userId`), as re-read under the lock.
   *
   * @returns A copy; change it and pass it to {@link NexusDeviceTransaction.set}.
   */
  get(apiUrl: string, userId: string): NexusDeviceEntry | null;
  /** Replace the entry for (origin of `apiUrl`, `userId`). Validated before it is kept. */
  set(apiUrl: string, userId: string, entry: NexusDeviceEntry): void;
  /**
   * CAS delete (§2.5): remove the entry only if it still has `expected`'s
   * device id and, when given, current credential id. Returns `true` when an
   * entry was removed.
   */
  delete(
    apiUrl: string,
    userId: string,
    expected: { readonly deviceId: string; readonly credentialId?: string | null },
  ): boolean;
  /** Every (origin, userId) pair in the file. */
  keys(): Array<{ readonly origin: string; readonly userId: string }>;
}

/**
 * File-backed store for Nexus device identities and credentials. See the
 * module comment for the safety rules.
 */
export class NexusDeviceStore {
  /** Absolute path of the store file. */
  readonly location: string;

  /** @param path - Store path; defaults to {@link nexusDevicePath}. */
  constructor(path: string = nexusDevicePath()) {
    this.location = path;
  }

  /**
   * A sealed snapshot of one entry, read without the lock. Use it to decide;
   * any change goes through {@link NexusDeviceStore.update}, which re-reads.
   *
   * @param apiUrl - Any URL on the API host.
   * @param userId - Nexus user id.
   * @returns The sealed entry, or `null`.
   * @throws {NexusDeviceStoreError} On a loose, foreign, newer or malformed file.
   */
  async get(apiUrl: string, userId: string): Promise<SealedNexusDevice | null> {
    const origin = nexusOriginKey(apiUrl);
    const entry = this.read().devices[origin]?.[userId];
    return entry ? new SealedNexusDevice(origin, userId, entry) : null;
  }

  /**
   * Every entry, sealed, sorted by origin then user id.
   *
   * @returns The sealed entries.
   * @throws {NexusDeviceStoreError} On a loose, foreign, newer or malformed file.
   */
  async list(): Promise<SealedNexusDevice[]> {
    const out: SealedNexusDevice[] = [];
    const devices = this.read().devices;
    for (const origin of Object.keys(devices).sort()) {
      const users = devices[origin] ?? {};
      for (const userId of Object.keys(users).sort()) {
        const entry = users[userId];
        if (entry) out.push(new SealedNexusDevice(origin, userId, entry));
      }
    }
    return out;
  }

  /**
   * Run `fn` under the cross-process lock on the file (M6, N1).
   *
   * The file is re-read **after** the lock is acquired, so `fn` always sees
   * the latest state, never a snapshot taken before another process wrote.
   * `fn` may await (the lock is held across an HTTP call where the protocol
   * says so). When `fn` changed anything, the file is written atomically
   * (temp file, fsync, rename, directory fsync) at 0600 before the lock is
   * released. When `fn` throws, nothing is written.
   *
   * @param fn - The read-modify-write step.
   * @returns What `fn` returned.
   * @throws {NexusDeviceStoreError} On a loose, foreign, newer or malformed file.
   */
  async update<R>(fn: (tx: NexusDeviceTransaction) => R | Promise<R>): Promise<R> {
    this.assertNoSymlink();
    this.seed();
    return withFileLock(this.location, async () => {
      const state = this.read();
      let dirty = false;
      const tx: NexusDeviceTransaction = {
        get: (apiUrl, userId) => {
          const entry = state.devices[nexusOriginKey(apiUrl)]?.[userId];
          return entry ? structuredClone(entry) : null;
        },
        set: (apiUrl, userId, entry) => {
          const parsed = entrySchema.safeParse(entry);
          if (!parsed.success) {
            throw new NexusDeviceStoreError(
              'E_NEXUS_DEVICE_ENTRY_INVALID',
              `refusing to store an invalid Nexus device entry: ${parsed.error.issues
                .map((i) => `${i.path.join('.')}: ${i.message}`)
                .join('; ')}`,
            );
          }
          const origin = nexusOriginKey(apiUrl);
          state.devices[origin] = { ...(state.devices[origin] ?? {}), [userId]: parsed.data };
          dirty = true;
        },
        delete: (apiUrl, userId, expected) => {
          const origin = nexusOriginKey(apiUrl);
          const users = state.devices[origin];
          const entry = users?.[userId];
          if (!users || !entry) return false;
          if (entry.deviceId !== expected.deviceId) return false;
          if (
            expected.credentialId !== undefined &&
            (entry.current?.credentialId ?? null) !== expected.credentialId
          ) {
            return false;
          }
          delete users[userId];
          if (Object.keys(users).length === 0) delete state.devices[origin];
          dirty = true;
          return true;
        },
        keys: () =>
          Object.entries(state.devices).flatMap(([origin, users]) =>
            Object.keys(users).map((userId) => ({ origin, userId })),
          ),
      };
      const result = await fn(tx);
      if (dirty) {
        this.writeAtomic(state);
        this.purgeBackups();
      }
      return result;
    });
  }

  /**
   * Read and validate the file. A missing or empty file (the lock's
   * placeholder) reads as an empty store. Anything else that does not parse
   * as a known version is refused, never read as empty, so it is never
   * overwritten.
   */
  private read(): NexusDeviceFile {
    this.assertPrivate();
    let raw: string;
    try {
      const fd = openSync(this.location, fsConstants.O_RDONLY | NO_FOLLOW);
      try {
        raw = readFileSync(fd, 'utf-8');
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return emptyFile();
      if (err instanceof Error && 'code' in err && err.code === 'ELOOP') {
        throw new NexusDeviceStoreError(
          'E_NEXUS_DEVICE_FILE_SYMLINK',
          `refusing to read the Nexus device file through a symlink: ${this.location}`,
        );
      }
      throw err;
    }
    if (!raw.trim()) return emptyFile();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new NexusDeviceStoreError(
        'E_NEXUS_DEVICE_FILE_INVALID',
        `the Nexus device file is not valid JSON and was left untouched: ${this.location}`,
      );
    }
    const version =
      typeof json === 'object' && json !== null && 'version' in json ? json.version : undefined;
    if (typeof version === 'number' && version > NEXUS_DEVICE_FILE_VERSION) {
      throw new NexusDeviceStoreError(
        'E_NEXUS_DEVICE_FILE_NEWER',
        `the Nexus device file is format version ${version}, newer than this CLI supports (${NEXUS_DEVICE_FILE_VERSION}); upgrade cleo. The file was left untouched: ${this.location}`,
      );
    }
    const parsed = fileSchema.safeParse(json);
    if (!parsed.success) {
      throw new NexusDeviceStoreError(
        'E_NEXUS_DEVICE_FILE_INVALID',
        `the Nexus device file does not match format version ${NEXUS_DEVICE_FILE_VERSION} and was left untouched: ${this.location} (${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')})`,
      );
    }
    return parsed.data;
  }

  /**
   * Write `state` atomically at 0600: a new temp file (`O_EXCL | O_NOFOLLOW`),
   * fsync, rename over the target, then fsync the directory so the rename
   * survives a crash. No backup copy is made.
   */
  private writeAtomic(state: NexusDeviceFile): void {
    const dir = dirname(this.location);
    const tmp = join(dir, `.${basename(this.location)}.${randomBytes(6).toString('hex')}.tmp`);
    const fd = openSync(
      tmp,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NO_FOLLOW,
      0o600,
    );
    try {
      try {
        writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.location);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* already renamed or never created */
      }
      throw err;
    }
    fsyncDirectory(dir);
  }

  /**
   * Create the file owner-only, in an owner-only directory, if it does not
   * exist, so the lock never creates it at the default mode. `O_EXCL` plus
   * `O_NOFOLLOW` close the window between the symlink check and the create.
   */
  private seed(): void {
    mkdirSync(dirname(this.location), { recursive: true, mode: 0o700 });
    let fd: number;
    try {
      fd = openSync(
        this.location,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NO_FOLLOW,
        0o600,
      );
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) throw err;
      try {
        closeSync(openSync(this.location, fsConstants.O_RDONLY | NO_FOLLOW));
      } catch {
        throw new NexusDeviceStoreError(
          'E_NEXUS_DEVICE_FILE_SYMLINK',
          `refusing to write the Nexus device file through a symlink: ${this.location}`,
        );
      }
      return;
    }
    try {
      writeSync(fd, `${JSON.stringify(emptyFile())}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Refuse a file with a mode wider than 0600 or another owner. Skipped on
   * Windows, where Node reports every file as 0o666 and uids do not apply.
   */
  private assertPrivate(): void {
    if (process.platform === 'win32') return;
    let st: ReturnType<typeof statSync>;
    try {
      st = lstatSync(this.location);
    } catch {
      return; // absent: created 0600 on first write
    }
    if (st.isSymbolicLink()) {
      throw new NexusDeviceStoreError(
        'E_NEXUS_DEVICE_FILE_SYMLINK',
        `refusing to read the Nexus device file through a symlink: ${this.location}`,
      );
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if ((st.mode & 0o077) !== 0 || (uid !== null && st.uid !== uid)) {
      throw new NexusDeviceStoreError(
        'E_NEXUS_DEVICE_FILE_PERMISSIONS',
        `refusing to read ${this.location}: it must be owned by you with mode 0600 (it is ${(st.mode & 0o777).toString(8)}). Run: chmod 600 "${this.location}"`,
      );
    }
  }

  /** Refuse to write through a symlink (it could point anywhere). */
  private assertNoSymlink(): void {
    try {
      if (lstatSync(this.location).isSymbolicLink()) {
        throw new NexusDeviceStoreError(
          'E_NEXUS_DEVICE_FILE_SYMLINK',
          `refusing to write the Nexus device file through a symlink: ${this.location}`,
        );
      }
    } catch (err) {
      if (err instanceof NexusDeviceStoreError) throw err;
    }
  }

  /**
   * Delete any rotated backup of the file (L3). This store never makes one,
   * but a generic `withLock` write elsewhere would, and a backup keeps old
   * tokens and keys on disk. Best effort.
   */
  private purgeBackups(): void {
    const backupDir = join(dirname(this.location), '.backups');
    const prefix = `${basename(this.location)}.`;
    let entries: string[];
    try {
      entries = readdirSync(backupDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      try {
        unlinkSync(join(backupDir, entry));
      } catch {
        /* best effort */
      }
    }
  }
}

/** A fresh, empty file value. */
function emptyFile(): NexusDeviceFile {
  return { version: NEXUS_DEVICE_FILE_VERSION, devices: {} };
}

/** fsync a directory so a rename in it is durable. Platforms that cannot (Windows) are skipped. */
function fsyncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  let fd: number;
  try {
    fd = openSync(dir, fsConstants.O_RDONLY);
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    /* some filesystems refuse fsync on a directory; the rename itself is atomic */
  } finally {
    closeSync(fd);
  }
}
