/**
 * CAAMP Hooks Normalizer
 *
 * Translates between CAAMP canonical hook events and provider-native
 * event names. Provides query functions for hook support, cross-provider
 * comparison, and event normalization.
 *
 * This module follows the same pattern as `src/core/mcp/transforms.ts` —
 * a translation layer that lets consumers use one canonical interface
 * while CAAMP handles provider-specific differences.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRegistryTemplatePath } from '../paths/standard.js';
import type {
  CanonicalEventDefinition,
  CanonicalHookEvent,
  CrossProviderMatrix,
  HookCategory,
  HookMapping,
  HookMappingsFile,
  HookSupportResult,
  HookSystemType,
  NormalizedHookEvent,
  ProviderHookProfile,
  ProviderHookSummary,
} from './types.js';
import { CANONICAL_HOOK_EVENTS, PROVIDER_HOOK_EVENTS } from './types.js';

// ── Data Loading ────────────────────────────────────────────────────

let _mappings: HookMappingsFile | null = null;

function findMappingsPath(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  // src/core/hooks/ -> providers/hook-mappings.json
  return join(thisDir, '..', '..', '..', 'providers', 'hook-mappings.json');
}

function loadMappings(): HookMappingsFile {
  if (_mappings) return _mappings;
  const mappingsPath = findMappingsPath();
  if (!existsSync(mappingsPath)) {
    // Return an empty but structurally valid mappings object when the file is missing.
    // This avoids ENOENT crashes in installed environments where the providers/
    // directory may not be bundled (e.g. global npm installs with hoisted deps).
    const empty: HookMappingsFile = {
      version: '0.0.0',
      lastUpdated: new Date().toISOString(),
      description: 'Empty fallback — hook-mappings.json not found',
      canonicalEvents: {} as HookMappingsFile['canonicalEvents'],
      providerMappings: {},
    };
    _mappings = empty;
    return empty;
  }
  const raw = readFileSync(mappingsPath, 'utf-8');
  _mappings = JSON.parse(raw) as HookMappingsFile;
  return _mappings;
}

/**
 * Reset the cached hook mappings data.
 *
 * @remarks
 * Clears the in-memory cache so the next query function call will
 * re-read `providers/hook-mappings.json` from disk. This is primarily
 * intended for test isolation — production code should not need to call this.
 *
 * @example
 * ```typescript
 * import { resetHookMappings, getHookMappingsVersion } from "./normalizer.js";
 *
 * // Force a fresh load from disk
 * resetHookMappings();
 * const version = getHookMappingsVersion();
 * ```
 *
 * @public
 */
export function resetHookMappings(): void {
  _mappings = null;
}

// ── Core Query Functions ────────────────────────────────────────────

/**
 * Get the canonical event definition (category, description, canBlock).
 *
 * @remarks
 * Looks up the definition from the hook mappings data file. The returned
 * object contains the event's category, human-readable description, and
 * whether handlers can block the associated action.
 *
 * @param event - The canonical event name to look up.
 * @returns The event definition containing category, description, and canBlock flag.
 *
 * @example
 * ```typescript
 * import { getCanonicalEvent } from "./normalizer.js";
 *
 * const def = getCanonicalEvent("PreToolUse");
 * console.log(def.category);  // "tool"
 * console.log(def.canBlock);  // true
 * ```
 *
 * @public
 */
export function getCanonicalEvent(event: CanonicalHookEvent): CanonicalEventDefinition {
  const data = loadMappings();
  return data.canonicalEvents[event];
}

/**
 * Get all canonical event definitions.
 *
 * @remarks
 * Returns the complete map of canonical event names to their definitions.
 * Useful for iterating over the full taxonomy or building UI displays
 * of all available events.
 *
 * @returns A record mapping every canonical event name to its definition.
 *
 * @example
 * ```typescript
 * import { getAllCanonicalEvents } from "./normalizer.js";
 *
 * const events = getAllCanonicalEvents();
 * for (const [name, def] of Object.entries(events)) {
 *   console.log(`${name}: ${def.description}`);
 * }
 * ```
 *
 * @public
 */
export function getAllCanonicalEvents(): Record<CanonicalHookEvent, CanonicalEventDefinition> {
  return loadMappings().canonicalEvents;
}

/**
 * Get canonical events filtered by category.
 *
 * @remarks
 * Filters the canonical event list to only those belonging to the specified
 * category. Useful for displaying events grouped by lifecycle phase
 * (e.g. all `"tool"` events or all `"session"` events).
 *
 * @param category - The hook category to filter by (e.g. `"session"`, `"tool"`).
 * @returns Array of canonical event names that belong to the specified category.
 *
 * @example
 * ```typescript
 * import { getCanonicalEventsByCategory } from "./normalizer.js";
 *
 * const toolEvents = getCanonicalEventsByCategory("tool");
 * // ["PreToolUse", "PostToolUse", "PostToolUseFailure"]
 * ```
 *
 * @public
 */
export function getCanonicalEventsByCategory(category: HookCategory): CanonicalHookEvent[] {
  const data = loadMappings();
  return CANONICAL_HOOK_EVENTS.filter((event) => data.canonicalEvents[event].category === category);
}

/**
 * Get the full hook profile for a provider.
 *
 * @remarks
 * Returns the complete hook configuration for a provider including its
 * hook system type, config path, handler types, and all event mappings.
 * Returns `undefined` if the provider has no hook mappings defined.
 *
 * @param providerId - The provider identifier (e.g. `"claude-code"`, `"gemini-cli"`).
 * @returns The provider's hook profile, or `undefined` if not found.
 *
 * @example
 * ```typescript
 * import { getProviderHookProfile } from "./normalizer.js";
 *
 * const profile = getProviderHookProfile("claude-code");
 * if (profile) {
 *   console.log(profile.hookSystem); // "config"
 *   console.log(profile.experimental); // false
 * }
 * ```
 *
 * @public
 */
export function getProviderHookProfile(providerId: string): ProviderHookProfile | undefined {
  const data = loadMappings();
  return data.providerMappings[providerId];
}

/**
 * Get all provider IDs that have hook mappings.
 *
 * @remarks
 * Returns the list of provider identifiers present in the hook mappings
 * data file. This reflects all providers for which CAAMP has hook
 * translation data, regardless of whether they support any events.
 *
 * @returns Array of provider ID strings.
 *
 * @example
 * ```typescript
 * import { getMappedProviderIds } from "./normalizer.js";
 *
 * const ids = getMappedProviderIds();
 * // ["claude-code", "gemini-cli", "cursor", "kimi", ...]
 * ```
 *
 * @public
 */
export function getMappedProviderIds(): string[] {
  return Object.keys(loadMappings().providerMappings);
}

// ── Normalization: Canonical → Native ───────────────────────────────

/**
 * Translate a CAAMP canonical event name to the provider's native name.
 *
 * @remarks
 * This is the primary forward-translation function. Given a canonical
 * event and a provider ID, it returns the provider-specific event name
 * that should be used when configuring hooks for that provider.
 * Returns `null` if the provider is unknown or does not support the event.
 *
 * @param canonical - The CAAMP canonical event name to translate.
 * @param providerId - The target provider identifier.
 * @returns The native event name, or `null` if unsupported.
 *
 * @example
 * ```typescript
 * import { toNative } from "./normalizer.js";
 *
 * toNative("PreToolUse", "claude-code");   // "PreToolUse"
 * toNative("PreToolUse", "gemini-cli");    // "BeforeTool"
 * toNative("PreToolUse", "cursor");        // "preToolUse"
 * toNative("PreToolUse", "kimi");          // null
 * ```
 *
 * @public
 */
export function toNative(canonical: CanonicalHookEvent, providerId: string): string | null {
  const profile = getProviderHookProfile(providerId);
  if (!profile) return null;
  const mapping = profile.mappings[canonical];
  return mapping?.supported ? mapping.nativeName : null;
}

/**
 * Translate a provider-native event name to the CAAMP canonical name.
 *
 * @remarks
 * This is the reverse-translation function. Scans all event mappings
 * for the given provider to find a canonical match for the native name.
 * Returns `null` if no mapping is found or the provider is unknown.
 *
 * @param nativeName - The provider-native event name to look up.
 * @param providerId - The provider identifier to search within.
 * @returns The canonical event name, or `null` if no mapping exists.
 *
 * @example
 * ```typescript
 * import { toCanonical } from "./normalizer.js";
 *
 * toCanonical("BeforeTool", "gemini-cli");     // "PreToolUse"
 * toCanonical("stop", "cursor");               // "ResponseComplete"
 * toCanonical("UserPromptSubmit", "claude-code"); // "PromptSubmit"
 * ```
 *
 * @public
 */
export function toCanonical(nativeName: string, providerId: string): CanonicalHookEvent | null {
  const profile = getProviderHookProfile(providerId);
  if (!profile) return null;

  for (const [canonical, mapping] of Object.entries(profile.mappings)) {
    if (mapping.supported && mapping.nativeName === nativeName) {
      return canonical as CanonicalHookEvent;
    }
  }
  return null;
}

/**
 * Batch-translate multiple canonical events to native names for a provider.
 *
 * @remarks
 * Translates an array of canonical events in a single call, returning
 * only the events that the provider actually supports. Each result
 * includes category and blocking metadata. Unsupported events are
 * silently excluded from the output.
 *
 * @param canonicals - Array of canonical event names to translate.
 * @param providerId - The target provider identifier.
 * @returns Array of normalized events (only supported ones included).
 *
 * @example
 * ```typescript
 * import { toNativeBatch } from "./normalizer.js";
 *
 * const events = toNativeBatch(
 *   ["PreToolUse", "PostToolUse", "ConfigChange"],
 *   "claude-code",
 * );
 * // Returns NormalizedHookEvent[] for supported events only
 * ```
 *
 * @public
 */
export function toNativeBatch(
  canonicals: CanonicalHookEvent[],
  providerId: string,
): NormalizedHookEvent[] {
  const data = loadMappings();
  const profile = data.providerMappings[providerId];
  if (!profile) return [];

  const results: NormalizedHookEvent[] = [];
  for (const canonical of canonicals) {
    const mapping = profile.mappings[canonical];
    if (mapping?.supported && mapping.nativeName) {
      results.push({
        canonical,
        native: mapping.nativeName,
        providerId,
        category: data.canonicalEvents[canonical].category,
        canBlock: data.canonicalEvents[canonical].canBlock,
      });
    }
  }
  return results;
}

// ── Support Queries ─────────────────────────────────────────────────

/**
 * Check if a provider supports a specific canonical hook event.
 *
 * @remarks
 * A quick boolean check that avoids returning the full mapping details.
 * Returns `false` if the provider is unknown or the event is not supported.
 *
 * @param canonical - The canonical event name to check.
 * @param providerId - The provider identifier to check against.
 * @returns `true` if the provider supports this canonical event, `false` otherwise.
 *
 * @example
 * ```typescript
 * import { supportsHook } from "./normalizer.js";
 *
 * supportsHook("PreToolUse", "claude-code"); // true
 * supportsHook("PreToolUse", "kimi");        // false
 * ```
 *
 * @public
 */
export function supportsHook(canonical: CanonicalHookEvent, providerId: string): boolean {
  const profile = getProviderHookProfile(providerId);
  if (!profile) return false;
  return profile.mappings[canonical]?.supported ?? false;
}

/**
 * Get full hook support details for a canonical event on a provider.
 *
 * @remarks
 * Returns a structured result with the native name translation and any
 * notes about support limitations. Unlike `supportsHook()`, this always
 * returns a result object even when the provider is unknown (with
 * `supported: false`).
 *
 * @param canonical - The canonical event name to query.
 * @param providerId - The provider identifier to query against.
 * @returns Support result including native name and optional notes.
 *
 * @example
 * ```typescript
 * import { getHookSupport } from "./normalizer.js";
 *
 * const result = getHookSupport("PreToolUse", "claude-code");
 * console.log(result.supported); // true
 * console.log(result.native);    // "PreToolUse"
 * ```
 *
 * @public
 */
export function getHookSupport(
  canonical: CanonicalHookEvent,
  providerId: string,
): HookSupportResult {
  const profile = getProviderHookProfile(providerId);
  if (!profile) {
    return { canonical, supported: false, native: null };
  }
  const mapping = profile.mappings[canonical];
  return {
    canonical,
    supported: mapping?.supported ?? false,
    native: mapping?.nativeName ?? null,
    notes: mapping?.notes,
  };
}

/**
 * Get all supported canonical events for a provider.
 *
 * @remarks
 * Filters the full canonical event list to only those that the provider
 * supports. Returns an empty array if the provider is unknown.
 *
 * @param providerId - The provider identifier to query.
 * @returns Array of canonical event names the provider supports.
 *
 * @example
 * ```typescript
 * import { getSupportedEvents } from "./normalizer.js";
 *
 * const events = getSupportedEvents("claude-code");
 * // ["SessionStart", "SessionEnd", "PreToolUse", ...]
 * ```
 *
 * @public
 */
export function getSupportedEvents(providerId: string): CanonicalHookEvent[] {
  const profile = getProviderHookProfile(providerId);
  if (!profile) return [];
  // Only provider events have provider mappings; domain events are not provider-translatable
  return PROVIDER_HOOK_EVENTS.filter((event) => profile.mappings[event]?.supported);
}

/**
 * Get all unsupported canonical events for a provider.
 *
 * @remarks
 * Returns the complement of `getSupportedEvents()`. If the provider is
 * unknown, all canonical events are returned since none are supported.
 *
 * @param providerId - The provider identifier to query.
 * @returns Array of canonical event names the provider does not support.
 *
 * @example
 * ```typescript
 * import { getUnsupportedEvents } from "./normalizer.js";
 *
 * const missing = getUnsupportedEvents("kimi");
 * // Returns all canonical events (kimi has no hook support)
 * ```
 *
 * @public
 */
export function getUnsupportedEvents(providerId: string): CanonicalHookEvent[] {
  const profile = getProviderHookProfile(providerId);
  // Only provider events have provider mappings; domain events are not provider-translatable
  if (!profile) return [...PROVIDER_HOOK_EVENTS];
  return PROVIDER_HOOK_EVENTS.filter((event) => !profile.mappings[event]?.supported);
}

/**
 * Get providers that support a specific canonical event.
 *
 * @remarks
 * Scans all provider mappings and returns the IDs of those that support
 * the given canonical event. Useful for determining which providers can
 * be targeted when configuring a specific hook.
 *
 * @param canonical - The canonical event name to search for.
 * @returns Array of provider IDs that support this event.
 *
 * @example
 * ```typescript
 * import { getProvidersForEvent } from "./normalizer.js";
 *
 * const providers = getProvidersForEvent("PreToolUse");
 * // ["claude-code", "gemini-cli", "cursor"]
 * ```
 *
 * @public
 */
export function getProvidersForEvent(canonical: CanonicalHookEvent): string[] {
  const data = loadMappings();
  return Object.entries(data.providerMappings)
    .filter(([, profile]) => profile.mappings[canonical]?.supported)
    .map(([id]) => id);
}

/**
 * Get canonical events common to all specified providers.
 *
 * @remarks
 * Computes the intersection of supported events across multiple providers.
 * Returns only events that every listed provider supports. Useful for
 * determining which hooks can be configured uniformly across a set of
 * target providers.
 *
 * @param providerIds - Array of provider IDs to intersect.
 * @returns Array of canonical events supported by all specified providers.
 *
 * @example
 * ```typescript
 * import { getCommonEvents } from "./normalizer.js";
 *
 * const common = getCommonEvents(["claude-code", "gemini-cli"]);
 * // Returns only events both providers support
 * ```
 *
 * @public
 */
export function getCommonEvents(providerIds: string[]): CanonicalHookEvent[] {
  if (providerIds.length === 0) return [];
  // Only provider events are relevant for cross-provider comparison
  return PROVIDER_HOOK_EVENTS.filter((event) => providerIds.every((id) => supportsHook(event, id)));
}

// ── Summary & Matrix Functions ──────────────────────────────────────

/**
 * Get a summary of hook support for a provider.
 *
 * @remarks
 * Builds an aggregated view of a provider's hook capabilities including
 * counts, coverage percentage, and categorized event lists. Returns
 * `undefined` if the provider has no hook mappings. Used by the CLI
 * `hooks show` command for provider overviews.
 *
 * @param providerId - The provider identifier to summarize.
 * @returns The hook support summary, or `undefined` if the provider is not found.
 *
 * @example
 * ```typescript
 * import { getProviderSummary } from "./normalizer.js";
 *
 * const summary = getProviderSummary("claude-code");
 * if (summary) {
 *   console.log(`${summary.coverage}% coverage`);
 *   console.log(`${summary.supportedCount}/${summary.totalCanonical} events`);
 * }
 * ```
 *
 * @public
 */
export function getProviderSummary(providerId: string): ProviderHookSummary | undefined {
  const profile = getProviderHookProfile(providerId);
  if (!profile) return undefined;

  const supported = getSupportedEvents(providerId);
  const unsupported = getUnsupportedEvents(providerId);

  return {
    providerId,
    hookSystem: profile.hookSystem,
    experimental: profile.experimental,
    supportedCount: supported.length,
    totalCanonical: PROVIDER_HOOK_EVENTS.length,
    supported,
    unsupported,
    providerOnly: profile.providerOnlyEvents,
    coverage: Math.round((supported.length / PROVIDER_HOOK_EVENTS.length) * 100),
  };
}

/**
 * Build a cross-provider hook support matrix.
 *
 * @remarks
 * Constructs a two-dimensional matrix showing which canonical events are
 * supported by which providers, with native name translations. When no
 * provider IDs are specified, all mapped providers are included. Used by
 * the CLI `hooks matrix` command for comparison tables.
 *
 * @param providerIds - Optional array of provider IDs to include. Defaults to all mapped providers.
 * @returns The cross-provider matrix with events, providers, and mapping data.
 *
 * @example
 * ```typescript
 * import { buildHookMatrix } from "./normalizer.js";
 *
 * const matrix = buildHookMatrix(["claude-code", "gemini-cli"]);
 * for (const event of matrix.events) {
 *   for (const provider of matrix.providers) {
 *     console.log(`${event} @ ${provider}: ${matrix.matrix[event][provider].supported}`);
 *   }
 * }
 * ```
 *
 * @public
 */
export function buildHookMatrix(providerIds?: string[]): CrossProviderMatrix {
  const data = loadMappings();
  const ids = providerIds ?? Object.keys(data.providerMappings);

  // Provider matrix only covers provider events — domain events have no provider mappings
  const matrix: Record<string, Record<string, HookMapping>> = {};
  for (const event of PROVIDER_HOOK_EVENTS) {
    matrix[event] = {};
    for (const id of ids) {
      const profile = data.providerMappings[id];
      matrix[event][id] = profile?.mappings[event] ?? {
        nativeName: null,
        supported: false,
      };
    }
  }

  return {
    events: [...PROVIDER_HOOK_EVENTS],
    providers: ids,
    matrix: matrix as CrossProviderMatrix['matrix'],
  };
}

/**
 * Get the hook system type for a provider.
 *
 * @remarks
 * Returns the provider's hook system type: `"config"` for file-based hooks,
 * `"plugin"` for extension-based hooks, or `"none"` if the provider does
 * not support hooks. Returns `"none"` for unknown providers.
 *
 * @param providerId - The provider identifier to query.
 * @returns The hook system type (`"config"`, `"plugin"`, or `"none"`).
 *
 * @example
 * ```typescript
 * import { getHookSystemType } from "./normalizer.js";
 *
 * getHookSystemType("claude-code"); // "config"
 * getHookSystemType("unknown");     // "none"
 * ```
 *
 * @public
 */
export function getHookSystemType(providerId: string): HookSystemType {
  const profile = getProviderHookProfile(providerId);
  return profile?.hookSystem ?? 'none';
}

/**
 * Get the resolved hook config path for a provider.
 *
 * @remarks
 * Resolves the provider's hook configuration file path by expanding
 * registry template variables (e.g. `~` to the home directory). Returns
 * `null` if the provider has no hook config path defined or is unknown.
 *
 * @param providerId - The provider identifier to query.
 * @returns The resolved filesystem path, or `null` if not available.
 *
 * @example
 * ```typescript
 * import { getHookConfigPath } from "./normalizer.js";
 *
 * const path = getHookConfigPath("claude-code");
 * // "/home/user/.claude/settings.json" (resolved from template)
 * ```
 *
 * @public
 */
export function getHookConfigPath(providerId: string): string | null {
  const profile = getProviderHookProfile(providerId);
  if (!profile?.hookConfigPath) return null;
  return resolveRegistryTemplatePath(profile.hookConfigPath);
}

/**
 * Get provider-only events (native events with no canonical mapping).
 *
 * @remarks
 * Some providers define hook events that have no equivalent in the CAAMP
 * canonical taxonomy. This function returns those provider-specific event
 * names. Returns an empty array for unknown providers.
 *
 * @param providerId - The provider identifier to query.
 * @returns Array of native event names unique to this provider.
 *
 * @example
 * ```typescript
 * import { getProviderOnlyEvents } from "./normalizer.js";
 *
 * const extras = getProviderOnlyEvents("claude-code");
 * // Returns any events specific to Claude Code with no canonical equivalent
 * ```
 *
 * @public
 */
export function getProviderOnlyEvents(providerId: string): string[] {
  const profile = getProviderHookProfile(providerId);
  return profile?.providerOnlyEvents ?? [];
}

// ── Multi-Provider Translation ──────────────────────────────────────

/**
 * Translate a canonical event to native names across multiple providers.
 *
 * @remarks
 * Performs a fan-out translation of a single canonical event to all
 * specified providers simultaneously. The result record only includes
 * providers that actually support the event — unsupported providers
 * are silently excluded.
 *
 * @param canonical - The canonical event name to translate.
 * @param providerIds - Array of provider IDs to translate for.
 * @returns Record mapping provider IDs to their native event names (supported only).
 *
 * @example
 * ```typescript
 * import { translateToAll } from "./normalizer.js";
 *
 * const result = translateToAll("PreToolUse", ["claude-code", "gemini-cli", "kimi"]);
 * // { "claude-code": "PreToolUse", "gemini-cli": "BeforeTool" }
 * // (kimi excluded — unsupported)
 * ```
 *
 * @public
 */
export function translateToAll(
  canonical: CanonicalHookEvent,
  providerIds: string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const id of providerIds) {
    const native = toNative(canonical, id);
    if (native) {
      result[id] = native;
    }
  }
  return result;
}

/**
 * Find the best canonical match for a native event name across all providers.
 *
 * @remarks
 * Scans every provider's mappings to find canonical events that match the
 * given native name. Useful when you have a native name but do not know
 * which provider it belongs to. Multiple results are possible if different
 * providers use the same native name for different canonical events.
 *
 * @param nativeName - The provider-native event name to resolve.
 * @returns Array of matches, each containing the provider ID and canonical event name.
 *
 * @example
 * ```typescript
 * import { resolveNativeEvent } from "./normalizer.js";
 *
 * const matches = resolveNativeEvent("BeforeTool");
 * // [{ providerId: "gemini-cli", canonical: "PreToolUse" }]
 * ```
 *
 * @public
 */
export function resolveNativeEvent(nativeName: string): Array<{
  providerId: string;
  canonical: CanonicalHookEvent;
}> {
  const data = loadMappings();
  const results: Array<{ providerId: string; canonical: CanonicalHookEvent }> = [];

  for (const [providerId, profile] of Object.entries(data.providerMappings)) {
    for (const [canonical, mapping] of Object.entries(profile.mappings)) {
      if (mapping.supported && mapping.nativeName === nativeName) {
        results.push({ providerId, canonical: canonical as CanonicalHookEvent });
      }
    }
  }

  return results;
}

/**
 * Get the version of the hook mappings data.
 *
 * @remarks
 * Returns the semver version string from the hook mappings JSON file.
 * This can be used to check compatibility or display the data version
 * in diagnostic output.
 *
 * @returns The semver version string of the loaded hook mappings data.
 *
 * @example
 * ```typescript
 * import { getHookMappingsVersion } from "./normalizer.js";
 *
 * const version = getHookMappingsVersion();
 * console.log(`Hook mappings v${version}`);
 * ```
 *
 * @public
 */
export function getHookMappingsVersion(): string {
  return loadMappings().version;
}
