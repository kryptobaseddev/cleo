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
 * @task T14357 — lead spawns strip denied tools via --disallowedTools
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AdapterSpawnProvider,
  AgentSuiteOwnership,
  SpawnContext,
  SpawnResult,
} from '@cleocode/contracts';
import { getErrorMessage } from '@cleocode/contracts';
import { E_LEAD_NO_OWNER_CHANNEL } from '@cleocode/contracts/operations/orchestrate.js';
import { findOnPath } from '@cleocode/paths';
import { OrcaExecutionError } from '../../orca-execution.js';
import { buildAgentSpawnArgs } from '../shared/agent-spawn-wrapper.js';
import { leadDeniedTools } from '../shared/lead-tool-strip.js';
import { removeSpawnPromptFile, writeSpawnPromptFile } from '../shared/prompt-file.js';
import {
  type LeadMcpSetup,
  prepareLeadMcp,
  requireLeadProjectTrust,
  runnerOnlyLeadMcp,
} from './lead-mcp.js';
import {
  buildLeadArgs,
  leadModeOf,
  leadSessionId,
  leadSessionSettings,
  resolveAbsoluteBinary,
  runInteractiveLead,
} from './lead-session.js';
import { reapAgentSuite } from './suite-reaper.js';

/**
 * Instance id CLEO pre-assigned to a tracked worker (`options.workerInstanceId`,
 * set only under `orchestrate.leadWorker.v1`), when it is shell-safe.
 *
 * @param options - Spawn context options.
 * @returns The id, or undefined when the spawn is not tracked.
 */
export function trackedWorkerInstanceId(options: SpawnContext['options']): string | undefined {
  const id = options?.workerInstanceId;
  return typeof id === 'string' && /^[A-Za-z0-9-]+$/.test(id) ? id : undefined;
}

/**
 * Claude Code settings that make a spawned worker report its own exit: a
 * `SessionEnd` hook running `cleo orchestrate worker-exit` for this instance,
 * which closes the worker record and fires SubagentStop once (T14359).
 *
 * @param instanceId - Spawn instance id the worker record is keyed by.
 * @returns The settings JSON passed to `claude --settings`.
 */
export function workerExitSettings(instanceId: string): string {
  const command = `cleo orchestrate worker-exit --instance ${instanceId}`;
  return JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: 'command', command }] }] } });
}

/** The string-valued entries of `options.env`. */
function envStrings(options: SpawnContext['options']): Record<string, string> {
  const env = options?.env;
  const out: Record<string, string> = {};
  if (typeof env !== 'object' || env === null) return out;
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') out[key] = value;
  return out;
}

/** Internal tracking entry for a spawned process. */
interface TrackedProcess {
  pid: number;
  taskId: string;
  startTime: string;
  /** Suite containment handle — used by terminate() and session-end reap (T11998). */
  ownership: AgentSuiteOwnership;
}

/**
 * Build the `claude` CLI argv for a spawn.
 *
 * - `--print`: non-interactive batch mode (process prompt, output response, exit)
 * - `--output-format json`: structured output for parsing
 * - Worker: `--dangerously-skip-permissions` allows every tool call without approval.
 * - Lead (`context.leadDeniedTools` set): an allow list built by
 *   `buildLeadArgs` (lead-session.ts) for the lead's mode, interactive or
 *   detached (T14363, T14423).
 *
 * @param context - Spawn context.
 * @param promptFile - Path of the prompt file passed as the final argument.
 * @param settingsArgs - Extra `--settings <file>` args (a tracked worker's exit hook, T14359).
 * @param leadMcp - A lead's MCP setup (from `prepareLeadMcp`). @defaultValue the runner alone, inline
 * @returns Argument list for the `claude` binary.
 * @task T14357
 */
export function buildClaudeArgs(
  context: SpawnContext,
  promptFile: string,
  settingsArgs: readonly string[] = [],
  leadMcp: LeadMcpSetup = runnerOnlyLeadMcp(),
): string[] {
  const denied = leadDeniedTools(context);
  if (denied === null) {
    return [
      '--print',
      '--dangerously-skip-permissions',
      '--output-format',
      'json',
      ...settingsArgs,
      promptFile,
    ];
  }
  const sessionId = leadSessionId(context.options);
  return buildLeadArgs({
    mode: leadModeOf(context.options),
    denied,
    leadMcp,
    promptFile,
    ...(sessionId !== undefined ? { sessionId } : {}),
    settingsArgs,
  });
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
 * written to temporary files under a private temp directory (`os.tmpdir()`) and cleaned up after the
 * child process exits. Processes are tracked by instance ID in an
 * in-memory map and verified via `kill(pid, 0)` liveness checks.
 */
export class ClaudeCodeSpawnProvider implements AdapterSpawnProvider {
  /** Lead spawns lose their denied tools through `--disallowedTools` (T14357). */
  readonly leadToolStrip = 'enforced' as const;

  /** Map of instance IDs to tracked process info. */
  private processMap = new Map<string, TrackedProcess>();

  /**
   * Check if the Claude CLI is available in PATH.
   *
   * @returns true if `claude` is found on PATH (PATHEXT-aware on Windows)
   */
  async canSpawn(): Promise<boolean> {
    return findOnPath('claude') !== null;
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
    const claudeJsonPath =
      leadDeniedTools(context) !== null
        ? requireLeadProjectTrust(context.workingDirectory ?? process.cwd(), {
            ...process.env,
            ...envStrings(context.options),
          })
        : undefined;
    // T14359: a tracked worker keeps the instance id its record was stored under.
    const trackedId = trackedWorkerInstanceId(context.options);
    const instanceId =
      trackedId ?? `claude-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
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

      tmpFile = await writeSpawnPromptFile('claude-spawn', enrichedPrompt);
      // T14359: a tracked worker signals its own exit. SessionEnd fires once
      // when the run ends; Stop fires every turn and may be blocked.
      let settingsArgs: string[] = [];
      if (trackedId !== undefined) {
        const settingsFile = join(dirname(tmpFile), 'settings.json');
        await writeFile(settingsFile, workerExitSettings(trackedId), 'utf-8');
        settingsArgs = ['--settings', settingsFile];
      }

      // T14423: a lead loads only the runner and the user's validated mbx
      // server; its settings delete the MCP file at start and the temp dir at end.
      let leadMcp: LeadMcpSetup | undefined;
      if (leadDeniedTools(context) !== null) {
        const dir = dirname(tmpFile);
        // T14363: absolute binaries, resolved now from absolute PATH entries.
        const binaries = {
          cleo: resolveAbsoluteBinary('cleo'),
          agentmbx: resolveAbsoluteBinary('agentmbx'),
        };
        leadMcp = await prepareLeadMcp(dir, context.workingDirectory ?? process.cwd(), {
          identityEnv: envStrings(context.options),
          ...(claudeJsonPath !== undefined ? { claudeJsonPath } : {}),
          ...(binaries.cleo ? { cleoBin: binaries.cleo } : {}),
        });
        const settingsFile = join(dir, 'lead-settings.json');
        const sessionId = leadSessionId(context.options);
        await writeFile(
          settingsFile,
          leadSessionSettings({
            dir,
            mcpFile: leadMcp.config,
            binaries,
            ...(sessionId !== undefined ? { sessionId } : {}),
          }),
          { mode: 0o600 },
        );
        settingsArgs = ['--settings', settingsFile];
        // T14363: a detached lead's only owner channel is the mbx server. Without
        // a loaded one it could never ask the owner, so it does not start.
        if (leadModeOf(context.options) === 'detached' && leadMcp.report.mailbox !== 'loaded') {
          await removeSpawnPromptFile(tmpFile);
          return {
            instanceId,
            taskId: context.taskId,
            providerId: 'claude-code',
            status: 'failed',
            startTime,
            endTime: new Date().toISOString(),
            error: `${E_LEAD_NO_OWNER_CHANNEL}: a detached lead needs the mbx MCP server to reach the owner (${leadMcp.report.warning ?? 'none is configured'})`,
            leadMcp: leadMcp.report,
          };
        }
        if (context.leadTerminalLauncher) {
          const command = resolveAbsoluteBinary('claude');
          if (!command || !context.onLeadStarted) {
            throw new Error(
              'The guarded Orca lead needs an absolute claude binary and a lifecycle recorder.',
            );
          }
          const terminal = await context.leadTerminalLauncher(
            {
              command,
              args: buildClaudeArgs(context, tmpFile, settingsArgs, leadMcp),
              cwd: context.workingDirectory ?? process.cwd(),
              tempDir: dir,
              env: envStrings(context.options),
            },
            context.onLeadStarted,
          );
          return {
            instanceId,
            taskId: context.taskId,
            providerId: 'claude-code',
            status: 'running',
            startTime,
            leadMcp: leadMcp.report,
            leadTempDir: dir,
            leadTerminal: terminal,
          };
        }
        if (leadModeOf(context.options) === 'interactive') {
          // T14363: the owner's terminal — stdio inherited, awaited, not detached.
          const env = envStrings(context.options);
          const exit = await runInteractiveLead(
            'claude',
            buildClaudeArgs(context, tmpFile, settingsArgs, leadMcp),
            {
              ...(context.workingDirectory ? { cwd: context.workingDirectory } : {}),
              ...(Object.keys(env).length > 0 ? { env: { ...process.env, ...env } } : {}),
              ...(context.onLeadStarted ? { onStart: context.onLeadStarted } : {}),
            },
          );
          await removeSpawnPromptFile(tmpFile);
          return {
            instanceId,
            taskId: context.taskId,
            providerId: 'claude-code',
            status: exit.exitCode === 0 ? 'completed' : 'failed',
            ...(exit.exitCode !== null ? { exitCode: exit.exitCode } : {}),
            startTime,
            endTime: new Date().toISOString(),
            leadMcp: leadMcp.report,
          };
        }
      }
      // --settings: a tracked worker's exit hook, or a lead's session hooks
      const claudeArgs = buildClaudeArgs(context, tmpFile, settingsArgs, leadMcp);

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
        // win32 `.cmd` shim routed through cmd.exe: keep its quoting (T12618).
        ...(spawnBuild.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
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
      // T14363: a detached lead's record names its own pid.
      if (leadMcp !== undefined && child.pid !== undefined) context.onLeadStarted?.(child.pid);

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
        await removeSpawnPromptFile(capturedTmpFile);
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
        ...(leadMcp ? { leadMcp: leadMcp.report, leadTempDir: dirname(tmpFile) } : {}),
      };
    } catch (error) {
      if (tmpFile) {
        await removeSpawnPromptFile(tmpFile);
      }
      if (context.leadTerminalLauncher) {
        // Public adapter entries are bundled separately, so constructor identity is not shared.
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof error.code === 'string' &&
          'fix' in error &&
          typeof error.fix === 'string'
        )
          throw error;
        throw new OrcaExecutionError(
          'E_LEAD_TOOLS_UNSTRIPPED',
          getErrorMessage(error),
          'Inspect the guarded Orca terminal setup and use --adapter claude-code; keep orchestrate.leadWorker.v1 enabled.',
        );
      }
      // Log spawn failure for debugging
      console.error(`[ClaudeCodeSpawnProvider] Failed to spawn: ${getErrorMessage(error)}`);

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
