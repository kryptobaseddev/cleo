/**
 * ContextEngine plugin registry — discovery surface for registered engines.
 *
 * Provides {@link registerContextEngine} for plugin registration and
 * {@link getContextEngine} for lookup, mirroring the provider-registry
 * pattern at `packages/core/src/llm/provider-registry/index.ts`.
 *
 * Auto-registers {@link RuleBasedTruncationEngine} under the `'rule-based'`
 * name at module load. The `'compression'` role in `executor-factory.ts`
 * seeds the engine registry with the `LlmSummarizationEngine`, which continues
 * to be the default; the rule-based engine is an alternative that callers
 * can select via {@link registerContextEngine}.
 *
 * @module llm/context-engines
 * @task T9312
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import type { ContextEngine } from '@cleocode/contracts/memory/context-engine.js';
import { RuleBasedTruncationEngine } from './rule-based-truncation.js';

// ---------------------------------------------------------------------------
// In-process registry state
// ---------------------------------------------------------------------------

/** Canonical registry: engine name → ContextEngine instance. */
const _registry = new Map<string, ContextEngine>();

// ---------------------------------------------------------------------------
// Auto-register builtins
// ---------------------------------------------------------------------------

/**
 * Built-in `'rule-based'` engine — deterministic, no LLM call required.
 *
 * Available immediately at module load. Callers that want the default LLM
 * summarizer should look up the `'compression'` role via `getLlmExecutor`
 * in `executor-factory.ts`; this registry is specifically for named,
 * swappable plugin engines.
 */
const RULE_BASED_ENGINE = new RuleBasedTruncationEngine();
_registry.set('rule-based', RULE_BASED_ENGINE);

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a named {@link ContextEngine} in the plugin registry.
 *
 * Last-writer-wins on name collisions — user plugins override builtins.
 * Names are stored as-is (case-sensitive). Registration is synchronous and
 * takes effect immediately for any subsequent {@link getContextEngine} call.
 *
 * @param name - Unique engine name (e.g. `'rule-based'`, `'my-custom-engine'`).
 * @param engine - The context engine implementation to register.
 */
export function registerContextEngine(name: string, engine: ContextEngine): void {
  _registry.set(name, engine);
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Look up a registered {@link ContextEngine} by name.
 *
 * Returns `undefined` when no engine is registered under the given name.
 * Callers MUST handle the `undefined` case — there is no implicit fallback
 * inside this function (fallback logic lives in `executor-factory.ts`).
 *
 * @param name - Engine name to look up.
 * @returns The registered {@link ContextEngine}, or `undefined`.
 */
export function getContextEngine(name: string): ContextEngine | undefined {
  return _registry.get(name);
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

/**
 * Return all registered engine names, sorted ascending.
 *
 * Used by `cleo llm context-engines list`.
 *
 * @returns Sorted array of registered engine name strings.
 */
export function listContextEngines(): ReadonlyArray<string> {
  return [..._registry.keys()].sort();
}

// ---------------------------------------------------------------------------
// Test helpers (package-internal)
// ---------------------------------------------------------------------------

/**
 * Reset registry state for testing.
 *
 * Re-registers the builtin `'rule-based'` engine after clearing to
 * match the module-load state.
 *
 * @internal — NOT part of the public API.
 */
export function _resetContextEngineRegistryForTesting(): void {
  _registry.clear();
  _registry.set('rule-based', RULE_BASED_ENGINE);
}
