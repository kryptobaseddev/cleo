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
 * ## Profiles (T12733)
 *
 * The store holds any number of profiles, several per provider (accounts,
 * each with its own key), addressed as `<provider>/<name>` (e.g.
 * `layahost/work`, `layahost/personal`, `jev/team`), and exactly one ACTIVE
 * profile, which everyday decisions use. The format stays additive on
 * version 1:
 *
 * ```json
 * { "version": 1,
 *   "provider": "layahost", "baseUrl": "https://layahost.com", "apiKey": "…",
 *   "model": "laya-auto", "updatedAt": "…",
 *   "active": "layahost/work",
 *   "profiles": {
 *     "layahost/work": { "provider": "layahost", "name": "work", "baseUrl": "default", "apiKey": "…", "model": "laya-auto" },
 *     "jev/team": { "provider": "jev", "name": "team", "baseUrl": "https://jev.internal", "apiKey": "…", "model": "…" } } }
 * ```
 *
 * - A profile's `baseUrl` is the literal `default` (its provider's preset
 *   URL, resolved at call time, so a changed preset flows through) or an
 *   override URL.
 * - The top-level single-config fields ARE the active profile with its URL
 *   resolved, so a CLEO that predates profiles (9.23) reads the active profile
 *   as its one config. Every write keeps them in sync.
 * - A file without `profiles` (written before T12733) is one active profile,
 *   `<provider>/default`.
 * - An older CLEO that rewrites the file drops `profiles` and `active` (its
 *   zod object strips unknown keys and its save replaces the file). When the
 *   top-level settings then differ from the active profile, the TOP-LEVEL
 *   settings are authoritative: they replace the active profile (or, when the
 *   provider changed, become `<new provider>/<active name>`), and
 *   {@link listDecideProfiles} reports `reconciled: true`. Profiles dropped
 *   by such a rewrite cannot be recovered and must be added again. Empty
 *   top-level settings beside a stored active profile mean the older CLEO
 *   cleared them: no profile is active.
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
  DECIDE_DEFAULT_PROFILE_NAME,
  DECIDE_PROFILE_DEFAULT_URL,
  DECIDE_PROFILE_NAME_PATTERN,
  DECISION_PROVIDER_KINDS,
  type DecideProfileListResult,
  type DecideProfileSummary,
  type DecideProfileUrlSource,
  type DecisionProviderKind,
  decisionProviderConfigSchema,
  decisionProviderKindSchema,
} from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';
import { z } from 'zod';
import { withLock } from '../store/file-utils.js';
import { isValidDecisionModelName } from './jev-wire.js';
import type { DecisionProviderConnection } from './provider.js';
import { inferDecisionProviderKind, presetBaseUrl } from './providers.js';

/** File name of the store, directly under the CLEO home. */
export const DECIDE_CREDENTIALS_FILE = 'decide-credentials.json';

/**
 * On-disk schema version. Deliberately still 1: `provider` is an additive
 * optional field, and released CLEO parses `z.literal(1)` — bumping this would
 * silently disable System One after a downgrade.
 */
export const DECIDE_CREDENTIALS_VERSION = 1;

/** On-disk shape of one profile (T12733). `baseUrl` is `default` or an override URL. */
const profileSchema = z.object({
  provider: decisionProviderKindSchema,
  name: z.string(),
  baseUrl: z.string(),
  apiKey: z.string(),
  model: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
});

/** One stored profile. */
type StoredProfile = z.infer<typeof profileSchema>;

/**
 * On-disk shape of the store. `null` settings mean "not configured". The
 * top-level settings are the active profile with its URL resolved (T12733);
 * `profiles` and `active` are additive, and a malformed value for either is
 * ignored rather than failing the whole file.
 */
const storeSchema = z.object({
  version: z.literal(DECIDE_CREDENTIALS_VERSION),
  /** T12713, optional: absent in files written before provider kinds existed. */
  provider: decisionProviderKindSchema.nullable().optional(),
  baseUrl: z.string().nullable(),
  apiKey: z.string().nullable(),
  model: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
  /** T12733, optional: every profile, keyed by `<provider>/<name>`. Entries are validated one by one. */
  profiles: z.record(z.string(), z.json()).optional().catch(undefined),
  /** T12733, optional: the id of the active profile. */
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
 * @param name - Candidate name (the part after `<provider>/`).
 * @returns True when the name may be stored.
 */
export function isValidDecideProfileName(name: string): boolean {
  return DECIDE_PROFILE_NAME_PATTERN.test(name);
}

/** A parsed profile reference. */
export interface DecideProfileRef {
  /** Provider kind. */
  readonly provider: DecisionProviderKind;
  /** Profile name within the provider. */
  readonly name: string;
  /** `<provider>/<name>`. */
  readonly id: string;
}

/**
 * Build a profile id.
 *
 * @param provider - Provider kind.
 * @param name - Profile name.
 * @returns `<provider>/<name>`.
 */
export function decideProfileId(provider: DecisionProviderKind, name: string): string {
  return `${provider}/${name}`;
}

/**
 * Parse a profile reference: `<provider>/<name>` (e.g. `layahost/work`), or a
 * bare provider kind meaning `<provider>/default`.
 *
 * @param ref - Reference as typed by the user.
 * @returns The parsed reference, or `null` when it names no valid profile.
 */
export function parseDecideProfileRef(ref: string): DecideProfileRef | null {
  const parts = ref.trim().split('/');
  const provider = DECISION_PROVIDER_KINDS.find((kind) => kind === parts[0]);
  if (!provider || parts.length > 2) return null;
  const name = parts.length === 2 ? (parts[1] ?? '') : DECIDE_DEFAULT_PROFILE_NAME;
  if (!isValidDecideProfileName(name)) return null;
  return { provider, name, id: decideProfileId(provider, name) };
}

/** A profile's URL resolved: its override, or its provider's preset for `default`. */
function resolveProfileUrl(profile: StoredProfile): string | undefined {
  return profile.baseUrl === DECIDE_PROFILE_DEFAULT_URL
    ? presetBaseUrl(profile.provider)
    : profile.baseUrl;
}

/** Strip trailing slashes for URL comparison. */
function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** The stored form of a URL: `default` when it is the provider's preset URL, else the URL. */
function urlSetting(provider: DecisionProviderKind, url: string): string {
  const preset = presetBaseUrl(provider);
  return preset && normalizeUrl(url) === normalizeUrl(preset) ? DECIDE_PROFILE_DEFAULT_URL : url;
}

/** The store as profiles: what every read and write works on. */
interface ProfileStore {
  /** Valid profiles, keyed by id. */
  readonly profiles: Readonly<Record<string, StoredProfile>>;
  /** The active profile's id, or `null`. Always a key of `profiles` when set. */
  readonly active: string | null;
  /** True when the top-level settings overrode a differing active profile. */
  readonly reconciled: boolean;
}

/** The top-level single config: the active profile with its URL resolved. */
interface TopLevelSettings {
  readonly provider: DecisionProviderKind;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string | null;
  readonly updatedAt?: string;
}

/** The top-level settings, or `null` when no URL + key is stored. */
function topLevelSettings(store: DecideCredentialsStore): TopLevelSettings | null {
  const baseUrl = store.baseUrl?.trim();
  const apiKey = store.apiKey?.trim();
  if (!baseUrl || !apiKey) return null;
  return {
    provider: store.provider ?? inferDecisionProviderKind(baseUrl),
    baseUrl,
    apiKey,
    model: store.model?.trim() || null,
    ...(store.updatedAt ? { updatedAt: store.updatedAt } : {}),
  };
}

/** Whether a profile holds the same settings as the top level (timestamps ignored). */
function matchesTopLevel(profile: StoredProfile, top: TopLevelSettings): boolean {
  const url = resolveProfileUrl(profile);
  return (
    profile.provider === top.provider &&
    url !== undefined &&
    normalizeUrl(url) === normalizeUrl(top.baseUrl) &&
    profile.apiKey.trim() === top.apiKey &&
    (profile.model?.trim() || null) === top.model
  );
}

/** Keep only well-formed profiles whose key matches their provider and name. */
function validProfiles(raw: DecideCredentialsStore['profiles']): Record<string, StoredProfile> {
  const profiles: Record<string, StoredProfile> = {};
  for (const [id, value] of Object.entries(raw ?? {})) {
    const parsed = profileSchema.safeParse(value);
    if (!parsed.success) continue;
    const ref = parseDecideProfileRef(id);
    if (ref?.id !== id || ref.provider !== parsed.data.provider || ref.name !== parsed.data.name) {
      continue;
    }
    profiles[id] = parsed.data;
  }
  return profiles;
}

/**
 * View the parsed store as profiles. The top-level settings are
 * authoritative for the active profile (see the module doc): when they
 * differ from it, they replace it (same provider) or become
 * `<their provider>/<active name>` (an older CLEO switched provider).
 */
function toProfileStore(store: DecideCredentialsStore): ProfileStore {
  const profiles = validProfiles(store.profiles);
  const hadProfiles = Object.keys(profiles).length > 0;
  const activeRef = store.active ? parseDecideProfileRef(store.active) : null;
  const top = topLevelSettings(store);
  if (!top) {
    // An older CLEO cleared the settings (or nothing was ever configured).
    return { profiles, active: null, reconciled: activeRef !== null && activeRef.id in profiles };
  }
  const name = activeRef?.name ?? DECIDE_DEFAULT_PROFILE_NAME;
  const id =
    activeRef?.provider === top.provider ? activeRef.id : decideProfileId(top.provider, name);
  const existing = profiles[id];
  const inSync = existing !== undefined && matchesTopLevel(existing, top);
  if (!inSync) {
    profiles[id] = {
      provider: top.provider,
      name: id.slice(top.provider.length + 1),
      baseUrl: urlSetting(top.provider, top.baseUrl),
      apiKey: top.apiKey,
      model: top.model,
      ...(top.updatedAt ? { updatedAt: top.updatedAt } : {}),
    };
  }
  const reconciled = (activeRef !== null || hadProfiles) && !(inSync && id === activeRef?.id);
  return { profiles, active: id, reconciled };
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

/** Render profiles back to the on-disk shape (top-level = active profile, URL resolved). */
function fromProfileStore(ps: ProfileStore): WrittenStore {
  const ids = Object.keys(ps.profiles).sort();
  if (ids.length === 0) return EMPTY_WRITTEN;
  const active = ps.active ? ps.profiles[ps.active] : undefined;
  const activeUrl = active ? resolveProfileUrl(active) : undefined;
  return {
    version: DECIDE_CREDENTIALS_VERSION,
    ...(active && activeUrl ? { provider: active.provider } : {}),
    baseUrl: active && activeUrl ? activeUrl : null,
    apiKey: active && activeUrl ? active.apiKey : null,
    model: (active && activeUrl ? active.model : null) ?? null,
    updatedAt: new Date().toISOString(),
    ...(ps.active && activeUrl ? { active: ps.active } : {}),
    profiles: Object.fromEntries(
      ids.flatMap((id) => {
        const profile = ps.profiles[id];
        return profile ? [[id, profile] as const] : [];
      }),
    ),
  };
}

/** Settings accepted by {@link saveDecideCredentials}. */
export interface DecideCredentialsInput {
  /**
   * Provider kind. Omitted → the provider of a `<provider>/<name>` profile,
   * else inferred from the URL (the layahost origin → `layahost`, any other →
   * `jev`), else `layahost` for a `default` URL.
   */
  readonly provider?: DecisionProviderKind;
  /**
   * `default` (the provider's preset URL, resolved at call time) or an
   * absolute override URL, e.g. `https://provider.example`. A URL equal to
   * the preset is stored as `default`.
   */
  readonly baseUrl: string;
  /** API key. Leading/trailing whitespace (e.g. a piped newline) is trimmed. */
  readonly apiKey: string;
  /** Optional default model; omitted → the request carries no model. */
  readonly model?: string;
  /**
   * Profile to add or update (T12733): `<provider>/<name>` or a bare name.
   * Omitted → `<provider>/default`. Other profiles are kept.
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
  /** Id (`<provider>/<name>`) of the profile described (T12733), when one is stored. */
  readonly profile?: string;
  /** Whether the profile's URL is its provider's preset or an override (T12733). */
  readonly urlSource?: DecideProfileUrlSource;
  /** Id of the active profile (T12733), when one is active. */
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

/** Seal settings, or `null` when the URL or key is unusable. */
function sealSettings(
  provider: DecisionProviderKind,
  baseUrl: string | undefined,
  apiKey: string,
  model: string | null | undefined,
): SealedDecideConnection | null {
  const url = baseUrl?.trim();
  const key = apiKey.trim();
  if (!url || !key || !isAllowedDecideBaseUrl(url)) return null;
  const m = model?.trim();
  return new SealedDecideConnection(
    url,
    key,
    m && isValidDecisionModelName(m) ? m : undefined,
    provider,
  );
}

/** Seal a stored profile (URL resolved), or `null` when unusable. */
function sealProfile(profile: StoredProfile | undefined): SealedDecideConnection | null {
  if (!profile) return null;
  return sealSettings(profile.provider, resolveProfileUrl(profile), profile.apiKey, profile.model);
}

/** Read the store as profiles. Never throws. */
function readProfileStoreSync(path: string = decideCredentialsPath()): ProfileStore {
  return toProfileStore(readStoreSync(path));
}

/** Human rule for profile references, used in error messages. */
const PROFILE_REF_RULE = `(use <provider>/<name>: provider ${DECISION_PROVIDER_KINDS.join('|')}, name of 1-32 lowercase letters, digits or -, e.g. layahost/work)`;

/** ` (profiles: a, b)`, or ` (no profiles are stored)`. */
function knownIds(ps: ProfileStore): string {
  const ids = Object.keys(ps.profiles).sort();
  return ids.length ? ` (profiles: ${ids.join(', ')})` : ' (no profiles are stored)';
}

/**
 * Parse a profile reference or throw.
 *
 * @throws {DecideCredentialsError} When the reference names no valid profile.
 */
function requireProfileRef(ref: string): DecideProfileRef {
  const parsed = parseDecideProfileRef(ref);
  if (!parsed) throw new DecideCredentialsError(`invalid profile '${ref}' ${PROFILE_REF_RULE}`);
  return parsed;
}

/**
 * Load the ACTIVE profile's connection: what everyday decisions use. Reads
 * the top-level settings, which are the active profile with its URL
 * resolved. Synchronous and total: missing, malformed or incomplete
 * settings return `null` (the decision client then falls back to heuristics).
 *
 * @returns The sealed connection, or `null` when unconfigured.
 */
export function loadDecideConnection(): SealedDecideConnection | null {
  const top = topLevelSettings(readStoreSync());
  return top ? sealSettings(top.provider, top.baseUrl, top.apiKey, top.model) : null;
}

/**
 * Load a profile's connection without changing the active profile. Total:
 * an invalid or unknown reference, or unusable settings, return `null`.
 *
 * @param ref - `<provider>/<name>`, or a bare provider for `<provider>/default`.
 * @returns The sealed connection, or `null`.
 */
export function loadDecideProfile(ref: string): SealedDecideConnection | null {
  const parsed = parseDecideProfileRef(ref);
  return parsed ? sealProfile(readProfileStoreSync().profiles[parsed.id]) : null;
}

/**
 * Resolve a profile to its connection, for callers (the System One
 * benchmark) that address a profile by name without switching the active
 * one. A `default` URL resolves to the provider's current preset. The key
 * stays sealed; call {@link SealedDecideConnection.connection} where the
 * request is built.
 *
 * @param ref - `<provider>/<name>` (e.g. `layahost/work`), or a bare provider for `<provider>/default`.
 * @returns The sealed connection.
 * @throws {DecideCredentialsError} When the reference is invalid or unknown,
 *   or the profile's settings are unusable. The message lists the stored ids.
 */
export function resolveDecideProfile(ref: string): SealedDecideConnection {
  const { id } = requireProfileRef(ref);
  const ps = readProfileStoreSync();
  const profile = ps.profiles[id];
  if (!profile) {
    throw new DecideCredentialsError(`no System One profile '${id}'${knownIds(ps)}`);
  }
  const sealed = sealProfile(profile);
  if (!sealed) {
    throw new DecideCredentialsError(
      `System One profile '${id}' has an unusable URL or key; store it again with: cleo decide config --profile ${id}`,
    );
  }
  return sealed;
}

/** Secret-free summary of one stored profile. */
function summarizeProfile(
  id: string,
  profile: StoredProfile,
  active: string | null,
): DecideProfileSummary {
  const model = profile.model?.trim();
  return {
    id,
    name: profile.name,
    active: id === active,
    configured: sealProfile(profile) !== null,
    provider: profile.provider,
    baseUrl: withoutUserinfo(resolveProfileUrl(profile) ?? ''),
    urlSource: profile.baseUrl === DECIDE_PROFILE_DEFAULT_URL ? 'default' : 'override',
    ...(model ? { model } : {}),
    keyPreview: maskApiKey(profile.apiKey),
    ...(profile.updatedAt ? { updatedAt: profile.updatedAt } : {}),
  };
}

/**
 * List every stored profile, the active one marked, keys masked. The
 * benchmark uses it to enumerate the profiles it can call by id.
 *
 * @returns The profiles sorted by id, the active id, and whether the
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
      .flatMap((id) => {
        const profile = ps.profiles[id];
        return profile ? [summarizeProfile(id, profile, ps.active)] : [];
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
 * Describe one profile's settings without the key.
 *
 * @param ref - `<provider>/<name>`, or a bare provider for `<provider>/default`.
 * @returns A secret-free summary; `configured: false` when the profile is unknown.
 */
export function describeDecideProfile(ref: string): DecideCredentialsSummary {
  const path = decideCredentialsPath();
  const ps = readProfileStoreSync(path);
  const parsed = parseDecideProfileRef(ref);
  const profile = parsed ? ps.profiles[parsed.id] : undefined;
  const activeProfile = ps.active ? { activeProfile: ps.active } : {};
  if (!parsed || !profile) return { configured: false, path, ...activeProfile };
  const summary = summarizeProfile(parsed.id, profile, ps.active);
  return {
    configured: summary.configured,
    path,
    provider: summary.provider,
    baseUrl: summary.baseUrl,
    ...(summary.model ? { model: summary.model } : {}),
    keyPreview: summary.keyPreview,
    ...(summary.updatedAt ? { updatedAt: summary.updatedAt } : {}),
    profile: parsed.id,
    urlSource: summary.urlSource,
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
 * Apply `change` to the profiles under the store lock and write the result
 * (0600, atomic), keeping the top-level settings equal to the active
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
 * The profile a save targets: `input.profile` as `<provider>/<name>` or a
 * bare name, with the provider from `input.provider`, the reference, or the
 * URL.
 */
function saveTarget(input: DecideCredentialsInput, baseUrl: string): DecideProfileRef {
  const raw = input.profile?.trim();
  if (raw?.includes('/')) {
    const ref = requireProfileRef(raw);
    if (input.provider && input.provider !== ref.provider) {
      throw new DecideCredentialsError(
        `profile '${ref.id}' belongs to ${ref.provider}, not ${input.provider}`,
      );
    }
    return ref;
  }
  const provider =
    input.provider ??
    (baseUrl === DECIDE_PROFILE_DEFAULT_URL ? 'layahost' : inferDecisionProviderKind(baseUrl));
  const name = raw || DECIDE_DEFAULT_PROFILE_NAME;
  if (!isValidDecideProfileName(name)) {
    throw new DecideCredentialsError(`invalid profile name '${name}' ${PROFILE_REF_RULE}`);
  }
  return { provider, name, id: decideProfileId(provider, name) };
}

/**
 * Store a profile: provider kind, base URL (`default` or an override), API
 * key and optional model (0600, locked, atomic). Adds the profile or
 * replaces that profile's settings; every other profile is kept. A URL equal
 * to the provider's preset is stored as `default`, so a changed preset flows
 * through. Writes schema version 1 with the active profile mirrored at the
 * top level, URL resolved.
 *
 * @param input - Settings to store, the profile and whether to activate it.
 * @returns Secret-free summary of the profile now stored.
 * @throws {DecideCredentialsError} When the URL is not https (or loopback http), `default`
 *   names a provider without a preset URL, the key is blank, the model or profile is
 *   invalid, or the store or its backups are symlinks.
 */
export async function saveDecideCredentials(
  input: DecideCredentialsInput,
): Promise<DecideCredentialsSummary> {
  const rawUrl = input.baseUrl.trim();
  const apiKey = input.apiKey.trim();
  const model = input.model?.trim();
  const target = saveTarget(input, rawUrl);
  let baseUrl = DECIDE_PROFILE_DEFAULT_URL;
  if (rawUrl === DECIDE_PROFILE_DEFAULT_URL) {
    if (!presetBaseUrl(target.provider)) {
      throw new DecideCredentialsError(
        `the ${target.provider} provider has no default URL; pass --url https://your-provider.example`,
      );
    }
  } else {
    if (hasUserinfo(rawUrl)) {
      throw new DecideCredentialsError(
        'base URL must not contain a username or password (user:pass@host); supply only the URL and the API key',
      );
    }
    if (!isAllowedDecideBaseUrl(rawUrl)) {
      throw new DecideCredentialsError(
        'base URL must be an absolute https:// URL (plain http:// is allowed only for localhost, 127.0.0.1 and ::1)',
      );
    }
    baseUrl = urlSetting(target.provider, rawUrl);
  }
  if (model && !isValidDecisionModelName(model)) {
    throw new DecideCredentialsError(
      'model name may contain only letters, digits and . _ : / @ - (1-128 characters)',
    );
  }
  if (!apiKey) throw new DecideCredentialsError('API key must not be empty');
  if (/\s/.test(apiKey)) throw new DecideCredentialsError('API key must not contain whitespace');

  await mutateProfiles((ps) => {
    const activate = input.activate ?? (ps.active === null || ps.active === target.id);
    const profile: StoredProfile = {
      provider: target.provider,
      name: target.name,
      baseUrl,
      apiKey,
      model: model || null,
      updatedAt: new Date().toISOString(),
    };
    return {
      profiles: { ...ps.profiles, [target.id]: profile },
      active: activate ? target.id : ps.active,
      reconciled: false,
    };
  });
  return describeDecideProfile(target.id);
}

/**
 * Make a profile the active one: everyday decisions use it from now on.
 *
 * @param ref - `<provider>/<name>`, or a bare provider for `<provider>/default`.
 * @returns The profile list after the switch.
 * @throws {DecideCredentialsError} When the reference is invalid or unknown.
 */
export async function useDecideProfile(ref: string): Promise<DecideProfileListResult> {
  const { id } = requireProfileRef(ref);
  await mutateProfiles((ps) => {
    if (!ps.profiles[id]) {
      throw new DecideCredentialsError(`no System One profile '${id}'${knownIds(ps)}`);
    }
    return { ...ps, active: id, reconciled: false };
  });
  return listDecideProfiles();
}

/**
 * Remove a profile, then delete every rotated backup of the store (a backup
 * may hold the removed key). The active profile is removed only when `use`
 * names another profile to activate in its place.
 *
 * @param ref - Profile to remove.
 * @param use - Profile to activate instead; required when `ref` is active.
 * @returns The profile list after the removal.
 * @throws {DecideCredentialsError} When a reference is invalid or unknown,
 *   or `ref` is active and `use` is missing or names it.
 */
export async function removeDecideProfile(
  ref: string,
  use?: string,
): Promise<DecideProfileListResult> {
  const { id } = requireProfileRef(ref);
  const useId = use === undefined ? undefined : requireProfileRef(use).id;
  await mutateProfiles((ps) => {
    if (!ps.profiles[id]) {
      throw new DecideCredentialsError(`no System One profile '${id}'${knownIds(ps)}`);
    }
    let active = ps.active;
    if (useId !== undefined) {
      if (useId === id || !ps.profiles[useId]) {
        throw new DecideCredentialsError(`--use must name another stored profile${knownIds(ps)}`);
      }
      active = useId;
    }
    if (active === id) {
      throw new DecideCredentialsError(
        `'${id}' is the active profile: name the profile to activate instead with --use <provider>/<name>, or remove every profile with --clear`,
      );
    }
    const profiles = Object.fromEntries(
      Object.entries(ps.profiles).filter(([profileId]) => profileId !== id),
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
