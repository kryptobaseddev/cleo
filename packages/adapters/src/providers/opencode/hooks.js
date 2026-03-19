/**
 * OpenCode Hook Provider
 *
 * Maps OpenCode's native hook events to CAAMP hook events.
 * OpenCode supports 6 of 8 CAAMP events through its agent/hook system.
 *
 * OpenCode event mapping:
 * - session.start     -> onSessionStart
 * - session.end       -> onSessionEnd
 * - tool.start        -> onToolStart
 * - tool.complete     -> onToolComplete
 * - error             -> onError
 * - prompt.submit     -> onPromptSubmit
 *
 * @task T5240
 */
/**
 * Mapping from OpenCode native event names to CAAMP event names.
 *
 * OpenCode uses dot-delimited event names (e.g. "session.start")
 * while CAAMP uses camelCase (e.g. "onSessionStart").
 */
const OPENCODE_EVENT_MAP = {
    'session.start': 'onSessionStart',
    'session.end': 'onSessionEnd',
    'tool.start': 'onToolStart',
    'tool.complete': 'onToolComplete',
    error: 'onError',
    'prompt.submit': 'onPromptSubmit',
};
/**
 * Hook provider for OpenCode.
 *
 * OpenCode registers hooks via its configuration system at
 * .opencode/config.json. Hook handlers are defined as shell commands
 * or script paths that execute when the corresponding event fires.
 *
 * Since hooks are registered through the config system (managed by
 * the install provider), registerNativeHooks and unregisterNativeHooks
 * track registration state without performing filesystem operations.
 */
export class OpenCodeHookProvider {
    registered = false;
    /**
     * Map an OpenCode native event name to a CAAMP hook event name.
     *
     * @param providerEvent - OpenCode event name (e.g. "session.start", "tool.complete")
     * @returns CAAMP event name or null if unmapped
     */
    mapProviderEvent(providerEvent) {
        return OPENCODE_EVENT_MAP[providerEvent] ?? null;
    }
    /**
     * Register native hooks for a project.
     *
     * For OpenCode, hooks are registered via the config system
     * (.opencode/config.json), which is handled by the install provider.
     * This method marks hooks as registered without performing
     * filesystem operations.
     *
     * @param _projectDir - Project directory (unused; config manages registration)
     */
    async registerNativeHooks(_projectDir) {
        this.registered = true;
    }
    /**
     * Unregister native hooks.
     *
     * For OpenCode, this is a no-op since hooks are managed through
     * the config system. Unregistration happens via the install
     * provider's uninstall method.
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
        return { ...OPENCODE_EVENT_MAP };
    }
}
//# sourceMappingURL=hooks.js.map