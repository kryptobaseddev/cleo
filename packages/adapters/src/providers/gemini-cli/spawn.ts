/**
 * Gemini CLI Spawn Provider
 *
 * Implements `AdapterSpawnProvider` for the Google Gemini CLI (`gemini` binary).
 *
 * The `gemini` binary is the Google Gemini CLI agent, available at:
 * https://github.com/google-gemini/gemini-cli
 *
 * Invocation: `gemini --yolo < <prompt-file>`
 *
 * The provider pipes the prompt via stdin using the `--yolo` flag, which
 * enables non-interactive mode (auto-approve all actions). Processes run
 * detached and are tracked by PID for listing and termination.
 *
 * If the `gemini` binary is not found, `canSpawn()` returns `false` with a
 * graceful error — no crash.
 *
 * @remarks
 * The Gemini CLI supports a `--model` flag to select the model family and a
 * `--yolo` flag for non-interactive headless execution (equivalent to Claude
 * Code's `--dangerously-skip-permissions`). Prompts are supplied via stdin
 * when run in `--yolo` mode. Install: `npm install -g @google/gemini-cli`
 * or see the GitHub repo above.
 *
 * @task T648
 */

import { exec, spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { AdapterSpawnProvider, SpawnContext, SpawnResult } from '@cleocode/contracts';
import { getErrorMessage } from '@cleocode/contracts';

const execAsync = promisify(exec);

/** Default Gemini model for subagent spawns. */
const DEFAULT_MODEL = 'gemini-2.5-pro';

/** Internal tracking entry for a spawned process. */
interface TrackedProcess {
  pid: number;
  taskId: string;
  startTime: string;
}

/**
 * Spawn provider for the Google Gemini CLI.
 *
 * Spawns detached Gemini CLI processes for subagent execution. Each spawn
 * pipes its prompt via stdin, then runs
 * `gemini --yolo --model <model>` as a detached, unref'd child process.
 *
 * @remarks
 * `canSpawn()` returns `false` (with no crash) when the `gemini` binary is
 * not found in PATH. Install instructions are emitted via `console.warn`
 * once to help operators discover the binary is missing.
 *
 * Processes are tracked by instance ID in an in-memory map and verified
 * via `kill(pid, 0)` liveness checks.
 *
 * @task T648
 */
export class GeminiCliSpawnProvider implements AdapterSpawnProvider {
  /** Map of instance IDs to tracked process info. */
  private processMap = new Map<string, TrackedProcess>();

  /**
   * Check if the Gemini CLI is available in PATH.
   *
   * @returns `true` if `gemini` is found via `which`
   */
  async canSpawn(): Promise<boolean> {
    try {
      await execAsync('which gemini');
      return true;
    } catch {
      console.warn(
        '[GeminiCliSpawnProvider] gemini CLI not found. ' +
          'Install: npm install -g @google/gemini-cli  ' +
          'Docs: https://github.com/google-gemini/gemini-cli',
      );
      return false;
    }
  }

  /**
   * Spawn a subagent via the Gemini CLI.
   *
   * Pipes the enriched prompt to stdin and spawns a detached Gemini
   * process. The process runs independently of the parent.
   *
   * @param context - Spawn context with taskId, prompt, and options
   * @returns Spawn result with instance ID and status
   */
  async spawn(context: SpawnContext): Promise<SpawnResult> {
    const instanceId = `gemini-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const startTime = new Date().toISOString();

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

      const model = (context.options?.model as string) ?? DEFAULT_MODEL;

      // --yolo: non-interactive batch mode (auto-approve all actions)
      // --model: select the Gemini model variant
      // Prompt is supplied via stdin (pipe)
      const args = ['--yolo', '--model', model];
      const spawnOpts: Parameters<typeof nodeSpawn>[2] = {
        detached: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      };

      if (context.workingDirectory) {
        spawnOpts.cwd = context.workingDirectory;
      }

      const child = nodeSpawn('gemini', args, spawnOpts);

      // Write the prompt to stdin then close so the CLI receives it.
      if (child.stdin) {
        child.stdin.write(enrichedPrompt, 'utf-8');
        child.stdin.end();
      }

      child.unref();

      if (child.pid) {
        this.processMap.set(instanceId, {
          pid: child.pid,
          taskId: context.taskId,
          startTime,
        });
      }

      child.on('exit', () => {
        this.processMap.delete(instanceId);
      });

      return {
        instanceId,
        taskId: context.taskId,
        providerId: 'gemini-cli',
        status: 'running',
        startTime,
      };
    } catch (error) {
      console.error(`[GeminiCliSpawnProvider] Failed to spawn: ${getErrorMessage(error)}`);

      return {
        instanceId,
        taskId: context.taskId,
        providerId: 'gemini-cli',
        status: 'failed',
        startTime,
        endTime: new Date().toISOString(),
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * List currently running Gemini CLI subagent processes.
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
          providerId: 'gemini-cli',
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
