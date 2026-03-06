/**
 * OpenCode Spawn Adapter
 *
 * Concrete implementation of CLEOSpawnAdapter for OpenCode.
 * Uses the OpenCode CLI for detached subagent execution and keeps a
 * project-local CLEO agent definition in sync for provider-native spawning.
 *
 * @task T1114
 * @task T5236
 */

import { spawn as spawnProcess, exec as execProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  CLEOSpawnAdapter,
  CLEOSpawnContext,
  CLEOSpawnResult,
} from '../../../types/spawn.js';
import { getSubagentConfig } from '../../skills/agents/config.js';

const execAsync = promisify(execProcess);

export const OPENCODE_SUBAGENT_NAME = 'cleo-subagent';
const OPENCODE_FALLBACK_AGENT = 'general';

function normalizeDescription(description: string | undefined): string {
  return (description ?? 'CLEO task executor with protocol compliance.')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildOpenCodeAgentMarkdown(
  description: string | undefined,
  instructions: string,
): string {
  return [
    '---',
    `description: ${JSON.stringify(normalizeDescription(description))}`,
    'mode: subagent',
    'hidden: true',
    '---',
    '',
    instructions.trim(),
    '',
  ].join('\n');
}

async function ensureOpenCodeSubagent(
  workingDirectory: string,
): Promise<{ agentName: string; agentPath?: string }> {
  const config = getSubagentConfig(workingDirectory);
  if (!config?.customInstructions) {
    return { agentName: OPENCODE_FALLBACK_AGENT };
  }

  const agentDir = join(workingDirectory, '.opencode', 'agent');
  const agentPath = join(agentDir, `${OPENCODE_SUBAGENT_NAME}.md`);
  const content = buildOpenCodeAgentMarkdown(config.description, config.customInstructions);

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

  return { agentName: OPENCODE_SUBAGENT_NAME, agentPath };
}

/**
 * OpenCode Spawn Adapter
 *
 * Uses `opencode run --agent ...` in detached mode to execute the fully
 * resolved CLEO spawn prompt through OpenCode's native agent system.
 */
export class OpenCodeSpawnAdapter implements CLEOSpawnAdapter {
  readonly id = 'opencode';
  readonly providerId = 'opencode';

  private processMap: Map<string, number> = new Map();

  async canSpawn(): Promise<boolean> {
    try {
      await execAsync('which opencode');

      const { providerSupportsById } = await import('@cleocode/caamp');
      return providerSupportsById('opencode', 'spawn.supportsSubagents');
    } catch {
      return false;
    }
  }

  async spawn(context: CLEOSpawnContext): Promise<CLEOSpawnResult> {
    const instanceId = `opencode-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const startTime = new Date().toISOString();
    const workingDirectory = context.workingDirectory ?? process.cwd();
    let agentName = OPENCODE_FALLBACK_AGENT;

    try {
      try {
        const ensured = await ensureOpenCodeSubagent(workingDirectory);
        agentName = ensured.agentName;
      } catch {
        // Fall back to the built-in general agent when the custom agent
        // definition cannot be synchronized into the project.
        agentName = OPENCODE_FALLBACK_AGENT;
      }

      const child = spawnProcess(
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
        this.processMap.set(instanceId, child.pid);
      }

      child.on('exit', () => {
        this.processMap.delete(instanceId);
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

  async terminate(instanceId: string): Promise<void> {
    const pid = this.processMap.get(instanceId);

    if (!pid) {
      return;
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // The process may already be gone.
    } finally {
      this.processMap.delete(instanceId);
    }
  }
}
