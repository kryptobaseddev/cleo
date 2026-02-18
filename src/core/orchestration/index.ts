/**
 * Orchestrator commands - coordinate multi-agent workflows.
 * @task T4466
 * @epic T4454
 */

import { readJsonRequired } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Task, TodoFile } from '../../types/task.js';
import { getTodoPath } from '../paths.js';
import { getExecutionWaves } from '../phases/deps.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Orchestrator session state. */
export interface OrchestratorSession {
  epicId: string;
  startedAt: string;
  status: 'active' | 'paused' | 'completed';
  currentWave: number;
  completedTasks: string[];
  spawnedAgents: string[];
}

/** Spawn context for a subagent. */
export interface SpawnContext {
  taskId: string;
  protocol: string;
  prompt: string;
  tokenResolution: {
    fullyResolved: boolean;
    unresolvedTokens: string[];
  };
}

/** Task readiness assessment. */
export interface TaskReadiness {
  taskId: string;
  title: string;
  ready: boolean;
  blockers: string[];
  protocol: string;
}

/** Orchestrator analysis result. */
export interface AnalysisResult {
  epicId: string;
  totalTasks: number;
  waves: Array<{
    wave: number;
    tasks: Array<{ id: string; title: string; status: string }>;
  }>;
  readyTasks: string[];
  blockedTasks: string[];
  completedTasks: string[];
}

/**
 * Start an orchestrator session for an epic.
 * @task T4466
 */
export async function startOrchestration(
  epicId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<OrchestratorSession> {
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(getTodoPath(cwd));
  const epic = data.tasks.find(t => t.id === epicId);

  if (!epic) {
    throw new CleoError(ExitCode.NOT_FOUND, `Epic not found: ${epicId}`);
  }

  if (epic.type !== 'epic') {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      `Task ${epicId} is not an epic (type: ${epic.type})`,
    );
  }

  const session: OrchestratorSession = {
    epicId,
    startedAt: new Date().toISOString(),
    status: 'active',
    currentWave: 1,
    completedTasks: [],
    spawnedAgents: [],
  };

  return session;
}

/**
 * Analyze an epic's dependency structure.
 * @task T4466
 */
export async function analyzeEpic(epicId: string, cwd?: string, accessor?: DataAccessor): Promise<AnalysisResult> {
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(getTodoPath(cwd));
  const epic = data.tasks.find(t => t.id === epicId);

  if (!epic) {
    throw new CleoError(ExitCode.NOT_FOUND, `Epic not found: ${epicId}`);
  }

  const childTasks = data.tasks.filter(t => t.parentId === epicId);
  const waves = await getExecutionWaves(epicId, cwd);

  const completedTasks = childTasks.filter(t => t.status === 'done').map(t => t.id);
  const blockedTasks = childTasks.filter(t => t.status === 'blocked').map(t => t.id);

  // Find ready tasks (all deps complete, not yet started)
  const completedSet = new Set(completedTasks);
  const readyTasks = childTasks
    .filter(t => {
      if (t.status === 'done' || t.status === 'cancelled') return false;
      const deps = t.depends ?? [];
      return deps.every(d => completedSet.has(d));
    })
    .map(t => t.id);

  return {
    epicId,
    totalTasks: childTasks.length,
    waves: waves.map(w => ({
      wave: w.wave,
      tasks: w.tasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
    })),
    readyTasks,
    blockedTasks,
    completedTasks,
  };
}

/**
 * Get parallel-safe ready tasks for an epic.
 * @task T4466
 */
export async function getReadyTasks(epicId: string, cwd?: string, accessor?: DataAccessor): Promise<TaskReadiness[]> {
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(getTodoPath(cwd));
  const childTasks = data.tasks.filter(t => t.parentId === epicId);
  const completedIds = new Set(
    data.tasks.filter(t => t.status === 'done').map(t => t.id),
  );

  return childTasks
    .filter(t => t.status !== 'done' && t.status !== 'cancelled')
    .map(task => {
      const deps = task.depends ?? [];
      const unmetDeps = deps.filter(d => !completedIds.has(d));
      const protocol = autoDispatch(task);

      return {
        taskId: task.id,
        title: task.title,
        ready: unmetDeps.length === 0,
        blockers: unmetDeps,
        protocol,
      };
    });
}

/**
 * Get the next task to work on for an epic.
 * @task T4466
 */
export async function getNextTask(epicId: string, cwd?: string, accessor?: DataAccessor): Promise<TaskReadiness | null> {
  const readyTasks = await getReadyTasks(epicId, cwd, accessor);
  const ready = readyTasks.filter(t => t.ready);

  if (ready.length === 0) return null;

  return ready[0]!;
}

/**
 * Prepare a spawn context for a subagent.
 * @task T4466
 */
export async function prepareSpawn(taskId: string, cwd?: string, accessor?: DataAccessor): Promise<SpawnContext> {
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(getTodoPath(cwd));
  const task = data.tasks.find(t => t.id === taskId);

  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${taskId}`);
  }

  const protocol = autoDispatch(task);
  const prompt = buildSpawnPrompt(task, protocol);

  // Check for unresolved tokens
  const unresolvedTokens = findUnresolvedTokens(prompt);

  return {
    taskId,
    protocol,
    prompt,
    tokenResolution: {
      fullyResolved: unresolvedTokens.length === 0,
      unresolvedTokens,
    },
  };
}

/**
 * Validate a subagent's output.
 * @task T4466
 */
export async function validateSpawnOutput(
  _taskId: string,
  output: { file?: string; manifestEntry?: boolean },
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  if (!output.file) {
    errors.push('No output file specified');
  }

  if (!output.manifestEntry) {
    errors.push('No manifest entry appended');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Get orchestrator context summary.
 * @task T4466
 */
export async function getOrchestratorContext(epicId: string, cwd?: string, accessor?: DataAccessor): Promise<{
  epicId: string;
  epicTitle: string;
  totalTasks: number;
  completed: number;
  inProgress: number;
  blocked: number;
  pending: number;
  completionPercent: number;
}> {
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(getTodoPath(cwd));
  const epic = data.tasks.find(t => t.id === epicId);

  if (!epic) {
    throw new CleoError(ExitCode.NOT_FOUND, `Epic not found: ${epicId}`);
  }

  const children = data.tasks.filter(t => t.parentId === epicId);
  const completed = children.filter(t => t.status === 'done').length;
  const inProgress = children.filter(t => t.status === 'active').length;
  const blocked = children.filter(t => t.status === 'blocked').length;
  const pending = children.filter(t => t.status === 'pending').length;

  return {
    epicId,
    epicTitle: epic.title,
    totalTasks: children.length,
    completed,
    inProgress,
    blocked,
    pending,
    completionPercent: children.length > 0 ? Math.floor(completed * 100 / children.length) : 0,
  };
}

// === SKILL DISPATCH ===

/** Protocol dispatch mapping. */
const DISPATCH_MAP: Record<string, { keywords: string[]; labels: string[] }> = {
  research: {
    keywords: ['research', 'investigate', 'explore', 'analyze', 'study'],
    labels: ['research', 'investigation', 'analysis'],
  },
  consensus: {
    keywords: ['vote', 'validate', 'decide', 'consensus'],
    labels: ['consensus', 'voting', 'decision'],
  },
  specification: {
    keywords: ['spec', 'rfc', 'design', 'specification'],
    labels: ['specification', 'design', 'rfc'],
  },
  decomposition: {
    keywords: ['epic', 'plan', 'decompose', 'breakdown'],
    labels: ['decomposition', 'planning', 'epic'],
  },
  implementation: {
    keywords: ['implement', 'build', 'create', 'code', 'develop', 'port', 'fix'],
    labels: ['implementation', 'development', 'coding'],
  },
  contribution: {
    keywords: ['pr', 'merge', 'shared', 'contribute'],
    labels: ['contribution', 'pr', 'merge'],
  },
  release: {
    keywords: ['release', 'version', 'publish', 'ship'],
    labels: ['release', 'versioning', 'publishing'],
  },
};

/**
 * Auto-dispatch: determine the protocol for a task based on metadata.
 * @task T4466
 */
export function autoDispatch(task: Task): string {
  // 1. Label-based dispatch (highest priority)
  if (task.labels?.length) {
    for (const [protocol, config] of Object.entries(DISPATCH_MAP)) {
      if (task.labels.some(l => config.labels.includes(l))) {
        return protocol;
      }
    }
  }

  // 2. Type-based dispatch
  if (task.type === 'epic') return 'decomposition';

  // 3. Keyword-based dispatch
  const text = `${task.title} ${task.description ?? ''}`.toLowerCase();
  for (const [protocol, config] of Object.entries(DISPATCH_MAP)) {
    if (config.keywords.some(kw => text.includes(kw))) {
      return protocol;
    }
  }

  // 4. Fallback
  return 'implementation';
}

/**
 * Build a spawn prompt for a subagent.
 * @task T4466
 */
function buildSpawnPrompt(task: Task, protocol: string): string {
  const epicId = task.parentId ?? 'none';
  const date = new Date().toISOString().split('T')[0];

  return [
    `## Task: ${task.id}`,
    `**Title**: ${task.title}`,
    task.description ? `**Description**: ${task.description}` : '',
    `**Protocol**: ${protocol}`,
    `**Epic**: ${epicId}`,
    `**Date**: ${date}`,
    '',
    `### Instructions`,
    `1. Set focus: \`cleo focus set ${task.id}\``,
    `2. Execute the ${protocol} protocol`,
    `3. Write output file`,
    `4. Append manifest entry to MANIFEST.jsonl`,
    `5. Complete: \`cleo complete ${task.id}\``,
    '',
    task.acceptance?.length ? `### Acceptance Criteria\n${task.acceptance.map(a => `- ${a}`).join('\n')}` : '',
    task.depends?.length ? `### Dependencies\n${task.depends.map(d => `- ${d}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Find unresolved tokens in a prompt.
 * @task T4466
 */
function findUnresolvedTokens(prompt: string): string[] {
  const tokens: string[] = [];
  const tokenRegex = /\{\{([A-Z_]+)\}\}/g;
  let match;
  while ((match = tokenRegex.exec(prompt)) !== null) {
    tokens.push(match[1]!);
  }

  const refRegex = /@([a-zA-Z0-9_./\-]+\.md)/g;
  while ((match = refRegex.exec(prompt)) !== null) {
    tokens.push(`@${match[1]}`);
  }

  return tokens;
}

/**
 * Resolve tokens in a prompt string.
 * @task T4466
 */
export function resolveTokens(
  prompt: string,
  context: Record<string, string>,
): { resolved: string; unresolved: string[] } {
  let resolved = prompt;
  const unresolved: string[] = [];

  resolved = resolved.replace(/\{\{([A-Z_]+)\}\}/g, (fullMatch, token: string) => {
    if (context[token] !== undefined) {
      return context[token]!;
    }
    unresolved.push(token);
    return fullMatch;
  });

  return { resolved, unresolved };
}
