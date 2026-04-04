/**
 * OpenCode Spawn Provider
 *
 * Implements AdapterSpawnProvider for OpenCode CLI.
 * Migrated from src/core/spawn/adapters/opencode-adapter.ts
 *
 * Uses `opencode run --agent ... --format json` to spawn subagent
 * processes. Processes run detached and are tracked by PID for
 * listing and termination.
 *
 * @task T5240
 */

import { exec, spawn as nodeSpawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AdapterSpawnProvider, SpawnContext, SpawnResult } from '@cleocode/contracts';

const execAsync = promisify(exec);

/** Name used for the CLEO subagent definition in OpenCode's agent directory. */
const OPENCODE_SUBAGENT_NAME = 'cleo-subagent';

/** Fallback agent name when custom agent definition cannot be created. */
const OPENCODE_FALLBACK_AGENT = 'general';

/** Internal tracking entry for a spawned process. */
interface TrackedProcess {
  pid: number;
  taskId: string;
  startTime: string;
}

/**
 * Build the markdown content for an OpenCode agent definition file.
 *
 * OpenCode agents are defined as markdown files with YAML frontmatter
 * in the .opencode/agent/ directory.
 *
 * @remarks
 * The generated markdown uses YAML frontmatter with `mode: subagent`
 * and `hidden: true` so the agent does not appear in OpenCode's
 * interactive agent selection menu.
 *
 * @param description - Agent description for frontmatter
 * @param instructions - Markdown instructions body
 * @returns Complete agent definition markdown with YAML frontmatter
 *
 * @example
 * ```typescript
 * import { buildOpenCodeAgentMarkdown } from '@cleocode/adapters/providers/opencode/spawn';
 *
 * const md = buildOpenCodeAgentMarkdown(
 *   'CLEO task executor',
 *   '# Subagent\n\nExecute the delegated task.',
 * );
 * ```
 */
export function buildOpenCodeAgentMarkdown(description: string, instructions: string): string {
  const normalizedDesc = description.replace(/\s+/g, ' ').trim();
  return [
    '---',
    `description: ${JSON.stringify(normalizedDesc)}`,
    'mode: subagent',
    'hidden: true',
    '---',
    '',
    instructions.trim(),
    '',
  ].join('\n');
}

/**
 * Ensure the CLEO subagent definition exists in the project's
 * .opencode/agent/ directory.
 *
 * Creates or updates the agent definition file if the content has changed.
 *
 * @param workingDirectory - Project root directory
 * @returns The agent name to use for spawning
 */
async function ensureSubagentDefinition(workingDirectory: string): Promise<string> {
  const agentDir = join(workingDirectory, '.opencode', 'agent');
  const agentPath = join(agentDir, `${OPENCODE_SUBAGENT_NAME}.md`);
  const description = 'CLEO task executor with protocol compliance.';
  const instructions = [
    '# CLEO Subagent',
    '',
    'You are a CLEO subagent executing a delegated task.',
    'Follow the CLEO protocol and complete the assigned work.',
    '',
    '@~/.cleo/templates/CLEO-INJECTION.md',
  ].join('\n');

  const content = buildOpenCodeAgentMarkdown(description, instructions);

  await mkdir(agentDir, { recursive: true });

  let existing: string | null = null;
  try {
    existing = await readFile(agentPath, 'utf-8');
  } catch {
    existing = null;
  }

  if (existing !== content) {
    await writeFile(agentPath, content, 'utf-8');
  }

  return OPENCODE_SUBAGENT_NAME;
}

/**
 * Spawn provider for OpenCode.
 *
 * Spawns detached OpenCode CLI processes for subagent execution.
 * Each spawn ensures a CLEO subagent definition exists, then runs
 * `opencode run --format json --agent <name> --title <title> <prompt>`
 * as a detached, unref'd child process.
 *
 * @remarks
 * Before spawning, the provider ensures a `cleo-subagent` agent definition
 * exists in `.opencode/agent/`. If the definition cannot be created, it
 * falls back to the built-in `general` agent. Processes are tracked by
 * instance ID in an in-memory map and verified via `kill(pid, 0)` liveness
 * checks.
 */
export class OpenCodeSpawnProvider implements AdapterSpawnProvider {
  /** Map of instance IDs to tracked process info. */
  private processMap = new Map<string, TrackedProcess>();

  /**
   * Check if the OpenCode CLI is available in PATH.
   *
   * @returns true if `opencode` is found via `which`
   */
  async canSpawn(): Promise<boolean> {
    try {
      await execAsync('which opencode');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Spawn a subagent via OpenCode CLI.
   *
   * Ensures the CLEO subagent definition exists in the project's
   * .opencode/agent/ directory, then spawns a detached OpenCode
   * process. The process runs independently of the parent.
   *
   * @param context - Spawn context with taskId, prompt, and options
   * @returns Spawn result with instance ID and status
   */
  async spawn(context: SpawnContext): Promise<SpawnResult> {
    const instanceId = `opencode-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const startTime = new Date().toISOString();
    const workingDirectory = context.workingDirectory ?? process.cwd();

    try {
      let agentName: string;
      try {
        agentName = await ensureSubagentDefinition(workingDirectory);
      } catch {
        agentName = OPENCODE_FALLBACK_AGENT;
      }

      const child = nodeSpawn(
        'opencode',
        [
          'run',
          '--format',
          'json',
          '--agent',
          agentName,
          '--title',
          `CLEO ${context.taskId}`,
          context.prompt,
        ],
        {
          cwd: workingDirectory,
          detached: true,
          stdio: 'ignore',
        },
      );

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
        providerId: 'opencode',
        status: 'running',
        startTime,
      };
    } catch {
      return {
        instanceId,
        taskId: context.taskId,
        providerId: 'opencode',
        status: 'failed',
        startTime,
        endTime: new Date().toISOString(),
      };
    }
  }

  /**
   * List currently running OpenCode subagent processes.
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
          providerId: 'opencode',
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
