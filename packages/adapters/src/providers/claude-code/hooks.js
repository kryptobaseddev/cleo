/**
 * Claude Code Hook Provider
 *
 * Maps Claude Code's native hook events to CAAMP hook events.
 * Claude Code uses: SessionStart, PostToolUse, UserPromptSubmit, Stop
 * CAAMP defines: onSessionStart, onToolComplete, onPromptSubmit, onSessionEnd
 *
 * @task T5240
 */
/**
 * Mapping from Claude Code native event names to CAAMP event names.
 */
const CLAUDE_CODE_EVENT_MAP = {
    SessionStart: 'onSessionStart',
    PostToolUse: 'onToolComplete',
    UserPromptSubmit: 'onPromptSubmit',
    Stop: 'onSessionEnd',
};
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
export class ClaudeCodeHookProvider {
    registered = false;
    /**
     * Map a Claude Code native event name to a CAAMP hook event name.
     *
     * @param providerEvent - Claude Code event name (e.g. "SessionStart", "PostToolUse")
     * @returns CAAMP event name or null if unmapped
     */
    mapProviderEvent(providerEvent) {
        return CLAUDE_CODE_EVENT_MAP[providerEvent] ?? null;
    }
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
    async registerNativeHooks(_projectDir) {
        this.registered = true;
    }
    /**
     * Unregister native hooks.
     *
     * For Claude Code, this is a no-op since hooks are managed through
     * the plugin system. Unregistration happens via the install provider's
     * uninstall method.
     */
    async unregisterNativeHooks() {
        this.registered = false;
    }
    /**
     * Check whether hooks have been registered via registerNativeHooks.
     */
    isRegistered() {
        return this.registered;
    }
    /**
     * Get the full event mapping for introspection/debugging.
     */
    getEventMap() {
        return { ...CLAUDE_CODE_EVENT_MAP };
    }
}
//# sourceMappingURL=hooks.js.map