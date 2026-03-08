/**
 * Claude Code Spawn Adapter
 *
 * Concrete implementation of CLEOSpawnAdapter for Claude Code.
 * Uses the native Claude CLI for subagent spawning via subprocess execution.
 *
 * Implements the adapter pattern to bridge CAAMP's SpawnAdapter interface
 * with CLEO's extended spawn context and result types.
 *
 * @task T5236
 * @phase 1E
 */

import { exec, spawn } from 'child_process';
import { unlink, writeFile } from 'fs/promises';
import { promisify } from 'util';
import type { CLEOSpawnAdapter, CLEOSpawnContext, CLEOSpawnResult } from '../../../types/spawn.js';

const execAsync = promisify(exec);

/**
 * Claude Code Spawn Adapter
 *
 * Uses Claude CLI for native subagent spawning. Spawns detached processes
 * that run independently of the parent process.
 */
export class ClaudeCodeSpawnAdapter implements CLEOSpawnAdapter {
  /** Unique identifier for this adapter instance */
  readonly id = 'claude-code';

  /** Provider ID this adapter uses */
  readonly providerId = 'claude-code';

  /** Map of instance IDs to spawned process PIDs for tracking */
  private processMap: Map<string, number> = new Map();

  /**
   * Check if this adapter can spawn in the current environment.
   *
   * Verifies that the Claude CLI is installed and accessible in PATH,
   * and that the provider supports subagent spawning.
   *
   * @returns Promise resolving to true if spawning is available
   */
  async canSpawn(): Promise<boolean> {
    try {
      // Check if Claude CLI is available
      await execAsync('which claude');

      // Check if provider supports spawn capability
      const { providerSupportsById } = await import('@cleocode/caamp');
      const supportsSpawn = providerSupportsById('claude-code', 'spawn.supportsSubagents');

      return supportsSpawn;
    } catch {
      return false;
    }
  }

  /**
   * Spawn a subagent via Claude CLI.
   *
   * Writes the prompt to a temporary file and spawns a detached Claude
   * process with the prompt file as input. The process runs independently
   * and unreferenced from the parent.
   *
   * @param context - Fully-resolved spawn context with task, protocol, and prompt
   * @returns Promise resolving to spawn result with instance ID and status
   * @throws Never throws; errors are returned in the result object
   */
  async spawn(context: CLEOSpawnContext): Promise<CLEOSpawnResult> {
    const instanceId = `claude-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const startTime = new Date().toISOString();
    let tmpFile: string | undefined;

    try {
      tmpFile = `/tmp/claude-spawn-${instanceId}.txt`;
      await writeFile(tmpFile, context.prompt, 'utf-8');

      const child = spawn('claude', ['--allow-insecure', '--no-upgrade-check', tmpFile], {
        detached: true,
        stdio: 'ignore',
      });

      child.unref();

      if (child.pid) {
        this.processMap.set(instanceId, child.pid);
      }

      child.on('exit', async () => {
        this.processMap.delete(instanceId);
        if (tmpFile) {
          try {
            await unlink(tmpFile);
          } catch {
            // Ignore cleanup errors
          }
        }
      });

      return {
        instanceId,
        status: 'running',
        taskId: context.taskId,
        providerId: this.providerId,
        timing: {
          startTime,
        },
      };
    } catch (error) {
      if (tmpFile) {
        try {
          await unlink(tmpFile);
        } catch {
          // Ignore cleanup errors
        }
      }

      const endTime = new Date().toISOString();

      return {
        instanceId,
        status: 'failed',
        taskId: context.taskId,
        providerId: this.providerId,
        output: error instanceof Error ? error.message : 'Unknown spawn error',
        timing: {
          startTime,
          endTime,
        },
      };
    }
  }

  /**
   * List currently running Claude processes.
   *
   * Returns spawn results for processes that are still tracked in the
   * process map and have not exited.
   *
   * @returns Promise resolving to array of running spawn results
   */
  async listRunning(): Promise<CLEOSpawnResult[]> {
    const running: CLEOSpawnResult[] = [];

    for (const [instanceId, pid] of this.processMap.entries()) {
      try {
        process.kill(pid, 0);
        running.push({
          instanceId,
          status: 'running',
          taskId: 'unknown',
          providerId: this.providerId,
          timing: {
            startTime: new Date().toISOString(),
          },
        });
      } catch {
        this.processMap.delete(instanceId);
      }
    }

    return running;
  }

  /**
   * Terminate a running spawn.
   *
   * Kills the process associated with the given instance ID using SIGTERM.
   * If the process is not found or already exited, this operation is a no-op.
   *
   * @param instanceId - ID of the spawn instance to terminate
   * @returns Promise that resolves when termination is complete
   */
  async terminate(instanceId: string): Promise<void> {
    const pid = this.processMap.get(instanceId);

    if (!pid) {
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
      this.processMap.delete(instanceId);
    } catch {
      // Process may have already exited
      this.processMap.delete(instanceId);
    }
  }
}
