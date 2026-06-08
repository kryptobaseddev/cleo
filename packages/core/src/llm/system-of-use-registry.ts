/**
 * `registerSystemOfUse` — runtime extension point for the E9 system-of-use
 * taxonomy (T11751 · AC1).
 *
 * ## Why a runtime registry
 *
 * {@link BUILTIN_SYSTEMS_OF_USE} is the static, closed-axis registry of the
 * well-known systems (orchestration tiers + roles + aux subsystems). Plugins,
 * extensions, and downstream packages need to declare NEW systems-of-use (e.g.
 * a `tool:my-search` or a bespoke `aux`-like subsystem) and give each a default
 * provider/model binding — WITHOUT editing the contracts SSoT.
 *
 * `registerSystemOfUse(key, displayName, defaults)` adds such a system to a
 * process-level registry. The registered default binding is consulted by the
 * single E9 resolution chokepoint (`resolveLLMForSystem` → `resolveLLMForRole`)
 * **strictly BELOW user config** — after `llm.systems[key]`, `llm.default`, and
 * `llm.defaultProfile` — so the user ALWAYS wins (AC1). A registered default
 * only supplies a binding when the user has configured nothing for that key.
 *
 * ## Import-time purity
 *
 * This module performs NO registration at import time — the registry starts
 * empty and is populated only by explicit `registerSystemOfUse(...)` calls. It
 * holds no I/O, no config reads, and no side effects on load (so importing it
 * is always safe). It is the runtime half intentionally split out of the
 * type-only `@cleocode/contracts` (Gate 10).
 *
 * @module llm/system-of-use-registry
 * @task T11751
 * @epic T11745
 */

import {
  BUILTIN_SYSTEMS_OF_USE,
  type RegisteredSystemOfUse,
  type SystemOfUseDefaults,
  type SystemOfUseKind,
  type SystemOfUsePickerEntry,
} from '@cleocode/contracts';
import { getLogger } from '../logger.js';
import { formatSystemKey, systemKeyKind } from './system-key.js';

const logger = getLogger('llm-system-of-use-registry');

/**
 * Process-level registry of runtime-registered systems-of-use, keyed by encoded
 * system key. Starts EMPTY — populated only by {@link registerSystemOfUse}.
 *
 * Module-private: callers reach it through the exported functions so the
 * "user wins" / "register vs read" contract is enforced in one place.
 */
const REGISTRY = new Map<string, RegisteredSystemOfUse>();

/**
 * A registered system-of-use whose `defaults` carry neither a `profile` nor a
 * complete `provider`+`model` tuple is structurally incomplete: it can declare
 * presence in the picker but cannot supply a resolution binding. Such a default
 * is skipped at resolution time (the chain falls through) — never an error.
 *
 * @param defaults - The candidate default binding.
 * @returns `true` when the default can actually bind a provider/model.
 * @task T11751
 */
export function isResolvableSystemDefault(defaults: SystemOfUseDefaults): boolean {
  if (defaults.profile) return true;
  return Boolean(defaults.provider && defaults.model);
}

/**
 * Register a new system-of-use with a default provider/model binding (AC1).
 *
 * The registration is merged UNDER user config: the resolver consults
 * `defaults` only when the user has configured nothing more specific for `key`
 * (no `llm.systems[key]`, no `llm.default`, no `llm.defaultProfile`). Re-calling
 * with the same `key` REPLACES the prior registration (last-write-wins) so a
 * package can update its own default idempotently.
 *
 * `key` MAY be a flat label (e.g. `'sentient'`) or an open-axis encoded key
 * (`'tool:web-search'`). Passing a structured `SystemOfUse` descriptor is also
 * supported via {@link registerSystemOfUseDescriptor}.
 *
 * @param key         - Encoded system-of-use key (non-empty).
 * @param displayName - Human-readable name for the picker surface (non-empty).
 * @param defaults    - Default binding consulted strictly below user config.
 * @returns The stored {@link RegisteredSystemOfUse} record.
 * @throws {RangeError} When `key` or `displayName` is empty.
 * @task T11751
 * @epic T11745
 */
export function registerSystemOfUse(
  key: string,
  displayName: string,
  defaults: SystemOfUseDefaults,
): RegisteredSystemOfUse {
  if (!key.trim()) {
    throw new RangeError('registerSystemOfUse: `key` must be a non-empty string');
  }
  if (!displayName.trim()) {
    throw new RangeError('registerSystemOfUse: `displayName` must be a non-empty string');
  }

  const record: RegisteredSystemOfUse = {
    key,
    displayName,
    // Defensive copy — the registry owns its records and never aliases the
    // caller's object (so a later caller mutation cannot rewrite a binding).
    defaults: { ...defaults },
  };
  REGISTRY.set(key, record);

  if (!isResolvableSystemDefault(defaults)) {
    logger.debug(
      { key },
      'registerSystemOfUse: registered with a non-binding default (picker-only) ' +
        '— resolution will fall through past this entry',
    );
  }
  return record;
}

/**
 * Register a system-of-use from a structured {@link SystemOfUse} descriptor,
 * encoding it to its canonical string key via {@link formatSystemKey}.
 *
 * Convenience wrapper over {@link registerSystemOfUse} for callers that already
 * hold a `{ kind, id }` descriptor (e.g. plugin-declared tools/skills).
 *
 * @param system      - The structured descriptor to register.
 * @param displayName - Human-readable name for the picker surface.
 * @param defaults    - Default binding consulted strictly below user config.
 * @returns The stored {@link RegisteredSystemOfUse} record.
 * @task T11751
 */
export function registerSystemOfUseDescriptor(
  system: Parameters<typeof formatSystemKey>[0],
  displayName: string,
  defaults: SystemOfUseDefaults,
): RegisteredSystemOfUse {
  return registerSystemOfUse(formatSystemKey(system), displayName, defaults);
}

/**
 * Look up the runtime-registered default binding for an encoded system key.
 *
 * Returns `undefined` when no system is registered under `key` OR when its
 * default is structurally incomplete (so the resolver falls through). This is
 * the read surface the E9 resolver calls AFTER exhausting all user-config tiers.
 *
 * @param key - Encoded system-of-use key (may be undefined — returns undefined).
 * @returns The resolvable {@link SystemOfUseDefaults}, or `undefined`.
 * @task T11751
 */
export function getRegisteredSystemDefault(
  key: string | undefined,
): SystemOfUseDefaults | undefined {
  if (!key) return undefined;
  const record = REGISTRY.get(key);
  if (!record) return undefined;
  if (!isResolvableSystemDefault(record.defaults)) return undefined;
  return record.defaults;
}

/**
 * Enumerate every system-of-use for the TUI / Studio profile picker (AC2):
 * the static {@link BUILTIN_SYSTEMS_OF_USE} table followed by every
 * runtime-registered system, de-duplicated by key (a registration for a builtin
 * key overrides the builtin entry — "user/runtime wins" for the picker label).
 *
 * Each entry carries its encoded `key`, a `displayName`, the discriminant
 * `kind`, and its `source` (`'builtin'` | `'registered'`) so the picker can
 * render and group them. Registered entries also surface their `defaults`.
 *
 * @param kind - Optional kind filter — when set, only that axis is returned.
 * @returns The merged, ordered picker entries.
 * @task T11751
 * @epic T11745
 */
export function listSystemsOfUse(kind?: SystemOfUseKind): SystemOfUsePickerEntry[] {
  const byKey = new Map<string, SystemOfUsePickerEntry>();

  // 1. Builtins first (stable order from the contracts SSoT).
  for (const sys of BUILTIN_SYSTEMS_OF_USE) {
    const key = formatSystemKey(sys);
    byKey.set(key, {
      key,
      displayName: defaultDisplayName(sys.kind, sys.id),
      kind: sys.kind,
      source: 'builtin',
    });
  }

  // 2. Runtime registrations override/extend (registered wins on key collision).
  for (const record of REGISTRY.values()) {
    byKey.set(record.key, {
      key: record.key,
      displayName: record.displayName,
      kind: systemKeyKind(record.key),
      source: 'registered',
      defaults: record.defaults,
    });
  }

  const entries = [...byKey.values()];
  return kind ? entries.filter((e) => e.kind === kind) : entries;
}

/**
 * Clear all runtime registrations.
 *
 * Intended for test isolation — production code never needs to un-register a
 * system. Builtins are unaffected (they live in the contracts SSoT, not here).
 *
 * @internal
 * @task T11751
 */
export function clearRegisteredSystemsOfUse(): void {
  REGISTRY.clear();
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derive a human-readable default display name for a builtin system. Plain
 * id-with-kind-prefix; the picker may localise/override on top of this.
 */
function defaultDisplayName(kind: SystemOfUseKind, id: string): string {
  return `${kind}: ${id}`;
}
