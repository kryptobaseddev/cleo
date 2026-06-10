/**
 * Pure provider-alias resolution over {@link ProviderDef.aliases} (T11704).
 *
 * M3 Provider SSoT (epic T11667 · task T11704). {@link resolveProviderId} maps a name
 * OR an alias to its canonical provider id, reading the {@link ProviderDef} set's
 * `aliases` arrays as the SINGLE source — `codex`/`chatgpt` → `openai`,
 * `claude` → `anthropic`, `google` → `gemini`, … It is the declarative replacement
 * for the ad-hoc `_aliases` Map the in-process registry populates imperatively.
 *
 * ## Pure + deterministic + side-effect-free (AC2 · AC5)
 *
 * The resolver is a pure function of `(input, defs)`: no DB, no network, no module
 * state. {@link buildAliasIndex} folds the provider set into an immutable
 * `alias → id` index once; {@link resolveProviderId} is a single case-insensitive
 * lookup. An alias that collides with ANOTHER provider's primary id is rejected at
 * index-build time (a hard error) so a mis-declared alias can never silently
 * mis-route. Unknown input returns `null`.
 *
 * @module llm/provider-registry/provider-alias
 * @task T11704
 * @epic T11667
 * @see @cleocode/contracts — {@link ProviderDef} (the declarative contract, T11702)
 * @see ./provider-defs.ts — {@link builtinProviderDefs} (the default provider set)
 */

import type { ProviderDef } from '@cleocode/contracts';
import { builtinProviderDefs } from './provider-defs.js';

/**
 * An immutable case-insensitive `alias-or-id → canonical-id` index built from a
 * provider set. Every provider's own id maps to itself; every alias maps to its
 * provider's id.
 *
 * @task T11704
 */
export type ProviderAliasIndex = ReadonlyMap<string, string>;

/**
 * Build the immutable {@link ProviderAliasIndex} from a provider set.
 *
 * Every provider's lower-cased `id` maps to itself; every lower-cased alias maps to
 * its provider's id. Pure + deterministic.
 *
 * @param defs - The provider definitions (defaults to {@link builtinProviderDefs}).
 * @returns The case-insensitive alias index.
 * @throws {Error} When an alias collides with ANOTHER provider's primary id, or two
 *   providers declare the SAME alias (ambiguous resolution — AC2).
 * @task T11704
 */
export function buildAliasIndex(
  defs: ReadonlyArray<ProviderDef> = builtinProviderDefs(),
): ProviderAliasIndex {
  const ids = new Set<string>();
  for (const def of defs) ids.add(def.id.toLowerCase());

  const index = new Map<string, string>();
  // Primary ids first — an id always resolves to itself.
  for (const id of ids) index.set(id, id);

  for (const def of defs) {
    const canonical = def.id.toLowerCase();
    for (const alias of def.aliases) {
      const key = alias.toLowerCase();
      // An alias that IS another provider's primary id is a hard collision.
      if (ids.has(key) && key !== canonical) {
        throw new Error(
          `[provider-alias] Alias "${alias}" for provider "${def.id}" collides with the ` +
            `primary id of another provider.`,
        );
      }
      const existing = index.get(key);
      if (existing !== undefined && existing !== canonical) {
        throw new Error(
          `[provider-alias] Alias "${alias}" is declared by both "${existing}" and ` +
            `"${def.id}" — ambiguous resolution.`,
        );
      }
      index.set(key, canonical);
    }
  }
  return index;
}

/**
 * Resolve a provider name or alias to its canonical provider id (case-insensitive).
 *
 * Pure + deterministic + side-effect-free. `codex`/`chatgpt` → `openai`,
 * `claude` → `anthropic`, an exact provider id → itself. Returns `null` for an
 * unknown name (callers handle the generic/fallback case).
 *
 * @param input - The provider name or alias to resolve.
 * @param indexOrDefs - An already-built {@link ProviderAliasIndex}, OR the provider
 *   set to build one from (defaults to {@link builtinProviderDefs}). Pass the prebuilt
 *   index in a hot loop to avoid rebuilding per call.
 * @returns The canonical provider id, or `null` when `input` matches no id/alias.
 * @task T11704
 */
export function resolveProviderId(
  input: string,
  indexOrDefs: ProviderAliasIndex | ReadonlyArray<ProviderDef> = builtinProviderDefs(),
): string | null {
  // Discriminate on the Map's `get` method — an already-built ProviderAliasIndex
  // (a ReadonlyMap) has it; a provider-set array does not (build the index from it).
  const index: ProviderAliasIndex =
    'get' in indexOrDefs ? indexOrDefs : buildAliasIndex(indexOrDefs);
  return index.get(input.trim().toLowerCase()) ?? null;
}
