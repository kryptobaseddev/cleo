/**
 * Decision-provider credential store — the provider kind, the two settings a
 * user supplies (an API base URL and an API key) and the default model.
 *
 * The file stays at schema version 1. T12713 added `provider` (`layahost` |
 * `jev`) as an OPTIONAL, additive field instead of bumping the version, so a
 * CLEO that predates provider kinds (whose zod object is non-strict and
 * accepts only `version: 1`) still parses the file after a downgrade. A file
 * without `provider` infers the kind from its base URL
 * ({@link inferDecisionProviderKind}).
 *
 * Stored at `<cleoHome>/decide-credentials.json` (resolved through
 * `@cleocode/paths`, arch gate 2) with 0600 permissions:
 *
 * - Writes go through `withLock` (cross-process lock) and
 *   `writeJsonFileAtomic({ mode: 0o600 })`, so neither the live file, the
 *   temp file nor a rotated backup ever exists at a looser mode. Modelled on
 *   `../llm/credentials-store.ts`.
 * - The file lives at the TOP level of the CLEO home so its rotated backups
 *   land in the owner-only `<cleoHome>/.backups/`, and the portable-bundle
 *   scanner classifies it as a secret (see `store/portable-bundle-scan.ts`).
 * - Reads return a {@link SealedDecideConnection}: the key sits in a private
 *   class field, so `JSON.stringify`, `util.inspect` and template strings of
 *   the handle only ever show a masked last-4 preview. The plaintext is
 *   materialised solely by {@link SealedDecideConnection.connection}, which the
 *   decision client calls at the wire.
 *
 * The key never lands in `config.json`, logs, LAFS envelopes or the decisions
 * audit: nothing here logs, and every summary this module returns carries the
 * masked preview only.
 *
 * @task T12491
 * @task T12713
 * @epic T12486
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';
import {
  type DecisionProviderKind,
  decisionProviderConfigSchema,
  decisionProviderKindSchema,
} from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';
import { z } from 'zod';
import { withLock } from '../store/file-utils.js';
import { isValidDecisionModelName } from './jev-wire.js';
import type { DecisionProviderConnection } from './provider.js';
import { inferDecisionProviderKind } from './providers.js';

/** File name of the store, directly under the CLEO home. */
export const DECIDE_CREDENTIALS_FILE = 'decide-credentials.json';

/**
 * On-disk schema version. Deliberately still 1: `provider` is an additive
 * optional field, and released CLEO parses `z.literal(1)` — bumping this would
 * silently disable System One after a downgrade.
 */
export const DECIDE_CREDENTIALS_VERSION = 1;

/** On-disk shape of the store. `null` settings mean "not configured". */
const storeSchema = z.object({
  version: z.literal(DECIDE_CREDENTIALS_VERSION),
  /** T12713, optional: absent in files written before provider kinds existed. */
  provider: decisionProviderKindSchema.nullable().optional(),
  baseUrl: z.string().nullable(),
  apiKey: z.string().nullable(),
  model: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
});

type DecideCredentialsStore = z.infer<typeof storeSchema>;

const EMPTY_STORE: DecideCredentialsStore = {
  version: DECIDE_CREDENTIALS_VERSION,
  baseUrl: null,
  apiKey: null,
};

/** Parse the store; a file without `provider` infers it from its base URL. */
function parseStore(value: unknown): DecideCredentialsStore | null {
  const parsed = storeSchema.safeParse(value);
  if (!parsed.success) return null;
  const store = parsed.data;
  if (store.provider || !store.baseUrl) return store;
  return { ...store, provider: inferDecisionProviderKind(store.baseUrl) };
}

/** Settings accepted by {@link saveDecideCredentials}. */
export interface DecideCredentialsInput {
  /** Provider kind. Omitted → `jev` (a custom endpoint). */
  readonly provider?: DecisionProviderKind;
  /** Absolute provider base URL, e.g. `https://provider.example`. */
  readonly baseUrl: string;
  /** API key. Leading/trailing whitespace (e.g. a piped newline) is trimmed. */
  readonly apiKey: string;
  /** Optional default model; omitted → the request carries no model. */
  readonly model?: string;
}

/** Secret-free description of the stored settings. Safe to log and to emit in envelopes. */
export interface DecideCredentialsSummary {
  /** True when a valid base URL and a non-blank key are stored. */
  readonly configured: boolean;
  /** Absolute path of the store file. */
  readonly path: string;
  /** Stored provider kind, when present. */
  readonly provider?: DecisionProviderKind;
  /** Stored base URL, when present. */
  readonly baseUrl?: string;
  /** Stored default model, when present. */
  readonly model?: string;
  /** Masked key preview (`…abcd`), when a key is stored. */
  readonly keyPreview?: string;
  /** ISO timestamp of the last write, when known. */
  readonly updatedAt?: string;
}

/**
 * Absolute path of the decision-credential store.
 *
 * @returns `<cleoHome>/decide-credentials.json`.
 */
export function decideCredentialsPath(): string {
  return join(getCleoHome(), DECIDE_CREDENTIALS_FILE);
}

/**
 * Mask an API key down to its last four characters.
 *
 * @param apiKey - Plaintext key (read transiently, not retained).
 * @returns `…` plus at most the last 4 characters; `…` alone for keys of 4 or fewer characters.
 */
export function maskApiKey(apiKey: string): string {
  const key = apiKey.trim();
  return key.length > 4 ? `…${key.slice(-4)}` : '…';
}

/**
 * Opaque handle to a stored connection. The key is held in a private field;
 * serialising or inspecting the handle yields the masked preview only.
 */
export class SealedDecideConnection {
  /** Provider kind (not secret). */
  readonly provider: DecisionProviderKind;
  /** Provider base URL (not secret). */
  readonly baseUrl: string;
  /** Default model, when configured. */
  readonly model?: string;
  /** Masked key preview (`…abcd`). */
  readonly keyPreview: string;
  readonly #apiKey: string;

  /**
   * @param baseUrl - Provider base URL.
   * @param apiKey - Plaintext key; captured privately.
   * @param model - Optional default model.
   * @param provider - Provider kind. Default `jev`.
   */
  constructor(
    baseUrl: string,
    apiKey: string,
    model?: string,
    provider: DecisionProviderKind = 'jev',
  ) {
    this.provider = provider;
    this.baseUrl = baseUrl;
    this.#apiKey = apiKey;
    this.keyPreview = maskApiKey(apiKey);
    if (model) this.model = model;
  }

  /**
   * Materialise the wire connection. Call only where the request is built.
   *
   * @returns Base URL, plaintext key and optional model.
   */
  connection(): DecisionProviderConnection {
    return {
      baseUrl: this.baseUrl,
      apiKey: this.#apiKey,
      ...(this.model ? { model: this.model } : {}),
    };
  }

  /** @returns The secret-free JSON form. */
  toJSON(): {
    provider: DecisionProviderKind;
    baseUrl: string;
    model?: string;
    keyPreview: string;
  } {
    return {
      provider: this.provider,
      baseUrl: this.baseUrl,
      ...(this.model ? { model: this.model } : {}),
      keyPreview: this.keyPreview,
    };
  }

  /** @returns A secret-free string form. */
  toString(): string {
    return `SealedDecideConnection(${this.provider} ${this.baseUrl}, key ${this.keyPreview})`;
  }

  /** Secret-free `util.inspect` / `console.log` form. */
  [inspect.custom](): string {
    return this.toString();
  }
}

/** Read and parse the store. Never throws; missing or malformed → empty. */
function readStoreSync(path: string = decideCredentialsPath()): DecideCredentialsStore {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return EMPTY_STORE;
  }
  if (!raw.trim()) return EMPTY_STORE;
  try {
    return parseStore(JSON.parse(raw)) ?? EMPTY_STORE;
  } catch {
    return EMPTY_STORE;
  }
}

/** `scheme://user:pass@` prefix of a URL — matched textually so an unparseable URL is covered too. */
const USERINFO_RE = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i;

/** Whether `baseUrl` carries userinfo (`user:pass@`). */
function hasUserinfo(baseUrl: string): boolean {
  return USERINFO_RE.test(baseUrl.trim());
}

/** `baseUrl` with any userinfo removed, for display. */
function withoutUserinfo(baseUrl: string): string {
  return baseUrl.replace(USERINFO_RE, '$1');
}

/** Hostnames for which plain `http://` is allowed (the loopback interface only). */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether `baseUrl` is an acceptable provider URL: absolute `https://`, or
 * plain `http://` to a loopback host (`localhost`, `127.0.0.1`, `::1`). A
 * remote plain-http URL is rejected so the bearer key never crosses the
 * network in clear text.
 *
 * @param baseUrl - Candidate base URL.
 * @returns True when the URL may be stored and used.
 */
export function isAllowedDecideBaseUrl(baseUrl: string): boolean {
  if (!decisionProviderConfigSchema.safeParse({ baseUrl }).success) return false;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  // Userinfo (`user:pass@host`) would be stored, echoed and sent as a second
  // credential beside the key; the key is the only credential accepted.
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
}

/**
 * Whether two base URLs address the same host (hostname + port).
 *
 * @param a - First URL.
 * @param b - Second URL.
 * @returns True when both parse and share `host`; false otherwise.
 */
export function sameDecideHost(a: string, b: string): boolean {
  try {
    return new URL(a).host.toLowerCase() === new URL(b).host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Load the stored connection. Synchronous and total: missing, malformed or
 * incomplete settings return `null` (the decision client then falls back to
 * heuristics).
 *
 * @returns The sealed connection, or `null` when unconfigured.
 */
export function loadDecideConnection(): SealedDecideConnection | null {
  const store = readStoreSync();
  const baseUrl = store.baseUrl?.trim();
  const apiKey = store.apiKey?.trim();
  if (!baseUrl || !apiKey || !isAllowedDecideBaseUrl(baseUrl)) return null;
  const model = store.model?.trim();
  return new SealedDecideConnection(
    baseUrl,
    apiKey,
    model && isValidDecisionModelName(model) ? model : undefined,
    store.provider ?? 'jev',
  );
}

/**
 * Describe the stored settings without the key.
 *
 * @returns A secret-free summary.
 */
export function describeDecideCredentials(): DecideCredentialsSummary {
  const path = decideCredentialsPath();
  const store = readStoreSync(path);
  const sealed = loadDecideConnection();
  return {
    configured: sealed !== null,
    path,
    ...(store.provider ? { provider: store.provider } : {}),
    ...(store.baseUrl ? { baseUrl: withoutUserinfo(store.baseUrl) } : {}),
    ...(store.model ? { model: store.model } : {}),
    ...(store.apiKey ? { keyPreview: maskApiKey(store.apiKey) } : {}),
    ...(store.updatedAt ? { updatedAt: store.updatedAt } : {}),
  };
}

/** Error thrown by {@link saveDecideCredentials} for invalid input. The message never contains the key. */
export class DecideCredentialsError extends Error {
  /** @param message - Secret-free description. */
  constructor(message: string) {
    super(message);
    this.name = 'DecideCredentialsError';
  }
}

/** Backup directory `withLock` rotates into (see `store/file-utils.ts`). */
function backupDirFor(path: string): string {
  return join(dirname(path), '.backups');
}

/**
 * Refuse to write through a symlink: the store file, the `.backups`
 * directory and every rotated backup of the store must be real files or
 * absent. `writeFileSync` (used for the backup copy) follows symlinks, so a
 * planted link could otherwise redirect the key elsewhere.
 *
 * @throws {DecideCredentialsError} When any of those paths is a symlink.
 */
function assertNoSymlinks(path: string): void {
  const backupDir = backupDirFor(path);
  const candidates = [path, backupDir];
  try {
    for (const entry of readdirSync(backupDir)) {
      if (entry.startsWith(`${DECIDE_CREDENTIALS_FILE}.`)) candidates.push(join(backupDir, entry));
    }
  } catch {
    /* no backup dir yet */
  }
  for (const candidate of candidates) {
    let isLink = false;
    try {
      isLink = lstatSync(candidate).isSymbolicLink();
    } catch {
      continue;
    }
    if (isLink) {
      throw new DecideCredentialsError(
        `refusing to write decision credentials through a symlink: ${candidate}`,
      );
    }
  }
}

let warnedLooseHome = false;

/** Warn once on stderr when the CLEO home is group- or world-writable. */
function warnIfHomeWritableByOthers(path: string): void {
  if (warnedLooseHome) return;
  try {
    const dirMode = statSync(dirname(path)).mode & 0o777;
    if ((dirMode & 0o022) !== 0) {
      warnedLooseHome = true;
      process.stderr.write(
        `warning: ${dirname(path)} is group- or world-writable (mode ${dirMode.toString(8)}); ` +
          'other users could tamper with the decision credentials. Run: chmod go-w <dir>\n',
      );
    }
  } catch {
    /* home missing — created owner-only below */
  }
}

/** Reset the once-only loose-home warning. Tests only. @internal */
export function _resetDecideHomeWarningForTest(): void {
  warnedLooseHome = false;
}

/** Pre-write checks shared by save and clear. */
function guardWrite(path: string): void {
  warnIfHomeWritableByOthers(path);
  assertNoSymlinks(path);
}

/**
 * Seed the store file (0600, owner-only directory) so `withLock`'s JSON read
 * never meets an empty placeholder.
 */
function ensureStoreFile(path: string): void {
  if (existsSync(path) && readFileSync(path, 'utf-8').trim()) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(EMPTY_STORE)}\n`, { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Store the provider kind, base URL, API key and optional model (0600, locked,
 * atomic). Writes schema version 1 with the optional `provider` field.
 *
 * @param input - Settings to store; replaces any previous settings.
 * @returns Secret-free summary of what is now stored.
 * @throws {DecideCredentialsError} When the URL is not https (or loopback http), the key is
 *   blank, the model name is invalid, or the store or its backups are symlinks.
 */
export async function saveDecideCredentials(
  input: DecideCredentialsInput,
): Promise<DecideCredentialsSummary> {
  const baseUrl = input.baseUrl.trim();
  const apiKey = input.apiKey.trim();
  const model = input.model?.trim();
  if (hasUserinfo(baseUrl)) {
    throw new DecideCredentialsError(
      'base URL must not contain a username or password (user:pass@host); supply only the URL and the API key',
    );
  }
  if (!isAllowedDecideBaseUrl(baseUrl)) {
    throw new DecideCredentialsError(
      'base URL must be an absolute https:// URL (plain http:// is allowed only for localhost, 127.0.0.1 and ::1)',
    );
  }
  if (model && !isValidDecisionModelName(model)) {
    throw new DecideCredentialsError(
      'model name may contain only letters, digits and . _ : / @ - (1-128 characters)',
    );
  }
  if (!apiKey) throw new DecideCredentialsError('API key must not be empty');
  if (/\s/.test(apiKey)) throw new DecideCredentialsError('API key must not contain whitespace');

  const path = decideCredentialsPath();
  guardWrite(path);
  ensureStoreFile(path);
  await withLock<DecideCredentialsStore>(
    path,
    () => ({
      version: DECIDE_CREDENTIALS_VERSION,
      provider: input.provider ?? 'jev',
      baseUrl,
      apiKey,
      model: model || null,
      updatedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  return describeDecideCredentials();
}

/**
 * Remove the stored settings: the store is overwritten with empty settings
 * and every rotated backup of it (which may hold an old key) is deleted.
 *
 * @returns True when settings were present before the call.
 */
export async function clearDecideCredentials(): Promise<boolean> {
  const path = decideCredentialsPath();
  const before = readStoreSync(path);
  const hadSettings = Boolean(before.baseUrl || before.apiKey || before.model);
  guardWrite(path);
  if (existsSync(path)) {
    ensureStoreFile(path);
    await withLock<DecideCredentialsStore>(path, () => EMPTY_STORE, { mode: 0o600 });
  }
  purgeBackups(path);
  return hadSettings;
}

/** Delete `<dir>/.backups/<name>.N` copies of the store. */
function purgeBackups(path: string): void {
  const backupDir = backupDirFor(path);
  let entries: string[];
  try {
    entries = readdirSync(backupDir);
  } catch {
    return;
  }
  const prefix = `${DECIDE_CREDENTIALS_FILE}.`;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    try {
      unlinkSync(join(backupDir, entry));
    } catch {
      /* best effort */
    }
  }
}
