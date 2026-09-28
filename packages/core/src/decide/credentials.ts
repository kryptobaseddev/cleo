/**
 * Decision-provider credential store — the two settings a user supplies
 * (an API base URL and an API key) plus an optional default model.
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
 * @epic T12486
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';
import { decisionProviderConfigSchema } from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';
import { z } from 'zod';
import { withLock } from '../store/file-utils.js';
import type { DecisionProviderConnection } from './provider.js';

/** File name of the store, directly under the CLEO home. */
export const DECIDE_CREDENTIALS_FILE = 'decide-credentials.json';

/** On-disk shape of the store. `null` settings mean "not configured". */
const storeSchema = z.object({
  version: z.literal(1),
  baseUrl: z.string().nullable(),
  apiKey: z.string().nullable(),
  model: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
});

type DecideCredentialsStore = z.infer<typeof storeSchema>;

const EMPTY_STORE: DecideCredentialsStore = { version: 1, baseUrl: null, apiKey: null };

/** Settings accepted by {@link saveDecideCredentials}. */
export interface DecideCredentialsInput {
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
   */
  constructor(baseUrl: string, apiKey: string, model?: string) {
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
  toJSON(): { baseUrl: string; model?: string; keyPreview: string } {
    return {
      baseUrl: this.baseUrl,
      ...(this.model ? { model: this.model } : {}),
      keyPreview: this.keyPreview,
    };
  }

  /** @returns A secret-free string form. */
  toString(): string {
    return `SealedDecideConnection(${this.baseUrl}, key ${this.keyPreview})`;
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
    const parsed = storeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : EMPTY_STORE;
  } catch {
    return EMPTY_STORE;
  }
}

function isValidBaseUrl(baseUrl: string): boolean {
  return decisionProviderConfigSchema.safeParse({ baseUrl }).success && /^https?:/i.test(baseUrl);
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
  if (!baseUrl || !apiKey || !isValidBaseUrl(baseUrl)) return null;
  return new SealedDecideConnection(baseUrl, apiKey, store.model?.trim() || undefined);
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
    ...(store.baseUrl ? { baseUrl: store.baseUrl } : {}),
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
 * Store the base URL, API key and optional model (0600, locked, atomic).
 *
 * @param input - Settings to store; replaces any previous settings.
 * @returns Secret-free summary of what is now stored.
 * @throws {DecideCredentialsError} When the URL is not an absolute http(s) URL or the key is blank.
 */
export async function saveDecideCredentials(
  input: DecideCredentialsInput,
): Promise<DecideCredentialsSummary> {
  const baseUrl = input.baseUrl.trim();
  const apiKey = input.apiKey.trim();
  const model = input.model?.trim();
  if (!isValidBaseUrl(baseUrl)) {
    throw new DecideCredentialsError('base URL must be an absolute http(s) URL');
  }
  if (!apiKey) throw new DecideCredentialsError('API key must not be empty');
  if (/\s/.test(apiKey)) throw new DecideCredentialsError('API key must not contain whitespace');

  const path = decideCredentialsPath();
  ensureStoreFile(path);
  await withLock<DecideCredentialsStore>(
    path,
    () => ({
      version: 1,
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
  if (existsSync(path)) {
    ensureStoreFile(path);
    await withLock<DecideCredentialsStore>(path, () => EMPTY_STORE, { mode: 0o600 });
  }
  purgeBackups(path);
  return hadSettings;
}

/** Delete `<dir>/.backups/<name>.N` copies of the store. */
function purgeBackups(path: string): void {
  const backupDir = join(dirname(path), '.backups');
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
