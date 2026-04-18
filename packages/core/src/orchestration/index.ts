/**
 * Orchestrator commands - coordinate multi-agent workflows.
 * @task T4466
 * @epic T4454
 */

import type { Task, TaskRef } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { getExecutionWaves } from '../phases/deps.js';
import type { DataAccessor } from '../store/data-accessor.js';
import {
  buildSpawnPrompt,
  DEFAULT_SPAWN_TIER,
  type SpawnProtocolPhase,
  type SpawnTier,
} from './spawn-prompt.js';

export type { CircularDependency, DependencyAnalysis, MissingDependency } from './analyze.js';
// Re-export new core modules for barrel access
export {
  analyzeDependencies,
  buildDependencyGraph,
  detectCircularDependencies,
  findMissingDependencies,
} from './analyze.js';
export type {
  AtomicityErrorCode,
  AtomicityInput,
  AtomicityResult,
} from './atomicity.js';
export { AtomicityViolationError, checkAtomicity, MAX_WORKER_FILES } from './atomicity.js';
export type { ContextEstimation } from './context.js';
export { countManifestEntries, estimateContext } from './context.js';
export type {
  HarnessHint,
  HarnessHintResult,
  HarnessProfile,
  ResolveHarnessHintOptions,
} from './harness-hint.js';
export {
  DEDUP_EMBED_CHARS,
  loadHarnessProfile,
  persistHarnessProfile,
  resolveHarnessHint,
} from './harness-hint.js';
export { OrchestrationHierarchyImpl } from './hierarchy.js';
export type {
  ComposeSpawnPayloadOptions,
  SpawnPayload,
  SpawnPayloadMeta,
  SpawnPayloadThinAgentMeta,
} from './spawn.js';
export { composeSpawnPayload } from './spawn.js';
export type {
  BuildSpawnPromptInput,
  BuildSpawnPromptResult,
  SpawnProtocolPhase,
  SpawnTier,
} from './spawn-prompt.js';
export {
  ALL_SPAWN_PROTOCOL_PHASES,
  buildSpawnPrompt,
  DEFAULT_SPAWN_TIER,
  resetSpawnPromptCache,
  resolvePromptTokens,
  slugify as slugifyTaskTitle,
} from './spawn-prompt.js';
export type {
  EpicStatus,
  OverallStatus,
  ProgressMetrics,
  StartupSummary,
  StatusCounts,
} from './status.js';
export {
  computeEpicStatus,
  computeOverallStatus,
  computeProgress,
  computeStartupSummary,
  countByStatus,
} from './status.js';
export type {
  ThinAgentEnforcementMode,
  ThinAgentFail,
  ThinAgentOk,
  ThinAgentResult,
} from './thin-agent.js';
export {
  E_THIN_AGENT_VIOLATION,
  enforceThinAgent,
  THIN_AGENT_SPAWN_TOOLS,
} from './thin-agent.js';

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
  /** Optional compiled CANT agent definition attached by `cleo orchestrate spawn`. */
  agentDef?: unknown;
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
    tasks: TaskRef[];
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
  _cwd?: string,
  accessor?: DataAccessor,
): Promise<OrchestratorSession> {
  const epic = await accessor!.loadSingleTask(epicId);

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
export async function analyzeEpic(
  epicId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<AnalysisResult> {
  const epic = await accessor!.loadSingleTask(epicId);

  if (!epic) {
    throw new CleoError(ExitCode.NOT_FOUND, `Epic not found: ${epicId}`);
  }

  const childTasks = await accessor!.getChildren(epicId);
  const waves = await getExecutionWaves(epicId, cwd, accessor);

  const completedTasks = childTasks.filter((t) => t.status === 'done').map((t) => t.id);
  const blockedTasks = childTasks.filter((t) => t.status === 'blocked').map((t) => t.id);

  // Find ready tasks (all deps complete, not yet started)
  const completedSet = new Set(completedTasks);
  const readyTasks = childTasks
    .filter((t) => {
      if (t.status === 'done' || t.status === 'cancelled') return false;
      const deps = t.depends ?? [];
      return deps.every((d) => completedSet.has(d));
    })
    .map((t) => t.id);

  return {
    epicId,
    totalTasks: childTasks.length,
    waves: waves.map((w) => ({
      wave: w.wave,
      tasks: w.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
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
export async function getReadyTasks(
  epicId: string,
  _cwd?: string,
  accessor?: DataAccessor,
): Promise<TaskReadiness[]> {
  const childTasks = await accessor!.getChildren(epicId);
  const { tasks: allTasks } = await accessor!.queryTasks({});
  const completedIds = new Set(allTasks.filter((t) => t.status === 'done').map((t) => t.id));

  return childTasks
    .filter((t) => t.status !== 'done' && t.status !== 'cancelled')
    .map((task) => {
      const deps = task.depends ?? [];
      const unmetDeps = deps.filter((d) => !completedIds.has(d));
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
export async function getNextTask(
  epicId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<TaskReadiness | null> {
  const readyTasks = await getReadyTasks(epicId, cwd, accessor);
  const ready = readyTasks.filter((t) => t.ready);

  if (ready.length === 0) return null;

  return ready[0]!;
}

/**
 * Prepare a spawn context for a subagent.
 *
 * Delegates prompt construction to the canonical
 * {@link buildSpawnPrompt} in `./spawn-prompt.ts`. The prompt is fully
 * self-contained (see {@link SpawnProtocolPhase}, {@link SpawnTier}).
 *
 * @task T4466
 * @task T882
 * @task T883
 */
export async function prepareSpawn(
  taskId: string,
  cwd?: string,
  accessor?: DataAccessor,
  options?: { tier?: SpawnTier; sessionId?: string | null },
): Promise<SpawnContext> {
  const task = await accessor!.loadSingleTask(taskId);

  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${taskId}`);
  }

  const protocol = autoDispatch(task);
  const tier: SpawnTier = options?.tier ?? DEFAULT_SPAWN_TIER;
  const projectRoot = cwd ?? process.cwd();

  const result = buildSpawnPrompt({
    task,
    protocol: protocol as SpawnProtocolPhase | string,
    tier,
    projectRoot,
    sessionId: options?.sessionId ?? null,
  });

  return {
    taskId,
    protocol: result.protocol,
    prompt: result.prompt,
    tokenResolution: {
      fullyResolved: result.unresolvedTokens.length === 0,
      unresolvedTokens: result.unresolvedTokens,
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
export async function getOrchestratorContext(
  epicId: string,
  _cwd?: string,
  accessor?: DataAccessor,
): Promise<{
  epicId: string;
  epicTitle: string;
  totalTasks: number;
  completed: number;
  inProgress: number;
  blocked: number;
  pending: number;
  completionPercent: number;
}> {
  const epic = await accessor!.loadSingleTask(epicId);

  if (!epic) {
    throw new CleoError(ExitCode.NOT_FOUND, `Epic not found: ${epicId}`);
  }

  const children = await accessor!.getChildren(epicId);
  const completed = children.filter((t) => t.status === 'done').length;
  const inProgress = children.filter((t) => t.status === 'active').length;
  const blocked = children.filter((t) => t.status === 'blocked').length;
  const pending = children.filter((t) => t.status === 'pending').length;

  return {
    epicId,
    epicTitle: epic.title,
    totalTasks: children.length,
    completed,
    inProgress,
    blocked,
    pending,
    completionPercent: children.length > 0 ? Math.floor((completed * 100) / children.length) : 0,
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
      if (task.labels.some((l) => config.labels.includes(l))) {
        return protocol;
      }
    }
  }

  // 2. Type-based dispatch
  if (task.type === 'epic') return 'decomposition';

  // 3. Keyword-based dispatch
  const text = `${task.title} ${task.description ?? ''}`.toLowerCase();
  for (const [protocol, config] of Object.entries(DISPATCH_MAP)) {
    if (config.keywords.some((kw) => text.includes(kw))) {
      return protocol;
    }
  }

  // 4. Fallback
  return 'implementation';
}

/**
 * Resolve tokens in a prompt string.
 *
 * Retained as a thin alias over the canonical {@link resolvePromptTokens} so
 * existing callers (tests, CLI helpers) keep working. New code should import
 * `resolvePromptTokens` from `./spawn-prompt.js` directly.
 *
 * @task T4466
 * @task T882
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
