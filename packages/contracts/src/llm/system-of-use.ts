/**
 * `SystemOfUse` taxonomy — the structured identity of every CLEO subsystem that
 * may request an LLM through the E9 chokepoint (`resolveLLMForSystem`).
 *
 * ## Why a discriminated descriptor (the hermes `_AUX_TASKS` analog)
 *
 * The first cut of the E9 chokepoint (T11749) accepted a flat string-literal
 * label ({@link SystemOfUseLabel} — `'sentient' | 'memory' | …`). That covered
 * the seven role-mapped background subsystems but had no room for the OTHER
 * axes CLEO routes LLMs along:
 *
 *   - **orchestration tiers** (`frontier`/`standard`/`fast`/`local`) — the
 *     capability lane a delegated turn runs in, independent of any role;
 *   - **tools / skills** — atomic tool primitives and `ct-*` skills that each
 *     may pin a model (the hermes `_AUX_TASKS` registry: one entry per named
 *     auxiliary task, each with its own provider/model binding);
 *   - **cantbook nodes** — per-node model selection inside a `.cantbook` flow;
 *   - **spawn units** — orchestrator-spawned worker agents that resolve their
 *     own LLM.
 *
 * `SystemOfUse` is the discriminated `{ kind, id }` descriptor that unifies all
 * of these axes under ONE identity type. {@link BUILTIN_SYSTEMS_OF_USE} is the
 * static registry of the well-known systems (orchestration tiers + the seven
 * {@link RoleName}s + the auxiliary systems); `tool:` / `skill:` / `cantbook:` /
 * `spawn-unit:` keys are OPEN — any runtime id is a valid `SystemOfUse` of the
 * corresponding kind without a registry edit (see {@link OPEN_SYSTEM_KEY_PREFIXES}).
 *
 * ## Relationship to the resolver input
 *
 * This descriptor is the *taxonomy / identity* layer. The E9 resolver
 * (`resolveLLMForSystem`) still accepts the ergonomic flat {@link SystemOfUseLabel}
 * for the seven role-mapped background subsystems (its locked contract); this
 * file is the SSoT that label set is derived against ({@link AUX_SYSTEM_IDS}),
 * and the home of the richer descriptor that profile-axis routing (tiers,
 * tools, skills, cantbook nodes, spawn units) keys off.
 *
 * Contracts-purity: this module is **types + `as const` DATA + type guards**
 * only — no runtime logic (Gate 10 · T11418). The runtime encode/decode for the
 * open-axis string keys (`parseSystemKey` / `formatSystemKey`) is intentionally
 * NOT defined here; it lives in `@cleocode/core` so this package stays type-only
 * (this module exposes only the {@link OPEN_SYSTEM_KEY_PREFIXES} DATA those
 * helpers read).
 *
 * @module llm/system-of-use
 * @task T11747
 * @epic T11745
 */

import type { LlmProviderTransport, RoleName } from '../config.js';
import type { ProviderTier } from './provider-profile.js';

/**
 * The axis a {@link SystemOfUse} belongs to — the discriminant of the
 * descriptor union.
 *
 * | Kind            | Meaning                                                        | Registry        |
 * |-----------------|----------------------------------------------------------------|-----------------|
 * | `role`          | One of the seven background {@link RoleName}s.                  | closed (7)      |
 * | `orchestration` | A capability tier lane (frontier/standard/fast/local).         | closed (4)      |
 * | `aux`           | A named auxiliary subsystem (hermes `_AUX_TASKS` analog).      | closed (~10)    |
 * | `tool`          | An atomic tool primitive that pins a model.                    | open (`tool:`)  |
 * | `skill`         | A `ct-*` skill that pins a model.                              | open (`skill:`) |
 * | `cantbook-node` | A node inside a `.cantbook` flow.                              | open (`cantbook:`) |
 * | `spawn-unit`    | An orchestrator-spawned worker agent.                          | open (`spawn-unit:`) |
 *
 * @task T11747
 */
export type SystemOfUseKind =
  | 'role'
  | 'orchestration'
  | 'aux'
  | 'tool'
  | 'skill'
  | 'cantbook-node'
  | 'spawn-unit';

/**
 * A subsystem whose identity is one of the seven background {@link RoleName}s.
 *
 * `id` is constrained to {@link RoleName} so the role axis can never drift from
 * the config SSoT.
 *
 * @task T11747
 */
export interface RoleSystem {
  readonly kind: 'role';
  /** The canonical role name (config SSoT — {@link RoleName}). */
  readonly id: RoleName;
}

/**
 * A subsystem identified by an orchestration capability tier.
 *
 * `id` is a {@link ProviderTier} — the lane a delegated/orchestrated turn runs
 * in (frontier flagship reasoning ↔ local on-device), independent of role.
 *
 * @task T11747
 */
export interface OrchestrationSystem {
  readonly kind: 'orchestration';
  /** Capability tier lane (see {@link ProviderTier}). */
  readonly id: ProviderTier;
}

/**
 * A named auxiliary subsystem — the direct analog of a hermes `_AUX_TASKS`
 * entry. Each id (`sentient`, `memory`, `compression`, …) is a stable,
 * code-referenced subsystem that may carry its own model binding.
 *
 * @task T11747
 */
export interface AuxSystem {
  readonly kind: 'aux';
  /** Stable auxiliary subsystem id (a member of {@link AUX_SYSTEM_IDS}). */
  readonly id: AuxSystemId;
}

/**
 * A tool primitive that resolves its own LLM. OPEN id — any atomic tool name is
 * valid (encoded `tool:<name>`), so new tools need no registry edit.
 *
 * @task T11747
 */
export interface ToolSystem {
  readonly kind: 'tool';
  /** Atomic tool name (free-form runtime id). */
  readonly id: string;
}

/**
 * A `ct-*` skill that resolves its own LLM. OPEN id — encoded `skill:<name>`.
 *
 * @task T11747
 */
export interface SkillSystem {
  readonly kind: 'skill';
  /** Skill name (free-form runtime id). */
  readonly id: string;
}

/**
 * A node inside a `.cantbook` flow that resolves its own LLM. OPEN id — encoded
 * `cantbook:<nodeId>`.
 *
 * @task T11747
 */
export interface CantbookNodeSystem {
  readonly kind: 'cantbook-node';
  /** Cantbook node id (free-form runtime id). */
  readonly id: string;
}

/**
 * An orchestrator-spawned worker agent that resolves its own LLM. OPEN id —
 * encoded `spawn-unit:<taskId>` (typically the `T####` it executes).
 *
 * @task T11747
 */
export interface SpawnUnitSystem {
  readonly kind: 'spawn-unit';
  /** Spawn-unit id, typically the executing task id (free-form runtime id). */
  readonly id: string;
}

/**
 * The discriminated `{ kind, id }` identity of any CLEO subsystem that requests
 * an LLM through the E9 chokepoint.
 *
 * Discriminate on {@link SystemOfUseKind} (`system.kind`) to narrow `id` to the
 * axis-specific type. Closed-axis kinds (`role`/`orchestration`/`aux`) carry a
 * typed id; open-axis kinds (`tool`/`skill`/`cantbook-node`/`spawn-unit`) carry
 * a free-form runtime string.
 *
 * @example
 * ```ts
 * const sys: SystemOfUse = { kind: 'tool', id: 'web-search' };
 * if (sys.kind === 'role') {
 *   // sys.id is narrowed to RoleName here
 * }
 * ```
 *
 * @task T11747
 * @epic T11745
 */
export type SystemOfUse =
  | RoleSystem
  | OrchestrationSystem
  | AuxSystem
  | ToolSystem
  | SkillSystem
  | CantbookNodeSystem
  | SpawnUnitSystem;

// ---------------------------------------------------------------------------
// Closed-axis value SSoTs (the type↔value mirrors)
// ---------------------------------------------------------------------------

/**
 * Value-level SSoT for the seven {@link RoleName}s.
 *
 * The `RoleName` *type* lives in `config.ts`; this `as const` tuple is the
 * single iterable VALUE mirror used to build the registry (and any other
 * `for (const role of ROLE_SYSTEM_IDS)` loop) so the role axis is enumerated
 * from ONE place. A compile-time `satisfies readonly RoleName[]` keeps it
 * locked to the type — adding a role to `RoleName` without extending this tuple
 * is a type error.
 *
 * @task T11747
 */
export const ROLE_SYSTEM_IDS = [
  'extraction',
  'consolidation',
  'derivation',
  'hygiene',
  'judgement',
  'plugin',
  'compression',
] as const satisfies readonly RoleName[];

/**
 * Value-level SSoT for the user-facing, *enumerable* background {@link RoleName}s
 * — the set `cleo llm whoami` reports and `cleo llm profile` accepts.
 *
 * This is the proper subset of {@link ROLE_SYSTEM_IDS} that excludes the two
 * internal sandbox/utility roles (`plugin`, `compression`): they are resolved
 * by code paths (plugin-scoped single-turn calls, context compression) rather
 * than configured per-call by users, so they are intentionally NOT enumerated
 * by the `whoami` / `profile` CLI surface.
 *
 * Sourcing the `cli-ops.ts` role list from THIS one tuple (instead of a
 * duplicated inline array) is the AC3 "ALL_ROLES from one SSoT" requirement
 * (T11750): the type-checker's `satisfies readonly RoleName[]` keeps every id
 * locked to {@link RoleName}, so the enumerable set can never silently drift
 * from the config vocabulary.
 *
 * @task T11750
 * @epic T11745
 */
export const WHOAMI_ROLE_IDS = [
  'extraction',
  'consolidation',
  'derivation',
  'hygiene',
  'judgement',
] as const satisfies readonly RoleName[];

/**
 * The id of a `whoami`-enumerable role — the element type of
 * {@link WHOAMI_ROLE_IDS}.
 *
 * @task T11750
 */
export type WhoamiRoleId = (typeof WHOAMI_ROLE_IDS)[number];

/**
 * Value-level SSoT for the four orchestration capability tiers. Mirrors the
 * {@link ProviderTier} type, most→least capable.
 *
 * @task T11747
 */
export const ORCHESTRATION_TIER_IDS = [
  'frontier',
  'standard',
  'fast',
  'local',
] as const satisfies readonly ProviderTier[];

/**
 * Value-level SSoT for the auxiliary subsystem ids (the hermes `_AUX_TASKS`
 * key set). These are the stable, code-referenced background subsystems CLEO
 * resolves an LLM for outside the role/tier/tool axes.
 *
 * The seven role-mapped resolver labels in {@link SystemOfUseLabel} are derived
 * from this set plus `default` — keeping the flat resolver vocabulary and the
 * structured taxonomy in lock-step.
 *
 * @task T11747
 */
export const AUX_SYSTEM_IDS = [
  /** Dream-cycle / consolidation subsystem (BRAIN sentient layer). */
  'sentient',
  /** BRAIN memory extraction subsystem. */
  'memory',
  /** Task-executor judgement subsystem. */
  'task-executor',
  /** BRAIN deriver subsystem. */
  'deriver',
  /** Hygiene-scan subsystem. */
  'hygiene',
  /** Plugin-scoped single-turn calls. */
  'plugin',
  /** Context-compression / summarization subsystem. */
  'compression',
  /** Decision conflict-validator (ADR write-gate). */
  'decision-validator',
  /** Title / summary generation (cheap aux tier). */
  'title-generation',
  /** Embedding generation for vector retrieval. */
  'embedding',
] as const;

/**
 * The id of a registered auxiliary subsystem — the element type of
 * {@link AUX_SYSTEM_IDS}.
 *
 * @task T11747
 */
export type AuxSystemId = (typeof AUX_SYSTEM_IDS)[number];

// ---------------------------------------------------------------------------
// Open-axis runtime key prefixes
// ---------------------------------------------------------------------------

/**
 * The four OPEN {@link SystemOfUseKind}s and the string-key prefix each is
 * encoded with for transport across string-only boundaries (config keys, CLI
 * args, audit logs). E.g. `{ kind: 'tool', id: 'web-search' }` ↔ `'tool:web-search'`.
 *
 * Declared as DATA so encode/decode never branches on a hardcoded prefix —
 * `@cleocode/core` reads this map (Gate 10 keeps the runtime split out).
 *
 * @task T11747
 */
export const OPEN_SYSTEM_KEY_PREFIXES = {
  tool: 'tool:',
  skill: 'skill:',
  'cantbook-node': 'cantbook:',
  'spawn-unit': 'spawn-unit:',
} as const satisfies Readonly<Record<OpenSystemKind, string>>;

/**
 * The subset of {@link SystemOfUseKind} whose ids are OPEN (any runtime string),
 * encoded via {@link OPEN_SYSTEM_KEY_PREFIXES}.
 *
 * @task T11747
 */
export type OpenSystemKind = 'tool' | 'skill' | 'cantbook-node' | 'spawn-unit';

// ---------------------------------------------------------------------------
// BUILTIN_SYSTEMS_OF_USE registry
// ---------------------------------------------------------------------------

/**
 * Static registry of every well-known (closed-axis) {@link SystemOfUse}: the
 * four orchestration tiers, the seven {@link RoleName}s, and the ~10 auxiliary
 * subsystems — the hermes `_AUX_TASKS` analog as a single typed table.
 *
 * Open-axis systems (`tool:`/`skill:`/`cantbook:`/`spawn-unit:`) are NOT listed
 * here — they are valid without a registry edit (see {@link OPEN_SYSTEM_KEY_PREFIXES}).
 *
 * Built by spreading the three closed-axis value SSoTs so the registry can
 * never drift from {@link ROLE_SYSTEM_IDS} / {@link ORCHESTRATION_TIER_IDS} /
 * {@link AUX_SYSTEM_IDS}.
 *
 * @task T11747
 * @epic T11745
 */
export const BUILTIN_SYSTEMS_OF_USE = [
  ...ORCHESTRATION_TIER_IDS.map((id): OrchestrationSystem => ({ kind: 'orchestration', id })),
  ...ROLE_SYSTEM_IDS.map((id): RoleSystem => ({ kind: 'role', id })),
  ...AUX_SYSTEM_IDS.map((id): AuxSystem => ({ kind: 'aux', id })),
] as const satisfies readonly SystemOfUse[];

// ---------------------------------------------------------------------------
// Type guards (contracts-pure — Gate 10 allows `v is T` guards)
// ---------------------------------------------------------------------------

/**
 * Type guard: is `value` a {@link SystemOfUse} descriptor (a `{ kind, id }`
 * object whose `kind` is a known {@link SystemOfUseKind})?
 *
 * Structural-only — does NOT assert that closed-axis ids are registered (use
 * {@link isBuiltinSystemOfUse} for that); an open-axis or as-yet-unregistered
 * id still passes.
 *
 * @param value - The candidate value.
 * @returns `true` when `value` is shaped like a {@link SystemOfUse}.
 * @task T11747
 */
export function isSystemOfUse(value: unknown): value is SystemOfUse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { kind?: unknown; id?: unknown };
  if (typeof v.id !== 'string') return false;
  return (
    v.kind === 'role' ||
    v.kind === 'orchestration' ||
    v.kind === 'aux' ||
    v.kind === 'tool' ||
    v.kind === 'skill' ||
    v.kind === 'cantbook-node' ||
    v.kind === 'spawn-unit'
  );
}

/**
 * Type guard: is `value` a closed-axis {@link SystemOfUse} present in
 * {@link BUILTIN_SYSTEMS_OF_USE} (an exact `kind`+`id` match)?
 *
 * @param value - The candidate value.
 * @returns `true` when `value` is a registered builtin system-of-use.
 * @task T11747
 */
export function isBuiltinSystemOfUse(value: unknown): value is SystemOfUse {
  if (!isSystemOfUse(value)) return false;
  return BUILTIN_SYSTEMS_OF_USE.some((s) => s.kind === value.kind && s.id === value.id);
}

/**
 * Type guard: is `kind` an OPEN-axis {@link OpenSystemKind} (one whose ids are
 * encoded with an {@link OPEN_SYSTEM_KEY_PREFIXES} prefix)?
 *
 * @param kind - The kind discriminant to test.
 * @returns `true` for `tool` / `skill` / `cantbook-node` / `spawn-unit`.
 * @task T11747
 */
export function isOpenSystemKind(kind: SystemOfUseKind): kind is OpenSystemKind {
  return kind === 'tool' || kind === 'skill' || kind === 'cantbook-node' || kind === 'spawn-unit';
}

// ---------------------------------------------------------------------------
// Runtime-registered systems-of-use (registerSystemOfUse — T11751)
// ---------------------------------------------------------------------------

/**
 * The default provider/model binding a runtime-registered {@link SystemOfUse}
 * advertises (T11751 · AC1).
 *
 * `registerSystemOfUse(key, displayName, defaults)` lets a plugin / extension /
 * downstream package declare a NEW system-of-use without a registry edit and
 * give it a default binding. That default is consulted strictly BELOW user
 * config (`llm.systems[key]` / `llm.default` / `llm.defaultProfile`) so the user
 * always wins — it only supplies a binding when the user has configured nothing
 * for that key.
 *
 * Either `profile` (a key of `LlmConfig.profiles`) OR an inline `provider` +
 * `model` tuple supplies the binding; `profile` wins when both are present. An
 * entry that supplies neither a resolvable `profile` nor a complete
 * `provider`+`model` tuple is structurally incomplete and is skipped at
 * resolution time (the chain falls through to implicit-fallback) — never an
 * error.
 *
 * @task T11751
 * @epic T11745
 */
export interface SystemOfUseDefaults {
  /**
   * Optional reference to a named profile in `LlmConfig.profiles`. When set and
   * resolvable, the named profile's provider/model/credentialLabel win over this
   * entry's inline tuple.
   */
  readonly profile?: string;
  /** Inline LLM provider transport (used when `profile` is absent/unresolvable). */
  readonly provider?: LlmProviderTransport;
  /** Inline full model identifier (used when `profile` is absent/unresolvable). */
  readonly model?: string;
  /**
   * Optional credential label pinning this default to a specific credential pool
   * entry. When omitted, standard priority-based credential resolution applies.
   */
  readonly credentialLabel?: string;
}

/**
 * A runtime-registered system-of-use — the merged record surfaced by the
 * profile-picker enumeration (T11751 · AC2).
 *
 * @task T11751
 * @epic T11745
 */
export interface RegisteredSystemOfUse {
  /** Encoded system-of-use key (e.g. `'sentient'`, `'tool:web-search'`). */
  readonly key: string;
  /** Human-readable display name for the picker surface. */
  readonly displayName: string;
  /** Default binding consulted strictly below user config (user wins). */
  readonly defaults: SystemOfUseDefaults;
}

/**
 * One enumerated entry in the merged profile-picker surface (T11751 · AC2).
 *
 * Combines the structured {@link SystemOfUse} identity with its display name and
 * provenance so the TUI/Studio picker can render every well-known builtin AND
 * every runtime-registered system in one list.
 *
 * @task T11751
 * @epic T11745
 */
export interface SystemOfUsePickerEntry {
  /** Encoded system-of-use key (the picker value). */
  readonly key: string;
  /** Human-readable display name. */
  readonly displayName: string;
  /** Discriminant axis of this system (see {@link SystemOfUseKind}). */
  readonly kind: SystemOfUseKind;
  /** Where this entry came from: a static builtin or a runtime registration. */
  readonly source: 'builtin' | 'registered';
  /**
   * The default binding when `source === 'registered'`. Absent for builtins
   * (their binding is resolved purely from user config + the role/aux mapping).
   */
  readonly defaults?: SystemOfUseDefaults;
}
