/**
 * Autonomous agent work loop — business logic extracted from `cleo agent work`.
 *
 * The CLI handler delegates here after resolving credentials and starting the
 * runtime. This module owns the poll-and-dispatch loop, LAFS envelope parsing,
 * and clean shutdown coordination.
 *
 * @module agents/work-loop
 * @epic T9833
 * @task T10062
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the autonomous work loop. */
export interface WorkLoopConfig {
  /** The agent ID running the loop. */
  agentId: string;
  /** Poll interval in milliseconds (default: 30 000). */
  pollIntervalMs: number;
  /** When true, tasks are executed via `orchestrate.spawn.execute`. */
  executeMode: boolean;
  /** Restrict autonomous execution to this epic ID (optional). */
  epicRestrict?: string;
  /** Route spawns through this adapter ID (optional). */
  adapterRestrict?: string;
}

/** Callbacks the CLI layer provides for output and shutdown wiring. */
export interface WorkLoopCallbacks {
  /** Emit a human-readable info line. */
  onInfo: (message: string) => void;
  /** Emit a human-readable warning line. */
  onWarn: (message: string) => void;
  /** Called when shutdown is requested. */
  onShutdown?: () => void;
}

/** Summary emitted after the loop terminates. */
export interface WorkLoopSummary {
  agentId: string;
  mode: 'conductor-loop' | 'watch-only';
  iterations: number;
}

// ---------------------------------------------------------------------------
// LAFS envelope parser
// ---------------------------------------------------------------------------

/**
 * Parse a LAFS envelope from raw CLI stdout.
 *
 * Handles both the minimal `{ok, r}` and full `{success, result|data}` shapes.
 *
 * @internal
 */
function parseLafs<T = unknown>(raw: string): T | undefined {
  const lines = raw.trim().split('\n');
  const envLine = [...lines].reverse().find((l) => l.startsWith('{'));
  if (!envLine) return undefined;
  try {
    const env = JSON.parse(envLine) as {
      ok?: boolean;
      r?: T;
      success?: boolean;
      result?: T;
      data?: T;
    };
    if (env.ok === true) return env.r;
    if (env.success === true) return (env.result ?? env.data) as T | undefined;
    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// runCleo helper
// ---------------------------------------------------------------------------

/**
 * Invoke a sibling `cleo` CLI command and return its stdout.
 *
 * @param args - CLI arguments after `cleo`
 * @param timeoutMs - Execution timeout (default: 15 000)
 */
async function runCleo(args: string[], timeoutMs = 15_000): Promise<string> {
  const { stdout } = await execFileAsync('cleo', args, {
    encoding: 'utf-8',
    timeout: timeoutMs,
  });
  return stdout;
}

// ---------------------------------------------------------------------------
// Work loop
// ---------------------------------------------------------------------------

/**
 * Start the autonomous work loop and return a handle to stop it.
 *
 * The loop polls for the next ready task on every `pollIntervalMs` tick. In
 * watch-only mode it announces available tasks. In conductor-loop mode it
 * actually spawns them via `cleo orchestrate spawn`.
 *
 * @param config - Loop parameters
 * @param callbacks - Output / lifecycle callbacks
 * @returns A function that stops the loop and resolves to a summary.
 */
export function startWorkLoop(
  config: WorkLoopConfig,
  callbacks: WorkLoopCallbacks,
): { stop: () => WorkLoopSummary } {
  const { agentId, pollIntervalMs, executeMode, epicRestrict, adapterRestrict } = config;
  const { onInfo, onWarn } = callbacks;

  let inFlight = false;
  let iterations = 0;

  const workLoop = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    iterations += 1;
    try {
      const currentRaw = await runCleo(['current']).catch(() => '');
      if (currentRaw.trim()) return; // task already in progress

      const nextArgs = epicRestrict ? ['orchestrate', 'next', epicRestrict] : ['next'];
      const nextRaw = await runCleo(nextArgs).catch(() => '');
      if (!nextRaw.trim()) return;

      const nextData = parseLafs<{
        nextTask?: { id?: string; title?: string } | null;
        id?: string;
        title?: string;
      }>(nextRaw);
      const taskId =
        nextData?.nextTask?.id ?? (typeof nextData?.id === 'string' ? nextData.id : undefined);

      if (!taskId) return;

      if (!executeMode) {
        onInfo(`[${agentId}] Task available: ${taskId}. Pass --execute to run autonomously.`);
        return;
      }

      const spawnArgs = ['orchestrate', 'spawn', taskId];
      if (adapterRestrict) spawnArgs.push('--adapter', adapterRestrict);

      const spawnRaw = await runCleo(spawnArgs, 60_000).catch((e) => {
        onWarn(`[${agentId}] conductor-loop: spawn failed for ${taskId}: ${String(e)}`);
        return '';
      });

      const spawnData = parseLafs<{
        instanceId?: string;
        taskId?: string;
        status?: string;
      }>(spawnRaw);
      if (spawnData?.instanceId) {
        onInfo(
          `[${agentId}] conductor-loop spawned task=${taskId} instance=${spawnData.instanceId} status=${spawnData.status ?? 'unknown'}`,
        );
      }
    } catch {
      // non-fatal — loop continues
    } finally {
      inFlight = false;
    }
  }, pollIntervalMs);

  return {
    stop(): WorkLoopSummary {
      clearInterval(workLoop);
      if (executeMode) {
        onInfo(`[${agentId}] conductor-loop shutdown after ${iterations} iterations.`);
      }
      return { agentId, mode: executeMode ? 'conductor-loop' : 'watch-only', iterations };
    },
  };
}
