/**
 * Resolve `--profiles a,b` to benchmark connections (T12495).
 *
 * Named decide profiles are being built in core by T12733, which will export
 * `resolveDecideProfile(name)` and `listDecideProfiles()`. Until it lands,
 * the benchmark resolves names through this small adapter, behind the
 * {@link BenchProfileResolver} interface so the switch is one function:
 *
 * 1. `CLEO_DECIDE_PROFILE_<NAME>_KEY` (plus `_URL`, `_MODEL`, `_PROVIDER`) in
 *    the environment — `<NAME>` upper-cased, non-alphanumerics as `_`. A
 *    `layahost` profile needs only the key (the preset URL and model apply);
 *    any other profile needs a URL.
 * 2. Otherwise, a name equal to the stored connection's provider kind
 *    (`cleo decide config`), or `default`, resolves to the stored connection.
 *
 * @task T12495
 * @epic T12486
 */

import { DECISION_PROVIDER_KINDS } from '@cleocode/contracts';
import { isAllowedDecideBaseUrl, loadDecideConnection } from '../credentials.js';
import { isValidDecisionModelName } from '../jev-wire.js';
import { DECISION_PROVIDER_PRESETS, parseDecisionProviderKind } from '../providers.js';
import type { BenchConnection } from './types.js';

/** Resolves one profile name to a connection. */
export interface BenchProfileResolver {
  /**
   * @param name - Profile name.
   * @returns The connection, or `null` when no profile has that name.
   * @throws BenchProfileInvalidError when the profile exists but is misconfigured.
   */
  resolve(name: string): BenchConnection | null;
}

/** A profile name that resolved to nothing. */
export class BenchProfileError extends Error {
  /** The names that did not resolve. */
  readonly missing: readonly string[];

  /**
   * @param missing - Unresolved names.
   */
  constructor(missing: readonly string[]) {
    super(
      `unknown decide profile(s): ${missing.join(', ')}. Set CLEO_DECIDE_PROFILE_<NAME>_KEY (and _URL for a non-layahost host), or store one with cleo decide config and name its provider kind.`,
    );
    this.name = 'BenchProfileError';
    this.missing = missing;
  }
}

/** A profile that exists but is misconfigured (bad URL or model). */
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

/**
 * The interim resolver (environment, then the stored connection).
 *
 * @param env - Environment to read. Default `process.env`.
 * @param stored - Stored-connection loader. Default `loadDecideConnection`.
 * @returns A resolver.
 */
export function createInterimProfileResolver(
  env: NodeJS.ProcessEnv = process.env,
  stored: typeof loadDecideConnection = loadDecideConnection,
): BenchProfileResolver {
  return {
    resolve(name: string): BenchConnection | null {
      const prefix = benchProfileEnvPrefix(name);
      const key = env[`${prefix}_KEY`]?.trim();
      if (key) {
        const kind =
          parseDecisionProviderKind(env[`${prefix}_PROVIDER`]) ??
          parseDecisionProviderKind(name) ??
          'jev';
        const preset = DECISION_PROVIDER_PRESETS[kind];
        const baseUrl = env[`${prefix}_URL`]?.trim() || preset.defaultBaseUrl;
        if (!baseUrl) {
          throw new BenchProfileInvalidError(name, `no URL (set ${prefix}_URL)`);
        }
        if (!isAllowedDecideBaseUrl(baseUrl)) {
          throw new BenchProfileInvalidError(
            name,
            `invalid URL in ${prefix}_URL (https://, or http:// to a loopback host)`,
          );
        }
        const model = env[`${prefix}_MODEL`]?.trim() || preset.defaultModel;
        if (model !== undefined && !isValidDecisionModelName(model)) {
          throw new BenchProfileInvalidError(name, `invalid model name in ${prefix}_MODEL`);
        }
        return { name, provider: kind, baseUrl, apiKey: key, ...(model ? { model } : {}) };
      }
      const sealed = stored();
      if (!sealed) return null;
      const matches =
        name === 'default' ||
        (DECISION_PROVIDER_KINDS.some((k) => k === name) && sealed.provider === name);
      if (!matches) return null;
      const c = sealed.connection();
      return {
        name,
        provider: sealed.provider,
        baseUrl: c.baseUrl,
        apiKey: c.apiKey,
        ...(c.model ? { model: c.model } : {}),
      };
    },
  };
}

/**
 * Resolve every name, or throw naming all that did not resolve.
 *
 * @param names - Profile names (duplicates removed, order kept).
 * @param resolver - Resolver. Default: {@link createInterimProfileResolver}.
 * @returns One connection per name.
 * @throws BenchProfileError when any name is unknown.
 * @throws BenchProfileInvalidError when a profile has a bad URL or model.
 */
export function resolveBenchProfiles(
  names: readonly string[],
  resolver: BenchProfileResolver = createInterimProfileResolver(),
): BenchConnection[] {
  const unique = [...new Set(names.map((n) => n.trim()).filter((n) => n !== ''))];
  const out: BenchConnection[] = [];
  const missing: string[] = [];
  for (const name of unique) {
    const c = resolver.resolve(name);
    if (c) out.push(c);
    else missing.push(name);
  }
  if (missing.length > 0) throw new BenchProfileError(missing);
  return out;
}
