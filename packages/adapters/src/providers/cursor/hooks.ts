/**
 * Cursor Hook Provider
 *
 * Maps Cursor's native hook events to CAAMP canonical hook events.
 * Cursor supports 10 of 16 canonical events through its config-based hook system.
 *
 * Event translation uses CAAMP normalizer APIs:
 * - `toCanonical(nativeName, 'cursor')` for runtime event name resolution
 * - `getSupportedEvents('cursor')` to enumerate supported canonical events
 * - `getProviderHookProfile('cursor')` for the full provider profile
 *
 * Cursor uses camelCase native event names (e.g. `sessionStart`, `preToolUse`).
 * Hooks are configured via `.cursor/hooks.json`. Supported handler types:
 * command, prompt.
 *
 * Unsupported events: PermissionRequest, PreModel, PostModel, PostCompact,
 * Notification, ConfigChange.
 *
 * @task T165
 * @epic T134
 */

import type { AdapterHookProvider } from '@cleocode/contracts';

/** CAAMP provider identifier for Cursor. */
const PROVIDER_ID = 'cursor' as const;

/**
 * Fallback map from Cursor native event names to CAAMP canonical names.
 *
 * Derived from `getProviderHookProfile('cursor').mappings` in CAAMP 1.9.1.
 * Covers all 10 supported events. PermissionRequest, PreModel, PostModel,
 * PostCompact, Notification, and ConfigChange are not supported by Cursor.
 *
 * Cursor uses camelCase names while CAAMP canonical names are PascalCase.
 */
const CURSOR_EVENT_MAP: Record<string, string> = {
  // CAAMP: toNative('SessionStart',       'cursor') = 'sessionStart'
  sessionStart: 'SessionStart',
  // CAAMP: toNative('SessionEnd',         'cursor') = 'sessionEnd'
  sessionEnd: 'SessionEnd',
  // CAAMP: toNative('PromptSubmit',       'cursor') = 'beforeSubmitPrompt'
  beforeSubmitPrompt: 'PromptSubmit',
  // CAAMP: toNative('ResponseComplete',   'cursor') = 'stop'
  stop: 'ResponseComplete',
  // CAAMP: toNative('PreToolUse',         'cursor') = 'preToolUse'
  preToolUse: 'PreToolUse',
  // CAAMP: toNative('PostToolUse',        'cursor') = 'postToolUse'
  postToolUse: 'PostToolUse',
  // CAAMP: toNative('PostToolUseFailure', 'cursor') = 'postToolUseFailure'
  postToolUseFailure: 'PostToolUseFailure',
  // CAAMP: toNative('SubagentStart',      'cursor') = 'subagentStart'
  subagentStart: 'SubagentStart',
  // CAAMP: toNative('SubagentStop',       'cursor') = 'subagentStop'
  subagentStop: 'SubagentStop',
  // CAAMP: toNative('PreCompact',         'cursor') = 'preCompact'
  preCompact: 'PreCompact',
};

/**
 * Hook provider for Cursor.
 *
 * Cursor registers hooks via its config system at `.cursor/hooks.json`.
 * Supported handler types: command, prompt.
 *
 * CAAMP 1.9.1 reveals Cursor supports 10 of 16 canonical events. Previously
 * this provider was a no-op stub. It now provides full event mapping and CAAMP
 * normalizer integration.
 *
 * Event mapping is based on `getProviderHookProfile('cursor')` from CAAMP 1.9.1.
 * Async accessors (`getSupportedCanonicalEvents`, `getProviderProfile`) call
 * CAAMP directly when available.
 *
 * Since hooks are registered through the config system (managed by the install
 * provider), `registerNativeHooks` and `unregisterNativeHooks` track registration
 * state without performing filesystem operations.
 *
 * @task T165
 * @epic T134
 */
export class CursorHookProvider implements AdapterHookProvider {
  private registered = false;

  /**
   * Map a Cursor native event name to a CAAMP canonical hook event name.
   *
   * Looks up the native event name in the map derived from
   * `getProviderHookProfile('cursor').mappings` (CAAMP 1.9.1). Cursor uses
   * camelCase names (e.g. "preToolUse", "sessionStart").
   *
   * Returns null for unsupported events (PermissionRequest, PreModel,
   * PostModel, PostCompact, Notification, ConfigChange).
   *
   * @param providerEvent - Cursor native event name (e.g. "preToolUse", "sessionStart")
   * @returns CAAMP canonical event name, or null if unmapped
   * @task T165
   */
  mapProviderEvent(providerEvent: string): string | null {
    return CURSOR_EVENT_MAP[providerEvent] ?? null;
  }

  /**
   * Register native hooks for a project.
   *
   * For Cursor, hooks are registered via the config system
   * (`.cursor/hooks.json`), managed by the install provider.
   * This method marks hooks as registered without performing filesystem operations.
   *
   * Iterating supported events is handled at install time using
   * `getSupportedCanonicalEvents()` to enumerate all 10 supported hooks.
   *
   * @param _projectDir - Project directory (unused; Cursor config manages registration)
   * @task T165
   */
  async registerNativeHooks(_projectDir: string): Promise<void> {
    this.registered = true;
  }

  /**
   * Unregister native hooks.
   *
   * For Cursor, this is a no-op since hooks are managed through the config
   * system. Unregistration happens via the install provider's uninstall method.
   *
   * @task T165
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
   * Returns the map derived from `getProviderHookProfile('cursor').mappings`
   * (CAAMP 1.9.1). Use `getSupportedCanonicalEvents()` to enumerate canonical
   * names via live CAAMP APIs.
   *
   * @returns Immutable record of native event name → canonical event name
   */
  getEventMap(): Readonly<Record<string, string>> {
    return { ...CURSOR_EVENT_MAP };
  }

  /**
   * Enumerate supported canonical events via CAAMP's `getSupportedEvents()`.
   *
   * Calls `getSupportedEvents('cursor')` from the CAAMP normalizer to get the
   * authoritative list. Cursor supports 10 of 16 canonical events. Falls back
   * to the values of the static event map when CAAMP is unavailable at runtime.
   *
   * @returns Array of CAAMP canonical event names supported by Cursor
   * @task T165
   */
  async getSupportedCanonicalEvents(): Promise<string[]> {
    try {
      const { getSupportedEvents } = await import('@cleocode/caamp');
      return getSupportedEvents(PROVIDER_ID) as string[];
    } catch {
      return [...new Set(Object.values(CURSOR_EVENT_MAP))];
    }
  }

  /**
   * Retrieve the full provider hook profile from CAAMP.
   *
   * Calls `getProviderHookProfile('cursor')` from the CAAMP normalizer to
   * get the complete profile: hook system type (`config`), config path
   * (`.cursor/hooks.json`), handler types (command, prompt), and all event
   * mappings. Returns null when CAAMP is unavailable at runtime.
   *
   * @returns Provider hook profile or null if CAAMP is unavailable
   * @task T165
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
   * Translate a CAAMP canonical event to its Cursor native name via CAAMP.
   *
   * Calls `toNative(canonical, 'cursor')` from the CAAMP normalizer.
   * Returns null for unsupported events or when CAAMP is unavailable.
   *
   * @param canonical - CAAMP canonical event name (e.g. "PreToolUse")
   * @returns Cursor native event name (e.g. "preToolUse") or null
   * @task T165
   */
  async toNativeEvent(canonical: string): Promise<string | null> {
    try {
      const { toNative } = await import('@cleocode/caamp');
      return toNative(canonical as Parameters<typeof toNative>[0], PROVIDER_ID);
    } catch {
      // Invert the static map as fallback
      const entry = Object.entries(CURSOR_EVENT_MAP).find(([, v]) => v === canonical);
      return entry?.[0] ?? null;
    }
  }
}
