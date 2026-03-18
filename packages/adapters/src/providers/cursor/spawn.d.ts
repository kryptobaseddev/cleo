/**
 * Cursor Spawn Provider
 *
 * Cursor is a GUI-based AI code editor and does not support
 * CLI-based subagent spawning. This provider implements
 * the AdapterSpawnProvider interface with appropriate rejections.
 *
 * @task T5240
 */
import type { AdapterSpawnProvider, SpawnContext, SpawnResult } from '@cleocode/contracts';
/**
 * Spawn provider for Cursor.
 *
 * Cursor does not support subagent spawning via CLI. The adapter
 * declares supportsSpawn: false in its capabilities. All methods
 * either reject or return empty results.
 */
export declare class CursorSpawnProvider implements AdapterSpawnProvider {
    /**
     * Check if Cursor supports spawning subagents.
     *
     * @returns false (Cursor does not support CLI spawning)
     */
    canSpawn(): Promise<boolean>;
    /**
     * Attempt to spawn a subagent via Cursor.
     *
     * Always throws because Cursor does not support subagent spawning.
     * Callers should check canSpawn() before calling this method.
     *
     * @param _context - Unused; spawning is not supported
     * @throws Error explaining that Cursor does not support subagent spawning
     */
    spawn(_context: SpawnContext): Promise<SpawnResult>;
    /**
     * List running Cursor subagent processes.
     *
     * @returns Empty array (no processes can be spawned)
     */
    listRunning(): Promise<SpawnResult[]>;
    /**
     * Terminate a Cursor subagent process.
     *
     * No-op because Cursor cannot spawn processes.
     *
     * @param _instanceId - Unused; no processes to terminate
     */
    terminate(_instanceId: string): Promise<void>;
}
//# sourceMappingURL=spawn.d.ts.map