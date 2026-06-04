/**
 * SystemOfUse contract types for the `resolveLLMForSystem` chokepoint (E9).
 *
 * A "system of use" is the semantic label for the subsystem that is requesting
 * an LLM client — e.g. `'sentient'`, `'memory'`, `'task-executor'`. It is
 * a higher-level, stable identity that CLEO maps to a {@link RoleName} for
 * config resolution. This indirection insulates call-sites from the config
 * vocabulary (roles) and from model/provider churn.
 *
 * `resolveLLMForSystem` is the single DRY chokepoint that the 4-resolver /
 * 3-picker sprawl will collapse onto (E9 · T11745).
 *
 * @module llm/system-resolver
 * @task T11749
 * @epic T11745
 */

import type { RoleName } from '../config.js';

/**
 * Semantic label for a CLEO subsystem that requests an LLM client.
 *
 * Each `SystemOfUse` value maps to a canonical {@link RoleName} used by
 * `resolveLLMForSystem` for config and credential resolution. Subsystems
 * MUST declare their identity so the resolver can apply the correct
 * per-system overrides and audit trails.
 *
 * ### Role mapping (static default; overridable via config `systemRoles`)
 *
 * | System            | Default role   |
 * |-------------------|----------------|
 * | `sentient`        | `consolidation`|
 * | `memory`          | `extraction`   |
 * | `task-executor`   | `judgement`    |
 * | `deriver`         | `derivation`   |
 * | `hygiene`         | `hygiene`      |
 * | `plugin`          | `plugin`       |
 * | `compression`     | `compression`  |
 * | `default`         | (global default, no role) |
 *
 * @task T11749
 */
export type SystemOfUse =
  | 'sentient'
  | 'memory'
  | 'task-executor'
  | 'deriver'
  | 'hygiene'
  | 'plugin'
  | 'compression'
  | 'default';

/**
 * Static mapping from {@link SystemOfUse} to the {@link RoleName} used for
 * config resolution. This is the canonical default; callers may override
 * individual systems via `config.llm.systemRoles[system]`.
 *
 * @task T11749
 */
export const SYSTEM_ROLE_MAP: Readonly<Record<SystemOfUse, RoleName | null>> = {
  sentient: 'consolidation',
  memory: 'extraction',
  'task-executor': 'judgement',
  deriver: 'derivation',
  hygiene: 'hygiene',
  plugin: 'plugin',
  compression: 'compression',
  /** `null` means "use the global LLM default, no per-role config". */
  default: null,
} as const;

/**
 * Options accepted by `resolveLLMForSystem()`.
 *
 * @task T11749
 */
export interface ResolveLLMForSystemOptions {
  /**
   * Absolute path to the project root for config + tier-5 credential lookup.
   * Defaults to `process.cwd()`.
   */
  projectRoot?: string;

  /**
   * Override the {@link RoleName} used for config resolution.
   *
   * When set, this takes precedence over the static {@link SYSTEM_ROLE_MAP}
   * lookup. Allows call-sites that straddle two roles to pick the correct one
   * without changing the system identity.
   */
  roleOverride?: RoleName;

  /**
   * When `true`, the resolver skips the provider-registry defaultModel lookup
   * and returns the raw `resolveLLMForRole` result unchanged.
   *
   * Used internally by tests that need predictable `implicit-fallback` behaviour
   * without triggering network-dependent registry discovery.
   *
   * @internal
   */
  skipCatalogDefault?: boolean;
}
