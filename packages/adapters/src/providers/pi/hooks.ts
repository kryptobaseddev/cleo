/**
 * Pi Hook Provider
 *
 * Maps Pi coding agent native event names to CAAMP canonical hook events.
 * Pi supports 11 of 16 canonical events through its extension/event system.
 *
 * Event translation uses CAAMP normalizer APIs:
 * - `toCanonical(nativeName, 'pi')` for runtime event name resolution
 * - `getSupportedEvents('pi')` to enumerate supported canonical events
 * - `getProviderHookProfile('pi')` for the full provider profile
 *
 * A static map derived from CAAMP hook-mappings.json piEventCatalog is
 * maintained as a fallback for environments where CAAMP's runtime
 * resolution is unavailable.
 *
 * Mappings (11/16 supported):
 *   session_start          → SessionStart
 *   session_shutdown       → SessionEnd
 *   input                  → PromptSubmit
 *   turn_end               → Notification  (assistant turn complete)
 *   tool_call              → PreToolUse
 *   tool_result            → PostToolUse
 *   before_agent_start     → SubagentStart
 *   agent_end              → SubagentStop
 *   before_provider_request → PreModel
 *   context                → PreCompact    (context assembly = pre-compaction proxy)
 *
 * Unsupported (5/16):
 *   ResponseComplete, PostToolUseFailure, PermissionRequest,
 *   PostModel, PostCompact, ConfigChange
 *
 * @task T553
 */

import type { AdapterHookProvider } from '@cleocode/contracts';

/** CAAMP provider identifier for Pi. */
const PROVIDER_ID = 'pi' as const;

/**
 * Fallback map from Pi native event names to CAAMP canonical names.
 *
 * Derived from the `piEventCatalog` block in CAAMP hook-mappings.json.
 * Covers all 11 supported events. ResponseComplete, PostToolUseFailure,
 * PermissionRequest, PostModel, PostCompact, and ConfigChange are not
 * supported by Pi and are absent from this map.
 *
 * Used as fallback when CAAMP runtime is unavailable, and as the
 * synchronous implementation of `mapProviderEvent()`.
 */
const PI_EVENT_MAP: Record<string, string> = {
  // piEventCatalog: session_start → SessionStart
  session_start: 'SessionStart',
  // piEventCatalog: session_shutdown → SessionEnd
  session_shutdown: 'SessionEnd',
  // piEventCatalog: input → PromptSubmit
  input: 'PromptSubmit',
  // piEventCatalog: turn_end → Notification (assistant turn complete)
  turn_end: 'Notification',
  // piEventCatalog: tool_call → PreToolUse
  tool_call: 'PreToolUse',
  // piEventCatalog: tool_execution_start → PreToolUse (duplicate path)
  tool_execution_start: 'PreToolUse',
  // piEventCatalog: tool_result → PostToolUse
  tool_result: 'PostToolUse',
  // piEventCatalog: tool_execution_end → PostToolUse (duplicate path)
  tool_execution_end: 'PostToolUse',
  // piEventCatalog: before_agent_start → SubagentStart
  before_agent_start: 'SubagentStart',
  // piEventCatalog: agent_end → SubagentStop
  agent_end: 'SubagentStop',
  // piEventCatalog: before_provider_request → PreModel
  before_provider_request: 'PreModel',
  // piEventCatalog: context → PreCompact (context assembly is the pre-compaction proxy for Pi)
  context: 'PreCompact',
};

/**
 * Hook provider for Pi coding agent.
 *
 * Pi registers hooks via its TypeScript extension system. Extensions are
 * loaded from `~/.pi/agent/extensions/*.ts` (global) or
 * `<projectDir>/.pi/extensions/*.ts` (project scope).
 *
 * Event mapping is based on the `piEventCatalog` block in CAAMP
 * hook-mappings.json. Async accessors (`getSupportedCanonicalEvents`,
 * `getProviderProfile`) call CAAMP directly when available.
 *
 * Since hooks are registered through the extension system (managed by the
 * install provider), `registerNativeHooks` and `unregisterNativeHooks`
 * track registration state without performing filesystem operations.
 *
 * @remarks
 * Pi is CAAMP's first-class primary harness (ADR-035). Its native events
 * use snake_case (e.g. `session_start`, `tool_call`) unlike the PascalCase
 * CAAMP canonical names. The static event map covers all 11 supported events.
 * Async CAAMP accessors fall back to the static map when CAAMP is unavailable.
 *
 * Pi does NOT support ResponseComplete, PostToolUseFailure, PermissionRequest,
 * PostModel, PostCompact, or ConfigChange canonical events.
 *
 * All hook dispatch is best-effort — hooks MUST never block or crash Pi.
 *
 * @task T553
 */
export class PiHookProvider implements AdapterHookProvider {
  /** Whether hooks have been registered for the current session. */
  private registered = false;

  /**
   * Map a Pi native event name to a CAAMP canonical hook event name.
   *
   * Looks up the native event name in the map derived from the
   * `piEventCatalog` block in CAAMP hook-mappings.json.
   * Returns null for unrecognised or unsupported events.
   *
   * @param providerEvent - Pi native event (e.g. "session_start", "tool_call")
   * @returns CAAMP canonical event name, or null if unmapped
   * @task T553
   */
  mapProviderEvent(providerEvent: string): string | null {
    return PI_EVENT_MAP[providerEvent] ?? null;
  }

  /**
   * Register native hooks for a project.
   *
   * For Pi, hooks are registered via the extension system, managed by
   * the install provider. This method marks hooks as registered without
   * performing filesystem operations.
   *
   * Iterating supported events is handled at install time using
   * `getSupportedCanonicalEvents()` to enumerate all 11 supported hooks.
   *
   * @param _projectDir - Project directory (unused; Pi uses extension system)
   * @task T553
   */
  async registerNativeHooks(_projectDir: string): Promise<void> {
    this.registered = true;
  }

  /**
   * Unregister native hooks.
   *
   * For Pi, this is a no-op since hooks are managed through the extension
   * system. Unregistration happens via the install provider's uninstall method.
   *
   * @task T553
   */
  async unregisterNativeHooks(): Promise<void> {
    this.registered = false;
  }

  /**
   * Check whether hooks have been registered via `registerNativeHooks`.
   */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Get the native→canonical event mapping for introspection and debugging.
   *
   * Returns the map derived from the `piEventCatalog` block in CAAMP
   * hook-mappings.json. Use `getSupportedCanonicalEvents()` to enumerate
   * canonical names via live CAAMP APIs.
   *
   * @returns Immutable record of native event name → canonical event name
   */
  getEventMap(): Readonly<Record<string, string>> {
    return { ...PI_EVENT_MAP };
  }

  /**
   * Enumerate supported canonical events via CAAMP's `getSupportedEvents()`.
   *
   * Calls `getSupportedEvents('pi')` from the CAAMP normalizer to get the
   * authoritative list. Pi supports 11 of 16 canonical events. Falls back
   * to the unique values of the static event map when CAAMP is unavailable.
   *
   * @returns Array of CAAMP canonical event names supported by Pi
   * @task T553
   */
  async getSupportedCanonicalEvents(): Promise<string[]> {
    try {
      const { getSupportedEvents } = await import('@cleocode/caamp');
      return getSupportedEvents(PROVIDER_ID) as string[];
    } catch {
      return [...new Set(Object.values(PI_EVENT_MAP))];
    }
  }

  /**
   * Retrieve the full provider hook profile from CAAMP.
   *
   * Calls `getProviderHookProfile('pi')` from the CAAMP normalizer to get
   * the complete profile including hook system type, config path, handler
   * types, and all event mappings. Returns null when CAAMP is unavailable.
   *
   * @returns Provider hook profile or null if CAAMP is unavailable
   * @task T553
   */
  async getProviderProfile(): Promise<unknown | null> {
    try {
      const { getProviderHookProfile } = await import('@cleocode/caamp');
      return getProviderHookProfile(PROVIDER_ID) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Translate a CAAMP canonical event to its Pi native name via CAAMP.
   *
   * Calls `toNative(canonical, 'pi')` from the CAAMP normalizer.
   * Returns null for unsupported events or when CAAMP is unavailable.
   *
   * @param canonical - CAAMP canonical event name (e.g. "PreToolUse")
   * @returns Pi native event name or null
   * @task T553
   */
  async toNativeEvent(canonical: string): Promise<string | null> {
    try {
      const { toNative } = await import('@cleocode/caamp');
      return toNative(canonical as Parameters<typeof toNative>[0], PROVIDER_ID);
    } catch {
      // Invert the static map as fallback — return the first match
      const entry = Object.entries(PI_EVENT_MAP).find(([, v]) => v === canonical);
      return entry?.[0] ?? null;
    }
  }
}
