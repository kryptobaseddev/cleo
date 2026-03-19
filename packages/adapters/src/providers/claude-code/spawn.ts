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

import { exec, spawn as nodeSpawn } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { AdapterSpawnProvider, SpawnContext, SpawnResult } from '@cleocode/contracts';
import { getErrorMessage } from '@cleocode/contracts';

const execAsync = promisify(exec);

/** Internal tracking entry for a spawned process. */
interface TrackedProcess {
  pid: number;
  taskId: string;
  startTime: string;
}

/**
 * Spawn provider for Claude Code.
 *
 * Spawns detached Claude CLI processes for subagent execution.
 * Each spawn writes its prompt to a temporary file, then runs
 * `claude --allow-insecure --no-upgrade-check <tmpFile>` as a
 * detached, unref'd child process.
 */
export class ClaudeCodeSpawnProvider implements AdapterSpawnProvider {
  /** Map of instance IDs to tracked process info. */
  private processMap = new Map<string, TrackedProcess>();

  /**
   * Check if the Claude CLI is available in PATH.
   *
   * @returns true if `claude` is found via `which`
   */
  async canSpawn(): Promise<boolean> {
    try {
      await execAsync('which claude');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Spawn a subagent via Claude CLI.
   *
   * Writes the prompt to a temporary file and spawns a detached Claude
   * process. The process runs independently of the parent.
   *
   * @param context - Spawn context with taskId, prompt, and options
   * @returns Spawn result with instance ID and status
   */
  async spawn(context: SpawnContext): Promise<SpawnResult> {
    const instanceId = `claude-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const startTime = new Date().toISOString();
    let tmpFile: string | undefined;

    try {
      tmpFile = `/tmp/claude-spawn-${instanceId}.txt`;
      await writeFile(tmpFile, context.prompt, 'utf-8');

      const args = ['--allow-insecure', '--no-upgrade-check', tmpFile];
      const spawnOpts: Parameters<typeof nodeSpawn>[2] = {
        detached: true,
        stdio: 'ignore',
      };

      if (context.workingDirectory) {
        spawnOpts.cwd = context.workingDirectory;
      }

      const child = nodeSpawn('claude', args, spawnOpts);
      child.unref();

      if (child.pid) {
        this.processMap.set(instanceId, {
          pid: child.pid,
          taskId: context.taskId,
          startTime,
        });
      }

      const capturedTmpFile = tmpFile;
      child.on('exit', async () => {
        this.processMap.delete(instanceId);
        try {
          await unlink(capturedTmpFile);
        } catch {
          // Ignore cleanup errors
        }
      });

      return {
        instanceId,
        taskId: context.taskId,
        providerId: 'claude-code',
        status: 'running',
        startTime,
      };
    } catch (error) {
      // Log spawn failure for debugging
      console.error(`[ClaudeCodeSpawnProvider] Failed to spawn: ${getErrorMessage(error)}`);

      if (tmpFile) {
        try {
          await unlink(tmpFile);
        } catch {
          // Ignore cleanup errors
        }
      }

      return {
        instanceId,
        taskId: context.taskId,
        providerId: 'claude-code',
        status: 'failed',
        startTime,
        endTime: new Date().toISOString(),
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * List currently running Claude subagent processes.
   *
   * Checks each tracked process via kill(pid, 0) to verify it is still alive.
   * Dead processes are automatically cleaned from the tracking map.
   *
   * @returns Array of spawn results for running processes
   */
  async listRunning(): Promise<SpawnResult[]> {
    const running: SpawnResult[] = [];

    for (const [instanceId, tracked] of this.processMap.entries()) {
      try {
        process.kill(tracked.pid, 0);
        running.push({
          instanceId,
          taskId: tracked.taskId,
          providerId: 'claude-code',
          status: 'running',
          startTime: tracked.startTime,
        });
      } catch {
        this.processMap.delete(instanceId);
      }
    }

    return running;
  }

  /**
   * Terminate a running spawn by instance ID.
   *
   * Sends SIGTERM to the tracked process. If the process is not found
   * or has already exited, this is a no-op.
   *
   * @param instanceId - ID of the spawn instance to terminate
   */
  async terminate(instanceId: string): Promise<void> {
    const tracked = this.processMap.get(instanceId);
    if (!tracked) return;

    try {
      process.kill(tracked.pid, 'SIGTERM');
    } catch {
      // Process may have already exited
    }
    this.processMap.delete(instanceId);
  }
}
