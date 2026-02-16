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
import { join } from 'node:path';
import { getTodoPath, getProjectRoot } from '../../paths.js';
import { findSkill, mapSkillName } from '../discovery.js';
import { injectTokens, type TokenValues } from '../injection/token.js';
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
): SpawnPromptResult {
  const todoPath = getTodoPath(cwd);

  if (!existsSync(todoPath)) {
    throw new CleoError(ExitCode.NOT_FOUND, 'Todo file not found. Run: cleo init');
  }

  // Load task
  const data = JSON.parse(readFileSync(todoPath, 'utf-8'));
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

  const outputDir = getAgentOutputDir(cwd);
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
    TASK_FOCUS_CMD: 'cleo focus set',
    TASK_FOCUS_SHOW_CMD: 'cleo focus show',
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

  // Inject tokens into template
  const promptContent = injectTokens(skill.content, tokenValues);

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
): SpawnPromptResult & { spawnTimestamp: string } {
  const result = buildPrompt(taskId, templateName, cwd);

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

  const todoPath = getTodoPath(cwd);
  if (!existsSync(todoPath)) {
    return { canParallelize: true, conflicts: [], safeToSpawn: taskIds };
  }

  const data = JSON.parse(readFileSync(todoPath, 'utf-8'));
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
// Helpers
// ============================================================================

/**
 * Get agent output directory (from config or default).
 */
function getAgentOutputDir(cwd?: string): string {
  const projectRoot = getProjectRoot(cwd);
  const configPath = join(projectRoot, '.cleo', 'config.json');

  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const dir = config.agentOutputs?.directory ?? config.research?.outputDir;
      if (dir) return dir;
    } catch {
      // fallback
    }
  }

  return 'claudedocs/agent-outputs';
}
