/**
 * CAAMP Hooks Normalizer - Type Definitions
 *
 * Defines the canonical CAAMP hook event taxonomy and provider mapping types.
 * CAAMP provides a unified hook interface across all providers — consumers
 * use canonical event names, and the normalizer translates to/from
 * provider-native names.
 */

// ── Canonical Hook Events ───────────────────────────────────────────

/**
 * All supported hook category names as a readonly tuple.
 *
 * @remarks
 * Categories group related canonical events for filtering and display.
 * Each canonical event belongs to exactly one category. The tuple is
 * `as const` so it can be used to derive the {@link HookCategory} union type.
 *
 * @public
 */
export const HOOK_CATEGORIES = ["session", "prompt", "tool", "agent", "context"] as const;

/**
 * Union type of valid hook category strings derived from {@link HOOK_CATEGORIES}.
 *
 * @remarks
 * Used to classify canonical events into logical groups such as `"session"`,
 * `"prompt"`, `"tool"`, `"agent"`, and `"context"`.
 *
 * @public
 */
export type HookCategory = (typeof HOOK_CATEGORIES)[number];

/**
 * All CAAMP canonical hook event names as a readonly tuple.
 *
 * @remarks
 * This is the single source of truth for the canonical event taxonomy.
 * Provider-native events are mapped to and from these canonical names
 * by the normalizer. The tuple is `as const` so it can derive the
 * {@link CanonicalHookEvent} union type.
 *
 * @public
 */
export const CANONICAL_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "PromptSubmit",
  "ResponseComplete",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "SubagentStart",
  "SubagentStop",
  "PreModel",
  "PostModel",
  "PreCompact",
  "PostCompact",
  "Notification",
  "ConfigChange",
] as const;

/**
 * Union type of valid canonical hook event names derived from {@link CANONICAL_HOOK_EVENTS}.
 *
 * @remarks
 * Every provider mapping references these canonical names. Use `toNative()`
 * to translate a canonical event to a provider-specific name, and `toCanonical()`
 * for the reverse direction.
 *
 * @public
 */
export type CanonicalHookEvent = (typeof CANONICAL_HOOK_EVENTS)[number];

/**
 * Definition of a canonical hook event including its category and behavior.
 *
 * @remarks
 * Each canonical event has a category for grouping, a human-readable description,
 * and a `canBlock` flag indicating whether a hook handler can prevent the
 * associated action from proceeding.
 *
 * @public
 */
export interface CanonicalEventDefinition {
  /** The lifecycle category this event belongs to (e.g. `"session"`, `"tool"`). */
  category: HookCategory;
  /** Human-readable description of when this event fires. */
  description: string;
  /** Whether a hook handler can block or cancel the associated action. */
  canBlock: boolean;
}

// ── Provider Hook System Types ──────────────────────────────────────

/**
 * The type of hook system a provider uses.
 *
 * @remarks
 * - `"config"` — hooks defined in a configuration file (e.g. Claude Code `.claude/settings.json`)
 * - `"plugin"` — hooks implemented via a plugin/extension system
 * - `"none"` — provider does not support hooks
 *
 * @public
 */
export type HookSystemType = "config" | "plugin" | "none";

/**
 * The mechanism a provider uses to execute hook handlers.
 *
 * @remarks
 * - `"command"` — shell command execution
 * - `"http"` — HTTP webhook callback
 * - `"prompt"` — LLM prompt injection
 * - `"agent"` — sub-agent delegation
 * - `"plugin"` — native plugin API call
 *
 * @public
 */
export type HookHandlerType = "command" | "http" | "prompt" | "agent" | "plugin";

/**
 * Mapping of a single canonical event to a provider's native representation.
 *
 * @remarks
 * Each entry in a provider's hook profile maps one canonical event to the
 * provider's native event name. If `supported` is `false`, the provider
 * does not fire this event. Optional `notes` capture caveats or limitations.
 *
 * @public
 */
export interface HookMapping {
  /** The provider-native event name, or `null` if the event has no native equivalent. */
  nativeName: string | null;
  /** Whether this canonical event is supported by the provider. */
  supported: boolean;
  /**
   * Optional notes about support limitations or behavioral differences.
   *
   * @defaultValue `undefined`
   */
  notes?: string;
}

/**
 * Complete hook profile for a single provider.
 *
 * @remarks
 * Describes the provider's hook system type, configuration location, supported
 * handler types, and the full mapping of canonical events to native names.
 * This is the primary data structure loaded from `providers/hook-mappings.json`.
 *
 * @public
 */
export interface ProviderHookProfile {
  /** The type of hook system the provider uses (`"config"`, `"plugin"`, or `"none"`). */
  hookSystem: HookSystemType;
  /** Filesystem path template to the provider's hook configuration file, or `null`. */
  hookConfigPath: string | null;
  /** The configuration format used for hooks (e.g. `"json"`, `"yaml"`), or `null`. */
  hookFormat: string | null;
  /** The handler execution mechanisms this provider supports. */
  handlerTypes: HookHandlerType[];
  /** Whether the provider's hook system is considered experimental or unstable. */
  experimental: boolean;
  /** Mapping of every canonical event to this provider's native representation. */
  mappings: Record<CanonicalHookEvent, HookMapping>;
  /** Native event names that exist only in this provider with no canonical equivalent. */
  providerOnlyEvents: string[];
}

// ── Normalization Result Types ──────────────────────────────────────

/**
 * A fully resolved hook event with both canonical and native names.
 *
 * @remarks
 * Returned by batch translation functions. Contains all the context needed
 * to register or invoke a hook handler: the canonical name for CAAMP logic,
 * the native name for provider-specific calls, and metadata about category
 * and blocking behavior.
 *
 * @public
 */
export interface NormalizedHookEvent {
  /** The CAAMP canonical event name. */
  canonical: CanonicalHookEvent;
  /** The provider-native event name. */
  native: string;
  /** The provider this event was resolved for. */
  providerId: string;
  /** The lifecycle category of this event. */
  category: HookCategory;
  /** Whether a handler for this event can block the associated action. */
  canBlock: boolean;
}

/**
 * Result of querying whether a provider supports a specific canonical event.
 *
 * @remarks
 * Returned by `getHookSupport()`. Includes the native name translation
 * and any notes about support limitations. When `supported` is `false`,
 * `native` will be `null`.
 *
 * @public
 */
export interface HookSupportResult {
  /** The canonical event that was queried. */
  canonical: CanonicalHookEvent;
  /** Whether the provider supports this event. */
  supported: boolean;
  /** The provider-native event name, or `null` if unsupported. */
  native: string | null;
  /**
   * Optional notes about support caveats.
   *
   * @defaultValue `undefined`
   */
  notes?: string;
}

/**
 * Aggregated hook support summary for a single provider.
 *
 * @remarks
 * Provides a high-level view of a provider's hook capabilities including
 * counts, coverage percentage, and lists of supported/unsupported events.
 * Useful for CLI display and provider comparison features.
 *
 * @public
 */
export interface ProviderHookSummary {
  /** The provider identifier. */
  providerId: string;
  /** The type of hook system the provider uses. */
  hookSystem: HookSystemType;
  /** Whether the provider's hook system is experimental. */
  experimental: boolean;
  /** Number of canonical events this provider supports. */
  supportedCount: number;
  /** Total number of canonical events in the taxonomy. */
  totalCanonical: number;
  /** List of canonical events this provider supports. */
  supported: CanonicalHookEvent[];
  /** List of canonical events this provider does not support. */
  unsupported: CanonicalHookEvent[];
  /** Native events unique to this provider with no canonical mapping. */
  providerOnly: string[];
  /** Percentage of canonical events supported (0-100). */
  coverage: number;
}

/**
 * Cross-provider hook support matrix comparing multiple providers.
 *
 * @remarks
 * Built by `buildHookMatrix()`. Provides a two-dimensional view of which
 * canonical events are supported by which providers, with native name
 * translations. Used to render comparison tables in the CLI.
 *
 * @public
 */
export interface CrossProviderMatrix {
  /** The canonical events included in this matrix (rows). */
  events: CanonicalHookEvent[];
  /** The provider IDs included in this matrix (columns). */
  providers: string[];
  /** Nested record mapping each canonical event to each provider's hook mapping. */
  matrix: Record<CanonicalHookEvent, Record<string, HookMapping>>;
}

// ── Hook Mappings Data File Types ───────────────────────────────────

/**
 * Schema for the `providers/hook-mappings.json` data file.
 *
 * @remarks
 * This interface represents the top-level structure of the hook mappings
 * JSON file that serves as the single source of truth for all provider
 * hook configurations. It is loaded and cached by the normalizer module.
 *
 * @public
 */
export interface HookMappingsFile {
  /** Semver version string of the hook mappings schema. */
  version: string;
  /** ISO 8601 date string of the last update to mappings data. */
  lastUpdated: string;
  /** Human-readable description of the mappings file purpose. */
  description: string;
  /** Definitions for every canonical event in the taxonomy. */
  canonicalEvents: Record<CanonicalHookEvent, CanonicalEventDefinition>;
  /** Hook profiles keyed by provider ID. */
  providerMappings: Record<string, ProviderHookProfile>;
}
