/**
 * Environment-variable credential seeder (E-CONFIG-AUTH-UNIFY E2a / T9409).
 *
 * Implements `CredentialSeeder` for every provider in the canonical
 * `ENV_VARS` mapping (re-exported from `../credentials.ts`). On `seed()`,
 * each instance reads `process.env[ENV_VARS[provider]]`; when the variable
 * is set to a non-empty (post-trim) string, the seeder emits a single
 * `SeederCredentialEntry` tagged with `source: 'env'` so downstream pool
 * code can attribute the credential back to the environment.
 *
 * ## Architectural mirror
 *
 * This is the architectural mirror of Hermes Agent's `_seed_from_env`
 * dispatch (`agent/credential_pool.py:1187` — see plan E2a §5.2 T-E2-2).
 * One instance handles exactly one `(sourceId='env', provider)` pair so
 * registry lookups via `getByProvider` stay clean.
 *
 * ## Consent gate
 *
 * Env vars are first-party config — the operator already exported them
 * deliberately. No external file consent is required, so
 * `isConsentEstablished` returns `true` unconditionally.
 *
 * ## Priority
 *
 * Each entry advertises `priority: 50` per the E2a §5.2 T-E2-2 spec.
 * Pool tier ordering is finalised in T9412; until then this value is
 * informational — the credential store's `max + 10` rule still applies
 * if the seeder bypasses the explicit priority hint at upsert time.
 *
 * ## Behavioral note
 *
 * No production code path consumes `BUILTIN_SEEDERS` yet — T9413 wires
 * the registry into the async resolver. Registering env seeders here is
 * a pure-additive change: the legacy 6-tier `resolveCredentials()` ladder
 * still owns the active resolution path.
 *
 * @module llm/credential-seeders/env-seeder
 * @task T9409
 * @epic E-CONFIG-AUTH-UNIFY (E2a)
 */

import { ENV_VARS } from '../credentials.js';
import type { ModelTransport } from '../types-config.js';
import { BUILTIN_SEEDERS, type CredentialSeeder, type SeederResult } from './index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default priority hint emitted by every env-seeded entry.
 *
 * Documented for forward-compat — see plan §5.2 T-E2-2. The pool tier
 * ordering (T9412) will canonicalise relative priority across all
 * seeders; until then, downstream consumers SHOULD NOT depend on the
 * literal value beyond "env-seeded entries share one stable priority".
 *
 * @task T9409
 */
export const ENV_SEEDER_PRIORITY = 50;

// ---------------------------------------------------------------------------
// EnvSeeder class
// ---------------------------------------------------------------------------

/**
 * Credential seeder that pulls a single provider's API key from
 * `process.env[ENV_VARS[provider]]`.
 *
 * One instance handles one provider. The `BUILTIN_SEEDERS` registry is
 * populated at module load with one `EnvSeeder` for every provider in the
 * canonical `ENV_VARS` mapping — see `registerEnvSeeders()` below.
 *
 * @task T9409
 */
export class EnvSeeder implements CredentialSeeder {
  /** Constant tag — every env-seeded entry attributes back to `'env'`. */
  readonly sourceId = 'env' as const;

  /** Provider transport this seeder reads the env var for. */
  readonly provider: ModelTransport;

  /**
   * Canonical env var name for this provider (e.g. `'ANTHROPIC_API_KEY'`).
   *
   * Snapshotted at construction from the shared `ENV_VARS` mapping so the
   * seeder's behaviour is deterministic for the lifetime of the instance,
   * even if a future refactor mutates the mapping.
   */
  readonly envVarName: string;

  /**
   * Construct an env seeder for a specific provider.
   *
   * @param provider - Provider transport (must have an entry in `ENV_VARS`).
   * @throws {Error} `E_ENV_SEEDER_UNKNOWN_PROVIDER` when the provider has
   *   no canonical env var registered in `ENV_VARS`. This is a
   *   programmer-error guard — runtime callers never construct seeders
   *   from arbitrary strings.
   */
  constructor(provider: ModelTransport) {
    const envVarName = ENV_VARS[provider];
    if (!envVarName) {
      throw new Error(
        `E_ENV_SEEDER_UNKNOWN_PROVIDER: no canonical env var registered for provider='${provider}'`,
      );
    }
    this.provider = provider;
    this.envVarName = envVarName;
  }

  /**
   * Read the env var and emit zero or one credential entry.
   *
   * - Empty or unset env var → `{ entries: [] }` (NOT an error).
   * - Whitespace-only value → `{ entries: [] }`.
   * - Non-empty value → one entry with the trimmed token, tagged
   *   `source: 'env'`, `authType: 'api_key'`, `priority: 50`.
   *
   * Never throws — env access is synchronous and side-effect-free.
   *
   * @returns `SeederResult` describing the discovered credential, if any.
   */
  async seed(): Promise<SeederResult> {
    const raw = process.env[this.envVarName];
    if (raw === undefined) return { entries: [] };
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { entries: [] };
    return {
      entries: [
        {
          provider: this.provider,
          label: `env:${this.envVarName}`,
          authType: 'api_key',
          source: 'env',
          accessToken: trimmed,
          priority: ENV_SEEDER_PRIORITY,
        },
      ],
    };
  }

  /**
   * Env vars are first-party — no external consent gate.
   *
   * The operator explicitly exported the variable, so the constructor's
   * implied consent applies. Returning `true` keeps the resolver's
   * dispatch table simple.
   */
  isConsentEstablished(): boolean {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register an `EnvSeeder` for every provider in `ENV_VARS` into the supplied
 * registry. Exposed so tests can exercise registration semantics against a
 * fresh `SeederRegistry()` without mutating the process-wide singleton.
 *
 * @param registry - Target registry (defaults to `BUILTIN_SEEDERS` so the
 *   module-load side effect uses the singleton path).
 * @task T9409
 */
export function registerEnvSeeders(registry = BUILTIN_SEEDERS): void {
  for (const provider of Object.keys(ENV_VARS) as ModelTransport[]) {
    registry.register(new EnvSeeder(provider));
  }
}

// ---------------------------------------------------------------------------
// Module-load side effect — populate BUILTIN_SEEDERS
// ---------------------------------------------------------------------------

// Eagerly register env seeders into the process-wide singleton. Importing
// this module exactly once (per Node ESM cache semantics) guarantees every
// provider in `ENV_VARS` has an env seeder available via
// `BUILTIN_SEEDERS.getByProvider(provider)`.
registerEnvSeeders();
