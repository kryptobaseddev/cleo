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
 * ## Named profiles (T12733)
 *
 * The store holds any number of named profiles (e.g. `layahost` and `jev`,
 * each with its own key) and exactly one ACTIVE profile, which everyday
 * decisions use. The format stays additive on version 1:
 *
 * ```json
 * { "version": 1,
 *   "provider": "layahost", "baseUrl": "https://layahost.com", "apiKey": "…",
 *   "model": "laya-auto", "updatedAt": "…",
 *   "active": "layahost",
 *   "profiles": { "layahost": { "provider": "layahost", "baseUrl": "…", "apiKey": "…", "model": "…" },
 *                 "jev": { "provider": "jev", "baseUrl": "https://jev.example", "apiKey": "…", "model": "…" } } }
 * ```
 *
 * - The top-level single-config fields ARE the active profile, so a CLEO
 *   that predates profiles (9.23) reads the active profile as its one config.
 *   Every write keeps them equal to `profiles[active]`.
 * - A file without `profiles` (written before T12733) is one profile named
 *   after its provider kind, and that profile is active.
 * - An older CLEO that rewrites the file drops `profiles` and `active` (its
 *   zod object strips unknown keys and its save replaces the file). When the
 *   top-level settings then differ from `profiles[active]`, the TOP-LEVEL
 *   settings are authoritative for the active profile: they replace its
 *   entry, and {@link listDecideProfiles} reports `reconciled: true`.
 *   Profiles dropped by such a rewrite cannot be recovered and must be added
 *   again. Empty top-level settings beside a stored active profile mean the
 *   older CLEO cleared them: no profile is active.
 *
 * @task T12491
 * @task T12713
 * @task T12733
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
  DECIDE_PROFILE_NAME_PATTERN,
  type DecideProfileListResult,
  type DecideProfileSummary,
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

/** On-disk shape of one named profile (T12733). */
const profileSchema = z.object({
  provider: decisionProviderKindSchema,
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
});

/** One stored profile. */
type StoredProfile = z.infer<typeof profileSchema>;

/**
 * On-disk shape of the store. `null` settings mean "not configured". The
 * top-level settings are the active profile (T12733); `profiles` and `active`
 * are additive, and a malformed value for either is ignored rather than
 * failing the whole file.
 */
const storeSchema = z.object({
  version: z.literal(DECIDE_CREDENTIALS_VERSION),
  /** T12713, optional: absent in files written before provider kinds existed. */
  provider: decisionProviderKindSchema.nullable().optional(),
  baseUrl: z.string().nullable(),
  apiKey: z.string().nullable(),
  model: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
  /** T12733, optional: every named profile, keyed by name. Entries are validated one by one. */
  profiles: z.record(z.string(), z.json()).optional().catch(undefined),
  /** T12733, optional: the name of the active profile. */
  active: z.string().nullable().optional().catch(undefined),
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

/**
 * Whether `name` is a valid profile name: 1-32 characters of `a-z`, `0-9`
 * and `-`, starting and ending with a letter or digit.
 *
 * @param name - Candidate name.
 * @returns True when the name may be stored.
 */
export function isValidDecideProfileName(name: string): boolean {
  return DECIDE_PROFILE_NAME_PATTERN.test(name);
}

/** The store as named profiles: what every read and write works on. */
interface ProfileStore {
  /** Valid profiles, keyed by name. */
  readonly profiles: Record<string, StoredProfile>;
  /** The active profile's name, or `null`. Always a key of `profiles` when set. */
  readonly active: string | null;
  /** True when the top-level settings overrode a differing `profiles[active]`. */
  readonly reconciled: boolean;
}

/** The top-level settings as a profile, or `null` when no URL + key is stored. */
function topLevelProfile(store: DecideCredentialsStore): StoredProfile | null {
  const baseUrl = store.baseUrl?.trim();
  const apiKey = store.apiKey?.trim();
  if (!baseUrl || !apiKey) return null;
  const model = store.model?.trim();
  return {
    provider: store.provider ?? inferDecisionProviderKind(baseUrl),
    baseUrl,
    apiKey,
    model: model || null,
    ...(store.updatedAt ? { updatedAt: store.updatedAt } : {}),
  };
}

/** Whether two profiles hold the same settings (timestamps ignored). */
function sameSettings(a: StoredProfile, b: StoredProfile): boolean {
  return (
    a.provider === b.provider &&
    a.baseUrl.trim() === b.baseUrl.trim() &&
    a.apiKey.trim() === b.apiKey.trim() &&
    (a.model?.trim() || null) === (b.model?.trim() || null)
  );
}

/**
 * View the parsed store as named profiles. The top-level settings are
 * authoritative for the active profile (see the module doc).
 */
function toProfileStore(store: DecideCredentialsStore): ProfileStore {
  const profiles: Record<string, StoredProfile> = {};
  for (const [name, value] of Object.entries(store.profiles ?? {})) {
    if (!isValidDecideProfileName(name)) continue;
    const parsed = profileSchema.safeParse(value);
    if (parsed.success) profiles[name] = parsed.data;
  }
  const named = store.active && isValidDecideProfileName(store.active) ? store.active : null;
  const top = topLevelProfile(store);
  if (!top) {
    // An older CLEO cleared the settings (or nothing was ever configured).
    return { profiles, active: null, reconciled: named !== null && named in profiles };
  }
  const name = named ?? top.provider;
  const existing = profiles[name];
  profiles[name] = existing && sameSettings(existing, top) ? existing : top;
  return {
    profiles,
    active: name,
    reconciled: existing !== undefined && !sameSettings(existing, top),
  };
}

/** The shape this module writes: the parsed shape with typed profiles. */
interface WrittenStore {
  readonly version: typeof DECIDE_CREDENTIALS_VERSION;
  readonly provider?: DecisionProviderKind;
  readonly baseUrl: string | null;
  readonly apiKey: string | null;
  readonly model?: string | null;
  readonly updatedAt?: string;
  readonly active?: string;
  readonly profiles?: Readonly<Record<string, StoredProfile>>;
}

/** The empty store as written. */
const EMPTY_WRITTEN: WrittenStore = {
  version: DECIDE_CREDENTIALS_VERSION,
  baseUrl: null,
  apiKey: null,
};

/** Render named profiles back to the on-disk shape (top-level = active profile). */
function fromProfileStore(ps: ProfileStore): WrittenStore {
  const names = Object.keys(ps.profiles).sort();
  if (names.length === 0) return EMPTY_WRITTEN;
  const active = ps.active ? ps.profiles[ps.active] : undefined;
  return {
    version: DECIDE_CREDENTIALS_VERSION,
    ...(active ? { provider: active.provider } : {}),
    baseUrl: active?.baseUrl ?? null,
    apiKey: active?.apiKey ?? null,
    model: active?.model ?? null,
    updatedAt: new Date().toISOString(),
    ...(active && ps.active ? { active: ps.active } : {}),
    profiles: Object.fromEntries(
      names.flatMap((n) => {
        const profile = ps.profiles[n];
        return profile ? [[n, profile] as const] : [];
      }),
    ),
  };
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
  /**
   * Profile to add or update (T12733). Omitted → the provider kind's name
   * (`layahost` or `jev`). Other profiles are kept.
   */
  readonly profile?: string;
  /**
   * Make the profile the active one. Omitted → true when no profile is active
   * yet (the first profile) or the profile is already active; else false.
   */
  readonly activate?: boolean;
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
  /** Name of the profile described (T12733), when one is stored. */
  readonly profile?: string;
  /** Name of the active profile (T12733), when one is active. */
  readonly activeProfile?: string;
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

/** Seal a stored profile, or `null` when its URL or key is unusable. */
function sealProfile(profile: StoredProfile | undefined): SealedDecideConnection | null {
  if (!profile) return null;
  const baseUrl = profile.baseUrl.trim();
  const apiKey = profile.apiKey.trim();
  if (!baseUrl || !apiKey || !isAllowedDecideBaseUrl(baseUrl)) return null;
  const model = profile.model?.trim();
  return new SealedDecideConnection(
    baseUrl,
    apiKey,
    model && isValidDecisionModelName(model) ? model : undefined,
    profile.provider,
  );
}

/** Read the store as named profiles. Never throws. */
function readProfileStoreSync(path: string = decideCredentialsPath()): ProfileStore {
  return toProfileStore(readStoreSync(path));
}

/** Human rule for profile names, used in error messages. */
const PROFILE_NAME_RULE =
  '(use 1-32 lowercase letters, digits or -, starting and ending with a letter or digit)';

/** ` (profiles: a, b)`, or ` (no profiles are stored)`. */
function knownNames(ps: ProfileStore): string {
  const names = Object.keys(ps.profiles).sort();
  return names.length ? ` (profiles: ${names.join(', ')})` : ' (no profiles are stored)';
}

/**
 * Load the ACTIVE profile's connection: what everyday decisions use. Reads
 * the top-level settings, which are the active profile. Synchronous and
 * total: missing, malformed or incomplete settings return `null` (the
 * decision client then falls back to heuristics).
 *
 * @returns The sealed connection, or `null` when unconfigured.
 */
export function loadDecideConnection(): SealedDecideConnection | null {
  const top = topLevelProfile(readStoreSync());
  return top ? sealProfile(top) : null;
}

/**
 * Load a named profile's connection without changing the active profile.
 * Total: an unknown name or unusable settings return `null`.
 *
 * @param name - Profile name.
 * @returns The sealed connection, or `null`.
 */
export function loadDecideProfile(name: string): SealedDecideConnection | null {
  if (!isValidDecideProfileName(name)) return null;
  return sealProfile(readProfileStoreSync().profiles[name]);
}

/**
 * Resolve a named profile to its connection, for callers (the System One
 * benchmark) that address a profile by name without switching the active
 * one. The key stays sealed; call {@link SealedDecideConnection.connection}
 * where the request is built.
 *
 * @param name - Profile name, e.g. `layahost` or `jev`.
 * @returns The sealed connection.
 * @throws {DecideCredentialsError} When the name is invalid, unknown, or its
 *   settings are unusable. The message lists the stored profile names.
 */
export function resolveDecideProfile(name: string): SealedDecideConnection {
  assertProfileName(name);
  const ps = readProfileStoreSync();
  const profile = ps.profiles[name];
  if (!profile) {
    throw new DecideCredentialsError(`no System One profile named '${name}'${knownNames(ps)}`);
  }
  const sealed = sealProfile(profile);
  if (!sealed) {
    throw new DecideCredentialsError(
      `System One profile '${name}' has an unusable URL or key; store it again with: cleo decide config --profile ${name}`,
    );
  }
  return sealed;
}

/** Secret-free summary of one stored profile. */
function summarizeProfile(
  name: string,
  profile: StoredProfile,
  active: string | null,
): DecideProfileSummary {
  const model = profile.model?.trim();
  return {
    name,
    active: name === active,
    configured: sealProfile(profile) !== null,
    provider: profile.provider,
    baseUrl: withoutUserinfo(profile.baseUrl),
    ...(model ? { model } : {}),
    keyPreview: maskApiKey(profile.apiKey),
    ...(profile.updatedAt ? { updatedAt: profile.updatedAt } : {}),
  };
}

/**
 * List every stored profile, the active one marked, keys masked. The
 * benchmark uses it to enumerate the profiles it can call by name.
 *
 * @returns The profiles sorted by name, the active name, and whether the
 *   top-level settings overrode a stale active entry (an older CLEO rewrote the file).
 */
export function listDecideProfiles(): DecideProfileListResult {
  const path = decideCredentialsPath();
  const ps = readProfileStoreSync(path);
  return {
    path,
    active: ps.active,
    profiles: Object.keys(ps.profiles)
      .sort()
      .flatMap((name) => {
        const profile = ps.profiles[name];
        return profile ? [summarizeProfile(name, profile, ps.active)] : [];
      }),
    reconciled: ps.reconciled,
  };
}

/**
 * Describe the ACTIVE profile's settings without the key.
 *
 * @returns A secret-free summary.
 */
export function describeDecideCredentials(): DecideCredentialsSummary {
  const path = decideCredentialsPath();
  const store = readStoreSync(path);
  const sealed = loadDecideConnection();
  const active = toProfileStore(store).active;
  return {
    configured: sealed !== null,
    path,
    ...(store.provider ? { provider: store.provider } : {}),
    ...(store.baseUrl ? { baseUrl: withoutUserinfo(store.baseUrl) } : {}),
    ...(store.model ? { model: store.model } : {}),
    ...(store.apiKey ? { keyPreview: maskApiKey(store.apiKey) } : {}),
    ...(store.updatedAt ? { updatedAt: store.updatedAt } : {}),
    ...(active ? { profile: active, activeProfile: active } : {}),
  };
}

/**
 * Describe one named profile's settings without the key.
 *
 * @param name - Profile name.
 * @returns A secret-free summary; `configured: false` when the profile is unknown.
 */
export function describeDecideProfile(name: string): DecideCredentialsSummary {
  const path = decideCredentialsPath();
  const ps = readProfileStoreSync(path);
  const profile = isValidDecideProfileName(name) ? ps.profiles[name] : undefined;
  const activeProfile = ps.active ? { activeProfile: ps.active } : {};
  if (!profile) return { configured: false, path, ...activeProfile };
  const summary = summarizeProfile(name, profile, ps.active);
  return {
    configured: summary.configured,
    path,
    provider: summary.provider,
    baseUrl: summary.baseUrl,
    ...(summary.model ? { model: summary.model } : {}),
    keyPreview: summary.keyPreview,
    ...(summary.updatedAt ? { updatedAt: summary.updatedAt } : {}),
    profile: name,
    ...activeProfile,
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
 * Validate a profile name.
 *
 * @throws {DecideCredentialsError} When the name is invalid.
 */
function assertProfileName(name: string): void {
  if (!isValidDecideProfileName(name)) {
    throw new DecideCredentialsError(`invalid profile name '${name}' ${PROFILE_NAME_RULE}`);
  }
}

/**
 * Apply `change` to the named profiles under the store lock and write the
 * result (0600, atomic), keeping the top-level settings equal to the active
 * profile. `change` may throw a {@link DecideCredentialsError} to abort
 * without writing.
 */
async function mutateProfiles(change: (ps: ProfileStore) => ProfileStore): Promise<void> {
  const path = decideCredentialsPath();
  guardWrite(path);
  ensureStoreFile(path);
  await withLock<WrittenStore>(
    path,
    (current) => fromProfileStore(change(toProfileStore(parseStore(current) ?? EMPTY_STORE))),
    { mode: 0o600 },
  );
}

/**
 * Store a profile: provider kind, base URL, API key and optional model (0600,
 * locked, atomic). Adds the profile or replaces that profile's settings;
 * every other profile is kept. Writes schema version 1 with the active
 * profile mirrored at the top level.
 *
 * @param input - Settings to store, the profile name and whether to activate it.
 * @returns Secret-free summary of the profile now stored.
 * @throws {DecideCredentialsError} When the URL is not https (or loopback http), the key is
 *   blank, the model or profile name is invalid, or the store or its backups are symlinks.
 */
export async function saveDecideCredentials(
  input: DecideCredentialsInput,
): Promise<DecideCredentialsSummary> {
  const baseUrl = input.baseUrl.trim();
  const apiKey = input.apiKey.trim();
  const model = input.model?.trim();
  const provider = input.provider ?? 'jev';
  const name = input.profile?.trim() || provider;
  assertProfileName(name);
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

  await mutateProfiles((ps) => {
    const activate = input.activate ?? (ps.active === null || ps.active === name);
    const profile: StoredProfile = {
      provider,
      baseUrl,
      apiKey,
      model: model || null,
      updatedAt: new Date().toISOString(),
    };
    return {
      profiles: { ...ps.profiles, [name]: profile },
      active: activate ? name : ps.active,
      reconciled: false,
    };
  });
  return describeDecideProfile(name);
}

/**
 * Make `name` the active profile: everyday decisions use it from now on.
 *
 * @param name - An existing profile.
 * @returns The profile list after the switch.
 * @throws {DecideCredentialsError} When the name is invalid or unknown.
 */
export async function useDecideProfile(name: string): Promise<DecideProfileListResult> {
  assertProfileName(name);
  await mutateProfiles((ps) => {
    if (!ps.profiles[name]) {
      throw new DecideCredentialsError(`no System One profile named '${name}'${knownNames(ps)}`);
    }
    return { ...ps, active: name, reconciled: false };
  });
  return listDecideProfiles();
}

/**
 * Remove a profile, then delete every rotated backup of the store (a backup
 * may hold the removed key). The active profile is removed only when `use`
 * names another profile to activate in its place.
 *
 * @param name - Profile to remove.
 * @param use - Profile to activate instead; required when `name` is active.
 * @returns The profile list after the removal.
 * @throws {DecideCredentialsError} When a name is invalid or unknown, or
 *   `name` is active and `use` is missing or names it.
 */
export async function removeDecideProfile(
  name: string,
  use?: string,
): Promise<DecideProfileListResult> {
  assertProfileName(name);
  if (use !== undefined) assertProfileName(use);
  await mutateProfiles((ps) => {
    if (!ps.profiles[name]) {
      throw new DecideCredentialsError(`no System One profile named '${name}'${knownNames(ps)}`);
    }
    let active = ps.active;
    if (use !== undefined) {
      if (use === name || !ps.profiles[use]) {
        throw new DecideCredentialsError(`--use must name another stored profile${knownNames(ps)}`);
      }
      active = use;
    }
    if (active === name) {
      throw new DecideCredentialsError(
        `'${name}' is the active profile: name the profile to activate instead with --use <profile>, or remove every profile with --clear`,
      );
    }
    const profiles = Object.fromEntries(
      Object.entries(ps.profiles).filter(([profileName]) => profileName !== name),
    );
    return { profiles, active, reconciled: false };
  });
  purgeBackups(decideCredentialsPath());
  return listDecideProfiles();
}

/**
 * Remove every profile: the store is overwritten with empty settings and
 * every rotated backup of it (which may hold an old key) is deleted.
 *
 * @returns True when settings were present before the call.
 */
export async function clearDecideCredentials(): Promise<boolean> {
  const path = decideCredentialsPath();
  const before = readStoreSync(path);
  const hadSettings = Boolean(
    before.baseUrl || before.apiKey || before.model || Object.keys(before.profiles ?? {}).length,
  );
  guardWrite(path);
  if (existsSync(path)) {
    ensureStoreFile(path);
    await withLock<WrittenStore>(path, () => EMPTY_WRITTEN, { mode: 0o600 });
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
