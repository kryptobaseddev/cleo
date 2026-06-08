/**
 * Runtime encode/decode for {@link SystemOfUse} string keys (E9 · T11751).
 *
 * The structured `{ kind, id }` {@link SystemOfUse} descriptor must cross
 * string-only boundaries (config keys under `llm.systems[...]`, CLI args, audit
 * logs, the runtime registry in `system-of-use-registry.ts`). This module is the
 * single canonical codec between the descriptor and its flat string form.
 *
 * Encoding rules (driven entirely by the {@link OPEN_SYSTEM_KEY_PREFIXES} DATA
 * declared in `@cleocode/contracts`, so the prefix set never drifts):
 *
 *   - OPEN axes (`tool` / `skill` / `cantbook-node` / `spawn-unit`) →
 *     `<prefix><id>` (e.g. `{ kind: 'tool', id: 'web-search' }` ↔ `'tool:web-search'`).
 *   - CLOSED axes (`role` / `orchestration` / `aux`) → the bare `id`
 *     (e.g. `{ kind: 'aux', id: 'sentient' }` ↔ `'sentient'`). The flat label
 *     vocabulary the resolver already accepts (`SystemOfUseLabel`) IS the closed
 *     `aux`/`role` id, so closed keys round-trip without a prefix.
 *
 * Contracts-purity (Gate 10): this runtime codec lives in `@cleocode/core`, NOT
 * in the type-only contracts package — it only READS the
 * {@link OPEN_SYSTEM_KEY_PREFIXES} data map.
 *
 * @module llm/system-key
 * @task T11751
 * @epic T11745
 */

import {
  isOpenSystemKind,
  OPEN_SYSTEM_KEY_PREFIXES,
  type OpenSystemKind,
  type SystemOfUse,
  type SystemOfUseKind,
} from '@cleocode/contracts';

/**
 * Encode a structured {@link SystemOfUse} descriptor into its canonical string
 * key (the form stored in `llm.systems[...]` and the runtime registry).
 *
 * Open-axis descriptors gain their {@link OPEN_SYSTEM_KEY_PREFIXES} prefix;
 * closed-axis descriptors (`role` / `orchestration` / `aux`) encode to the bare
 * `id` so they round-trip with the flat resolver label vocabulary.
 *
 * @param system - The descriptor to encode.
 * @returns The canonical string key.
 * @task T11751
 */
export function formatSystemKey(system: SystemOfUse): string {
  if (isOpenSystemKind(system.kind)) {
    return `${OPEN_SYSTEM_KEY_PREFIXES[system.kind]}${system.id}`;
  }
  // Closed axes (role / orchestration / aux) encode to the bare id.
  return system.id;
}

/**
 * Decode an open-axis string key back into its {@link SystemOfUse} descriptor.
 *
 * Returns `undefined` for a bare key with NO recognised open prefix — such keys
 * are closed-axis ids (`role` / `orchestration` / `aux`) whose `kind` cannot be
 * inferred from the string alone (the same `'sentient'` is an `aux` id and a
 * resolver label). Callers that need the closed-axis descriptor must consult the
 * value SSoTs (`AUX_SYSTEM_IDS` / `ROLE_SYSTEM_IDS` / `ORCHESTRATION_TIER_IDS`).
 *
 * @param key - The string key to decode.
 * @returns The open-axis descriptor, or `undefined` for an un-prefixed key.
 * @task T11751
 */
export function parseSystemKey(key: string): SystemOfUse | undefined {
  for (const kind of Object.keys(OPEN_SYSTEM_KEY_PREFIXES) as OpenSystemKind[]) {
    const prefix = OPEN_SYSTEM_KEY_PREFIXES[kind];
    if (key.startsWith(prefix)) {
      const id = key.slice(prefix.length);
      if (!id) return undefined;
      return { kind, id } as SystemOfUse;
    }
  }
  return undefined;
}

/**
 * The {@link SystemOfUseKind} a string key encodes, inferred from its prefix.
 *
 * Open-prefixed keys return their open kind; un-prefixed keys are reported as
 * `'aux'` (the closed lane the flat resolver labels live in). Pure inspection —
 * does not assert the id is registered.
 *
 * @param key - The string key to inspect.
 * @returns The inferred kind.
 * @task T11751
 */
export function systemKeyKind(key: string): SystemOfUseKind {
  const parsed = parseSystemKey(key);
  return parsed ? parsed.kind : 'aux';
}
