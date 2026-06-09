/**
 * ConfigDomainHandler — routes the config-as-domain operations to the
 * `ConfigManifest` cascade resolver.
 *
 * This is the CORE-side routing surface for the four config-as-domain ops added
 * in T11917 (`config.get`, `config.list`, `config.validate`, `config.unset`),
 * plus the pre-existing `config.show` read. Every method delegates to the pure
 * JSON cascade resolver in `../config/registry.js` (`resolveCleoConfig`,
 * `getConfigValue`, `validateConfig`, `unsetConfigValue`) — the SSoT
 * implementation of the {@link ConfigManifestEntry} contract from
 * `@cleocode/contracts/config`.
 *
 * The handler lives in CORE (not the CLI `cleo/` dispatch layer) so the routing
 * logic — and the cascade resolver it calls — is reusable by every consumer
 * (CLI dispatch, the SDK gateway, REST clients) without crossing the
 * package boundary back into `cleo/`. The thin `admin` DomainHandler in
 * `packages/cleo/src/dispatch/domains/admin.ts` delegates its `config.*` ops to
 * this class and wraps the {@link EngineResult} into the LAFS envelope.
 *
 * Pure JSON file IO only — does NOT open SQLite (ADR-068 DB Open Guard
 * preserved; the cascade resolver it calls is also SQLite-free).
 *
 * @packageDocumentation
 * @module @cleocode/core/dispatch/config-domain-handler
 *
 * @task T11917 — config-as-domain (M5/AC3)
 * @epic T11769 — EP-API-STANDARD-FOUNDATION
 * @saga T9855 — ConfigManifest SSoT
 * @adr 076
 */

import { type EngineResult, engineError, engineSuccess } from '@cleocode/contracts';
import {
  flattenConfigKeys,
  getConfigValue,
  type ResolveScope,
  resolveCleoConfig,
  unsetConfigValue,
  type ValidateScope,
  validateConfig,
} from '../config/registry.js';

/** Result of `config.get`. */
export interface ConfigGetResult {
  /** The dot-notation key that was resolved. */
  key: string;
  /** Cascade slice the value was resolved against. */
  scope: ResolveScope;
  /** Resolved value, or `null` when the key is absent. */
  value: unknown;
  /** `true` IFF the key resolved to a defined value in the cascade. */
  found: boolean;
}

/** Result of `config.list`. */
export interface ConfigListResult {
  /** Cascade slice the config was resolved against. */
  scope: ResolveScope;
  /** Full resolved config object for the slice. */
  config: Record<string, unknown>;
  /** Flattened dot-notation keys present in the resolved config. */
  keys: string[];
}

/** Result of `config.validate`. */
export interface ConfigValidateResult {
  /** Scope that was validated. */
  scope: ValidateScope;
  /** `true` IFF every gate passed. */
  ok: boolean;
  /** Human-readable schema issues. Empty when `ok === true`. */
  issues: string[];
}

/** Result of `config.unset`. */
export interface ConfigUnsetResult {
  /** Config key that was targeted. */
  key: string;
  /** Scope the key was removed from. */
  scope: 'project' | 'global';
  /** `true` IFF a value was actually deleted. */
  removed: boolean;
}

/** Cascade slice selector accepted by `config.get` / `config.list`. */
const RESOLVE_SCOPES: readonly ResolveScope[] = ['global', 'project', 'merged'];

/** Scope selector accepted by `config.validate`. */
const VALIDATE_SCOPES: readonly ValidateScope[] = ['global', 'project'];

/**
 * Narrow an untrusted scope string to a {@link ResolveScope}, defaulting to
 * `'merged'`. Returns `null` when the string is non-empty but invalid so the
 * caller can reject with `E_INVALID_INPUT`.
 */
function coerceResolveScope(scope: string | undefined): ResolveScope | null {
  if (scope === undefined) return 'merged';
  return RESOLVE_SCOPES.includes(scope as ResolveScope) ? (scope as ResolveScope) : null;
}

/**
 * Narrow an untrusted scope string to a {@link ValidateScope}, defaulting to
 * `'project'`. Returns `null` when the string is non-empty but invalid.
 */
function coerceValidateScope(scope: string | undefined): ValidateScope | null {
  if (scope === undefined) return 'project';
  return VALIDATE_SCOPES.includes(scope as ValidateScope) ? (scope as ValidateScope) : null;
}

/**
 * Routes the config-as-domain operations to the ConfigManifest cascade
 * resolver. Stateless — construct once and reuse, or instantiate per call.
 *
 * @task T11917
 */
export class ConfigDomainHandler {
  /**
   * `config.get` — resolve a single config value by dot-notation key through
   * the cascade resolver ({@link getConfigValue}).
   *
   * @param projectRoot - Absolute path to the project root.
   * @param key - Dot-notation config key (required).
   * @param scopeRaw - Cascade slice (`global` | `project` | `merged`). Defaults
   *   to `merged`.
   */
  async get(
    projectRoot: string,
    key: string | undefined,
    scopeRaw?: string,
  ): Promise<EngineResult<ConfigGetResult>> {
    if (!key) {
      return engineError('E_INVALID_INPUT', 'key is required', { fix: 'cleo config get <key>' });
    }
    const scope = coerceResolveScope(scopeRaw);
    if (scope === null) {
      return engineError('E_INVALID_INPUT', `scope must be one of: ${RESOLVE_SCOPES.join(', ')}`);
    }
    try {
      const value = await getConfigValue(key, { scope, projectRoot });
      return engineSuccess({ key, scope, value: value ?? null, found: value !== undefined });
    } catch (err) {
      return engineError(
        'E_CONFIG_RESOLVE_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * `config.list` — resolve the full config cascade for a slice and surface its
   * flattened dot-notation keys ({@link resolveCleoConfig} +
   * {@link flattenConfigKeys}).
   *
   * @param projectRoot - Absolute path to the project root.
   * @param scopeRaw - Cascade slice. Defaults to `merged`.
   */
  async list(projectRoot: string, scopeRaw?: string): Promise<EngineResult<ConfigListResult>> {
    const scope = coerceResolveScope(scopeRaw);
    if (scope === null) {
      return engineError('E_INVALID_INPUT', `scope must be one of: ${RESOLVE_SCOPES.join(', ')}`);
    }
    try {
      const config = await resolveCleoConfig({ scope, projectRoot });
      return engineSuccess({ scope, config, keys: flattenConfigKeys(config) });
    } catch (err) {
      return engineError(
        'E_CONFIG_RESOLVE_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * `config.validate` — schema-validate a scoped config file against its
   * manifest entry's schema ({@link validateConfig}). A rejected file resolves
   * to `{ ok: false, issues: [...] }` — it does NOT throw.
   *
   * @param projectRoot - Absolute path to the project root.
   * @param scopeRaw - `global` | `project`. Defaults to `project`. `merged` is
   *   rejected — validation runs against a single file's manifest entry.
   */
  async validate(
    projectRoot: string,
    scopeRaw?: string,
  ): Promise<EngineResult<ConfigValidateResult>> {
    const scope = coerceValidateScope(scopeRaw);
    if (scope === null) {
      return engineError(
        'E_INVALID_INPUT',
        `scope must be one of: ${VALIDATE_SCOPES.join(', ')} (merged is not validatable)`,
      );
    }
    try {
      const result = await validateConfig(scope, projectRoot);
      return engineSuccess({ scope, ok: result.ok, issues: result.issues });
    } catch (err) {
      return engineError(
        'E_CONFIG_VALIDATE_FAILED',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * `config.unset` — remove a key from a scoped config file and persist the
   * result ({@link unsetConfigValue}). Idempotent: removing an absent key is a
   * success with `removed: false`.
   *
   * @param projectRoot - Absolute path to the project root.
   * @param key - Dot-notation config key to remove (required).
   * @param global - When `true`, target the global config file.
   */
  async unset(
    projectRoot: string,
    key: string | undefined,
    global?: boolean,
  ): Promise<EngineResult<ConfigUnsetResult>> {
    if (!key) {
      return engineError('E_INVALID_INPUT', 'key is required', { fix: 'cleo config unset <key>' });
    }
    try {
      const result = await unsetConfigValue(key, { projectRoot, global });
      return engineSuccess({ key: result.key, scope: result.scope, removed: result.removed });
    } catch (err) {
      return engineError('E_CONFIG_UNSET_FAILED', err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Shared singleton {@link ConfigDomainHandler}. The handler is stateless, so a
 * single instance is reused across the process.
 *
 * @task T11917
 */
export const configDomainHandler = new ConfigDomainHandler();
