/**
 * `SystemOfUseLabel` contract types for the `resolveLLMForSystem` chokepoint (E9).
 *
 * A "system of use label" is the flat, ergonomic vocabulary the E9 resolver
 * accepts for the seven role-mapped background subsystems — e.g. `'sentient'`,
 * `'memory'`, `'task-executor'`. It is a higher-level, stable identity that
 * CLEO maps to a {@link RoleName} for config resolution. This indirection
 * insulates call-sites from the config vocabulary (roles) and from
 * model/provider churn.
 *
 * The richer, structured `{ kind, id }` taxonomy that covers the OTHER routing
 * axes (orchestration tiers, tools, skills, cantbook nodes, spawn units) lives
 * in {@link import('./system-of-use.js').SystemOfUse} (T11747). This label set
 * is the flat resolver-input subset; both are kept in lock-step (the label set
 * mirrors the `aux` axis plus `default`).
 *
 * `resolveLLMForSystem` is the single DRY chokepoint that the 4-resolver /
 * 3-picker sprawl will collapse onto (E9 · T11745).
 *
 * @module llm/system-resolver
 * @task T11749
 * @epic T11745
 */

import type { RoleName } from '../config.js';
import type { RoleSystem } from './system-of-use.js';

/**
 * Flat, ergonomic label for a CLEO background subsystem that requests an LLM
 * client through the E9 resolver.
 *
 * Each `SystemOfUseLabel` value maps to a canonical {@link RoleName} used by
 * `resolveLLMForSystem` for config and credential resolution. Subsystems
 * MUST declare their identity so the resolver can apply the correct
 * per-system overrides and audit trails.
 *
 * For the full structured taxonomy (tools/skills/cantbook nodes/spawn units/
 * orchestration tiers), see the discriminated
 * {@link import('./system-of-use.js').SystemOfUse} descriptor (T11747).
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
export type SystemOfUseLabel =
  | 'sentient'
  | 'memory'
  | 'task-executor'
  | 'deriver'
  | 'hygiene'
  | 'plugin'
  | 'compression'
  | 'default';

/**
 * Static mapping from {@link SystemOfUseLabel} to the {@link RoleName} used for
 * config resolution. This is the canonical default; callers may override
 * individual systems via `config.llm.systemRoles[system]`.
 *
 * @task T11749
 */
export const SYSTEM_ROLE_MAP: Readonly<Record<SystemOfUseLabel, RoleName | null>> = {
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
 * Input accepted by `resolveLLMForSystem()`.
 *
 * The chokepoint accepts EITHER:
 *
 *  - the flat, ergonomic {@link SystemOfUseLabel} for the role-mapped background
 *    subsystems (`'sentient'`, `'memory'`, … — the original locked vocabulary), OR
 *  - a structured {@link RoleSystem} descriptor (`{ kind: 'role', id: RoleName }`)
 *    for a *direct* role resolution.
 *
 * The descriptor form makes the E9 equivalence
 * `resolveLLMForRole(role) ≡ resolveLLMForSystem({ kind: 'role', id: role })`
 * (T11750 · AC1) directly expressible at the chokepoint, so role callers can
 * collapse onto the same single resolution path with ZERO duplicate resolution
 * logic. Both forms funnel through the SAME `resolveLLMForRole` core inside
 * `@cleocode/core`.
 *
 * @task T11750
 * @epic T11745
 */
export type SystemResolverInput = SystemOfUseLabel | RoleSystem;

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

  /**
   * Raw prompt used to derive a role from complexity when neither an explicit
   * tier/role nor a role-mapped system label is available (L1 proposer · T11906).
   *
   * When the `system` argument is the flat `'default'` label (which maps to NO
   * role) and `roleOverride` is unset, the resolver runs the L1 complexity
   * classifier over this prompt and proposes a {@link RoleName} from the
   * resulting tier (`low → hygiene`, `mid → consolidation`, `high → judgement`).
   * This is a COMPLEMENT to the resolver — it only supplies a role when one is
   * otherwise absent; an explicit label, descriptor, or `roleOverride` always
   * wins. The classifier returns a TIER only and constructs no LLM client.
   *
   * Ignored when the role is already determined by the input or `roleOverride`.
   */
  complexityPrompt?: string;

  /**
   * Explicit encoded system-of-use key for the `llm.systems[key]` granular
   * override tier (T11759 · M4).
   *
   * The flat-label input form derives this key from `system` itself; this option
   * lets a caller resolving an OPEN-axis system (whose identity is NOT a flat
   * {@link SystemOfUseLabel}) — e.g. a `.cantbook` node keyed
   * `cantbook:<playbook>#<nodeId>` — supply that identity as the granular
   * override + audit key while passing a resolvable background label as
   * `system`. When set, it OVERRIDES the label-derived key. Omit it and the
   * pre-T11759 derivation is unchanged.
   *
   * @task T11759
   */
  systemKey?: string;

  /**
   * Optional named profile (a key of `llm.profiles`) that pins the resolution to
   * a specific provider/model/credential, winning over the role tier (T11759 ·
   * M4).
   *
   * Threaded down to `ResolveLLMForRoleOptions.profileOverride`. A `.cantbook`
   * stage's `profile:` flows through here. When the named profile is
   * absent/incomplete, resolution falls through the normal chain unchanged.
   *
   * @task T11759
   */
  profile?: string;
}
