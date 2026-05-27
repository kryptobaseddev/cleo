/**
 * Pi Spawn Provider
 *
 * Implements AdapterSpawnProvider for Pi coding agent CLI.
 *
 * Uses the `pi` CLI (or the path from `PI_CLI_PATH` env var) to spawn
 * subagent processes with prompts written to temporary files. Processes
 * run detached and are tracked by PID for listing and termination.
 *
 * Pi detection: `PI_CLI_PATH` env var or `which pi`.
 *
 * @task T553
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
 * Resolve the Pi CLI executable path.
 *
 * Honours `PI_CLI_PATH` env var when set, otherwise uses `pi` (expects
 * the binary on PATH).
 */
function getPiCliPath(): string {
  return process.env['PI_CLI_PATH'] ?? 'pi';
}

/**
 * Spawn provider for Pi coding agent.
 *
 * Spawns detached Pi CLI processes for subagent execution. Each spawn
 * writes its prompt to a temporary file, then runs the Pi CLI with the
 * prompt file as the primary argument as a detached, unref'd child process.
 *
 * @remarks
 * Prompts are written to temporary files under `/tmp/` and cleaned up
 * after the child process exits. Processes are tracked by instance ID in
 * an in-memory map and verified via `kill(pid, 0)` liveness checks.
 * All failures are best-effort and non-blocking.
 */
export class PiSpawnProvider implements AdapterSpawnProvider {
  /** Map of instance IDs to tracked process info. */
  private processMap = new Map<string, TrackedProcess>();

  /**
   * Check if the Pi CLI is available.
   *
   * Checks `PI_CLI_PATH` env var first, then tries `which pi`.
   *
   * @returns true if the Pi CLI is accessible
   */
  async canSpawn(): Promise<boolean> {
    const cliPath = getPiCliPath();
    try {
      if (cliPath !== 'pi') {
        // Custom path — check if it exists
        const { stdout } = await execAsync(`test -x "${cliPath}" && echo ok`);
        return stdout.trim() === 'ok';
      }
      await execAsync('which pi');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Spawn a subagent via Pi CLI.
   *
   * Writes the prompt to a temporary file and spawns a detached Pi
   * process. The process runs independently of the parent.
   *
   * @param context - Spawn context with taskId, prompt, and options
   * @returns Spawn result with instance ID and status
   */
  async spawn(context: SpawnContext): Promise<SpawnResult> {
    const instanceId = `pi-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const startTime = new Date().toISOString();
    let tmpFile: string | undefined;

    try {
      tmpFile = `/tmp/pi-spawn-${instanceId}.txt`;
      await writeFile(tmpFile, context.prompt, 'utf-8');

      const cliPath = getPiCliPath();
      const args = [tmpFile];
      const spawnOpts: Parameters<typeof nodeSpawn>[2] = {
        detached: true,
        stdio: 'ignore',
      };

      if (context.workingDirectory) {
        spawnOpts.cwd = context.workingDirectory;
      }

      const child = nodeSpawn(cliPath, args, spawnOpts);
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
        providerId: 'pi',
        status: 'running',
        startTime,
      };
    } catch (error) {
      console.error(`[PiSpawnProvider] Failed to spawn: ${getErrorMessage(error)}`);

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
        providerId: 'pi',
        status: 'failed',
        startTime,
        endTime: new Date().toISOString(),
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * List currently running Pi subagent processes.
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
          providerId: 'pi',
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
