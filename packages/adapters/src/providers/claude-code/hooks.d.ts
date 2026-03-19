/**
 * Claude Code Hook Provider
 *
 * Maps Claude Code's native hook events to CAAMP hook events.
 * Claude Code uses: SessionStart, PostToolUse, UserPromptSubmit, Stop
 * CAAMP defines: onSessionStart, onToolComplete, onPromptSubmit, onSessionEnd
 *
 * @task T5240
 */
import type { AdapterHookProvider } from '@cleocode/contracts';
/**
 * Hook provider for Claude Code.
 *
 * Claude Code registers hooks via a plugin directory
 * with a hooks.json descriptor. The actual hook scripts are shell scripts
 * that invoke CLEO's brain observation system.
 *
 * Since hooks are registered through the plugin system (installed via
 * the install provider), registerNativeHooks and unregisterNativeHooks
 * are effectively no-ops here — the plugin installer handles registration.
 */
export declare class ClaudeCodeHookProvider implements AdapterHookProvider {
  private registered;
  /**
   * Map a Claude Code native event name to a CAAMP hook event name.
   *
   * @param providerEvent - Claude Code event name (e.g. "SessionStart", "PostToolUse")
   * @returns CAAMP event name or null if unmapped
   */
  mapProviderEvent(providerEvent: string): string | null;
  /**
   * Register native hooks for a project.
   *
   * For Claude Code, hooks are registered via the plugin system
   * (hooks.json descriptor), which is handled by the
   * install provider. This method is a no-op since registration
   * is managed through the plugin install lifecycle.
   *
   * @param _projectDir - Project directory (unused; hooks are global)
   */
  registerNativeHooks(_projectDir: string): Promise<void>;
  /**
   * Unregister native hooks.
   *
   * For Claude Code, this is a no-op since hooks are managed through
   * the plugin system. Unregistration happens via the install provider's
   * uninstall method.
   */
  unregisterNativeHooks(): Promise<void>;
  /**
   * Check whether hooks have been registered via registerNativeHooks.
   */
  isRegistered(): boolean;
  /**
   * Get the full event mapping for introspection/debugging.
   */
  getEventMap(): Readonly<Record<string, string>>;
}
//# sourceMappingURL=hooks.d.ts.map
