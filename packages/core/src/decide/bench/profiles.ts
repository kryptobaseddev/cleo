/**
 * Resolve `--profiles a,b` to benchmark connections (T12495, T12735).
 *
 * Names resolve through the System One profile store (T12733,
 * `decide-credentials.json`), in this order:
 *
 * 1. An exact profile id, `<provider>/<name>` (e.g. `layahost/work`).
 * 2. A bare provider kind (`layahost`, `jev`): that provider's ACTIVE
 *    profile when the active profile belongs to it, else `<provider>/default`.
 * 3. The environment override layer, for a name the store does not hold:
 *    `CLEO_DECIDE_PROFILE_<NAME>_KEY` (plus `_URL`, `_MODEL`, `_PROVIDER`),
 *    `<NAME>` upper-cased with non-alphanumerics as `_`
 *    (`layahost/lab` → `CLEO_DECIDE_PROFILE_LAYAHOST_LAB_KEY`). Useful for a
 *    throwaway key that should never be written to disk.
 *
 * A stored profile's `default` URL, and an environment profile without
 * `_URL`, both resolve through {@link presetBaseUrl} — the same preset table
 * everyday decisions use. An unknown name fails with {@link BenchProfileError},
 * which lists the stored profile ids with masked keys.
 *
 * @task T12735
 * @epic T12486
 */

import type { DecisionProviderKind } from '@cleocode/contracts';
import {
  DecideCredentialsError,
  isAllowedDecideBaseUrl,
  listDecideProfiles,
  parseDecideProfileRef,
  resolveDecideProfile,
} from '../credentials.js';
import { isValidDecisionModelName } from '../jev-wire.js';
import {
  DECISION_PROVIDER_PRESETS,
  parseDecisionProviderKind,
  presetBaseUrl,
} from '../providers.js';
import type { BenchConnection } from './types.js';

/** Resolves one profile name to a connection. */
export interface BenchProfileResolver {
  /**
   * @param name - Profile name.
   * @returns The connection, or `null` when no profile has that name.
   * @throws BenchProfileInvalidError when the profile exists but is misconfigured.
   */
  resolve(name: string): BenchConnection | null;
  /**
   * The profiles that could be named, for the unknown-profile error.
   *
   * @returns Secret-free labels, e.g. `layahost/work (key …1111)`.
   */
  available?(): readonly string[];
}

/** A profile name that resolved to nothing. */
export class BenchProfileError extends Error {
  /** The names that did not resolve. */
  readonly missing: readonly string[];
  /** Secret-free labels of the stored profiles (id and masked key). */
  readonly available: readonly string[];

  /**
   * @param missing - Unresolved names.
   * @param available - Secret-free labels of the profiles that do exist.
   */
  constructor(missing: readonly string[], available: readonly string[] = []) {
    const known = available.length
      ? `stored profiles: ${available.join(', ')}`
      : 'no profiles are stored';
    super(
      `unknown decide profile(s): ${missing.join(', ')} (${known}). Store one with: cleo decide config --profile <provider>/<name>, or set CLEO_DECIDE_PROFILE_<NAME>_KEY for a one-off key.`,
    );
    this.name = 'BenchProfileError';
    this.missing = missing;
    this.available = available;
  }
}

/** A profile that exists but is misconfigured (bad URL, key or model). */
export class BenchProfileInvalidError extends Error {
  /** The profile name. */
  readonly profile: string;

  /**
   * @param profile - Profile name.
   * @param problem - What is wrong, e.g. `invalid URL "…"`.
   */
  constructor(profile: string, problem: string) {
    super(`decide profile '${profile}': ${problem}`);
    this.name = 'BenchProfileInvalidError';
    this.profile = profile;
  }
}

/**
 * Environment variable prefix for one profile.
 *
 * @param name - Profile name.
 * @returns `CLEO_DECIDE_PROFILE_<NAME>` (upper-cased, non-alphanumerics as `_`).
 */
export function benchProfileEnvPrefix(name: string): string {
  return `CLEO_DECIDE_PROFILE_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** Profile-store access, injectable for tests. Defaults to the real store. */
export interface BenchProfileStore {
  /** List the stored profiles (secret-free). */
  readonly list: typeof listDecideProfiles;
  /** Resolve one stored profile (contains the key). */
  readonly resolve: typeof resolveDecideProfile;
}

/** Options for {@link createProfileResolver}. */
export interface BenchProfileResolverOptions {
  /** Environment for the override layer. Default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Profile store. Default: `decide-credentials.json` in the CLEO home. */
  readonly store?: BenchProfileStore;
}

/** The store profile id a name refers to, or `null` when it names none that is stored. */
function storedProfileId(name: string, store: BenchProfileStore): string | null {
  const listed = store.list();
  const ids = new Set(listed.profiles.map((p) => p.id));
  const ref = parseDecideProfileRef(name);
  if (!ref) return null;
  if (name.includes('/')) return ids.has(ref.id) ? ref.id : null;
  // Bare provider: its active profile, else <provider>/default.
  const active = listed.active ? parseDecideProfileRef(listed.active) : null;
  if (active && active.provider === ref.provider && ids.has(active.id)) return active.id;
  return ids.has(ref.id) ? ref.id : null;
}

/** Resolve a name from the environment override layer, or `null` when unset. */
function resolveFromEnv(name: string, env: NodeJS.ProcessEnv): BenchConnection | null {
  const prefix = benchProfileEnvPrefix(name);
  const key = env[`${prefix}_KEY`]?.trim();
  if (!key) return null;
  const kind: DecisionProviderKind =
    parseDecisionProviderKind(env[`${prefix}_PROVIDER`]) ??
    parseDecideProfileRef(name)?.provider ??
    'jev';
  const baseUrl = env[`${prefix}_URL`]?.trim() || presetBaseUrl(kind);
  if (!baseUrl) {
    throw new BenchProfileInvalidError(name, `no URL (set ${prefix}_URL)`);
  }
  if (!isAllowedDecideBaseUrl(baseUrl)) {
    throw new BenchProfileInvalidError(
      name,
      `invalid URL in ${prefix}_URL (https://, or http:// to a loopback host)`,
    );
  }
  const model = env[`${prefix}_MODEL`]?.trim() || DECISION_PROVIDER_PRESETS[kind].defaultModel;
  if (model !== undefined && !isValidDecisionModelName(model)) {
    throw new BenchProfileInvalidError(name, `invalid model name in ${prefix}_MODEL`);
  }
  return { name, provider: kind, baseUrl, apiKey: key, ...(model ? { model } : {}) };
}

/**
 * The benchmark's profile resolver: the T12733 profile store (exact id, then
 * bare provider), then the environment override layer. See the module doc.
 *
 * @param opts - Environment and store. Defaults: `process.env` and the real store.
 * @returns A resolver.
 */
export function createProfileResolver(
  opts: BenchProfileResolverOptions = {},
): BenchProfileResolver {
  const env = opts.env ?? process.env;
  const store: BenchProfileStore = opts.store ?? {
    list: listDecideProfiles,
    resolve: resolveDecideProfile,
  };
  return {
    resolve(name: string): BenchConnection | null {
      const id = storedProfileId(name, store);
      if (id) {
        let resolved: ReturnType<typeof resolveDecideProfile>;
        try {
          resolved = store.resolve(id);
        } catch (err) {
          if (err instanceof DecideCredentialsError) {
            throw new BenchProfileInvalidError(name, err.message);
          }
          throw err;
        }
        return {
          name,
          provider: resolved.provider,
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
          ...(resolved.model ? { model: resolved.model } : {}),
        };
      }
      return resolveFromEnv(name, env);
    },
    available(): readonly string[] {
      return store
        .list()
        .profiles.map((p) => `${p.id}${p.active ? ' [active]' : ''} (key ${p.keyPreview})`);
    },
  };
}

/**
 * Resolve every name, or throw naming all that did not resolve.
 *
 * @param names - Profile names (duplicates removed, order kept).
 * @param resolver - Resolver. Default: {@link createProfileResolver}.
 * @returns One connection per name.
 * @throws BenchProfileError when any name is unknown (lists the stored profiles, keys masked).
 * @throws BenchProfileInvalidError when a profile has a bad URL, key or model.
 */
export function resolveBenchProfiles(
  names: readonly string[],
  resolver: BenchProfileResolver = createProfileResolver(),
): BenchConnection[] {
  const unique = [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))];
  const out: BenchConnection[] = [];
  const missing: string[] = [];
  for (const name of unique) {
    const c = resolver.resolve(name);
    if (c) out.push(c);
    else missing.push(name);
  }
  if (missing.length > 0) throw new BenchProfileError(missing, resolver.available?.() ?? []);
  return out;
}
