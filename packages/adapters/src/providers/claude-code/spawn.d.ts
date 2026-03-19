/**
 * Claude Code Spawn Provider
 *
 * Implements AdapterSpawnProvider for Claude Code CLI.
 * Migrated from src/core/spawn/adapters/claude-code-adapter.ts
 *
 * Uses the native `claude` CLI to spawn subagent processes with prompts
 * written to temporary files. Processes run detached and are tracked
 * by PID for listing and termination.
 *
 * @task T5240
 */
import type { AdapterSpawnProvider, SpawnContext, SpawnResult } from '@cleocode/contracts';
/**
 * Spawn provider for Claude Code.
 *
 * Spawns detached Claude CLI processes for subagent execution.
 * Each spawn writes its prompt to a temporary file, then runs
 * `claude --allow-insecure --no-upgrade-check <tmpFile>` as a
 * detached, unref'd child process.
 */
export declare class ClaudeCodeSpawnProvider implements AdapterSpawnProvider {
  /** Map of instance IDs to tracked process info. */
  private processMap;
  /**
   * Check if the Claude CLI is available in PATH.
   *
   * @returns true if `claude` is found via `which`
   */
  canSpawn(): Promise<boolean>;
  /**
   * Spawn a subagent via Claude CLI.
   *
   * Writes the prompt to a temporary file and spawns a detached Claude
   * process. The process runs independently of the parent.
   *
   * @param context - Spawn context with taskId, prompt, and options
   * @returns Spawn result with instance ID and status
   */
  spawn(context: SpawnContext): Promise<SpawnResult>;
  /**
   * List currently running Claude subagent processes.
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
