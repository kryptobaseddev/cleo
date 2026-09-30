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
 *   unconfirmed sign-out (E9) or revoke (E10) (§3.5, M3);
 * - `retired`, the unsettled sign-out or revoke of a device this entry
 *   replaced, so a live credential is never dropped on a device change.
 *
 * The file is separate from `nexus-credentials.json`, which stays format
 * version 1 so a downgraded CLI can read it and never touches this file
 * (finding 8).
 *
 * Safety rules, all enforced here:
 *
 * - **Sealed at rest.** Every token and private key is encrypted with
 *   AES-256-GCM under the machine key (`crypto/credentials.ts`,
 *   KDF id `nexus-device:` + `JSON.stringify([origin, userId])`, which no
 *   choice of origin and user id can make collide). Each value carries its
 *   field path (for example `current.token`) as GCM associated data, so
 *   values cannot be swapped between fields either. A copy of the file on
 *   another machine, or under another (origin, user), cannot be opened. The
 *   file is also excluded from every backup bundle. Read paths (`get`,
 *   `list`) never create the machine key or salt: without them an entry
 *   reads as unreadable. A lost key never blocks re-login: the login discards
 *   the unreadable entry ({@link NexusDeviceTransaction.discardUnreadable}).
 * - **Owner-only.** The file is created 0600 (`O_EXCL | O_NOFOLLOW`). Every
 *   read opens it without following links and checks the open descriptor:
 *   a regular file, one link, owned by this user, no group or other bits.
 *   The CLEO home must be owned by this user, inside a parent no other user
 *   can rewrite; a home the user owns that is group- or world-writable is
 *   tightened with `chmod go-w` on the first write, with a warning in
 *   {@link NexusDeviceTransaction.warnings}. Each refusal names the fix.
 * - **Locked, re-read, atomic.** Every mutation runs through
 *   {@link NexusDeviceStore.update}: it takes this store's own cross-process
 *   lock (about a minute of waiting, see {@link NexusDeviceStoreOptions}),
 *   re-reads the file **after** acquiring it (M6, N1), and writes a temp file
 *   that is fsynced and renamed over the original, then fsyncs the directory.
 *   On macOS, Node's fsync is `F_FULLFSYNC` (libuv), so the data reaches the
 *   disk, not only the drive cache. No rotated backups are made; any found are
 *   purged (L3), and stale temp files are swept under the lock.
 * - **Never held across a network call (contract v2.9).** The lock covers
 *   only a local read-modify-write. Every change that involves the server
 *   follows one order: under the lock, re-read and persist the intent (a
 *   `pending` credential before E8, §2.5 step 1; the E1 intent before E1,
 *   §3.3 step 5); **return from `update`, releasing the lock**; make the call
 *   (E1, E8, E9, E10) with a plain `AbortSignal.timeout(...)`; then call
 *   `update` again and re-check with a compare-and-swap (is the entry still
 *   the one this process wrote?) before promoting or clearing. `update`
 *   writes when `fn` returns, so the intent is durable before the request.
 * - **Lock loss aborts.** If the lock is taken over (a stale-lock takeover
 *   after the machine slept, say), {@link NexusDeviceTransaction.signal} is
 *   aborted, no further write happens, and `update` rejects with
 *   `E_NEXUS_DEVICE_LOCK_COMPROMISED`.
 * - **No downgrade.** A file whose `version` is newer than this CLI knows is
 *   refused, never read as empty and never rewritten. A malformed file is
 *   refused the same way. Unknown fields of a known version, at any depth,
 *   are kept on rewrite.
 * - **Unreadable entries are carried, not dropped.** An entry whose secrets do
 *   not open under this machine's key (copied in from another machine) is
 *   written back byte-identical and never decrypted, rewritten or deleted.
 *   Updates to other entries go ahead; only an operation on that entry fails
 *   (`E_NEXUS_DEVICE_UNSEAL_FAILED`), and {@link NexusDeviceStore.list}
 *   reports it as an {@link UnreadableNexusDevice}.
 * - **Fenced writes.** Before each rename the file is compared (inode, size,
 *   mtime in ns) with what this transaction last read or wrote; a change
 *   made by anyone else aborts with `E_NEXUS_DEVICE_LOCK_COMPROMISED`.
 * - **Sealed handles.** Nothing handed out prints a secret: entries from
 *   {@link NexusDeviceTransaction.get}, {@link SealedNexusDevice.unseal} and
 *   the `apply*` transitions carry non-enumerable `toJSON` and `util.inspect`
 *   guards, and {@link NexusDeviceEnrolment} holds its secrets privately.
 *   {@link redactNexusDeviceSecrets} masks credentials and private keys in any
 *   diagnostic text. The guards are non-enumerable, so spreading a guarded
 *   entry (`{ ...entry }`) produces an unguarded copy: T12868–T12871 must
 *   never spread an entry, or any part of one, into a log line or envelope.
 *
 * Behaviour that uses it ships behind `CLEO_NEXUS_DEVICE=1`
 * ({@link isNexusDeviceEnabled}): login enrolment and the 9.24 upgrade
 * (`nexus-enrol.ts`, T12868), then rotation, logout and the cloud reads
 * (T12869–T12871).
 *
 * @task T12867
 * @epic T12323
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  type Stats,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { resolveNexusDevicePath } from '@cleocode/paths';
import * as lockfile from 'proper-lockfile';
import { z } from 'zod';
import {
  deriveGlobalKeyFromMaterial,
  type GlobalKeyMaterial,
  loadGlobalKeyMaterial,
  openWithGlobalKey,
  sealWithGlobalKey,
} from '../crypto/credentials.js';
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

/** Why an E1 call is in flight: an interactive login (§3.3) or the 9.24 auto-upgrade (§3.4). */
export const NEXUS_DEVICE_INTENT_KINDS = ['login', 'upgrade'] as const;

/**
 * Most credentials one sign-out or revoke slot may hold. A transition that
 * would need more refuses (`E_NEXUS_DEVICE_SLOT_FULL`) instead of dropping a
 * live credential.
 */
export const NEXUS_DEVICE_MAX_SLOT_CREDENTIALS = 8;

/** Most retired-device items one entry may hold; beyond it a device change refuses. */
export const NEXUS_DEVICE_MAX_RETIRED = 8;

/** Default time {@link NexusDeviceStore.update} waits for the lock. */
export const NEXUS_DEVICE_LOCK_WAIT_MS = 60_000;

/** Default age after which a lock whose holder stopped refreshing it may be taken over. */
export const NEXUS_DEVICE_LOCK_STALE_MS = 30_000;

/** `O_NOFOLLOW` where the platform has it (not on Windows). */
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
/** `O_NONBLOCK`, so opening a planted FIFO cannot hang the read. */
const NON_BLOCK = fsConstants.O_NONBLOCK ?? 0;

/** Matches a device credential, or a truncated/suffixed fragment of one, anywhere in text. */
const CREDENTIAL_IN_TEXT = /cnx_d1_[A-Za-z0-9_-]+/g;
/** Matches a private-key field and its value in JSON or `util.inspect` output. */
const PRIVATE_KEY_IN_TEXT = /(["']?privateKey["']?\s*[:=]\s*["'])([^"']*)(["'])/g;

/** Temp files this store writes: `.nexus-device.json.<12 hex>.tmp`. */
const TEMP_FILE = /^\.nexus-device\.json\.[0-9a-f]{12}\.tmp$/;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const isoTime = z.iso.datetime();

/** Plain (in-memory) secret leaves. */
const plainToken = z
  .string()
  .regex(NEXUS_DEVICE_CREDENTIAL_PATTERN, 'expected a cnx_d1_ device credential');
const plainPrivateKey = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'expected a base64 32-byte key');
/** Sealed (on-disk) secret leaves: AES-GCM ciphertext, base64. */
const sealedLeaf = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'expected sealed base64');
const publicKey = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'expected a base64 32-byte key');

/**
 * Build the entry schema over a token leaf and a private-key leaf, so the
 * in-memory form (validated plaintext) and the on-disk form (ciphertext)
 * share one shape. Every object is loose: unknown fields survive a rewrite.
 */
function makeEntrySchema(token: z.ZodString, privateKey: z.ZodString) {
  const keyPair = z.looseObject({ publicKey, privateKey });
  const slotCredential = z.looseObject({ credentialId: uuid.nullable(), token });
  const credentials = z.array(slotCredential).min(1).max(NEXUS_DEVICE_MAX_SLOT_CREDENTIALS);
  const pendingEnd = z.looseObject({ credentials, requestedAt: isoTime });
  return z.looseObject({
    deviceId: uuid,
    createdAt: isoTime,
    keys: z.looseObject({ encryption: keyPair, signing: keyPair }).nullable(),
    current: z
      .looseObject({
        credentialId: uuid,
        token,
        profile: z.enum(NEXUS_DEVICE_PROFILES),
        scopes: z.array(z.enum(NEXUS_DEVICE_SCOPES)),
        createdAt: isoTime,
      })
      .nullable(),
    pending: z
      .looseObject({
        /** Server id of the new credential; `null` until E8 answers (the client minted the token). */
        credentialId: uuid.nullable(),
        token,
        createdAt: isoTime,
      })
      .nullable(),
    pendingSignOut: pendingEnd.nullable(),
    pendingRevoke: pendingEnd.nullable(),
    retired: z
      .array(
        z.looseObject({
          deviceId: uuid,
          kind: z.enum(['sign-out', 'revoke']),
          credentials,
          requestedAt: isoTime,
        }),
      )
      .max(NEXUS_DEVICE_MAX_RETIRED)
      .optional(),
    /**
     * An E1 call in flight (contract §3.3 step 5, §3.4 step 1): persisted under
     * the lock before E1 is sent, cleared at step 7. Holds no secret.
     */
    /**
     * A credential E1 issued to this process while the file already held
     * another one for the same device, and the server could not yet say which
     * is live (§3.3 step 7, ruling A). Kept, sealed, until E2 settles it, so
     * the only live credential is never lost.
     */
    raceCandidate: z
      .looseObject({
        credentialId: uuid,
        token,
        profile: z.enum(NEXUS_DEVICE_PROFILES),
        scopes: z.array(z.enum(NEXUS_DEVICE_SCOPES)),
        createdAt: isoTime,
      })
      .nullable()
      .optional(),
    enrolIntent: z
      .looseObject({
        deviceId: uuid,
        kind: z.enum(NEXUS_DEVICE_INTENT_KINDS),
        /** Random id of the process that wrote it (a CAS token). */
        owner: z.string().regex(/^[0-9a-f]{32}$/),
        startedAt: isoTime,
      })
      .nullable()
      .optional(),
  });
}

const entrySchema = makeEntrySchema(plainToken, plainPrivateKey);
const sealedEntrySchema = makeEntrySchema(sealedLeaf, sealedLeaf);
const sealedFileSchema = z.looseObject({
  version: z.literal(NEXUS_DEVICE_FILE_VERSION),
  devices: z.record(z.string(), z.record(z.string(), sealedEntrySchema)),
});

/** One (origin, user) entry of the device file, secrets in plaintext (in memory only). */
export type NexusDeviceEntry = z.infer<typeof entrySchema>;
/** The device's two key pairs (contract §2.4). */
export type NexusDeviceKeys = NonNullable<NexusDeviceEntry['keys']>;
/** A stored key pair, base64 (32 raw bytes each). */
export type NexusDeviceKeyPair = NexusDeviceKeys['encryption'];
/** The credential in use, as issued by E1 or promoted from `pending`. */
export type NexusDeviceCurrentCredential = NonNullable<NexusDeviceEntry['current']>;
/** A client-minted rotation credential awaiting confirmation (contract §2.5). */
export type NexusDevicePendingCredential = NonNullable<NexusDeviceEntry['pending']>;
/** A `pendingSignOut` or `pendingRevoke` slot (contract §3.5). */
export type NexusDevicePendingEnd = NonNullable<NexusDeviceEntry['pendingSignOut']>;
/** One credential kept in a sign-out or revoke slot. */
export type NexusDeviceSlotCredential = NexusDevicePendingEnd['credentials'][number];
/** An unsettled sign-out or revoke of a device an entry replaced. */
export type NexusDeviceRetired = NonNullable<NexusDeviceEntry['retired']>[number];
/** An E1 call in flight for an entry (§3.3 step 5, §3.4 step 1). */
export type NexusDeviceEnrolIntent = NonNullable<NexusDeviceEntry['enrolIntent']>;
/** A racing login's unsettled credential (§3.3 step 7). */
export type NexusDeviceRaceCandidate = NonNullable<NexusDeviceEntry['raceCandidate']>;
/** The on-disk file, with secrets sealed. */
type SealedFile = z.infer<typeof sealedFileSchema>;
/** A device credential profile. */
export type NexusDeviceProfile = (typeof NEXUS_DEVICE_PROFILES)[number];
/** A device credential scope. */
export type NexusDeviceScope = (typeof NEXUS_DEVICE_SCOPES)[number];

/** Codes carried by {@link NexusDeviceStoreError}. */
export type NexusDeviceStoreErrorCode =
  | 'E_NEXUS_DEVICE_FILE_PERMISSIONS'
  | 'E_NEXUS_DEVICE_FILE_UNSAFE'
  | 'E_NEXUS_DEVICE_FILE_SYMLINK'
  | 'E_NEXUS_DEVICE_DIR_UNSAFE'
  | 'E_NEXUS_DEVICE_FILE_NEWER'
  | 'E_NEXUS_DEVICE_FILE_INVALID'
  | 'E_NEXUS_DEVICE_UNSEAL_FAILED'
  | 'E_NEXUS_DEVICE_MACHINE_KEY'
  | 'E_NEXUS_DEVICE_IO'
  | 'E_NEXUS_DEVICE_ENTRY_INVALID'
  | 'E_NEXUS_DEVICE_PENDING_EXISTS'
  | 'E_NEXUS_DEVICE_REVOKE_PENDING'
  | 'E_NEXUS_DEVICE_SLOT_FULL'
  | 'E_NEXUS_DEVICE_BUSY'
  | 'E_NEXUS_DEVICE_REENTRANT'
  | 'E_NEXUS_DEVICE_LOCK_COMPROMISED';

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
 * The preview keeps the last 4 characters (24 of the token's 256 random
 * bits), enough to tell two credentials apart in a diagnostic and far too
 * little to guess the rest. The same rule as `maskNexusToken`.
 *
 * @param value - Plaintext credential (read transiently, not retained).
 * @returns `cnx_d1_…` plus the last 4 characters, or `…` for anything shorter.
 */
export function maskNexusDeviceCredential(value: string): string {
  return value.startsWith('cnx_d1_') && value.length > 16 ? `cnx_d1_…${value.slice(-4)}` : '…';
}

/**
 * Mask every device credential and every private-key field in `text`. Use on
 * any diagnostic string (errors, logs, envelopes) that might hold one.
 *
 * @param text - Arbitrary text.
 * @returns The text with every `cnx_d1_…` credential masked and every
 *   `privateKey` value replaced by `[redacted]`.
 */
export function redactNexusDeviceSecrets(text: string): string {
  return text
    .replace(CREDENTIAL_IN_TEXT, (match) => maskNexusDeviceCredential(match))
    .replace(PRIVATE_KEY_IN_TEXT, (_m, open: string, _value: string, close: string) => {
      return `${open}[redacted]${close}`;
    });
}

/** A plain JSON-like object (not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A copy of `value` with every `token` masked and every `privateKey` removed,
 * at any depth. Public keys, ids and times are kept.
 */
function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDeep);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'token' && typeof child === 'string') {
      out.tokenPreview = maskNexusDeviceCredential(child);
    } else if (key === 'privateKey') {
      out.privateKey = '[redacted]';
    } else {
      out[key] = redactDeep(child);
    }
  }
  return out;
}

/**
 * Attach non-enumerable `toJSON` and `util.inspect` guards to `value` and to
 * every object inside it, so printing or serialising it (or any part of it)
 * shows only {@link redactDeep}'s view. Reading a field directly still returns
 * the secret; that is the explicit path. The guards are non-enumerable, so a
 * spread or a schema parse drops them and the store never writes a redacted
 * value.
 */
function guard<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) guard(item);
    return value;
  }
  if (!isPlainObject(value)) return value;
  for (const child of Object.values(value)) guard(child);
  const self = value;
  Object.defineProperty(self, 'toJSON', {
    value: () => redactDeep(self),
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(self, inspect.custom, {
    value: () => redactDeep(self),
    enumerable: false,
    configurable: true,
  });
  return value;
}

/**
 * Attach the store's non-enumerable `toJSON` and `util.inspect` guards to any
 * value that holds device secrets (tokens, private keys), at every depth, so
 * printing or serialising it shows only the redacted view. Never spread the
 * result: a spread drops the guards.
 *
 * @param value - An object holding `token` or `privateKey` fields.
 * @returns The same object, guarded.
 */
export function guardNexusDeviceSecrets<T>(value: T): T {
  return guard(value);
}

/** A deep copy of an entry, guarded. */
function guardedCopy(entry: NexusDeviceEntry): NexusDeviceEntry {
  return guard(entrySchema.parse(structuredClone(entry)));
}

/**
 * Secret-free diagnostic view of one entry. Public keys are shown; private
 * keys and tokens never are.
 *
 * @param entry - A stored entry.
 * @returns A view safe to print, log or put in an envelope.
 */
export function redactNexusDeviceEntry(entry: NexusDeviceEntry): Record<string, unknown> {
  const view = redactDeep(entry);
  return isPlainObject(view) ? view : {};
}

/**
 * Opaque read handle to one entry. Tokens and private keys are held in a
 * private field; serialising or inspecting the handle yields
 * {@link redactNexusDeviceEntry} only. The accessors are for the code that
 * builds an `Authorization` header or signs with the device key.
 */
export class SealedNexusDevice {
  /** Always `true`: this entry opened under this machine's key. */
  readonly readable = true;
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
    this.#entry = entrySchema.parse(structuredClone(entry));
  }

  /** The current credential's token, or `null`. Call only where the request is built. */
  currentBearer(): string | null {
    return this.#entry.current?.token ?? null;
  }

  /** The pending rotation credential's token, or `null` (§2.5: try it before `current`). */
  pendingBearer(): string | null {
    return this.#entry.pending?.token ?? null;
  }

  /**
   * A guarded copy of the whole entry, secrets included, for the flows that
   * must act on them. Printing or serialising it shows the redacted view.
   */
  unseal(): NexusDeviceEntry {
    return guardedCopy(this.#entry);
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

/**
 * What E1 returned, as it is about to be stored (contract §3.3 step 7). The
 * issued credential and any device keys are held in private fields, so the
 * value never prints a secret.
 */
export class NexusDeviceEnrolment {
  /** The device id that was enrolled. */
  readonly deviceId: string;
  readonly #keys: NexusDeviceKeys | null;
  readonly #credential: NexusDeviceCurrentCredential;

  /**
   * @param input - The enrolled device id, the keys when this enrolment
   *   created or confirmed them (else `null`), and the credential E1 issued.
   * @throws {NexusDeviceStoreError} `E_NEXUS_DEVICE_ENTRY_INVALID` on a malformed credential or keys.
   */
  constructor(input: {
    readonly deviceId: string;
    readonly keys: NexusDeviceKeys | null;
    readonly credential: NexusDeviceCurrentCredential;
  }) {
    const shape = entrySchema.shape;
    const parsed = z
      .object({ deviceId: shape.deviceId, keys: shape.keys, current: shape.current.unwrap() })
      .safeParse({ deviceId: input.deviceId, keys: input.keys, current: input.credential });
    if (!parsed.success) {
      throw new NexusDeviceStoreError(
        'E_NEXUS_DEVICE_ENTRY_INVALID',
        `invalid enrolment: ${issuesText(parsed.error)}`,
      );
    }
    this.deviceId = parsed.data.deviceId;
    this.#keys = parsed.data.keys;
    this.#credential = parsed.data.current;
  }

  /** A guarded copy of the keys, or `null`. */
  keys(): NexusDeviceKeys | null {
    return this.#keys ? guard(structuredClone(this.#keys)) : null;
  }

  /** A guarded copy of the issued credential. */
  credential(): NexusDeviceCurrentCredential {
    return guard(structuredClone(this.#credential));
  }

  /** Secret-free JSON form. */
  toJSON(): Record<string, unknown> {
    const view = redactDeep({
      deviceId: this.deviceId,
      keys: this.#keys,
      credential: this.#credential,
    });
    return isPlainObject(view) ? view : {};
  }

  /** Secret-free string form. */
  toString(): string {
    return `NexusDeviceEnrolment(device ${this.deviceId}, credential ${this.#credential.credentialId})`;
  }

  /** Secret-free `util.inspect` form. */
  [inspect.custom](): string {
    return this.toString();
  }
}

/** Zod issues as one line (paths and messages only; never values). */
function issuesText(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ');
}

// ---------- slot transitions (pure; run them inside NexusDeviceStore.update) ----------

/** The live credentials of an entry, newest first: `raceCandidate`, `pending`, then `current`. */
function liveCredentials(entry: NexusDeviceEntry): NexusDeviceSlotCredential[] {
  const out: NexusDeviceSlotCredential[] = [];
  if (entry.raceCandidate) {
    out.push({ credentialId: entry.raceCandidate.credentialId, token: entry.raceCandidate.token });
  }
  if (entry.pending)
    out.push({ credentialId: entry.pending.credentialId, token: entry.pending.token });
  if (entry.current)
    out.push({ credentialId: entry.current.credentialId, token: entry.current.token });
  return out;
}

/**
 * Merge credential lists in the order given, dropping repeated tokens. Never
 * truncates: a merge that exceeds the slot size refuses, because every
 * credential in these lists may still be live on the server.
 */
function mergeCredentials(
  ...lists: readonly (readonly NexusDeviceSlotCredential[])[]
): NexusDeviceSlotCredential[] {
  const seen = new Set<string>();
  const out: NexusDeviceSlotCredential[] = [];
  for (const c of lists.flat()) {
    if (seen.has(c.token)) continue;
    seen.add(c.token);
    out.push({ credentialId: c.credentialId, token: c.token });
  }
  if (out.length > NEXUS_DEVICE_MAX_SLOT_CREDENTIALS) {
    throw new NexusDeviceStoreError(
      'E_NEXUS_DEVICE_SLOT_FULL',
      `refusing to hold more than ${NEXUS_DEVICE_MAX_SLOT_CREDENTIALS} unconfirmed credentials for one device; settle the pending sign-out or revoke first, or revoke this device on cleocode.dev`,
    );
  }
  return out;
}

/**
 * Throw unless a login may enrol `deviceId` over `entry`. While a revoke of
 * the same device is unconfirmed, enrolling would re-activate a device the
 * user asked to revoke: retry E10 first (`cleo logout nexus --revoke`), and
 * if it cannot be confirmed, revoke the device on cleocode.dev. Call this
 * before E1 is sent; {@link applyEnrolment} checks it again.
 *
 * @param entry - The entry read under the lock, or `null`.
 * @param deviceId - The device id the login would enrol.
 * @throws {NexusDeviceStoreError} `E_NEXUS_DEVICE_REVOKE_PENDING`.
 */
export function assertEnrolmentAllowed(entry: NexusDeviceEntry | null, deviceId: string): void {
  if (entry !== null && entry.deviceId === deviceId && entry.pendingRevoke !== null) {
    throw new NexusDeviceStoreError(
      'E_NEXUS_DEVICE_REVOKE_PENDING',
      'a revoke of this device is not yet confirmed by the server. Run `cleo logout nexus --revoke` to retry it; if it still cannot be confirmed, revoke this device on cleocode.dev, then log in again',
    );
  }
}

/**
 * Record a successful E1 (M6).
 *
 * - **Same device:** store the new credential and clear `pending` and
 *   `pendingSignOut`, because E1 revoked every older credential of the device
 *   on the server. Refused while `pendingRevoke` is set
 *   ({@link assertEnrolmentAllowed}).
 * - **New device** (a fresh identity replaced the entry's device): the old
 *   device's unsettled revoke, and any credential it still holds, move to
 *   `retired`, so they are retried rather than dropped.
 *
 * @param entry - The entry read under the lock, or `null` for a new identity.
 * @param enrolment - E1's result.
 * @param now - Clock, for `createdAt` of a new entry and retired items.
 * @returns The updated entry, guarded.
 * @throws {NexusDeviceStoreError} `E_NEXUS_DEVICE_REVOKE_PENDING`, or
 *   `E_NEXUS_DEVICE_SLOT_FULL` when `retired` is full.
 */
export function applyEnrolment(
  entry: NexusDeviceEntry | null,
  enrolment: NexusDeviceEnrolment,
  now: Date = new Date(),
): NexusDeviceEntry {
  assertEnrolmentAllowed(entry, enrolment.deviceId);
  const credential = enrolment.credential();
  const keys = enrolment.keys();
  if (entry !== null && entry.deviceId === enrolment.deviceId) {
    return guard({
      ...entry,
      keys: keys ?? entry.keys,
      current: { ...credential },
      pending: null,
      pendingSignOut: null,
      raceCandidate: null,
    });
  }
  const retired = retireDevice(entry, now);
  return guard({
    deviceId: enrolment.deviceId,
    createdAt: now.toISOString(),
    keys,
    current: { ...credential },
    pending: null,
    pendingSignOut: null,
    pendingRevoke: null,
    ...(retired.length > 0 ? { retired } : {}),
  });
}

/**
 * The `retired` list an entry leaves behind when a new identity replaces its
 * device: every credential the old device may still hold (and its unsettled
 * sign-out or revoke) is kept for a retry, never dropped.
 *
 * @throws {NexusDeviceStoreError} `E_NEXUS_DEVICE_SLOT_FULL` when `retired` is full.
 */
function retireDevice(entry: NexusDeviceEntry | null, now: Date): NexusDeviceRetired[] {
  const retired: NexusDeviceRetired[] = (entry?.retired ?? []).map((r) => ({
    deviceId: r.deviceId,
    kind: r.kind,
    credentials: r.credentials.map((c) => ({ credentialId: c.credentialId, token: c.token })),
    requestedAt: r.requestedAt,
  }));
  if (entry !== null) {
    const live = mergeCredentials(liveCredentials(entry), entry.pendingSignOut?.credentials ?? []);
    if (live.length > 0) {
      retired.push({
        deviceId: entry.deviceId,
        kind: 'sign-out',
        credentials: live,
        requestedAt: entry.pendingSignOut?.requestedAt ?? now.toISOString(),
      });
    }
    if (entry.pendingRevoke) {
      retired.push({
        deviceId: entry.deviceId,
        kind: 'revoke',
        credentials: entry.pendingRevoke.credentials.map((c) => ({
          credentialId: c.credentialId,
          token: c.token,
        })),
        requestedAt: entry.pendingRevoke.requestedAt,
      });
    }
  }
  if (retired.length > NEXUS_DEVICE_MAX_RETIRED) {
    throw new NexusDeviceStoreError(
      'E_NEXUS_DEVICE_SLOT_FULL',
      `refusing to retire more than ${NEXUS_DEVICE_MAX_RETIRED} unsettled devices for one account; settle them first, or revoke them on cleocode.dev`,
    );
  }
  return retired;
}

/**
 * Persist the identity a login or upgrade is about to enrol, with its E1
 * intent (§3.3 step 5, §3.4 step 1), before E1 is sent.
 *
 * - **No entry:** a new identity with `deviceId` and `keys`.
 * - **Same device:** the intent is recorded; `keys` fill in only when the
 *   entry has none (lost keys, §3.3 step 6 `device-keys-changed`). Every
 *   credential and slot is kept: E1 has not run yet.
 * - **Another device** (a fresh identity after 409 `device-revoked`,
 *   `device-other-account`, `device-id-taken` or `device-keys-changed`): the
 *   old device's credentials and unsettled slots move to `retired`, as in
 *   {@link applyEnrolment}, so nothing live is dropped.
 *
 * @param entry - The entry read under the lock, or `null`.
 * @param identity - The device id and keys to enrol, and the intent.
 * @param now - Clock.
 * @returns The updated entry, guarded.
 * @throws {NexusDeviceStoreError} `E_NEXUS_DEVICE_REVOKE_PENDING` for the same
 *   device while a revoke is unconfirmed, or `E_NEXUS_DEVICE_SLOT_FULL`.
 */
export function applyEnrolIntent(
  entry: NexusDeviceEntry | null,
  identity: {
    readonly deviceId: string;
    readonly keys: NexusDeviceKeys;
    readonly intent: NexusDeviceEnrolIntent;
  },
  now: Date = new Date(),
): NexusDeviceEntry {
  assertEnrolmentAllowed(entry, identity.deviceId);
  if (entry !== null && entry.deviceId === identity.deviceId) {
    return guard({
      ...entry,
      keys: entry.keys ?? structuredClone(identity.keys),
      enrolIntent: { ...identity.intent },
    });
  }
  const retired = retireDevice(entry, now);
  return guard({
    deviceId: identity.deviceId,
    createdAt: now.toISOString(),
    keys: structuredClone(identity.keys),
    current: null,
    pending: null,
    pendingSignOut: null,
    pendingRevoke: null,
    ...(retired.length > 0 ? { retired } : {}),
    enrolIntent: { ...identity.intent },
  });
}

/**
 * Clear an E1 intent, as a compare-and-swap on its owner: another process's
 * intent is never cleared.
 *
 * @param entry - The entry read under the lock.
 * @param owner - The intent owner this process wrote.
 * @returns The updated entry (guarded), or the entry unchanged.
 */
export function applyClearEnrolIntent(entry: NexusDeviceEntry, owner: string): NexusDeviceEntry {
  if (entry.enrolIntent?.owner !== owner) return entry;
  return guard({ ...entry, enrolIntent: null });
}

/**
 * Drop `current`, as a compare-and-swap on its credential id: used when the
 * server refused it and no other credential is live (§3.3 step 7, both
 * racing credentials answered 401). Nothing is moved to a sign-out slot: a
 * refused credential needs no E9.
 *
 * @param entry - The entry read under the lock.
 * @param credentialId - The credential id the caller saw refused.
 * @returns The updated entry (guarded), or the entry unchanged when `current` moved on.
 */
export function applyDropCurrent(entry: NexusDeviceEntry, credentialId: string): NexusDeviceEntry {
  if (entry.current?.credentialId !== credentialId) return entry;
  return guard({ ...entry, current: null });
}

/**
 * Refresh this process's E1 intent right before E1 is sent (compare-and-swap
 * on the owner), so a live intent never looks stale while its owner is still
 * working (§3.4 step 1).
 *
 * @param entry - The entry read under the lock.
 * @param owner - The intent owner this process wrote.
 * @param now - Clock.
 * @returns The updated entry (guarded), or `null` when the intent is no
 *   longer this process's (another process replaced or took it over).
 */
export function applyRefreshEnrolIntent(
  entry: NexusDeviceEntry,
  owner: string,
  now: Date = new Date(),
): NexusDeviceEntry | null {
  const intent = entry.enrolIntent;
  if (!intent || intent.owner !== owner) return null;
  return guard({ ...entry, enrolIntent: { ...intent, startedAt: now.toISOString() } });
}

/**
 * Park a racing login's credential beside `current` until E2 settles which is
 * live (§3.3 step 7). An existing candidate is replaced only by a newer one;
 * the older is dropped, because E1 re-enrolment revoked it.
 *
 * @param entry - The entry read under the lock.
 * @param candidate - The credential E1 issued to this process.
 * @returns The updated entry, guarded.
 */
export function applySetRaceCandidate(
  entry: NexusDeviceEntry,
  candidate: NexusDeviceRaceCandidate,
): NexusDeviceEntry {
  const held = entry.raceCandidate ?? null;
  if (held !== null && Date.parse(held.createdAt) > Date.parse(candidate.createdAt)) return entry;
  return guard({ ...entry, raceCandidate: structuredClone(candidate) });
}

/**
 * Drop the race candidate, as a compare-and-swap on its credential id (it
 * lost: the server refused it, or `current` is newer).
 *
 * @param entry - The entry read under the lock.
 * @param credentialId - The candidate the caller settled.
 * @returns The updated entry (guarded), or the entry unchanged.
 */
export function applyDropRaceCandidate(
  entry: NexusDeviceEntry,
  credentialId: string,
): NexusDeviceEntry {
  if (entry.raceCandidate?.credentialId !== credentialId) return entry;
  return guard({ ...entry, raceCandidate: null });
}

/**
 * Store a freshly minted rotation credential as `pending` (§2.5 step 1). A
 * second pending credential is never minted: when one exists the caller must
 * replay it instead. The caller MUST let `update` write it (return from the
 * transaction, releasing the lock) before sending E8, never send E8 inside it.
 *
 * @param entry - The entry read under the lock.
 * @param newToken - The client-minted `cnx_d1_…` token.
 * @param now - Clock.
 * @returns The updated entry, guarded.
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
  const pending = entrySchema.shape.pending.unwrap().safeParse({
    credentialId: null,
    token: newToken,
    createdAt: now.toISOString(),
  });
  if (!pending.success) {
    throw new NexusDeviceStoreError(
      'E_NEXUS_DEVICE_ENTRY_INVALID',
      `invalid pending credential: ${issuesText(pending.error)}`,
    );
  }
  return guard({ ...entry, pending: pending.data });
}

/**
 * Promote `pending` to `current` (§2.5 step 5, or its first successful use),
 * as a compare-and-swap: only when `pending` still holds `expectedToken`.
 * The profile and scopes carry over: E8 issues the new credential with the
 * same profile and scopes as the one it replaced.
 *
 * @param entry - The entry read under the lock.
 * @param expectedToken - The pending token the caller saw succeed.
 * @param credentialId - The server id of the promoted credential.
 * @returns The updated entry (guarded), or the entry unchanged when `pending`
 *   moved on or there is nothing to promote.
 */
export function applyPromotePending(
  entry: NexusDeviceEntry,
  expectedToken: string,
  credentialId: string,
): NexusDeviceEntry {
  if (!entry.pending || !entry.current || entry.pending.token !== expectedToken) return entry;
  return guard({
    ...entry,
    current: {
      ...entry.current,
      credentialId,
      token: entry.pending.token,
      createdAt: entry.pending.createdAt,
    },
    pending: null,
  });
}

/**
 * CAS-drop `pending`: only when it still holds `expectedToken` (§2.5).
 *
 * @param entry - The entry read under the lock.
 * @param expectedToken - The pending token the caller saw fail.
 * @returns The updated entry (guarded), or the entry unchanged when `pending` moved on.
 */
export function applyDropPending(entry: NexusDeviceEntry, expectedToken: string): NexusDeviceEntry {
  if (!entry.pending || entry.pending.token !== expectedToken) return entry;
  return guard({ ...entry, pending: null });
}

/**
 * Begin `cleo logout nexus` (§3.5, M3): move the live credentials into
 * `pendingSignOut`, newest first (`pending`, then `current`, then any
 * credential an earlier unsettled sign-out holds), so they are used for
 * nothing but the E9 retry. The device keys stay.
 *
 * @param entry - The entry read under the lock.
 * @param now - Clock.
 * @returns The updated entry (guarded), unchanged when it holds no credential at all.
 * @throws {NexusDeviceStoreError} `E_NEXUS_DEVICE_SLOT_FULL` rather than drop a credential.
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
  return guard({
    ...entry,
    current: null,
    pending: null,
    raceCandidate: null,
    pendingSignOut: {
      credentials,
      requestedAt: entry.pendingSignOut?.requestedAt ?? now.toISOString(),
    },
  });
}

/**
 * Begin `cleo logout nexus --revoke` (§3.5, M3): move every credential the
 * entry holds into `pendingRevoke`, newest first: `pending`, `current`, an
 * unsettled sign-out's, then an earlier unsettled revoke's. The entry, and its
 * keys, stay until E10 is confirmed.
 *
 * @param entry - The entry read under the lock.
 * @param now - Clock.
 * @returns The updated entry (guarded), unchanged when it holds no credential at all.
 * @throws {NexusDeviceStoreError} `E_NEXUS_DEVICE_SLOT_FULL` rather than drop a credential.
 */
export function applyBeginRevoke(
  entry: NexusDeviceEntry,
  now: Date = new Date(),
): NexusDeviceEntry {
  const credentials = mergeCredentials(
    liveCredentials(entry),
    entry.pendingSignOut?.credentials ?? [],
    entry.pendingRevoke?.credentials ?? [],
  );
  if (credentials.length === 0) return entry;
  return guard({
    ...entry,
    current: null,
    pending: null,
    raceCandidate: null,
    pendingSignOut: null,
    pendingRevoke: {
      credentials,
      requestedAt: entry.pendingRevoke?.requestedAt ?? now.toISOString(),
    },
  });
}

/**
 * Settle a confirmed sign-out (E9 answered 200, or 401 `device-signed-out` or
 * `device-revoked`): clear `pendingSignOut`.
 *
 * @param entry - The entry read under the lock.
 * @returns The updated entry, guarded.
 */
export function applySignOutConfirmed(entry: NexusDeviceEntry): NexusDeviceEntry {
  return guard({ ...entry, pendingSignOut: null });
}

/**
 * End an unfinishable revoke (§E10, contract v2.13): E10 answered 401
 * `device-signed-out`, so the device is signed out on the server and every
 * credential it held is dead; no request from this machine can revoke it
 * any more. Clear `pendingRevoke` so it is not retried forever; the entry and
 * its keys stay, and the caller tells the user to revoke the device on
 * cleocode.dev.
 *
 * @param entry - The entry read under the lock.
 * @returns The updated entry, guarded.
 */
export function applyRevokeFoundSignedOut(entry: NexusDeviceEntry): NexusDeviceEntry {
  return guard({ ...entry, pendingRevoke: null });
}

/**
 * Settle a confirmed sign-out or revoke of a retired device.
 *
 * @param entry - The entry read under the lock.
 * @param deviceId - The retired device the server confirmed.
 * @param kind - Which request was confirmed.
 * @returns The updated entry, guarded.
 */
export function applyRetiredSettled(
  entry: NexusDeviceEntry,
  deviceId: string,
  kind: NexusDeviceRetired['kind'],
): NexusDeviceEntry {
  const retired = (entry.retired ?? []).filter(
    (r) => !(r.deviceId === deviceId && r.kind === kind),
  );
  const { retired: _drop, ...rest } = entry;
  return guard(retired.length > 0 ? { ...rest, retired } : rest);
}

// ---------- sealing ----------

/**
 * The machine-key KDF id binding one entry's secrets. JSON-encoding the pair
 * keeps it unambiguous: `("https://a.test:8443", "u")` and
 * `("https://a.test", "8443:u")` give different ids (review N3).
 */
function sealId(origin: string, userId: string): string {
  return `nexus-device:${JSON.stringify([origin, userId])}`;
}

/**
 * Apply `f` to every secret leaf of an entry, with the leaf's field path
 * (used as GCM associated data), keeping every other field (known or not).
 * The sealed and plain entry shapes differ only in what the secret strings
 * hold, so one type serves both directions.
 */
function mapSecrets(
  entry: NexusDeviceEntry,
  f: (secret: string, path: string) => string,
): NexusDeviceEntry {
  const creds = (list: NexusDeviceSlotCredential[], at: string): NexusDeviceSlotCredential[] =>
    list.map((c, i) => ({ ...c, token: f(c.token, `${at}.credentials.${i}.token`) }));
  const pair = (p: NexusDeviceKeyPair, at: string): NexusDeviceKeyPair => ({
    ...p,
    privateKey: f(p.privateKey, `${at}.privateKey`),
  });
  return {
    ...entry,
    keys: entry.keys
      ? {
          ...entry.keys,
          encryption: pair(entry.keys.encryption, 'keys.encryption'),
          signing: pair(entry.keys.signing, 'keys.signing'),
        }
      : null,
    current: entry.current
      ? { ...entry.current, token: f(entry.current.token, 'current.token') }
      : null,
    pending: entry.pending
      ? { ...entry.pending, token: f(entry.pending.token, 'pending.token') }
      : null,
    ...(entry.raceCandidate
      ? {
          raceCandidate: {
            ...entry.raceCandidate,
            token: f(entry.raceCandidate.token, 'raceCandidate.token'),
          },
        }
      : {}),
    pendingSignOut: entry.pendingSignOut
      ? {
          ...entry.pendingSignOut,
          credentials: creds(entry.pendingSignOut.credentials, 'pendingSignOut'),
        }
      : null,
    pendingRevoke: entry.pendingRevoke
      ? {
          ...entry.pendingRevoke,
          credentials: creds(entry.pendingRevoke.credentials, 'pendingRevoke'),
        }
      : null,
    ...(entry.retired
      ? {
          retired: entry.retired.map((r, i) => ({
            ...r,
            credentials: creds(r.credentials, `retired.${i}`),
          })),
        }
      : {}),
  };
}

/** Thrown inside {@link mapSecrets} when one value fails to open. */
class UnsealLeafError extends Error {}

/** A file's identity for fencing: inode, size and mtime in ns, or `absent`. */
function fingerprintOf(path: string): string {
  try {
    const st = lstatSync(path, { bigint: true });
    return `${st.ino}:${st.size}:${st.mtimeNs}`;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return 'absent';
    throw err;
  }
}

// ---------- the store ----------

/** Read and write access to the file, valid only inside {@link NexusDeviceStore.update}. */
export interface NexusDeviceTransaction {
  /**
   * Aborted when the lock is lost (taken over as stale). No HTTP call is ever
   * made inside `update` (v2.9): persist, return, call, then re-lock and CAS.
   */
  readonly signal: AbortSignal;
  /**
   * The entry for (origin of `apiUrl`, `userId`), as re-read under the lock.
   *
   * @returns A guarded copy; change it and pass it to {@link NexusDeviceTransaction.set}.
   */
  get(apiUrl: string, userId: string): NexusDeviceEntry | null;
  /** Replace the entry for (origin of `apiUrl`, `userId`). Validated before it is kept. */
  set(apiUrl: string, userId: string, entry: NexusDeviceEntry): void;
  /**
   * CAS delete (§2.5): remove the entry only if it still has `expected`'s
   * device id and current credential id (`null` when it must have none).
   * Returns `true` when an entry was removed.
   */
  delete(
    apiUrl: string,
    userId: string,
    expected: { readonly deviceId: string; readonly credentialId: string | null },
  ): boolean;
  /**
   * Write the changes so far to disk now, atomically, with the lock still
   * held. `update` also writes when `fn` returns, which is the normal path: a
   * `pending` credential or an E1 intent is persisted by returning from
   * `update` (releasing the lock) before E8 or E1 is sent. `flush` is for a
   * long transaction that must make a change durable before it continues
   * locally; never before a network call made with the lock held.
   *
   * @throws {NexusDeviceStoreError} `E_NEXUS_DEVICE_LOCK_COMPROMISED` once the lock is lost.
   */
  flush(): Promise<void>;
  /**
   * Every (origin, userId) pair in the file. `readable: false` marks an entry
   * this machine's key cannot open: it is carried through untouched, and any
   * `get`, `set` or `delete` on it fails with `E_NEXUS_DEVICE_UNSEAL_FAILED`.
   */
  keys(): Array<{ readonly origin: string; readonly userId: string; readonly readable: boolean }>;
  /**
   * Drop an entry this machine cannot open (a lost machine key, or one copied
   * in from elsewhere), so a login can enrol afresh. Compare-and-swap on the
   * device id, which is stored in clear. The server-side device stays active,
   * so the returned warning (also added to {@link NexusDeviceTransaction.warnings})
   * names the device id to revoke on cleocode.dev. A readable entry is never
   * discarded this way; use `delete`.
   *
   * @returns Whether the entry was dropped, and the warning when it was.
   */
  discardUnreadable(
    apiUrl: string,
    userId: string,
    expected: { readonly deviceId: string },
  ): { readonly discarded: boolean; readonly warning: string | null };
  /**
   * One-line warnings from this transaction (for example, the CLEO home was
   * tightened with `chmod go-w`). The caller puts them in its result envelope.
   */
  readonly warnings: readonly string[];
}

/** An entry this machine's key cannot open, as {@link NexusDeviceStore.list} reports it. No secrets. */
export class UnreadableNexusDevice {
  /** Always `false`: the entry could not be opened here. */
  readonly readable = false;
  /** API origin. */
  readonly origin: string;
  /** Nexus user id. */
  readonly userId: string;
  /** The device id stored in clear, when present. */
  readonly deviceId: string | null;
  /** Why it could not be opened. */
  readonly reason: string;

  /**
   * @param origin - API origin.
   * @param userId - Nexus user id.
   * @param deviceId - The device id stored in clear, when present.
   * @param reason - Why it could not be opened.
   */
  constructor(origin: string, userId: string, deviceId: string | null, reason: string) {
    this.origin = origin;
    this.userId = userId;
    this.deviceId = deviceId;
    this.reason = reason;
  }
}

/** Tuning for {@link NexusDeviceStore}. The defaults suit production; tests shorten them. */
export interface NexusDeviceStoreOptions {
  /** How long `update` waits for the lock before `E_NEXUS_DEVICE_BUSY`. Default one minute. */
  readonly lockWaitMs?: number;
  /** Lock staleness threshold (minimum 2000). Default 30 s. */
  readonly lockStaleMs?: number;
  /** CLEO home whose machine key seals the secrets. Default: the store file's directory. */
  readonly cleoHome?: string;
}

/** Store files locked by the current async context (re-entry detection). */
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * File-backed store for Nexus device identities and credentials. See the
 * module comment for the safety rules.
 */
export class NexusDeviceStore {
  /** Absolute path of the store file. */
  readonly location: string;
  readonly #lockWaitMs: number;
  readonly #lockStaleMs: number;
  readonly #cleoHome: string;

  /**
   * @param path - Store path; defaults to {@link nexusDevicePath}.
   * @param options - Lock and sealing options.
   */
  constructor(path: string = nexusDevicePath(), options: NexusDeviceStoreOptions = {}) {
    this.location = resolve(path);
    this.#lockWaitMs = options.lockWaitMs ?? NEXUS_DEVICE_LOCK_WAIT_MS;
    this.#lockStaleMs = Math.max(options.lockStaleMs ?? NEXUS_DEVICE_LOCK_STALE_MS, 2000);
    this.#cleoHome = options.cleoHome ?? dirname(this.location);
  }

  /**
   * A sealed snapshot of one entry, read without the lock. Use it to decide;
   * any change goes through {@link NexusDeviceStore.update}, which re-reads.
   *
   * @param apiUrl - Any URL on the API host.
   * @param userId - Nexus user id.
   * @returns The sealed entry, or `null`.
   * @throws {NexusDeviceStoreError} On an unsafe, newer, malformed or foreign-sealed file.
   */
  async get(apiUrl: string, userId: string): Promise<SealedNexusDevice | null> {
    const origin = nexusOriginKey(apiUrl);
    const sealed = this.readSealed().file.devices[origin]?.[userId];
    if (!sealed) return null;
    const material = await this.material(false);
    return new SealedNexusDevice(origin, userId, this.open(origin, userId, sealed, material));
  }

  /**
   * Every entry, sorted by origin then user id. An entry this machine's key
   * cannot open is listed as an {@link UnreadableNexusDevice} (no secrets)
   * instead of failing the whole listing.
   *
   * @returns The entries.
   * @throws {NexusDeviceStoreError} On an unsafe, newer or malformed file.
   */
  async list(): Promise<Array<SealedNexusDevice | UnreadableNexusDevice>> {
    const out: Array<SealedNexusDevice | UnreadableNexusDevice> = [];
    const devices = this.readSealed().file.devices;
    const material = Object.keys(devices).length > 0 ? await this.material(false) : null;
    for (const origin of Object.keys(devices).sort()) {
      const users = devices[origin] ?? {};
      for (const userId of Object.keys(users).sort()) {
        const sealed = users[userId];
        if (!sealed) continue;
        try {
          out.push(
            new SealedNexusDevice(origin, userId, this.open(origin, userId, sealed, material)),
          );
        } catch (err) {
          if (
            !(err instanceof NexusDeviceStoreError && err.code === 'E_NEXUS_DEVICE_UNSEAL_FAILED')
          ) {
            throw err;
          }
          out.push(
            new UnreadableNexusDevice(
              origin,
              userId,
              sealed.deviceId,
              material === null
                ? 'this CLEO home has no machine key or global salt (lost, or never created); kept untouched'
                : "sealed under another machine's key (copied from another machine or home); kept untouched",
            ),
          );
        }
      }
    }
    return out;
  }

  /**
   * Run `fn` under this store's cross-process lock (M6, N1).
   *
   * - The file is re-read **after** the lock is acquired, so `fn` always sees
   *   the latest state, never a snapshot taken before another process wrote.
   * - `fn` may await local work (another store's lock, taken after this one),
   *   but MUST NOT make a network call: the lock is never held across E1,
   *   E8, E9 or E10 (v2.9). Persist the intent, return, make the call, then
   *   call `update` again and re-check with a CAS.
   * - `tx.flush()` writes mid-transaction; whatever is still unflushed is
   *   written when `fn` returns. When `fn` throws, unflushed changes are
   *   dropped.
   * - Waiting for the lock gives up after `lockWaitMs` with
   *   `E_NEXUS_DEVICE_BUSY`. Calling `update` on the same file from inside
   *   `fn` fails at once with `E_NEXUS_DEVICE_REENTRANT` (it would otherwise
   *   wait on itself).
   * - If the lock is lost while `fn` runs, `tx.signal` aborts, nothing more
   *   is written, and `update` rejects with `E_NEXUS_DEVICE_LOCK_COMPROMISED`.
   *
   * @param fn - The read-modify-write step.
   * @returns What `fn` returned.
   * @throws {NexusDeviceStoreError} As above, or on an unsafe, newer, malformed or foreign-sealed file.
   */
  async update<R>(fn: (tx: NexusDeviceTransaction) => R | Promise<R>): Promise<R> {
    const held = heldLocks.getStore();
    if (held?.has(this.location)) {
      throw new NexusDeviceStoreError(
        'E_NEXUS_DEVICE_REENTRANT',
        `update() on ${this.location} was called from inside another update() on the same file; do the work in the outer transaction`,
      );
    }
    const warnings: string[] = [];
    const tightened = this.prepareDirectory();
    if (tightened !== null) warnings.push(tightened);
    this.seed();

    const controller = new AbortController();
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(this.location, {
        stale: this.#lockStaleMs,
        retries: {
          retries: Math.max(1, Math.ceil(this.#lockWaitMs / 250)),
          factor: 1,
          minTimeout: 250,
          maxTimeout: 250,
        },
        onCompromised: () => {
          controller.abort(
            new NexusDeviceStoreError(
              'E_NEXUS_DEVICE_LOCK_COMPROMISED',
              `the lock on ${this.location} was lost while it was held (another process took it over as stale); nothing more was written. Retry the command`,
            ),
          );
        },
      });
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ELOCKED') {
        throw new NexusDeviceStoreError(
          'E_NEXUS_DEVICE_BUSY',
          `another cleo process has held ${this.location} for more than ${Math.round(this.#lockWaitMs / 1000)} s; retry when it finishes`,
        );
      }
      throw err;
    }

    try {
      return await heldLocks.run(new Set([...(held ?? []), this.location]), () =>
        this.transact(fn, controller.signal, warnings),
      );
    } finally {
      try {
        await release();
      } catch {
        /* already released: the lock was compromised */
      }
    }
  }

  /** The body of {@link NexusDeviceStore.update}, with the lock held. */
  private async transact<R>(
    fn: (tx: NexusDeviceTransaction) => R | Promise<R>,
    signal: AbortSignal,
    warnings: string[],
  ): Promise<R> {
    this.sweepTempFiles();
    const { file: sealedState, raw, fingerprint: readPrint } = this.readSealed();
    let fingerprint = readPrint;
    // Write paths may create the machine key and salt (review N1).
    let material: GlobalKeyMaterial | null = null;
    const ensureMaterial = async (): Promise<GlobalKeyMaterial> => {
      if (material === null) material = await this.material(true);
      if (material === null) {
        throw new NexusDeviceStoreError(
          'E_NEXUS_DEVICE_MACHINE_KEY',
          `the machine key or global salt of ${this.#cleoHome} could not be created`,
        );
      }
      return material;
    };
    if (Object.keys(sealedState.devices).length > 0) await ensureMaterial();
    const state: Record<string, Record<string, NexusDeviceEntry>> = {};
    // Entries this machine's key cannot open: kept as their raw JSON and
    // written back unchanged, never decrypted, rewritten or deleted.
    const opaque: Record<string, Record<string, unknown>> = {};
    for (const [origin, users] of Object.entries(sealedState.devices)) {
      for (const [userId, sealed] of Object.entries(users)) {
        try {
          state[origin] = {
            ...(state[origin] ?? {}),
            [userId]: this.open(origin, userId, sealed, material),
          };
        } catch (err) {
          if (
            !(err instanceof NexusDeviceStoreError && err.code === 'E_NEXUS_DEVICE_UNSEAL_FAILED')
          ) {
            throw err;
          }
          opaque[origin] = { ...(opaque[origin] ?? {}), [userId]: rawEntry(raw, origin, userId) };
        }
      }
    }
    const refuseOpaque = (origin: string, userId: string): void => {
      if (opaque[origin]?.[userId] !== undefined) {
        throw new NexusDeviceStoreError(
          'E_NEXUS_DEVICE_UNSEAL_FAILED',
          `the Nexus device entry for ${origin} could not be opened with this machine's key and is kept untouched: ${this.location}. Run \`cleo login nexus\` against another origin or account, or remove the entry by hand`,
        );
      }
    };
    let dirty = false;
    const assertLive = (): void => {
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new NexusDeviceStoreError('E_NEXUS_DEVICE_LOCK_COMPROMISED', 'the lock was lost');
      }
    };
    const flush = async (): Promise<void> => {
      assertLive();
      if (!dirty) return;
      const sealed = this.seal(sealedState, state, opaque, await ensureMaterial());
      assertLive();
      fingerprint = this.writeAtomic(sealed, fingerprint);
      this.purgeBackups();
      dirty = false;
    };
    const tx: NexusDeviceTransaction = {
      signal,
      warnings,
      get: (apiUrl, userId) => {
        const origin = nexusOriginKey(apiUrl);
        refuseOpaque(origin, userId);
        const entry = state[origin]?.[userId];
        return entry ? guardedCopy(entry) : null;
      },
      set: (apiUrl, userId, entry) => {
        assertLive();
        refuseOpaque(nexusOriginKey(apiUrl), userId);
        const parsed = entrySchema.safeParse(entry);
        if (!parsed.success) {
          throw new NexusDeviceStoreError(
            'E_NEXUS_DEVICE_ENTRY_INVALID',
            `refusing to store an invalid Nexus device entry: ${issuesText(parsed.error)}`,
          );
        }
        const origin = nexusOriginKey(apiUrl);
        state[origin] = { ...(state[origin] ?? {}), [userId]: parsed.data };
        dirty = true;
      },
      delete: (apiUrl, userId, expected) => {
        assertLive();
        const origin = nexusOriginKey(apiUrl);
        refuseOpaque(origin, userId);
        const users = state[origin];
        const entry = users?.[userId];
        if (!users || !entry) return false;
        if (entry.deviceId !== expected.deviceId) return false;
        if ((entry.current?.credentialId ?? null) !== expected.credentialId) return false;
        delete users[userId];
        if (Object.keys(users).length === 0) delete state[origin];
        dirty = true;
        return true;
      },
      flush,
      discardUnreadable: (apiUrl, userId, expected) => {
        assertLive();
        const origin = nexusOriginKey(apiUrl);
        const users = opaque[origin];
        const raw = users?.[userId];
        const rawDeviceId = isPlainObject(raw) ? raw.deviceId : undefined;
        if (!users || raw === undefined || rawDeviceId !== expected.deviceId) {
          return { discarded: false, warning: null };
        }
        delete users[userId];
        if (Object.keys(users).length === 0) delete opaque[origin];
        dirty = true;
        const warning = `W_NEXUS_DEVICE_DISCARDED_UNREADABLE: the Nexus device ${expected.deviceId} for ${origin} could not be opened on this machine and was removed locally. It is still active on the server: revoke device ${expected.deviceId} on cleocode.dev`;
        warnings.push(warning);
        return { discarded: true, warning };
      },
      keys: () => [
        ...Object.entries(state).flatMap(([origin, users]) =>
          Object.keys(users).map((userId) => ({ origin, userId, readable: true })),
        ),
        ...Object.entries(opaque).flatMap(([origin, users]) =>
          Object.keys(users).map((userId) => ({ origin, userId, readable: false })),
        ),
      ],
    };
    const result = await fn(tx);
    await flush();
    return result;
  }

  /**
   * Load this home's machine key and salt, mapping any failure other than
   * "missing" to `E_NEXUS_DEVICE_MACHINE_KEY` (review N5), so it is never
   * mistaken for a file copied from another machine.
   *
   * @param create - Whether missing material may be created (write paths only).
   * @returns The material, or `null` when it is missing and `create` is false.
   */
  private async material(create: boolean): Promise<GlobalKeyMaterial | null> {
    try {
      return await loadGlobalKeyMaterial({ cleoHome: this.#cleoHome, create });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new NexusDeviceStoreError(
        'E_NEXUS_DEVICE_MACHINE_KEY',
        `the machine key or global salt of ${this.#cleoHome} cannot be used, so the Nexus device file was left untouched: ${detail}`,
      );
    }
  }

  /**
   * Decrypt one sealed entry and validate the plaintext.
   *
   * @throws {NexusDeviceStoreError} `E_NEXUS_DEVICE_UNSEAL_FAILED` when there
   *   is no key material or a value fails authentication.
   */
  private open(
    origin: string,
    userId: string,
    sealed: NexusDeviceEntry,
    material: GlobalKeyMaterial | null,
  ): NexusDeviceEntry {
    if (material === null) {
      throw new NexusDeviceStoreError(
        'E_NEXUS_DEVICE_UNSEAL_FAILED',
        `the Nexus device entry for ${origin} cannot be opened: this CLEO home has no machine key or global salt (lost, or never created). It was left untouched: ${this.location}. Run \`cleo login nexus\` to enrol this machine again`,
      );
    }
    const key = deriveGlobalKeyFromMaterial(material, sealId(origin, userId));
    let plain: NexusDeviceEntry;
    try {
      plain = mapSecrets(sealed, (value, path) => {
        const opened = openWithGlobalKey(value, key, path);
        if (opened === null) throw new UnsealLeafError(path);
        return opened;
      });
    } catch (err) {
      if (!(err instanceof UnsealLeafError)) throw err;
      throw new NexusDeviceStoreError(
        'E_NEXUS_DEVICE_UNSEAL_FAILED',
        `the Nexus device entry for ${origin} could not be opened with this machine's key (a file copied from another machine or home?). It was left untouched: ${this.location}. Run \`cleo login nexus\` to enrol this machine as its own device`,
      );
    }
    const parsed = entrySchema.safeParse(plain);
    if (!parsed.success) {
      throw new NexusDeviceStoreError(
        'E_NEXUS_DEVICE_FILE_INVALID',
        `the Nexus device entry for ${origin} is malformed and was left untouched: ${this.location} (${issuesText(parsed.error)})`,
      );
    }
    return parsed.data;
  }

  /**
   * Seal the in-memory state into the on-disk form, keeping unknown top-level
   * fields, and put every unopenable entry back exactly as it was read.
   */
  private seal(
    base: SealedFile,
    state: Record<string, Record<string, NexusDeviceEntry>>,
    opaque: Record<string, Record<string, unknown>>,
    material: GlobalKeyMaterial,
  ): Record<string, unknown> {
    const devices: Record<string, Record<string, unknown>> = {};
    for (const [origin, users] of Object.entries(opaque)) {
      devices[origin] = { ...users };
    }
    for (const [origin, users] of Object.entries(state)) {
      for (const [userId, entry] of Object.entries(users)) {
        const plain = entrySchema.parse(entry); // drops the non-enumerable guards
        const key = deriveGlobalKeyFromMaterial(material, sealId(origin, userId));
        devices[origin] = {
          ...(devices[origin] ?? {}),
          [userId]: mapSecrets(plain, (value, path) => sealWithGlobalKey(value, key, path)),
        };
      }
    }
    return { ...base, version: NEXUS_DEVICE_FILE_VERSION, devices };
  }

  /**
   * Read and validate the file. A missing or empty file (the seed's
   * placeholder) reads as an empty store. Anything else that does not parse
   * as a known version is refused, never read as empty, so it is never
   * overwritten.
   */
  private readSealed(): {
    readonly file: SealedFile;
    readonly raw: unknown;
    readonly fingerprint: string;
  } {
    this.assertSafeDirectory();
    const read = this.readPrivate();
    const fingerprint = read?.fingerprint ?? 'absent';
    const raw = read?.text ?? null;
    if (raw === null || !raw.trim()) {
      return { file: emptyFile(), raw: emptyFile(), fingerprint };
    }
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
    const parsed = sealedFileSchema.safeParse(json);
    if (!parsed.success) {
      throw new NexusDeviceStoreError(
        'E_NEXUS_DEVICE_FILE_INVALID',
        `the Nexus device file does not match format version ${NEXUS_DEVICE_FILE_VERSION} and was left untouched: ${this.location} (${issuesText(parsed.error)})`,
      );
    }
    return { file: parsed.data, raw: json, fingerprint };
  }

  /**
   * Open the file without following links and check the open descriptor
   * (so nothing can be swapped between the check and the read): a regular
   * file with one link, owned by this user, with no group or other bits.
   *
   * @returns The contents and the file's fencing fingerprint, or `null` when
   *   the file does not exist.
   */
  private readPrivate(): { readonly text: string; readonly fingerprint: string } | null {
    if (process.platform === 'win32') {
      // No O_NOFOLLOW on Windows: refuse symlinks and other reparse points first.
      try {
        if (lstatSync(this.location).isSymbolicLink()) throw this.symlinkError('read');
      } catch (err) {
        if (err instanceof NexusDeviceStoreError) throw err;
        return null;
      }
    }
    let fd: number;
    try {
      fd = openSync(this.location, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? err.code : undefined;
      if (code === 'ENOENT') return null;
      if (code === 'ELOOP' || code === 'EMLINK') throw this.symlinkError('read');
      if (code === 'EACCES' || code === 'EPERM') {
        throw new NexusDeviceStoreError(
          'E_NEXUS_DEVICE_FILE_PERMISSIONS',
          `cannot open ${this.location} (${String(code)}). ${this.ownerRemedy()}`,
        );
      }
      throw err;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) {
        throw new NexusDeviceStoreError(
          'E_NEXUS_DEVICE_FILE_UNSAFE',
          `refusing to read ${this.location}: it is not a regular file`,
        );
      }
      if (process.platform !== 'win32') {
        if (st.nlink !== 1) {
          throw new NexusDeviceStoreError(
            'E_NEXUS_DEVICE_FILE_UNSAFE',
            `refusing to read ${this.location}: it has ${st.nlink} hard links, so another path can read or replace it. Remove the other links, or delete the file and run \`cleo login nexus\``,
          );
        }
        const uid = typeof process.getuid === 'function' ? process.getuid() : null;
        if ((st.mode & 0o077) !== 0 || (uid !== null && st.uid !== uid)) {
          throw new NexusDeviceStoreError(
            'E_NEXUS_DEVICE_FILE_PERMISSIONS',
            `refusing to read ${this.location}: it must be owned by you with mode 0600 (it is ${(st.mode & 0o777).toString(8)}, owner uid ${st.uid}). ${this.ownerRemedy()}`,
          );
        }
      }
      const text = readFileSync(fd, 'utf-8');
      const big = fstatSync(fd, { bigint: true });
      return { text, fingerprint: `${big.ino}:${big.size}:${big.mtimeNs}` };
    } finally {
      closeSync(fd);
    }
  }

  /** The remedy for a mode or owner problem, including the sudo case. */
  private ownerRemedy(): string {
    return `Run: chmod 600 "${this.location}". If it is owned by another user (for example it was created by a cleo run under sudo), run: sudo chown "$(id -un)" "${this.location}" && chmod 600 "${this.location}"`;
  }

  /** A symlink refusal for `op`. */
  private symlinkError(op: 'read' | 'write'): NexusDeviceStoreError {
    return new NexusDeviceStoreError(
      'E_NEXUS_DEVICE_FILE_SYMLINK',
      `refusing to ${op} the Nexus device file through a symlink: ${this.location}`,
    );
  }

  /**
   * Refuse a CLEO home another user could use to replace the file: one owned
   * by someone else, or one inside a parent that another user owns and that
   * is group- or world-writable without the sticky bit. A symlinked home is
   * resolved first, and the checks apply to the real directory and its real
   * parent (review N4). A home owned by the caller that is group- or
   * world-writable is allowed here: reads check the open descriptor, and
   * {@link NexusDeviceStore.prepareDirectory} tightens it on the first write.
   * Skipped on Windows, where the profile ACL governs.
   *
   * @returns The real home, its stat and whether the configured path is a
   *   symlink, or `null` when it does not exist (or on Windows).
   */
  private assertSafeDirectory(): {
    readonly real: string;
    readonly st: Stats;
    readonly viaSymlink: boolean;
  } | null {
    if (process.platform === 'win32') return null;
    const dir = dirname(this.location);
    let viaSymlink: boolean;
    let real: string;
    let st: Stats;
    try {
      viaSymlink = lstatSync(dir).isSymbolicLink();
      real = viaSymlink ? realpathSync(dir) : dir;
      st = statSync(real);
    } catch {
      return null; // absent: created 0700 by prepareDirectory()
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!st.isDirectory() || (uid !== null && st.uid !== uid)) {
      throw new NexusDeviceStoreError(
        'E_NEXUS_DEVICE_DIR_UNSAFE',
        `refusing to use ${this.location}: the CLEO home ${real} must be a directory owned by you (it is owned by uid ${st.uid}). Fix its owner, for example: sudo chown "$(id -un)" "${real}"`,
      );
    }
    const parent = dirname(real);
    let pst: Stats | null = null;
    try {
      pst = statSync(parent);
    } catch {
      pst = null;
    }
    if (
      pst !== null &&
      uid !== null &&
      pst.uid !== uid &&
      (pst.mode & 0o022) !== 0 &&
      (pst.mode & 0o1000) === 0
    ) {
      throw new NexusDeviceStoreError(
        'E_NEXUS_DEVICE_DIR_UNSAFE',
        `refusing to use ${this.location}: the CLEO home's parent ${parent} is owned by another user (uid ${pst.uid}) and writable by group or others, so the home could be replaced. Move the CLEO home (CLEO_HOME) somewhere you own`,
      );
    }
    return { real, st, viaSymlink };
  }

  /**
   * Before a write: create the CLEO home 0700 if it is missing, check it,
   * and tighten a home the caller owns that is group- or world-writable with
   * `chmod go-w` (the CLEO home is CLEO's own directory). A home reached
   * through a symlink is never changed: its target may be a directory CLEO
   * does not own the purpose of, so only a warning is given (review N4).
   *
   * @returns A one-line warning when the home was tightened or should be, else `null`.
   */
  private prepareDirectory(): string | null {
    const dir = dirname(this.location);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const home = this.assertSafeDirectory();
    if (home === null || (home.st.mode & 0o022) === 0) return null;
    const before = home.st.mode & 0o7777;
    const after = before & ~0o022;
    if (home.viaSymlink) {
      return `W_NEXUS_DEVICE_HOME_WRITABLE: the CLEO home ${dir} is a symlink to ${home.real}, which is writable by group or others (${before.toString(8)}). It was not changed; if that directory is only for CLEO, run: chmod go-w "${home.real}"`;
    }
    chmodSync(dir, after);
    return `W_NEXUS_DEVICE_HOME_TIGHTENED: the CLEO home ${dir} was writable by group or others (${before.toString(8)}); it was changed to ${after.toString(8)} (chmod go-w)`;
  }

  /**
   * Write `state` atomically at 0600: a new temp file (`O_EXCL | O_NOFOLLOW`),
   * fsync (F_FULLFSYNC on macOS, through libuv), rename over the target, then
   * fsync the directory so the rename survives a crash. No backup copy is
   * made. On Windows a rename blocked by a scanner (EPERM, EBUSY) is retried.
   */
  private writeAtomic(state: Record<string, unknown>, expected: string): string {
    const dir = dirname(this.location);
    const tmp = join(dir, `.${basename(this.location)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const fd = openSync(
        tmp,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NO_FOLLOW,
        0o600,
      );
      try {
        writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // Fencing (review L1): the file must still be what this transaction
      // last read or wrote. Anything else means another writer got in.
      if (fingerprintOf(this.location) !== expected) {
        throw new NexusDeviceStoreError(
          'E_NEXUS_DEVICE_LOCK_COMPROMISED',
          `${this.location} was changed by another writer while this process held the lock; nothing was written. Retry the command`,
        );
      }
      renameWithRetry(tmp, this.location);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* already renamed or never created */
      }
      if (err instanceof NexusDeviceStoreError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      throw new NexusDeviceStoreError(
        'E_NEXUS_DEVICE_IO',
        `could not write ${this.location}; the previous file is intact: ${detail}`,
      );
    }
    fsyncDirectory(dir);
    return fingerprintOf(this.location);
  }

  /**
   * Create the file owner-only, in an owner-only directory, if it does not
   * exist, so the lock never creates it at the default mode. `O_EXCL` plus
   * `O_NOFOLLOW` close the window between the symlink check and the create.
   */
  private seed(): void {
    let fd: number;
    try {
      fd = openSync(
        this.location,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | NO_FOLLOW,
        0o600,
      );
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? err.code : undefined;
      if (code === 'EACCES' || code === 'EPERM') {
        throw new NexusDeviceStoreError(
          'E_NEXUS_DEVICE_FILE_PERMISSIONS',
          `cannot create ${this.location} (${String(code)}). ${this.ownerRemedy()}`,
        );
      }
      if (code !== 'EEXIST') throw err;
      // It exists: make sure it is not a link before the lock touches it.
      try {
        if (lstatSync(this.location).isSymbolicLink()) throw this.symlinkError('write');
      } catch (inner) {
        if (inner instanceof NexusDeviceStoreError) throw inner;
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
   * Delete temp files a crashed writer left behind. Runs under the lock, so
   * no live writer's temp file can match.
   */
  private sweepTempFiles(): void {
    const dir = dirname(this.location);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!TEMP_FILE.test(entry)) continue;
      try {
        unlinkSync(join(dir, entry));
      } catch {
        /* best effort */
      }
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

/** The raw JSON value of one entry, exactly as it was parsed from the file. */
function rawEntry(raw: unknown, origin: string, userId: string): unknown {
  if (!isPlainObject(raw)) return undefined;
  const devices = raw.devices;
  if (!isPlainObject(devices)) return undefined;
  const users = devices[origin];
  return isPlainObject(users) ? users[userId] : undefined;
}

/** A fresh, empty file value. */
function emptyFile(): SealedFile {
  return { version: NEXUS_DEVICE_FILE_VERSION, devices: {} };
}

/** Block the thread for `ms` (used only between Windows rename retries). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Rename `from` over `to`. On Windows a scanner or indexer briefly holding
 * the target makes the rename fail with EPERM or EBUSY; retry a few times.
 */
function renameWithRetry(from: string, to: string): void {
  const attempts = process.platform === 'win32' ? 10 : 1;
  for (let i = 1; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? err.code : undefined;
      if (i >= attempts || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
      sleepSync(20 * i);
    }
  }
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
