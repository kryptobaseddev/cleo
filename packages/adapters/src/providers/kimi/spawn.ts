/**
 * Kimi (Moonshot AI) Spawn Provider
 *
 * Implements `AdapterSpawnProvider` for Moonshot AI's Kimi models.
 *
 * There is no widely-distributed standalone Kimi CLI binary. This provider
 * uses the Moonshot AI Chat Completions API directly (REST, no extra SDK
 * dependency) when `MOONSHOT_API_KEY` is present in the environment.
 *
 * API documentation: https://platform.moonshot.cn/docs/api/chat
 * Endpoint: https://api.moonshot.cn/v1/chat/completions
 *
 * `canSpawn()` returns `true` only when:
 * 1. `MOONSHOT_API_KEY` is set in the environment, OR
 * 2. A `kimi` binary is found in PATH (future CLI support)
 *
 * If neither condition holds, `canSpawn()` returns `false` with a clear
 * message — no crash.
 *
 * @remarks
 * Unlike the CLI-based providers (codex, gemini-cli), Kimi spawn runs the
 * API call to completion before returning (`status: 'completed'` or
 * `status: 'failed'`). This mirrors the claude-sdk and openai-sdk providers.
 * The API call uses Node's built-in `fetch` (Node 18+) with no extra
 * dependencies.
 *
 * @task T648
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { AdapterSpawnProvider, SpawnContext, SpawnResult } from '@cleocode/contracts';
import { getErrorMessage } from '@cleocode/contracts';

const execAsync = promisify(exec);

/** Moonshot AI API base URL. */
const MOONSHOT_API_BASE = 'https://api.moonshot.cn/v1';

/** Default model when none is specified in spawn options. */
const DEFAULT_MODEL = 'moonshot-v1-8k';

/**
 * Shape of a Moonshot chat completion response (subset we care about).
 *
 * @internal
 */
interface MoonshotChatResponse {
  choices: Array<{
    message: {
      content: string;
    };
    finish_reason: string;
  }>;
  error?: {
    message: string;
    type: string;
  };
}

/** Internal tracking entry for an in-flight API call. */
interface TrackedRun {
  instanceId: string;
  taskId: string;
  startTime: string;
}

/**
 * Resolve the Moonshot API key from the environment.
 *
 * @returns The key string if set, or `null` if absent/empty.
 */
function resolveMoonshotApiKey(): string | null {
  const key = process.env.MOONSHOT_API_KEY;
  return key?.trim() ? key : null;
}

/**
 * Check whether a `kimi` CLI binary is available in PATH.
 *
 * This is a forward-compatibility hook for any future official Kimi CLI.
 *
 * @returns `true` if `kimi` is found via `which`
 */
async function kimiCliBinaryAvailable(): Promise<boolean> {
  try {
    await execAsync('which kimi');
    return true;
  } catch {
    return false;
  }
}

/**
 * Spawn provider for Moonshot AI Kimi.
 *
 * Uses the Moonshot AI Chat Completions REST API to run subagent prompts.
 * Each `spawn()` call completes synchronously (awaits the API response) and
 * returns `status: 'completed'` or `status: 'failed'`.
 *
 * In-flight runs are tracked by instance ID so `listRunning()` reflects
 * concurrent spawns correctly.
 *
 * @remarks
 * `canSpawn()` checks for `MOONSHOT_API_KEY` first (API mode), then falls
 * back to checking for a `kimi` CLI binary (CLI mode, future). If neither is
 * available, `canSpawn()` returns `false` and `spawn()` throws a descriptive
 * error rather than crashing silently.
 *
 * @task T648
 */
export class KimiSpawnProvider implements AdapterSpawnProvider {
  /** In-flight run tracking set. */
  private readonly runningInstances = new Map<string, TrackedRun>();

  /**
   * Check whether Kimi spawning is available in the current environment.
   *
   * Returns `true` when either:
   * - `MOONSHOT_API_KEY` is set (API mode), or
   * - A `kimi` binary is found in PATH (CLI mode — future)
   *
   * @returns `true` when any Kimi access method is available
   */
  async canSpawn(): Promise<boolean> {
    if (resolveMoonshotApiKey()) return true;
    if (await kimiCliBinaryAvailable()) return true;

    console.warn(
      '[KimiSpawnProvider] No Kimi access method found. ' +
        'Set MOONSHOT_API_KEY to enable API-based spawning. ' +
        'Get a key at: https://platform.moonshot.cn/',
    );
    return false;
  }

  /**
   * Spawn a subagent via the Moonshot AI Kimi API.
   *
   * Enriches the prompt with CANT context (best-effort), then calls
   * the Moonshot Chat Completions API. The call is awaited to completion.
   *
   * @param context - Spawn context with taskId, prompt, and options
   * @returns Resolved spawn result with `status: 'completed'` or `'failed'`
   */
  async spawn(context: SpawnContext): Promise<SpawnResult> {
    const instanceId = `kimi-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const startTime = new Date().toISOString();

    this.runningInstances.set(instanceId, {
      instanceId,
      taskId: context.taskId,
      startTime,
    });

    try {
      const apiKey = resolveMoonshotApiKey();
      if (!apiKey) {
        throw new Error(
          'MOONSHOT_API_KEY is not set. ' +
            'Set the environment variable to enable Kimi spawning. ' +
            'Get a key at: https://platform.moonshot.cn/',
        );
      }

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

      const response = await fetch(`${MOONSHOT_API_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: enrichedPrompt,
            },
          ],
          stream: false,
        }),
      });

      if (!response.ok) {
        const bodyText = await response.text();
        throw new Error(
          `Moonshot API error ${response.status} ${response.statusText}: ${bodyText}`,
        );
      }

      const data = (await response.json()) as MoonshotChatResponse;

      if (data.error) {
        throw new Error(`Moonshot API returned error: ${data.error.message} (${data.error.type})`);
      }

      const output = data.choices[0]?.message?.content ?? '';
      const endTime = new Date().toISOString();
      this.runningInstances.delete(instanceId);

      return {
        instanceId,
        taskId: context.taskId,
        providerId: 'kimi',
        status: 'completed',
        output,
        exitCode: 0,
        startTime,
        endTime,
      };
    } catch (error) {
      const endTime = new Date().toISOString();
      this.runningInstances.delete(instanceId);

      return {
        instanceId,
        taskId: context.taskId,
        providerId: 'kimi',
        status: 'failed',
        exitCode: 1,
        startTime,
        endTime,
        error: getErrorMessage(error),
      };
    }
  }

  /**
   * List currently in-flight Kimi API calls.
   *
   * Because each `spawn()` call awaits the API response, this list is
   * typically empty unless concurrent spawns are in flight.
   *
   * @returns Array of in-progress spawn results
   */
  async listRunning(): Promise<SpawnResult[]> {
    return [...this.runningInstances.values()].map((entry) => ({
      instanceId: entry.instanceId,
      taskId: entry.taskId,
      providerId: 'kimi',
      status: 'running' as const,
      startTime: entry.startTime,
    }));
  }

  /**
   * Remove an instance from the running-instances tracking map.
   *
   * The underlying fetch call cannot be cancelled externally once started.
   * This method removes the entry so it will no longer appear in
   * `listRunning()`, but does not abort the in-progress HTTP request.
   *
   * @param instanceId - ID of the spawn instance to terminate
   */
  async terminate(instanceId: string): Promise<void> {
    this.runningInstances.delete(instanceId);
  }
}
