/**
 * Subagent protocol injection.
 * Ports lib/skills/subagent-inject.sh.
 *
 * Guarantees protocol compliance for all subagent spawns by automatically
 * injecting the RFC 2119 protocol base from skills/_shared/subagent-protocol-base.md.
 *
 * Injection pattern:
 *   [SKILL CONTENT]
 *   ---
 *   ## SUBAGENT PROTOCOL (RFC 2119)
 *   [Content from subagent-protocol-base.md with tokens resolved]
 *   ---
 *   [TASK CONTEXT]
 *
 * @epic T4454
 * @task T4521
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot, getTodoPath } from '../../paths.js';
import { findSkill } from '../discovery.js';
import { injectTokens, type TokenValues } from './token.js';
import type { Task } from '../../../types/task.js';
import { CleoError } from '../../errors.js';
import { ExitCode } from '../../../types/exit-codes.js';

// ============================================================================
// Protocol Base
// ============================================================================

/**
 * Get the path to the subagent protocol base file.
 */
function getProtocolBasePath(cwd?: string): string {
  return join(getProjectRoot(cwd), 'skills', '_shared', 'subagent-protocol-base.md');
}

/**
 * Load the subagent protocol base content.
 * @task T4521
 */
export function loadProtocolBase(cwd?: string): string | null {
  const path = getProtocolBasePath(cwd);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

// ============================================================================
// Task Context
// ============================================================================

/**
 * Build task context block for injection into a subagent prompt.
 * @task T4521
 */
export function buildTaskContext(taskId: string, cwd?: string): string {
  const todoPath = getTodoPath(cwd);
  if (!existsSync(todoPath)) {
    return `## Task Context\n\n**Task**: ${taskId}\n**Status**: unknown\n`;
  }

  const data = JSON.parse(readFileSync(todoPath, 'utf-8'));
  const tasks: Task[] = data.tasks ?? [];
  const task = tasks.find(t => t.id === taskId);

  if (!task) {
    return `## Task Context\n\n**Task**: ${taskId}\n**Status**: not found\n`;
  }

  const lines = [
    '## Task Context',
    '',
    `**Task**: ${task.id}`,
    `**Title**: ${task.title}`,
    `**Status**: ${task.status}`,
  ];

  if (task.description) {
    lines.push(`**Description**: ${task.description}`);
  }
  if (task.parentId) {
    lines.push(`**Epic**: ${task.parentId}`);
  }
  if (task.depends?.length) {
    lines.push(`**Dependencies**: ${task.depends.join(', ')}`);
  }
  if (task.labels?.length) {
    lines.push(`**Labels**: ${task.labels.join(', ')}`);
  }
  if (task.priority) {
    lines.push(`**Priority**: ${task.priority}`);
  }

  return lines.join('\n');
}

// ============================================================================
// Injection
// ============================================================================

/**
 * Inject the subagent protocol into skill content.
 * Composes: skill content + protocol base + task context.
 * @task T4521
 */
export function injectProtocol(
  skillContent: string,
  taskId: string,
  tokenValues: TokenValues,
  cwd?: string,
): string {
  const protocolBase = loadProtocolBase(cwd);
  const taskContext = buildTaskContext(taskId, cwd);

  // Inject tokens into skill content
  const resolvedSkill = injectTokens(skillContent, tokenValues);

  // Compose the full prompt
  const parts = [resolvedSkill];

  if (protocolBase) {
    const resolvedProtocol = injectTokens(protocolBase, tokenValues);
    parts.push('\n---\n');
    parts.push('## SUBAGENT PROTOCOL (RFC 2119)\n\n');
    parts.push(resolvedProtocol);
  }

  parts.push('\n---\n');
  parts.push(taskContext);

  return parts.join('\n');
}

/**
 * Full orchestrator spawn workflow (skill-based).
 * High-level function that loads the skill, injects protocol, and returns the prompt.
 * @task T4521
 */
export function orchestratorSpawnSkill(
  taskId: string,
  skillName: string,
  tokenValues: TokenValues,
  cwd?: string,
): string {
  // Find the skill
  const skill = findSkill(skillName, cwd);
  if (!skill || !skill.content) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Skill not found: ${skillName}`,
      { fix: `Check skills directory for ${skillName}/SKILL.md` },
    );
  }

  return injectProtocol(skill.content, taskId, tokenValues, cwd);
}

/**
 * Prepare standard token values for a task spawn.
 * @task T4521
 */
export function prepareTokenValues(
  taskId: string,
  topicSlug: string,
  epicId?: string,
  _cwd?: string,
): TokenValues {
  const dateToday = new Date().toISOString().split('T')[0];

  const values: TokenValues = {
    TASK_ID: taskId,
    DATE: dateToday,
    TOPIC_SLUG: topicSlug,
    RESEARCH_ID: `${topicSlug}-${dateToday}`,
    TITLE: topicSlug.replace(/-/g, ' '),
  };

  if (epicId) {
    values['EPIC_ID'] = epicId;
  }

  return values;
}
