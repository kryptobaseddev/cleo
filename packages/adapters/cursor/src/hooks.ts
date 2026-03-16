/**
 * Cursor Hook Provider
 *
 * Cursor does not have a native hook/event system for external tools.
 * This provider returns null for all event mappings and marks hooks
 * as unsupported. It exists to satisfy the AdapterHookProvider contract
 * so the adapter can be used uniformly by the AdapterManager.
 *
 * @task T5240
 */

import type { AdapterHookProvider } from '@cleocode/contracts';

/**
 * Hook provider for Cursor (stub).
 *
 * Cursor lacks a hook-based lifecycle event system. All mapping
 * operations return null. Registration is a no-op.
 */
export class CursorHookProvider implements AdapterHookProvider {
  private registered = false;

  /**
   * Map a provider event name to a CAAMP hook event name.
   *
   * Always returns null since Cursor does not emit hook events.
   *
   * @param _providerEvent - Ignored; Cursor has no hook events
   * @returns null (no mapping available)
   */
  mapProviderEvent(_providerEvent: string): string | null {
    return null;
  }

  /**
   * Register native hooks for a project.
   *
   * No-op for Cursor since it has no hook system.
   *
   * @param _projectDir - Ignored
   */
  async registerNativeHooks(_projectDir: string): Promise<void> {
    this.registered = true;
  }

  /**
   * Unregister native hooks.
   *
   * No-op for Cursor since it has no hook system.
   */
  async unregisterNativeHooks(): Promise<void> {
    this.registered = false;
  }

  /**
   * Check whether hooks have been registered.
   */
  isRegistered(): boolean {
    return this.registered;
  }
}
