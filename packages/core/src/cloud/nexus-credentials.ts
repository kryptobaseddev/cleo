/**
 * Cleo Nexus session-token store.
 *
 * Stored at `<cleoHome>/nexus-credentials.json` (resolved through
 * `@cleocode/paths`, arch gate 2) with 0600 permissions, one session per API
 * origin. Modelled on `../decide/credentials.ts`:
 *
 * - Writes go through `withLock` and `writeJsonFileAtomic({ mode: 0o600 })`,
 *   so neither the live file, the temp file nor a rotated backup is ever
 *   looser than owner-only. Deleting a session also purges the rotated
 *   backups, which would otherwise keep a copy of the token.
 * - Reads return a {@link SealedNexusSession}: the token sits in a private
 *   field, so `JSON.stringify`, `util.inspect` and template strings of the
 *   handle show a masked preview only. {@link SealedNexusSession.bearer} is the
 *   one accessor, called where the HTTP request is built.
 *
 * Everything goes through the {@link NexusTokenStore} interface, so an OS
 * keychain store can replace the file later without touching the callers.
 *
 * @task T12712
 * @epic T12322
 */

import {
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { inspect } from 'node:util';
import {
  type NexusAccountOrganization,
  type NexusAccountUser,
  nexusAccountOrganizationSchema,
  nexusAccountUserSchema,
} from '@cleocode/contracts';
import { resolveNexusCredentialsPath } from '@cleocode/paths';
import { z } from 'zod';
import { withLock } from '../store/file-utils.js';

/** File name of the store, directly under the CLEO home. */
export const NEXUS_CREDENTIALS_FILE = 'nexus-credentials.json';

const sessionSchema = z.object({
  token: z.string().min(1),
  tokenType: z.string(),
  expiresAt: z.string().nullable(),
  user: nexusAccountUserSchema.nullable(),
  organization: nexusAccountOrganizationSchema.nullable(),
  createdAt: z.string(),
});

const storeSchema = z.object({
  version: z.literal(1),
  sessions: z.record(z.string(), sessionSchema),
});

type NexusCredentialsFile = z.infer<typeof storeSchema>;

const EMPTY_STORE: NexusCredentialsFile = { version: 1, sessions: {} };

/** `O_NOFOLLOW` where the platform has it (not on Windows). */
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** A session to store. The token is the only secret. */
export interface NexusSessionInput {
  /** Bearer session token issued by the device-code grant. */
  readonly token: string;
  /** Token type the server reported (`Bearer`). */
  readonly tokenType: string;
  /** ISO expiry, when the server reported one. */
  readonly expiresAt: string | null;
  /** The signed-in user, when known. */
  readonly user: NexusAccountUser | null;
  /** Primary organization, when known. */
  readonly organization: NexusAccountOrganization | null;
}

/**
 * Pluggable storage for Nexus session tokens, keyed by API origin.
 *
 * The file store below is the default. A keychain-backed store implements the
 * same four methods.
 */
export interface NexusTokenStore {
  /** Absolute location shown to the user (a path, or a keychain service name). */
  readonly location: string;
  /** The session for `apiUrl`'s origin, or `null`. */
  get(apiUrl: string): Promise<SealedNexusSession | null>;
  /** Store (replace) the session for `apiUrl`'s origin. */
  put(apiUrl: string, session: NexusSessionInput): Promise<void>;
  /**
   * Delete the session for `apiUrl`'s origin. With `expected`, delete only if
   * the stored token is still that session's token (checked under the store's
   * lock), so a login that finished meanwhile is not wiped. Returns `true` when
   * a session was deleted.
   */
  delete(apiUrl: string, expected?: SealedNexusSession): Promise<boolean>;
  /** Every stored session. */
  list(): Promise<SealedNexusSession[]>;
}

/**
 * Mask a token down to a short, non-reversible preview.
 *
 * @param token - Plaintext token (read transiently, not retained).
 * @returns `…` plus at most the last 4 characters.
 */
export function maskNexusToken(token: string): string {
  return token.length > 12 ? `…${token.slice(-4)}` : '…';
}

/**
 * Opaque handle to a stored session. The token is held in a private field;
 * serialising or inspecting the handle yields the masked preview only.
 */
export class SealedNexusSession {
  /** API origin the session belongs to. */
  readonly apiUrl: string;
  /** Token type (`Bearer`). */
  readonly tokenType: string;
  /** ISO expiry, when known. */
  readonly expiresAt: string | null;
  /** Signed-in user, when known. */
  readonly user: NexusAccountUser | null;
  /** Primary organization, when known. */
  readonly organization: NexusAccountOrganization | null;
  /** ISO time the session was stored. */
  readonly createdAt: string;
  /** Masked token preview. */
  readonly tokenPreview: string;
  readonly #token: string;

  /**
   * @param apiUrl - API origin.
   * @param record - Stored record; the token is captured privately.
   */
  constructor(apiUrl: string, record: z.infer<typeof sessionSchema>) {
    this.apiUrl = apiUrl;
    this.tokenType = record.tokenType;
    this.expiresAt = record.expiresAt;
    this.user = record.user;
    this.organization = record.organization;
    this.createdAt = record.createdAt;
    this.#token = record.token;
    this.tokenPreview = maskNexusToken(record.token);
  }

  /**
   * The plaintext token. Call only where the `Authorization` header is built.
   *
   * @returns The bearer token.
   */
  bearer(): string {
    return this.#token;
  }

  /** Secret-free JSON form. */
  toJSON(): Record<string, unknown> {
    return {
      apiUrl: this.apiUrl,
      tokenType: this.tokenType,
      expiresAt: this.expiresAt,
      user: this.user,
      organization: this.organization,
      createdAt: this.createdAt,
      tokenPreview: this.tokenPreview,
    };
  }

  /** Secret-free string form. */
  toString(): string {
    return `SealedNexusSession(${this.apiUrl}, token ${this.tokenPreview})`;
  }

  /** Secret-free `util.inspect` form. */
  [inspect.custom](): string {
    return this.toString();
  }
}

/** Thrown when the store cannot be written safely. */
export class NexusCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NexusCredentialsError';
  }
}

/**
 * The storage key for an API URL: its origin (scheme, host and port).
 *
 * @param apiUrl - Any URL on the API host.
 * @returns The origin, e.g. `https://api.cleocode.dev`.
 */
export function nexusOriginKey(apiUrl: string): string {
  return new URL(apiUrl).origin;
}

/**
 * Absolute path of the default file store.
 *
 * @returns `<cleoHome>/nexus-credentials.json`.
 */
export function nexusCredentialsPath(): string {
  return resolveNexusCredentialsPath();
}

/**
 * File-backed {@link NexusTokenStore}: `<cleoHome>/nexus-credentials.json`,
 * mode 0600, one entry per API origin.
 */
export class FileNexusTokenStore implements NexusTokenStore {
  /** Absolute path of the store file. */
  readonly location: string;

  /** @param path - Store path; defaults to {@link nexusCredentialsPath}. */
  constructor(path: string = nexusCredentialsPath()) {
    this.location = path;
  }

  async get(apiUrl: string): Promise<SealedNexusSession | null> {
    const key = nexusOriginKey(apiUrl);
    const record = this.read().sessions[key];
    return record ? new SealedNexusSession(key, record) : null;
  }

  async put(apiUrl: string, session: NexusSessionInput): Promise<void> {
    const key = nexusOriginKey(apiUrl);
    const record = sessionSchema.parse({
      token: session.token,
      tokenType: session.tokenType,
      expiresAt: session.expiresAt,
      user: session.user,
      organization: session.organization,
      createdAt: new Date().toISOString(),
    });
    await this.write((current) => ({
      version: 1,
      sessions: { ...current.sessions, [key]: record },
    }));
  }

  async delete(apiUrl: string, expected?: SealedNexusSession): Promise<boolean> {
    const key = nexusOriginKey(apiUrl);
    let deleted = false;
    if (key in this.read().sessions) {
      await this.write((current) => {
        const stored = current.sessions[key];
        if (!stored || (expected !== undefined && stored.token !== expected.bearer())) {
          return current;
        }
        deleted = true;
        const sessions = { ...current.sessions };
        delete sessions[key];
        return { version: 1, sessions };
      });
    }
    // Rotated backups hold earlier copies of the file, and so of the token.
    this.purgeBackups();
    return deleted;
  }

  async list(): Promise<SealedNexusSession[]> {
    return Object.entries(this.read().sessions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, record]) => new SealedNexusSession(key, record));
  }

  /**
   * Read and validate the file; a missing or malformed file reads as empty. A
   * file readable or writable by group/others, or owned by another user, is
   * refused: its token may already be exposed or planted.
   */
  private read(): NexusCredentialsFile {
    this.assertPrivate();
    let raw: string;
    try {
      raw = readFileSync(this.location, 'utf-8');
    } catch {
      return EMPTY_STORE;
    }
    if (!raw.trim()) return EMPTY_STORE;
    try {
      const parsed = storeSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : EMPTY_STORE;
    } catch {
      return EMPTY_STORE;
    }
  }

  /** Locked, atomic, owner-only read-modify-write. */
  private async write(
    transform: (current: NexusCredentialsFile) => NexusCredentialsFile,
  ): Promise<void> {
    this.assertNoSymlinks();
    this.seed();
    await withLock<NexusCredentialsFile>(
      this.location,
      (current) => {
        const parsed = storeSchema.safeParse(current);
        return transform(parsed.success ? parsed.data : EMPTY_STORE);
      },
      { mode: 0o600 },
    );
  }

  /**
   * Create the store file owner-only if it does not exist. `O_EXCL` plus
   * `O_NOFOLLOW` close the window between the symlink check and the create: a
   * symlink planted meanwhile makes the open fail instead of being followed.
   * On `EEXIST` the existing entry is re-opened with `O_NOFOLLOW`, which fails
   * (`ELOOP`) on a symlink, so a planted link is refused before the locked
   * write can touch it.
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
        throw new NexusCredentialsError(
          `refusing to write Nexus credentials through a symlink: ${this.location}`,
        );
      }
      return;
    }
    try {
      writeSync(fd, `${JSON.stringify(EMPTY_STORE)}\n`);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Throw when the store exists with a mode wider than 0600 or another owner.
   * Skipped on Windows, where Node reports every file as 0o666 and uids do not
   * apply; the file lives in the user's profile, protected by its ACL.
   */
  private assertPrivate(): void {
    if (process.platform === 'win32') return;
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(this.location);
    } catch {
      return; // absent: created 0600 on first write
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if ((st.mode & 0o077) !== 0 || (uid !== null && st.uid !== uid)) {
      throw new NexusCredentialsError(
        `refusing to read ${this.location}: it must be owned by you with mode 0600 (it is ${(st.mode & 0o777).toString(8)}). Run: chmod 600 ${this.location}`,
      );
    }
  }

  /** Refuse to write a token through a symlink (it could point anywhere). */
  private assertNoSymlinks(): void {
    for (const candidate of [this.location, ...this.backupFiles()]) {
      let isLink = false;
      try {
        isLink = lstatSync(candidate).isSymbolicLink();
      } catch {
        continue;
      }
      if (isLink) {
        throw new NexusCredentialsError(
          `refusing to write Nexus credentials through a symlink: ${candidate}`,
        );
      }
    }
  }

  /** Rotated backups of the store file. */
  private backupFiles(): string[] {
    const backupDir = join(dirname(this.location), '.backups');
    const prefix = `${basename(this.location)}.`;
    try {
      return readdirSync(backupDir)
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => join(backupDir, entry));
    } catch {
      return [];
    }
  }

  /** Delete every rotated backup (best effort). */
  private purgeBackups(): void {
    for (const file of this.backupFiles()) {
      try {
        unlinkSync(file);
      } catch {
        /* best effort */
      }
    }
  }
}
