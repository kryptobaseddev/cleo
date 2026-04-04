/**
 * OpenCode Hook Provider
 *
 * Maps OpenCode's native hook events to CAAMP canonical hook events.
 * OpenCode supports 10 of 16 canonical events through its plugin system.
 *
 * Event translation uses CAAMP normalizer APIs:
 * - `toCanonical(nativeName, 'opencode')` for runtime event name resolution
 * - `getSupportedEvents('opencode')` to enumerate supported canonical events
 * - `getProviderHookProfile('opencode')` for the full provider profile
 *
 * OpenCode uses a JavaScript plugin system with event-prefixed names
 * (e.g. `event:session.created`) for some hooks and bare names for others.
 * The map is derived from `getProviderHookProfile('opencode').mappings` in
 * CAAMP 1.9.1. PostToolUseFailure, SubagentStart, SubagentStop, Notification,
 * and ConfigChange are not supported by OpenCode.
 *
 * @task T164
 * @epic T134
 */

import type { AdapterHookProvider } from '@cleocode/contracts';

/** CAAMP provider identifier for OpenCode. */
const PROVIDER_ID = 'opencode' as const;

/**
 * Fallback map from OpenCode native event names to CAAMP canonical names.
 *
 * Derived from `getProviderHookProfile('opencode').mappings` in CAAMP 1.9.1.
 * Covers all 10 supported events. PostToolUseFailure, SubagentStart,
 * SubagentStop, Notification, and ConfigChange are not supported by OpenCode
 * and are absent from this map.
 *
 * OpenCode uses dot-delimited and event-prefixed names (e.g. "event:session.created")
 * while CAAMP canonical names are PascalCase (e.g. "SessionStart").
 */
const OPENCODE_EVENT_MAP: Record<string, string> = {
  // CAAMP: toNative('SessionStart',       'opencode') = 'event:session.created'
  'event:session.created': 'SessionStart',
  // CAAMP: toNative('SessionEnd',         'opencode') = 'event:session.deleted'
  'event:session.deleted': 'SessionEnd',
  // CAAMP: toNative('PromptSubmit',       'opencode') = 'chat.message'
  'chat.message': 'PromptSubmit',
  // CAAMP: toNative('ResponseComplete',   'opencode') = 'event:session.idle'
  'event:session.idle': 'ResponseComplete',
  // CAAMP: toNative('PreToolUse',         'opencode') = 'tool.execute.before'
  'tool.execute.before': 'PreToolUse',
  // CAAMP: toNative('PostToolUse',        'opencode') = 'tool.execute.after'
  'tool.execute.after': 'PostToolUse',
  // CAAMP: toNative('PermissionRequest',  'opencode') = 'permission.ask'
  'permission.ask': 'PermissionRequest',
  // CAAMP: toNative('PreModel',           'opencode') = 'chat.params'
  'chat.params': 'PreModel',
  // CAAMP: toNative('PreCompact',         'opencode') = 'experimental.session.compacting'
  'experimental.session.compacting': 'PreCompact',
  // CAAMP: toNative('PostCompact',        'opencode') = 'event:session.compacted'
  'event:session.compacted': 'PostCompact',
};

/**
 * Hook provider for OpenCode.
 *
 * OpenCode registers hooks via its JavaScript plugin system at
 * `.opencode/plugins/`. Supported handler type: plugin (JavaScript).
 *
 * Event mapping is based on `getProviderHookProfile('opencode')` from
 * CAAMP 1.9.1. Async accessors (`getSupportedCanonicalEvents`,
 * `getProviderProfile`) call CAAMP directly when available.
 *
 * Since hooks are registered through the plugin system (managed by the install
 * provider), `registerNativeHooks` and `unregisterNativeHooks` track registration
 * state without performing filesystem operations.
 *
 * @remarks
 * OpenCode uses dot-delimited and `event:`-prefixed event names
 * (e.g. `event:session.created`, `tool.execute.before`) which differ
 * significantly from the PascalCase CAAMP canonical names. The static
 * event map covers all 10 supported events. Async CAAMP accessors
 * (`getSupportedCanonicalEvents`, `getProviderProfile`, `toNativeEvent`)
 * call the normalizer directly when available and fall back to the static map.
 *
 * @task T164
 * @epic T134
 */
export class OpenCodeHookProvider implements AdapterHookProvider {
  /** Whether hooks have been registered for the current session. */
  private registered = false;

  /**
   * Map an OpenCode native event name to a CAAMP canonical hook event name.
   *
   * Looks up the native event name in the map derived from
   * `getProviderHookProfile('opencode').mappings` (CAAMP 1.9.1).
   * Returns null for unsupported events (PostToolUseFailure, SubagentStart,
   * SubagentStop, Notification, ConfigChange).
   *
   * @param providerEvent - OpenCode native event (e.g. "event:session.created", "tool.execute.before")
   * @returns CAAMP canonical event name, or null if unmapped
   * @task T164
   */
  mapProviderEvent(providerEvent: string): string | null {
    return OPENCODE_EVENT_MAP[providerEvent] ?? null;
  }

  /**
   * Register native hooks for a project.
   *
   * For OpenCode, hooks are registered via the plugin system
   * (`.opencode/plugins/`), managed by the install provider.
   * This method marks hooks as registered without performing filesystem operations.
   *
   * Iterating supported events is handled at install time using
   * `getSupportedCanonicalEvents()` to enumerate all 10 supported hooks.
   *
   * @param _projectDir - Project directory (unused; config manages registration)
   * @task T164
   */
  async registerNativeHooks(_projectDir: string): Promise<void> {
    this.registered = true;
  }

  /**
   * Unregister native hooks.
   *
   * For OpenCode, this is a no-op since hooks are managed through the plugin
   * system. Unregistration happens via the install provider's uninstall method.
   *
   * @task T164
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
   * Returns the map derived from `getProviderHookProfile('opencode').mappings`
   * (CAAMP 1.9.1). Use `getSupportedCanonicalEvents()` to enumerate canonical
   * names via live CAAMP APIs.
   *
   * @returns Immutable record of native event name → canonical event name
   */
  getEventMap(): Readonly<Record<string, string>> {
    return { ...OPENCODE_EVENT_MAP };
  }

  /**
   * Enumerate supported canonical events via CAAMP's `getSupportedEvents()`.
   *
   * Calls `getSupportedEvents('opencode')` from the CAAMP normalizer to get the
   * authoritative list. OpenCode supports 10 of 16 canonical events via its
   * plugin system. Falls back to the values of the static event map when
   * CAAMP is unavailable at runtime.
   *
   * @returns Array of CAAMP canonical event names supported by OpenCode
   * @task T164
   */
  async getSupportedCanonicalEvents(): Promise<string[]> {
    try {
      const { getSupportedEvents } = await import('@cleocode/caamp');
      return getSupportedEvents(PROVIDER_ID) as string[];
    } catch {
      return [...new Set(Object.values(OPENCODE_EVENT_MAP))];
    }
  }

  /**
   * Retrieve the full provider hook profile from CAAMP.
   *
   * Calls `getProviderHookProfile('opencode')` from the CAAMP normalizer to
   * get the complete profile: hook system type (`plugin`), config path
   * (`.opencode/plugins/`), handler types, and all event mappings.
   * Returns null when CAAMP is unavailable at runtime.
   *
   * @returns Provider hook profile or null if CAAMP is unavailable
   * @task T164
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
   * Translate a CAAMP canonical event to its OpenCode native name via CAAMP.
   *
   * Calls `toNative(canonical, 'opencode')` from the CAAMP normalizer.
   * Returns null for unsupported events or when CAAMP is unavailable.
   *
   * @param canonical - CAAMP canonical event name (e.g. "PreToolUse")
   * @returns OpenCode native event name or null
   * @task T164
   */
  async toNativeEvent(canonical: string): Promise<string | null> {
    try {
      const { toNative } = await import('@cleocode/caamp');
      return toNative(canonical as Parameters<typeof toNative>[0], PROVIDER_ID);
    } catch {
      // Invert the static map as fallback
      const entry = Object.entries(OPENCODE_EVENT_MAP).find(([, v]) => v === canonical);
      return entry?.[0] ?? null;
    }
  }
}
