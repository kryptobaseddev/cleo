/**
 * Cursor Spawn Provider
 *
 * Cursor is a GUI-based AI code editor and does not support
 * CLI-based subagent spawning. This provider implements
 * the AdapterSpawnProvider interface with appropriate rejections.
 *
 * @task T5240
 */
/**
 * Spawn provider for Cursor.
 *
 * Cursor does not support subagent spawning via CLI. The adapter
 * declares supportsSpawn: false in its capabilities. All methods
 * either reject or return empty results.
 */
export class CursorSpawnProvider {
    /**
     * Check if Cursor supports spawning subagents.
     *
     * @returns false (Cursor does not support CLI spawning)
     */
    async canSpawn() {
        return false;
    }
    /**
     * Attempt to spawn a subagent via Cursor.
     *
     * Always throws because Cursor does not support subagent spawning.
     * Callers should check canSpawn() before calling this method.
     *
     * @param _context - Unused; spawning is not supported
     * @throws Error explaining that Cursor does not support subagent spawning
     */
    async spawn(_context) {
        throw new Error('Cursor does not support subagent spawning. ' +
            'Cursor is a GUI-based editor without CLI subagent capabilities. ' +
            'Use a provider that supports spawning (e.g., Claude Code or OpenCode).');
    }
    /**
     * List running Cursor subagent processes.
     *
     * @returns Empty array (no processes can be spawned)
     */
    async listRunning() {
        return [];
    }
    /**
     * Terminate a Cursor subagent process.
     *
     * No-op because Cursor cannot spawn processes.
     *
     * @param _instanceId - Unused; no processes to terminate
     */
    async terminate(_instanceId) {
        // No-op: Cursor does not spawn processes.
    }
}
//# sourceMappingURL=spawn.js.map