/**
 * CLEO Provider Registry — public API.
 *
 * A lightweight, in-process registry mapping canonical provider names (and
 * their aliases) to {@link ProviderProfile} descriptors. Ported idiomatically
 * from the Hermes provider registry (`providers/__init__.py`).
 *
 * ## Semantics
 * - Last-writer-wins on `name` collision — user plugins override builtins.
 * - Alias conflicts with another profile's **primary** name throw at
 *   registration time to prevent silent mis-routing.
 * - Discovery is lazy and idempotent: the first call to `getProviderProfile`
 *   or `listProviders` triggers a one-shot discovery pass that:
 *     1. Registers all builtin profiles.
 *     2. Scans `${CLEO_HOME}/plugins/model-providers/` for user plugins.
 *   Subsequent calls reuse the same discovery promise.
 *
 * @task T9262
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 *
 * @example
 * ```ts
 * import { getProviderProfile, listProviders } from '@cleocode/core/llm/provider-registry';
 *
 * const profile = await getProviderProfile('anthropic');
 * // → { name: 'anthropic', displayName: 'Anthropic Claude', … }
 *
 * const all = await listProviders();
 * // → [{ name: 'anthropic', … }]
 * ```
 */

import type { ProviderProfile } from '@cleocode/contracts';
import { anthropicProfile } from './builtin/anthropic.js';
import { bedrockProfile } from './builtin/bedrock.js';
import { geminiProfile } from './builtin/gemini.js';
import { kimiCodeProfile } from './builtin/kimi-code.js';
import { moonshotProfile } from './builtin/moonshot.js';
import { ollamaProfile } from './builtin/ollama.js';
import { openrouterProfile } from './builtin/openrouter.js';
import { xaiProfile, xaiResponsesProfile } from './builtin/xai.js';
import { runDiscovery } from './loader.js';

// ---------------------------------------------------------------------------
// In-process registry state
// ---------------------------------------------------------------------------

/** Primary registry: canonical lower-cased name → profile. */
const _registry = new Map<string, ProviderProfile>();

/**
 * Alias map: lower-cased alias → canonical lower-cased name.
 *
 * Aliases MUST NOT shadow primary names of *other* profiles.
 */
const _aliases = new Map<string, string>();

/** Discovery singleton — `null` means discovery hasn't started yet. */
let _discoveryPromise: Promise<void> | null = null;

// ---------------------------------------------------------------------------
// Builtin profiles
// ---------------------------------------------------------------------------

/**
 * All builtin provider profiles registered before user plugins are loaded.
 * Add new builtins here — the registry loads them in array order.
 */
const BUILTIN_PROFILES: ReadonlyArray<ProviderProfile> = [
  anthropicProfile,
  bedrockProfile,
  geminiProfile,
  kimiCodeProfile,
  moonshotProfile,
  ollamaProfile,
  openrouterProfile,
  xaiProfile,
  xaiResponsesProfile,
];

// ---------------------------------------------------------------------------
// Core registration
// ---------------------------------------------------------------------------

/**
 * Register a provider profile.
 *
 * - Keys the profile by `profile.name.toLowerCase()` in the primary registry.
 * - Indexes each alias in {@link _aliases}. An alias that conflicts with the
 *   primary name of a *different* already-registered profile throws a
 *   `TypeError` to prevent silent mis-routing.
 * - Last-writer-wins on primary name collisions (user plugins override
 *   builtins).
 *
 * @param profile - The provider profile to register.
 * @throws {TypeError} When an alias conflicts with another profile's primary name.
 */
export function registerProvider(profile: ProviderProfile): void {
  const key = profile.name.toLowerCase();
  _registry.set(key, profile);

  for (const alias of profile.aliases ?? []) {
    const aliasKey = alias.toLowerCase();
    const existing = _aliases.get(aliasKey);
    if (existing !== undefined && existing !== key) {
      // Check whether this alias is the primary name of a *different* profile.
      if (_registry.has(aliasKey) && aliasKey !== key) {
        throw new TypeError(
          `[provider-registry] Alias "${alias}" for provider "${profile.name}" conflicts ` +
            `with the primary name of provider "${_registry.get(aliasKey)?.name ?? aliasKey}".`,
        );
      }
    }
    _aliases.set(aliasKey, key);
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Ensure the one-shot discovery pass has run.
 *
 * Calling this multiple times is safe — it returns the same promise every time.
 * The discovery pass:
 *   1. Registers all {@link BUILTIN_PROFILES}.
 *   2. Scans `${CLEO_HOME}/plugins/model-providers/` for user plugins.
 */
export async function ensureDiscovered(): Promise<void> {
  if (_discoveryPromise === null) {
    _discoveryPromise = runDiscovery(registerProvider, BUILTIN_PROFILES);
  }
  return _discoveryPromise;
}

/**
 * Run plugin discovery explicitly.
 *
 * Idempotent: subsequent calls after the first discovery pass return
 * the cached promise immediately without rescanning the filesystem.
 */
export async function discoverPlugins(): Promise<void> {
  return ensureDiscovered();
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * Look up a provider profile by name or alias (case-insensitive).
 *
 * Triggers discovery on the first call. Returns `undefined` when no profile
 * matches — callers MUST handle this case (generic/fallback behaviour).
 *
 * @param name - Provider name or alias to look up.
 * @returns The matching {@link ProviderProfile}, or `undefined`.
 */
export async function getProviderProfile(name: string): Promise<ProviderProfile | undefined> {
  await ensureDiscovered();
  const key = name.toLowerCase();
  // Check aliases first (aliases resolve to canonical keys).
  const canonical = _aliases.get(key) ?? key;
  return _registry.get(canonical);
}

/**
 * Return all registered provider profiles, sorted ascending by canonical name.
 *
 * Triggers discovery on the first call. Each profile appears exactly once
 * (aliases do not generate duplicate entries).
 *
 * @returns Sorted array of registered {@link ProviderProfile} objects.
 */
export async function listProviders(): Promise<ReadonlyArray<ProviderProfile>> {
  await ensureDiscovered();
  // _registry is keyed by canonical name — values are already deduplicated.
  const profiles = [..._registry.values()];
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Test helpers (package-internal)
// ---------------------------------------------------------------------------

/**
 * Reset registry state for testing.
 *
 * @internal — NOT part of the public API. Exported so the test suite can
 *   isolate each test case without restarting the process.
 */
export function _resetRegistryForTesting(): void {
  _registry.clear();
  _aliases.clear();
  _discoveryPromise = null;
}
