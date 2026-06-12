/**
 * Claude Code Spawn Provider
 *
 * Implements AdapterSpawnProvider for Claude Code CLI.
 * Migrated from src/core/spawn/adapters/claude-code-adapter.ts
 *
 * Uses the native `claude` CLI to spawn subagent processes with prompts
 * written to temporary files. Processes run in per-session containment
 * (systemd transient scope on Linux, or setsid process group as fallback)
 * so that session end reaps the entire MCP suite tree.
 *
 * @task T5240
 * @task T11998 — per-session scope/pgid suite containment
 */

import { exec, spawn as nodeSpawn } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type {
  AdapterSpawnProvider,
  AgentSuiteOwnership,
  SpawnContext,
  SpawnResult,
} from '@cleocode/contracts';
import { getErrorMessage } from '@cleocode/contracts';
import { buildAgentSpawnArgs } from '../shared/agent-spawn-wrapper.js';
import { reapAgentSuite } from './suite-reaper.js';

const execAsync = promisify(exec);

/** Internal tracking entry for a spawned process. */
interface TrackedProcess {
  pid: number;
  taskId: string;
  startTime: string;
  /** Suite containment handle — used by terminate() and session-end reap (T11998). */
  ownership: AgentSuiteOwnership;
}

/**
 * Spawn provider for Claude Code.
 *
 * Spawns detached Claude CLI processes for subagent execution.
 * Each spawn writes its prompt to a temporary file, then runs
 * `claude --allow-insecure --no-upgrade-check <tmpFile>` as a
 * detached, unref'd child process.
 *
 * @remarks
 * The provider uses `--allow-insecure --no-upgrade-check` flags to
 * ensure the Claude CLI starts without interactive prompts. Prompts are
 * written to temporary files under `/tmp/` and cleaned up after the
 * child process exits. Processes are tracked by instance ID in an
 * in-memory map and verified via `kill(pid, 0)` liveness checks.
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
      // Enrich prompt with CANT bundle, memory bridge, mental model, and NEXUS context (T555, T625).
      // Best-effort: if CANT context is unavailable, the raw prompt is used.
      let enrichedPrompt = context.prompt;
      try {
        const { buildCantEnrichedPrompt } = await import('../../cant-context.js');
        enrichedPrompt = await buildCantEnrichedPrompt({
          projectDir: context.workingDirectory ?? process.cwd(),
          basePrompt: context.prompt,
          agentName: (context.options?.agentName as string) ?? undefined,
          // Inject NEXUS code intelligence context for the task scope (T625).
          // This injects callers/callees/impact data so the agent understands
          // blast radius before modifying any symbol.
          taskId: context.taskId ?? undefined,
        });
      } catch {
        // CANT enrichment unavailable — use raw prompt
      }

      tmpFile = `/tmp/claude-spawn-${instanceId}.txt`;
      await writeFile(tmpFile, enrichedPrompt, 'utf-8');

      // --print: non-interactive batch mode (process prompt, output response, exit)
      // --dangerously-skip-permissions: allow all tool calls without human approval
      // --output-format json: structured output for parsing
      const claudeArgs = [
        '--print',
        '--dangerously-skip-permissions',
        '--output-format',
        'json',
        tmpFile,
      ];

      // T11998: Build the argv with per-session containment.
      // On Linux with systemd, this wraps 'claude' inside a transient
      // cleo.slice scope (systemd-run --user --scope ...).
      // On non-Linux or without systemd, falls back to pgid (detached+setsid).
      // The ownership handle records the scope unit name or pgid for reaping.
      const spawnBuild = buildAgentSpawnArgs('claude', claudeArgs, instanceId);

      // For the systemd path: the child of systemd-run is NOT detached (systemd
      // manages the scope lifecycle).  For the pgid path: we use detached:true
      // so Node creates a new session, giving us a fresh pgid to kill the group.
      const isSystemd = spawnBuild.ownership.mode === 'systemd';
      const spawnOpts: Parameters<typeof nodeSpawn>[2] = {
        detached: !isSystemd,
        stdio: ['ignore', 'pipe', 'pipe'],
      };

      if (context.workingDirectory) {
        // T1759: workingDirectory is the isolation cwd from provisionIsolatedShell,
        // not the project root. orchestrateSpawnExecute sets this via the
        // centralized isolation utility.
        spawnOpts.cwd = context.workingDirectory;
      }

      // T1759: Merge isolation env vars (from options.env) into the spawn
      // environment so CLEO_WORKTREE_ROOT, CLEO_AGENT_ROLE, CLEO_WORKTREE_BRANCH,
      // and CLEO_PROJECT_HASH are visible to the spawned agent process.
      // Per-call options.env overrides win over process.env.
      const optionsEnv = context.options?.env as Record<string, string> | undefined;
      if (optionsEnv !== undefined && Object.keys(optionsEnv).length > 0) {
        spawnOpts.env = { ...process.env, ...optionsEnv };
      }

      const child = nodeSpawn(spawnBuild.command, spawnBuild.args, spawnOpts);
      // unref() so the parent process can exit without waiting for the child.
      // The containment scope/pgid ensures the child tree can still be reaped.
      child.unref();

      // Resolve the ownership handle: for the pgid path the pgid is the same
      // as the pid when detached:true (Node sets the child as the group leader).
      const ownership: AgentSuiteOwnership = {
        ...spawnBuild.ownership,
        pid: child.pid,
        pgid:
          spawnBuild.ownership.mode === 'pgid' && child.pid !== undefined
            ? child.pid
            : spawnBuild.ownership.pgid,
      };

      if (child.pid) {
        this.processMap.set(instanceId, {
          pid: child.pid,
          taskId: context.taskId,
          startTime,
          ownership,
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
        // T11998: surface the ownership handle in the result so callers can
        // persist it or pass it to reapAgentSuite on session end.
        ownership,
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
          // T11998: propagate ownership handle so callers can reap the suite.
          ownership: tracked.ownership,
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
   * Uses the suite-reaper to kill the entire process tree (root claude CLI +
   * all MCP grandchildren) via the containment handle recorded at spawn time.
   * Falls back to a direct SIGTERM on the tracked PID for legacy entries
   * that pre-date T11998 and lack an ownership handle.
   *
   * Idempotent: no-op if the instance is not found or has already exited.
   *
   * @param instanceId - ID of the spawn instance to terminate
   * @task T11998
   */
  async terminate(instanceId: string): Promise<void> {
    const tracked = this.processMap.get(instanceId);
    if (!tracked) return;

    this.processMap.delete(instanceId);

    try {
      // T11998: reap the entire suite tree via the containment handle.
      await reapAgentSuite(tracked.ownership);
    } catch {
      // Best-effort: fall back to direct SIGTERM on the root pid.
      try {
        process.kill(tracked.pid, 'SIGTERM');
      } catch {
        // Process may have already exited — no-op.
      }
    }
  }

  /**
   * Terminate all tracked spawn instances on session end.
   *
   * Called by the session lifecycle when a CLEO session ends, ensuring
   * no orphaned agent suites (root process + MCP children) remain.
   *
   * @task T11998
   */
  async terminateAll(): Promise<void> {
    const instanceIds = [...this.processMap.keys()];
    await Promise.allSettled(instanceIds.map((id) => this.terminate(id)));
  }
}
