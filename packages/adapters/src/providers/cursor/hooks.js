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
/**
 * Hook provider for Cursor (stub).
 *
 * Cursor lacks a hook-based lifecycle event system. All mapping
 * operations return null. Registration is a no-op.
 */
export class CursorHookProvider {
    registered = false;
    /**
     * Map a provider event name to a CAAMP hook event name.
     *
     * Always returns null since Cursor does not emit hook events.
     *
     * @param _providerEvent - Ignored; Cursor has no hook events
     * @returns null (no mapping available)
     */
    mapProviderEvent(_providerEvent) {
        return null;
    }
    /**
     * Register native hooks for a project.
     *
     * No-op for Cursor since it has no hook system.
     *
     * @param _projectDir - Ignored
     */
    async registerNativeHooks(_projectDir) {
        this.registered = true;
    }
    /**
     * Unregister native hooks.
     *
     * No-op for Cursor since it has no hook system.
     */
    async unregisterNativeHooks() {
        this.registered = false;
    }
    /**
     * Check whether hooks have been registered.
     */
    isRegistered() {
        return this.registered;
    }
}
//# sourceMappingURL=hooks.js.map