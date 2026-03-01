/**
 * Orchestrator spawn logic.
 * Ports lib/skills/orchestrator-spawn.sh (prompt building functions from orchestrator-startup.sh).
 *
 * Builds fully-resolved prompts for subagent spawning by:
 *   1. Loading skill template (SKILL.md)
 *   2. Injecting token values
 *   3. Appending protocol base
 *   4. Appending task context
 *
 * @epic T4454
 * @task T4519
 */

import { existsSync, readFileSync } from 'node:fs';
import { getTaskPath, getAgentOutputsDir } from '../../paths.js';
import { findSkill, mapSkillName } from '../discovery.js';
import { type TokenValues } from '../injection/token.js';
import { injectProtocol } from '../injection/subagent.js';
import type { Task } from '../../../types/task.js';
import type { SpawnPromptResult } from '../types.js';
import { CleoError } from '../../errors.js';
import { ExitCode } from '../../../types/exit-codes.js';

// ============================================================================
// Prompt Building
// ============================================================================

/**
 * Build a fully-resolved prompt for spawning a subagent.
 * @task T4519
 */
export function buildPrompt(
  taskId: string,
  templateName: string = 'TASK-EXECUTOR',
  cwd?: string,
  tier?: 0 | 1 | 2,
): SpawnPromptResult {
  const taskPath = getTaskPath(cwd);

  if (!existsSync(taskPath)) {
    throw new CleoError(ExitCode.NOT_FOUND, 'Todo file not found. Run: cleo init');
  }

  // Load task
  const data = JSON.parse(readFileSync(taskPath, 'utf-8'));
  const tasks: Task[] = data.tasks ?? [];
  const task = tasks.find(t => t.id === taskId);

  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task ${taskId} not found`);
  }

  // Find skill template
  const skill = findSkill(templateName, cwd);
  if (!skill || !skill.content) {
    const { canonical } = mapSkillName(templateName);
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Skill template ${templateName} not found`,
      { fix: `Expected at skills/${canonical}/SKILL.md` },
    );
  }

  // Prepare token values
  const dateToday = new Date().toISOString().split('T')[0];
  const topicSlug = task.title
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-|-$/g, '');

  const outputDir = getAgentOutputsDir(cwd);
  const manifestPath = `${outputDir}/MANIFEST.jsonl`;

  // Get epic info
  let epicId = '';
  if (task.parentId) {
    epicId = task.parentId;
  }

  const tokenValues: TokenValues = {
    TASK_ID: taskId,
    DATE: dateToday,
    TOPIC_SLUG: topicSlug,
    EPIC_ID: epicId,
    OUTPUT_DIR: outputDir,
    MANIFEST_PATH: manifestPath,
    TITLE: task.title,
    TASK_TITLE: task.title,
    TASK_NAME: task.title,
    TASK_DESCRIPTION: task.description ?? '',
    RESEARCH_ID: `${topicSlug}-${dateToday}`,

    // CLEO command defaults
    TASK_SHOW_CMD: 'cleo show',
    TASK_START_CMD: 'cleo start',
    TASK_CURRENT_CMD: 'cleo current',
    TASK_COMPLETE_CMD: 'cleo complete',
    TASK_LINK_CMD: 'cleo research link',
    TASK_LIST_CMD: 'cleo list',
    TASK_FIND_CMD: 'cleo find',
    TASK_ADD_CMD: 'cleo add',
    TASK_EXISTS_CMD: 'cleo exists',
    TASK_PHASE_CMD: 'cleo phase show',
    TASK_TREE_CMD: 'cleo list --tree',
    SESSION_LIST_CMD: 'cleo session list',
    SESSION_START_CMD: 'cleo session start',
    SESSION_END_CMD: 'cleo session end',
    SESSION_GC_CMD: 'cleo session gc',
    RESEARCH_LIST_CMD: 'cleo research list',
    RESEARCH_SHOW_CMD: 'cleo research show',
    RESEARCH_PENDING_CMD: 'cleo research pending',
    RESEARCH_INJECT_CMD: 'cleo research inject',
    DASH_CMD: 'cleo dash',
  };

  // Extract task-specific tokens
  if (task.labels?.length) {
    tokenValues['TOPICS_JSON'] = JSON.stringify(task.labels);
  }
  if (task.depends?.length) {
    tokenValues['DEPENDS_LIST'] = task.depends.join(', ');
  }

  // Inject tokens and protocol into template
  const promptContent = injectProtocol(skill.content, taskId, tokenValues, cwd, tier);

  return {
    taskId,
    template: templateName,
    topicSlug,
    date: dateToday,
    outputDir,
    outputFile: `${dateToday}_${topicSlug}.md`,
    prompt: promptContent,
  };
}

/**
 * Generate full spawn command with metadata.
 * @task T4519
 */
export function spawn(
  taskId: string,
  templateName: string = 'TASK-EXECUTOR',
  cwd?: string,
  tier?: 0 | 1 | 2,
): SpawnPromptResult & { spawnTimestamp: string } {
  const result = buildPrompt(taskId, templateName, cwd, tier);

  return {
    ...result,
    spawnTimestamp: new Date().toISOString(),
  };
}

/**
 * Check if tasks can be spawned in parallel (no inter-dependencies).
 * @task T4519
 */
export function canParallelize(
  taskIds: string[],
  cwd?: string,
): {
  canParallelize: boolean;
  conflicts: Array<{ id: string; dependsOn: string[] }>;
  safeToSpawn: string[];
} {
  if (taskIds.length === 0) {
    return { canParallelize: true, conflicts: [], safeToSpawn: [] };
  }

  const taskPath = getTaskPath(cwd);
  if (!existsSync(taskPath)) {
    return { canParallelize: true, conflicts: [], safeToSpawn: taskIds };
  }

  const data = JSON.parse(readFileSync(taskPath, 'utf-8'));
  const tasks: Task[] = data.tasks ?? [];
  const taskIdSet = new Set(taskIds);

  const conflicts: Array<{ id: string; dependsOn: string[] }> = [];
  const safeToSpawn: string[] = [];

  for (const tid of taskIds) {
    const task = tasks.find(t => t.id === tid);
    if (!task) continue;

    const depsInSet = (task.depends ?? []).filter(d => taskIdSet.has(d));
    if (depsInSet.length > 0) {
      conflicts.push({ id: tid, dependsOn: depsInSet });
    } else {
      safeToSpawn.push(tid);
    }
  }

  return {
    canParallelize: conflicts.length === 0,
    conflicts,
    safeToSpawn,
  };
}

// ============================================================================
// Batch Spawn
// ============================================================================

/** Result of a single spawn within a batch. */
export interface BatchSpawnEntry {
  taskId: string;
  success: boolean;
  result?: SpawnPromptResult & { spawnTimestamp: string };
  error?: string;
}

/** Result of a batch spawn operation. */
export interface BatchSpawnResult {
  count: number;
  succeeded: number;
  failed: number;
  spawns: BatchSpawnEntry[];
}

/**
 * Spawn prompts for multiple tasks in a batch.
 * Ports orchestrator_spawn_batch from lib/skills/orchestrator-spawn.sh.
 *
 * Iterates over task IDs, building spawn prompts for each. Individual failures
 * are captured per-entry rather than aborting the entire batch.
 *
 * @task T4712
 * @epic T4663
 */
export function spawnBatch(
  taskIds: string[],
  templateName?: string,
  cwd?: string,
  tier?: 0 | 1 | 2,
): BatchSpawnResult {
  const spawns: BatchSpawnEntry[] = [];

  for (const taskId of taskIds) {
    try {
      const result = spawn(taskId, templateName, cwd, tier);
      spawns.push({ taskId, success: true, result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      spawns.push({ taskId, success: false, error: message });
    }
  }

  return {
    count: spawns.length,
    succeeded: spawns.filter(s => s.success).length,
    failed: spawns.filter(s => !s.success).length,
    spawns,
  };
}

