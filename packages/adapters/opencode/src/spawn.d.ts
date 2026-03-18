/**
 * OpenCode Spawn Provider
 *
 * Implements AdapterSpawnProvider for OpenCode CLI.
 * Migrated from src/core/spawn/adapters/opencode-adapter.ts
 *
 * Uses `opencode run --agent ... --format json` to spawn subagent
 * processes. Processes run detached and are tracked by PID for
 * listing and termination.
 *
 * @task T5240
 */
import type { AdapterSpawnProvider, SpawnContext, SpawnResult } from '@cleocode/contracts';
/**
 * Build the markdown content for an OpenCode agent definition file.
 *
 * OpenCode agents are defined as markdown files with YAML frontmatter
 * in the .opencode/agent/ directory.
 *
 * @param description - Agent description for frontmatter
 * @param instructions - Markdown instructions body
 * @returns Complete agent definition markdown
 */
export declare function buildOpenCodeAgentMarkdown(description: string, instructions: string): string;
/**
 * Spawn provider for OpenCode.
 *
 * Spawns detached OpenCode CLI processes for subagent execution.
 * Each spawn ensures a CLEO subagent definition exists, then runs
 * `opencode run --format json --agent <name> --title <title> <prompt>`
 * as a detached, unref'd child process.
 */
export declare class OpenCodeSpawnProvider implements AdapterSpawnProvider {
    /** Map of instance IDs to tracked process info. */
    private processMap;
    /**
     * Check if the OpenCode CLI is available in PATH.
     *
     * @returns true if `opencode` is found via `which`
     */
    canSpawn(): Promise<boolean>;
    /**
     * Spawn a subagent via OpenCode CLI.
     *
     * Ensures the CLEO subagent definition exists in the project's
     * .opencode/agent/ directory, then spawns a detached OpenCode
     * process. The process runs independently of the parent.
     *
     * @param context - Spawn context with taskId, prompt, and options
     * @returns Spawn result with instance ID and status
     */
    spawn(context: SpawnContext): Promise<SpawnResult>;
    /**
     * List currently running OpenCode subagent processes.
     *
     * Checks each tracked process via kill(pid, 0) to verify it is still alive.
     * Dead processes are automatically cleaned from the tracking map.
     *
     * @returns Array of spawn results for running processes
     */
    listRunning(): Promise<SpawnResult[]>;
    /**
     * Terminate a running spawn by instance ID.
     *
     * Sends SIGTERM to the tracked process. If the process is not found
     * or has already exited, this is a no-op.
     *
     * @param instanceId - ID of the spawn instance to terminate
     */
    terminate(instanceId: string): Promise<void>;
}
//# sourceMappingURL=spawn.d.ts.map