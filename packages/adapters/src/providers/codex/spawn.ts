/**
 * Codex CLI Spawn Provider
 *
 * Implements `AdapterSpawnProvider` for the OpenAI Codex CLI (`codex` binary).
 *
 * The `codex` binary is the OpenAI Codex CLI agent, available at:
 * https://github.com/openai/codex
 *
 * Invocation: `codex --full-auto <prompt-file>`
 *
 * The provider uses `--full-auto` (non-interactive, auto-approve all actions)
 * which is the headless equivalent of the Claude Code `--dangerously-skip-permissions`
 * flag. Processes run detached and are tracked by PID for listing and termination.
 *
 * If the `codex` binary is not found, `canSpawn()` returns `false` with a
 * graceful error — no crash.
 *
 * @remarks
 * As of 2026, the Codex CLI is the successor to the original OpenAI Codex
 * playground. It reads prompts from stdin or file arguments and emits output
 * to stdout. The `--full-auto` flag suppresses interactive approval prompts.
 * Install: `npm install -g @openai/codex` or see the GitHub repo above.
 *
 * @task T648
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
 * Spawn provider for the OpenAI Codex CLI.
 *
 * Spawns detached Codex CLI processes for subagent execution. Each spawn
 * writes its prompt to a temporary file, then runs
 * `codex --full-auto <tmpFile>` as a detached, unref'd child process.
 *
 * @remarks
 * `canSpawn()` returns `false` (with no crash) when the `codex` binary is
 * not found in PATH. Install instructions are emitted via `console.warn`
 * once to help operators discover the binary is missing.
 *
 * Processes are tracked by instance ID in an in-memory map and verified
 * via `kill(pid, 0)` liveness checks.
 *
 * @task T648
 */
export class CodexSpawnProvider implements AdapterSpawnProvider {
  /** Map of instance IDs to tracked process info. */
  private processMap = new Map<string, TrackedProcess>();

  /**
   * Check if the Codex CLI is available in PATH.
   *
   * @returns `true` if `codex` is found via `which`
   */
  async canSpawn(): Promise<boolean> {
    try {
      await execAsync('which codex');
      return true;
    } catch {
      console.warn(
        '[CodexSpawnProvider] codex CLI not found. ' +
          'Install: npm install -g @openai/codex  ' +
          'Docs: https://github.com/openai/codex',
      );
      return false;
    }
  }

  /**
   * Spawn a subagent via the Codex CLI.
   *
   * Writes the prompt to a temporary file and spawns a detached Codex
   * process. The process runs independently of the parent.
   *
   * @param context - Spawn context with taskId, prompt, and options
   * @returns Spawn result with instance ID and status
   */
  async spawn(context: SpawnContext): Promise<SpawnResult> {
    const instanceId = `codex-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const startTime = new Date().toISOString();
    let tmpFile: string | undefined;

    try {
      // Enrich prompt with CANT bundle, memory bridge, and mental model.
      // Best-effort: if CANT context is unavailable, the raw prompt is used.
      let enrichedPrompt = context.prompt;
      try {
        const { buildCantEnrichedPrompt } = await import('../../cant-context.js');
        enrichedPrompt = await buildCantEnrichedPrompt({
          projectDir: context.workingDirectory ?? process.cwd(),
          basePrompt: context.prompt,
          agentName: (context.options?.agentName as string) ?? undefined,
        });
      } catch {
        // CANT enrichment unavailable — use raw prompt
      }

      tmpFile = `/tmp/codex-spawn-${instanceId}.txt`;
      await writeFile(tmpFile, enrichedPrompt, 'utf-8');

      // --full-auto: non-interactive batch mode (auto-approve all actions)
      const args = ['--full-auto', tmpFile];
      const spawnOpts: Parameters<typeof nodeSpawn>[2] = {
        detached: true,
        stdio: 'ignore',
      };

      if (context.workingDirectory) {
        spawnOpts.cwd = context.workingDirectory;
      }

      const child = nodeSpawn('codex', args, spawnOpts);
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
        providerId: 'codex',
        status: 'running',
        startTime,
      };
    } catch (error) {
      console.error(`[CodexSpawnProvider] Failed to spawn: ${getErrorMessage(error)}`);

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
        providerId: 'codex',
        status: 'failed',
        startTime,
        endTime: new Date().toISOString(),
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * List currently running Codex subagent processes.
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
          providerId: 'codex',
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
