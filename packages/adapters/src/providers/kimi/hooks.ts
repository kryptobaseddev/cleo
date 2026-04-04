/**
 * Kimi Hook Provider
 *
 * Kimi has no native hook system (hookSystem is "none").
 * This provider implements the minimal AdapterHookProvider interface
 * with a no-op mapProviderEvent that always returns null.
 *
 * @task T163
 * @epic T134
 */

import type { AdapterHookProvider } from '@cleocode/contracts';

/**
 * Hook provider for Kimi.
 *
 * Kimi does not expose a native hook or event system.
 * All hook-related methods are no-ops; mapProviderEvent always
 * returns null since there are no events to map.
 *
 * @remarks
 * Since Kimi has no hookable events, the event map is empty and
 * `mapProviderEvent` always returns null. Registration state is tracked
 * purely for interface compliance with {@link AdapterHookProvider}.
 *
 * @task T163
 * @epic T134
 */
export class KimiHookProvider implements AdapterHookProvider {
  /** Whether hooks have been registered (always a no-op for Kimi). */
  private registered = false;

  /**
   * Map a Kimi native event name to a CAAMP hook event name.
   *
   * Kimi has no hook system, so this always returns null.
   *
   * @param _providerEvent - Unused; Kimi emits no hookable events
   * @returns Always null
   * @task T163
   */
  mapProviderEvent(_providerEvent: string): string | null {
    return null;
  }

  /**
   * Register native hooks for a project.
   *
   * Kimi has no hook system. This method is a no-op and only
   * tracks registration state for interface compliance.
   *
   * @param _projectDir - Project directory (unused)
   * @task T163
   */
  async registerNativeHooks(_projectDir: string): Promise<void> {
    this.registered = true;
  }

  /**
   * Unregister native hooks.
   *
   * Kimi has no hook system. This method is a no-op.
   * @task T163
   */
  async unregisterNativeHooks(): Promise<void> {
    this.registered = false;
  }

  /**
   * Check whether hooks have been registered via registerNativeHooks.
   * @task T163
   */
  isRegistered(): boolean {
    return this.registered;
  }

  /**
   * Get the full event mapping for introspection/debugging.
   *
   * Returns an empty map since Kimi has no hookable events.
   * @task T163
   */
  getEventMap(): Readonly<Record<string, string>> {
    return {};
  }
}
