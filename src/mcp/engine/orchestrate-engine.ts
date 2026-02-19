/**
 * Orchestrate Engine
 *
 * Native TypeScript implementation of orchestrate domain operations.
 * Handles dependency analysis, wave computation, spawn readiness,
 * and orchestration context.
 *
 * @task T4478
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { resolveProjectRoot } from './store.js';
import { getManifestPath as getCentralManifestPath } from '../../core/paths.js';
import { getAccessor } from '../../store/data-accessor.js';
import type { TaskRecord } from './task-engine.js';
import { taskNext, taskBlockers } from './task-engine.js';
import { sessionStatus, sessionDecisionLog, sessionContextDrift } from './session-engine.js';
import type { BrainState } from '../types/operations/orchestrate.js';

/**
 * Engine result type
 */
interface EngineResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}


/**
 * Wave: a set of tasks that can run in parallel
 */
interface Wave {
  waveNumber: number;
  tasks: string[];
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Load all tasks from todo.json
 */
async function loadTasks(projectRoot?: string): Promise<TaskRecord[]> {
  const root = projectRoot || resolveProjectRoot();
  try {
    const accessor = await getAccessor(root);
    const todoData = await accessor.loadTodoFile();
    return (todoData as any)?.tasks || [];
  } catch {
    return [];
  }
}

/**
 * Get children of an epic
 */
function getEpicChildren(epicId: string, tasks: TaskRecord[]): TaskRecord[] {
  return tasks.filter((t) => t.parentId === epicId);
}

/**
 * Build dependency graph for tasks
 */
function buildDependencyGraph(tasks: TaskRecord[]): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();

  for (const task of tasks) {
    if (!graph.has(task.id)) {
      graph.set(task.id, new Set());
    }
    if (task.depends) {
      for (const dep of task.depends) {
        graph.get(task.id)!.add(dep);
      }
    }
  }

  return graph;
}

/**
 * Compute execution waves using topological sort
 */
function computeWaves(tasks: TaskRecord[]): Wave[] {
  const graph = buildDependencyGraph(tasks);
  const waves: Wave[] = [];
  const completed = new Set<string>();

  // Mark already-completed tasks
  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'cancelled') {
      completed.add(task.id);
    }
  }

  let remaining = tasks.filter(
    (t) => t.status !== 'done' && t.status !== 'cancelled'
  );

  let waveNumber = 1;
  const maxWaves = 50; // Safety limit

  while (remaining.length > 0 && waveNumber <= maxWaves) {
    // Find tasks with all dependencies met
    const waveTasks = remaining.filter((t) => {
      const deps = graph.get(t.id) || new Set();
      return Array.from(deps).every((d) => completed.has(d));
    });

    if (waveTasks.length === 0) {
      // Remaining tasks have circular dependencies or unresolvable deps
      break;
    }

    waves.push({
      waveNumber,
      tasks: waveTasks.map((t) => t.id),
      status: waveTasks.every((t) => completed.has(t.id))
        ? 'completed'
        : waveTasks.some((t) => t.status === 'active')
        ? 'in_progress'
        : 'pending',
    });

    // Mark wave tasks as "completed" for next wave computation
    for (const t of waveTasks) {
      completed.add(t.id);
    }

    remaining = remaining.filter(
      (t) => !waveTasks.some((wt) => wt.id === t.id)
    );

    waveNumber++;
  }

  // Handle any remaining tasks with unresolvable dependencies
  if (remaining.length > 0) {
    waves.push({
      waveNumber,
      tasks: remaining.map((t) => t.id),
      status: 'pending',
    });
  }

  return waves;
}

/**
 * orchestrate.status - Get orchestrator status
 * @task T4478
 */
export async function orchestrateStatus(
  epicId?: string,
  projectRoot?: string
): Promise<EngineResult> {
  const tasks = await loadTasks(projectRoot);

  if (epicId) {
    const epic = tasks.find((t) => t.id === epicId);
    if (!epic) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Epic ${epicId} not found` },
      };
    }

    const children = getEpicChildren(epicId, tasks);
    const waves = computeWaves(children);

    return {
      success: true,
      data: {
        epicId,
        epicTitle: epic.title,
        totalTasks: children.length,
        byStatus: {
          pending: children.filter((t) => t.status === 'pending').length,
          active: children.filter((t) => t.status === 'active').length,
          blocked: children.filter((t) => t.status === 'blocked').length,
          done: children.filter((t) => t.status === 'done').length,
          cancelled: children.filter((t) => t.status === 'cancelled').length,
        },
        waves: waves.length,
        currentWave: waves.find((w) => w.status !== 'completed')?.waveNumber || null,
      },
    };
  }

  // No epicId - return overall status
  const epics = tasks.filter(
    (t) => !t.parentId && (t.type === 'epic' || getEpicChildren(t.id, tasks).length > 0)
  );

  return {
    success: true,
    data: {
      totalEpics: epics.length,
      totalTasks: tasks.length,
      byStatus: {
        pending: tasks.filter((t) => t.status === 'pending').length,
        active: tasks.filter((t) => t.status === 'active').length,
        blocked: tasks.filter((t) => t.status === 'blocked').length,
        done: tasks.filter((t) => t.status === 'done').length,
      },
    },
  };
}

/**
 * orchestrate.analyze - Dependency analysis
 * @task T4478
 */
export async function orchestrateAnalyze(
  epicId: string,
  projectRoot?: string
): Promise<EngineResult> {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  const tasks = await loadTasks(projectRoot);
  const epic = tasks.find((t) => t.id === epicId);

  if (!epic) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Epic ${epicId} not found` },
    };
  }

  const children = getEpicChildren(epicId, tasks);
  const graph = buildDependencyGraph(children);
  const waves = computeWaves(children);

  // Find circular dependencies
  const circularDeps: string[][] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function dfs(taskId: string, path: string[]): void {
    visited.add(taskId);
    recursionStack.add(taskId);

    const deps = graph.get(taskId) || new Set();
    for (const dep of deps) {
      if (!visited.has(dep)) {
        dfs(dep, [...path, taskId]);
      } else if (recursionStack.has(dep)) {
        circularDeps.push([...path, taskId, dep]);
      }
    }

    recursionStack.delete(taskId);
  }

  for (const task of children) {
    if (!visited.has(task.id)) {
      dfs(task.id, []);
    }
  }

  // Find tasks with missing dependencies
  const childIds = new Set(children.map((t) => t.id));
  const missingDeps: Array<{ taskId: string; missingDep: string }> = [];

  for (const task of children) {
    if (task.depends) {
      for (const dep of task.depends) {
        if (!childIds.has(dep) && !tasks.find((t) => t.id === dep && t.status === 'done')) {
          missingDeps.push({ taskId: task.id, missingDep: dep });
        }
      }
    }
  }

  return {
    success: true,
    data: {
      epicId,
      epicTitle: epic.title,
      totalTasks: children.length,
      waves,
      circularDependencies: circularDeps,
      missingDependencies: missingDeps,
      dependencyGraph: Object.fromEntries(
        Array.from(graph.entries()).map(([k, v]) => [k, Array.from(v)])
      ),
    },
  };
}

/**
 * orchestrate.ready - Get parallel-safe tasks (ready to execute)
 * @task T4478
 */
export async function orchestrateReady(
  epicId: string,
  projectRoot?: string
): Promise<EngineResult> {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  const tasks = await loadTasks(projectRoot);
  const epic = tasks.find((t) => t.id === epicId);

  if (!epic) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Epic ${epicId} not found` },
    };
  }

  const children = getEpicChildren(epicId, tasks);
  const graph = buildDependencyGraph(children);

  // Find tasks that are pending and have all dependencies completed
  const completedIds = new Set(
    children
      .filter((t) => t.status === 'done' || t.status === 'cancelled')
      .map((t) => t.id)
  );

  // Also consider tasks outside the epic that are done
  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'cancelled') {
      completedIds.add(task.id);
    }
  }

  const readyTasks = children.filter((t) => {
    if (t.status !== 'pending') return false;

    const deps = graph.get(t.id) || new Set();
    return Array.from(deps).every((d) => completedIds.has(d));
  });

  return {
    success: true,
    data: {
      epicId,
      readyTasks: readyTasks.map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        depends: t.depends || [],
      })),
      total: readyTasks.length,
    },
  };
}

/**
 * orchestrate.next - Next task to spawn
 * @task T4478
 */
export async function orchestrateNext(
  epicId: string,
  projectRoot?: string
): Promise<EngineResult> {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  const readyResult = await orchestrateReady(epicId, projectRoot);
  if (!readyResult.success) {
    return readyResult;
  }

  const readyData = readyResult.data as { readyTasks: Array<{ id: string; title: string; priority: string }>; total: number };

  if (readyData.total === 0) {
    return {
      success: true,
      data: {
        epicId,
        nextTask: null,
        message: 'No tasks ready to spawn. All pending tasks may have unmet dependencies.',
      },
    };
  }

  // Pick highest priority task, break ties by ID order
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = readyData.readyTasks.sort((a, b) => {
    const aPri = priorityOrder[a.priority] ?? 2;
    const bPri = priorityOrder[b.priority] ?? 2;
    if (aPri !== bPri) return aPri - bPri;
    return a.id.localeCompare(b.id);
  });

  return {
    success: true,
    data: {
      epicId,
      nextTask: sorted[0],
      alternatives: sorted.slice(1, 4),
      totalReady: readyData.total,
    },
  };
}

/**
 * orchestrate.waves - Compute dependency waves
 * @task T4478
 */
export async function orchestrateWaves(
  epicId: string,
  projectRoot?: string
): Promise<EngineResult> {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  const tasks = await loadTasks(projectRoot);
  const epic = tasks.find((t) => t.id === epicId);

  if (!epic) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Epic ${epicId} not found` },
    };
  }

  const children = getEpicChildren(epicId, tasks);
  const waves = computeWaves(children);

  // Enrich waves with task titles
  const taskMap = new Map(children.map((t) => [t.id, t]));
  const enrichedWaves = waves.map((w) => ({
    ...w,
    tasks: w.tasks.map((id) => ({
      id,
      title: taskMap.get(id)?.title || id,
      status: taskMap.get(id)?.status || 'unknown',
    })),
  }));

  return {
    success: true,
    data: {
      epicId,
      waves: enrichedWaves,
      totalWaves: waves.length,
      totalTasks: children.length,
    },
  };
}

/**
 * orchestrate.context - Context usage check
 * @task T4478
 */
export async function orchestrateContext(
  epicId?: string,
  projectRoot?: string
): Promise<EngineResult> {
  const tasks = await loadTasks(projectRoot);
  const root = projectRoot || resolveProjectRoot();

  // Estimate context usage
  let taskCount = tasks.length;
  if (epicId) {
    taskCount = getEpicChildren(epicId, tasks).length;
  }

  // Estimate token usage (rough: ~100 tokens per task summary)
  const estimatedTokens = taskCount * 100;

  // Check manifest size
  const manifestPath = getCentralManifestPath(root);
  let manifestEntries = 0;
  if (existsSync(manifestPath)) {
    try {
      const content = readFileSync(manifestPath, 'utf-8');
      manifestEntries = content.split('\n').filter((l) => l.trim()).length;
    } catch {
      // ignore
    }
  }

  return {
    success: true,
    data: {
      epicId: epicId || null,
      taskCount,
      manifestEntries,
      estimatedTokens,
      recommendation: estimatedTokens > 5000
        ? 'Consider using manifest summaries instead of full task details'
        : 'Context usage is within recommended limits',
      limits: {
        orchestratorBudget: 10000,
        maxFilesPerAgent: 3,
        currentUsage: estimatedTokens,
      },
    },
  };
}

/**
 * orchestrate.skill.list - Available skills
 * @task T4478
 */
export function orchestrateSkillList(
  projectRoot?: string
): EngineResult {
  const root = projectRoot || resolveProjectRoot();
  const skillsDir = join(root, 'skills');

  if (!existsSync(skillsDir)) {
    return {
      success: true,
      data: {
        skills: [],
        total: 0,
        message: 'No skills directory found',
      },
    };
  }

  try {
    const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
      .map((d) => {
        const skillPath = join(skillsDir, d.name, 'SKILL.md');
        let description = '';

        if (existsSync(skillPath)) {
          try {
            const content = readFileSync(skillPath, 'utf-8');
            // Extract description from frontmatter or first paragraph
            const descMatch = content.match(/description:\s*[|>]?\s*\n?\s*(.+)/);
            if (descMatch) {
              description = descMatch[1].trim();
            }
          } catch {
            // ignore
          }
        }

        return {
          name: d.name,
          path: `skills/${d.name}`,
          hasSkillFile: existsSync(skillPath),
          description,
        };
      });

    return {
      success: true,
      data: {
        skills: skillDirs,
        total: skillDirs.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_SKILL_LIST_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * orchestrate.validate - Validate spawn readiness for a task
 * @task T4478
 */
export async function orchestrateValidate(
  taskId: string,
  projectRoot?: string
): Promise<EngineResult> {
  if (!taskId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId is required' } };
  }

  const tasks = await loadTasks(projectRoot);
  const task = tasks.find((t) => t.id === taskId);

  if (!task) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Task ${taskId} not found` },
    };
  }

  const issues: Array<{ code: string; message: string; severity: string }> = [];

  // Check task status
  if (task.status === 'done') {
    issues.push({ code: 'V_ALREADY_DONE', message: 'Task is already completed', severity: 'error' });
  }
  if (task.status === 'cancelled') {
    issues.push({ code: 'V_CANCELLED', message: 'Task is cancelled', severity: 'error' });
  }

  // Check dependencies
  if (task.depends) {
    for (const dep of task.depends) {
      const depTask = tasks.find((t) => t.id === dep);
      if (!depTask) {
        issues.push({
          code: 'V_MISSING_DEP',
          message: `Dependency ${dep} not found`,
          severity: 'error',
        });
      } else if (depTask.status !== 'done') {
        issues.push({
          code: 'V_UNMET_DEP',
          message: `Dependency ${dep} (${depTask.title}) is not complete (status: ${depTask.status})`,
          severity: 'error',
        });
      }
    }
  }

  // Check title/description
  if (!task.title) {
    issues.push({ code: 'V_MISSING_TITLE', message: 'Task title is missing', severity: 'error' });
  }
  if (!task.description) {
    issues.push({ code: 'V_MISSING_DESC', message: 'Task description is missing', severity: 'error' });
  }

  return {
    success: true,
    data: {
      taskId,
      title: task.title,
      ready: issues.filter((i) => i.severity === 'error').length === 0,
      issues,
    },
  };
}

/**
 * orchestrate.spawn - Generate spawn prompt for a task
 * @task T4478
 */
export async function orchestrateSpawn(
  taskId: string,
  protocolType?: string,
  projectRoot?: string
): Promise<EngineResult> {
  if (!taskId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId is required' } };
  }

  // First validate readiness
  const validation = await orchestrateValidate(taskId, projectRoot);
  if (!validation.success) {
    return validation;
  }

  const validationData = validation.data as { ready: boolean; issues: any[]; title: string };
  if (!validationData.ready) {
    return {
      success: false,
      error: {
        code: 'E_NOT_READY',
        message: `Task ${taskId} is not ready to spawn`,
        details: { issues: validationData.issues },
      },
    };
  }

  const tasks = await loadTasks(projectRoot);
  const task = tasks.find((t) => t.id === taskId)!;

  // Build spawn context
  const spawnContext = {
    taskId: task.id,
    title: task.title,
    description: task.description,
    priority: task.priority,
    type: task.type,
    labels: task.labels,
    depends: task.depends,
    parentId: task.parentId,
    protocolType: protocolType || inferProtocolType(task),
  };

  return {
    success: true,
    data: {
      taskId,
      spawnContext,
      protocolType: spawnContext.protocolType,
      tokenResolution: {
        fullyResolved: true,
      },
    },
  };
}

/**
 * Infer protocol type from task attributes
 */
function inferProtocolType(task: TaskRecord): string {
  const titleLower = task.title.toLowerCase();
  const descLower = task.description.toLowerCase();
  const combined = `${titleLower} ${descLower}`;

  if (combined.includes('research') || combined.includes('investigate') || combined.includes('explore')) {
    return 'research';
  }
  if (combined.includes('spec') || combined.includes('rfc') || combined.includes('design')) {
    return 'specification';
  }
  if (combined.includes('implement') || combined.includes('build') || combined.includes('create')) {
    return 'implementation';
  }
  if (combined.includes('test') || combined.includes('validate') || combined.includes('verify')) {
    return 'validation';
  }
  if (combined.includes('release') || combined.includes('version') || combined.includes('publish')) {
    return 'release';
  }
  if (combined.includes('decompose') || combined.includes('plan') || combined.includes('epic')) {
    return 'decomposition';
  }

  return 'implementation'; // Default
}

/**
 * orchestrate.startup - Initialize orchestration for an epic
 * @task T4478
 */
export async function orchestrateStartup(
  epicId: string,
  projectRoot?: string
): Promise<EngineResult> {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  const tasks = await loadTasks(projectRoot);
  const epic = tasks.find((t) => t.id === epicId);

  if (!epic) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Epic ${epicId} not found` },
    };
  }

  const children = getEpicChildren(epicId, tasks);
  const waves = computeWaves(children);
  const readyResult = await orchestrateReady(epicId, projectRoot);
  const readyData = readyResult.data as { readyTasks: any[]; total: number };

  return {
    success: true,
    data: {
      epicId,
      epicTitle: epic.title,
      initialized: true,
      summary: {
        totalTasks: children.length,
        totalWaves: waves.length,
        readyTasks: readyData?.total || 0,
        byStatus: {
          pending: children.filter((t) => t.status === 'pending').length,
          active: children.filter((t) => t.status === 'active').length,
          blocked: children.filter((t) => t.status === 'blocked').length,
          done: children.filter((t) => t.status === 'done').length,
        },
      },
      firstWave: waves[0] || null,
    },
  };
}

/**
 * orchestrate.bootstrap - Load brain state for agent bootstrapping
 *
 * Provides tiered context loading:
 * - fast: session + currentTask + nextSuggestion + progress
 * - full: fast + recentDecisions + blockers + contextDrift
 * - complete: full + all available data
 *
 * @task T4478
 */
/**
 * @task T4657
 * @epic T4654
 */
export async function orchestrateBootstrap(
  projectRoot?: string,
  params?: { speed?: 'fast' | 'full' | 'complete' }
): Promise<EngineResult<BrainState>> {
  const root = projectRoot || resolveProjectRoot();
  const speed = params?.speed || 'fast';
  const brain: BrainState = {
    _meta: {
      speed,
      generatedAt: new Date().toISOString(),
      version: '1.0.0',
    },
  };

  // --- Session ---
  const statusResult = await sessionStatus(root);
  if (statusResult.success && statusResult.data) {
    const sd = statusResult.data;
    if (sd.session) {
      brain.session = {
        id: sd.session.id,
        name: sd.session.name || sd.session.id,
        status: sd.session.status,
        startedAt: sd.session.startedAt,
      };
    }
  }

  // --- Progress (from all tasks) ---
  const tasks = await loadTasks(root);
  const progress = {
    total: tasks.length,
    done: tasks.filter((t) => t.status === 'done').length,
    active: tasks.filter((t) => t.status === 'active').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
    pending: tasks.filter((t) => t.status === 'pending').length,
  };
  brain.progress = progress;

  // --- Current Task (from focus) ---
  const focusData = statusResult.success ? statusResult.data : null;
  const currentTaskId = focusData?.session?.focus?.currentTask
    || focusData?.focus?.currentTask
    || null;

  if (currentTaskId) {
    const task = tasks.find((t) => t.id === currentTaskId);
    if (task) {
      brain.currentTask = {
        id: task.id,
        title: task.title,
        status: task.status,
      };
    }
  }

  // --- Next Suggestion ---
  const nextResult = await taskNext(root, { count: 1, explain: false });
  if (nextResult.success && nextResult.data && nextResult.data.suggestions.length > 0) {
    const suggestion = nextResult.data.suggestions[0];
    brain.nextSuggestion = {
      id: suggestion.id,
      title: suggestion.title,
      score: suggestion.score,
    };
  }

  // --- Full tier: decisions, blockers, contextDrift ---
  if (speed === 'full' || speed === 'complete') {
    // Recent decisions (last 5)
    const decisionsResult = await sessionDecisionLog(root);
    if (decisionsResult.success && decisionsResult.data) {
      const recent = decisionsResult.data.slice(-5);
      brain.recentDecisions = recent.map((d) => ({
        id: d.id,
        decision: d.decision,
        timestamp: d.timestamp,
      }));
    }

    // Blockers
    const blockersResult = await taskBlockers(root);
    if (blockersResult.success && blockersResult.data) {
      brain.blockers = blockersResult.data.blockedTasks.map((b) => ({
        taskId: b.id,
        title: b.title,
        blockedBy: b.depends || [],
      }));
    }

    // Context drift
    const driftResult = await sessionContextDrift(root);
    if (driftResult.success && driftResult.data) {
      brain.contextDrift = {
        score: driftResult.data.score,
        factors: driftResult.data.factors,
      };
    }
  }

  return {
    success: true,
    data: brain,
  };
}

/**
 * orchestrate.critical-path - Find the longest dependency chain in the task graph
 * @task T4478
 */
export async function orchestrateCriticalPath(
  projectRoot?: string
): Promise<EngineResult> {
  const tasks = await loadTasks(projectRoot);

  if (tasks.length === 0) {
    return {
      success: true,
      data: {
        path: [],
        length: 0,
        totalEffort: 0,
        completedInPath: 0,
        remainingInPath: 0,
      },
    };
  }

  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // Build dependsOn map: dependsOn[taskId] = set of tasks that taskId depends on
  // Build dependents map: dependents[taskId] = set of tasks that depend on taskId
  const dependsOn = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();

  for (const task of tasks) {
    if (!dependsOn.has(task.id)) {
      dependsOn.set(task.id, new Set());
    }
    if (!dependents.has(task.id)) {
      dependents.set(task.id, new Set());
    }
    if (task.depends) {
      for (const dep of task.depends) {
        dependsOn.get(task.id)!.add(dep);
        if (!dependents.has(dep)) {
          dependents.set(dep, new Set());
        }
        dependents.get(dep)!.add(task.id);
      }
    }
  }

  // Find the longest path using DFS with memoization
  // longestPathEndingAt(taskId) returns the longest chain ending at taskId
  // by tracing backwards through dependencies
  const memo = new Map<string, string[]>();

  function longestPathEndingAt(taskId: string, visited: Set<string>): string[] {
    if (memo.has(taskId)) {
      return memo.get(taskId)!;
    }

    if (visited.has(taskId)) {
      // Circular dependency - stop recursion
      return [taskId];
    }

    visited.add(taskId);

    const deps = dependsOn.get(taskId) || new Set();
    let longest: string[] = [];

    for (const dep of deps) {
      if (taskMap.has(dep)) {
        const path = longestPathEndingAt(dep, visited);
        if (path.length > longest.length) {
          longest = path;
        }
      }
    }

    visited.delete(taskId);

    const result = [...longest, taskId];
    memo.set(taskId, result);
    return result;
  }

  // Find leaf nodes (tasks that nothing else depends on)
  const leafNodes = tasks.filter((t) => {
    const deps = dependents.get(t.id);
    return !deps || deps.size === 0;
  });

  // Trace back from each leaf to find the longest path
  let criticalPath: string[] = [];

  for (const leaf of leafNodes) {
    const path = longestPathEndingAt(leaf.id, new Set());
    if (path.length > criticalPath.length) {
      criticalPath = path;
    }
  }

  // If no leaf nodes found (all circular), try all tasks
  if (criticalPath.length === 0) {
    for (const task of tasks) {
      const path = longestPathEndingAt(task.id, new Set());
      if (path.length > criticalPath.length) {
        criticalPath = path;
      }
    }
  }

  // Size weights
  const sizeWeights: Record<string, number> = { small: 1, medium: 3, large: 8 };

  // Annotate each task in the critical path
  const annotatedPath = criticalPath.map((taskId) => {
    const task = taskMap.get(taskId);
    const size = task?.size || 'medium';
    const incompleteDeps = (task?.depends || []).filter((dep) => {
      const depTask = taskMap.get(dep);
      return depTask && depTask.status !== 'done' && depTask.status !== 'cancelled';
    });

    return {
      taskId,
      title: task?.title || taskId,
      status: task?.status || 'unknown',
      size,
      blockerCount: incompleteDeps.length,
    };
  });

  const completedInPath = annotatedPath.filter(
    (t) => t.status === 'done' || t.status === 'cancelled'
  ).length;
  const remainingInPath = annotatedPath.length - completedInPath;

  // Total effort: only count non-done tasks
  const totalEffort = annotatedPath
    .filter((t) => t.status !== 'done' && t.status !== 'cancelled')
    .reduce((sum, t) => sum + (sizeWeights[t.size] ?? 3), 0);

  return {
    success: true,
    data: {
      path: annotatedPath,
      length: criticalPath.length,
      totalEffort,
      completedInPath,
      remainingInPath,
    },
  };
}

/**
 * Build a reverse dependency map: for each task, which tasks depend on it
 */
function buildReverseDependencyMap(tasks: TaskRecord[]): Map<string, string[]> {
  const reverseMap = new Map<string, string[]>();

  for (const task of tasks) {
    if (task.depends) {
      for (const dep of task.depends) {
        const existing = reverseMap.get(dep) || [];
        existing.push(task.id);
        reverseMap.set(dep, existing);
      }
    }
  }

  return reverseMap;
}

/**
 * Count transitive dependents: all tasks that directly or transitively depend on a given task
 */
function countTransitiveDependents(
  taskId: string,
  reverseMap: Map<string, string[]>,
  visited: Set<string> = new Set()
): string[] {
  if (visited.has(taskId)) return [];
  visited.add(taskId);

  const directDependents = reverseMap.get(taskId) || [];
  const allDependents: string[] = [...directDependents];

  for (const dep of directDependents) {
    const transitive = countTransitiveDependents(dep, reverseMap, visited);
    allDependents.push(...transitive);
  }

  return allDependents;
}

/**
 * orchestrate.unblock-opportunities - Analyze dependency graph for unblocking opportunities
 *
 * Finds:
 * 1. High-impact completions: tasks whose completion would unblock the most others
 * 2. Single-blocker tasks: blocked tasks with only one remaining incomplete dependency
 * 3. Common blockers: tasks that appear as a dependency for many other tasks
 *
 * @task T4478
 */
export async function orchestrateUnblockOpportunities(
  projectRoot?: string
): Promise<EngineResult> {
  const tasks = await loadTasks(projectRoot);
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const completedIds = new Set(
    tasks
      .filter((t) => t.status === 'done' || t.status === 'cancelled')
      .map((t) => t.id)
  );

  // Only consider non-done tasks for high-impact and common-blocker analysis
  const nonDoneTasks = tasks.filter(
    (t) => t.status !== 'done' && t.status !== 'cancelled'
  );

  const reverseMap = buildReverseDependencyMap(tasks);

  // 1. High-impact completions: non-done tasks whose completion would unblock the most others
  const highImpact: Array<{
    taskId: string;
    title: string;
    wouldUnblock: number;
    dependents: string[];
  }> = [];

  for (const task of nonDoneTasks) {
    const allDependents = countTransitiveDependents(task.id, reverseMap, new Set());
    // Deduplicate
    const uniqueDependents = [...new Set(allDependents)];
    if (uniqueDependents.length > 0) {
      highImpact.push({
        taskId: task.id,
        title: task.title,
        wouldUnblock: uniqueDependents.length,
        dependents: uniqueDependents,
      });
    }
  }

  // Sort by wouldUnblock descending
  highImpact.sort((a, b) => b.wouldUnblock - a.wouldUnblock);

  // 2. Single-blocker tasks: tasks that have exactly one remaining incomplete dependency
  const singleBlocker: Array<{
    taskId: string;
    title: string;
    remainingBlocker: { id: string; title: string };
  }> = [];

  for (const task of tasks) {
    if (!task.depends || task.depends.length === 0) continue;

    const incompleteDeps = task.depends.filter((depId) => !completedIds.has(depId));
    if (incompleteDeps.length === 1) {
      const blockerId = incompleteDeps[0];
      const blockerTask = taskMap.get(blockerId);
      singleBlocker.push({
        taskId: task.id,
        title: task.title,
        remainingBlocker: {
          id: blockerId,
          title: blockerTask?.title || blockerId,
        },
      });
    }
  }

  // 3. Common blockers: tasks that appear as a dependency for many other tasks
  const blockerCounts = new Map<string, string[]>();

  for (const task of tasks) {
    if (!task.depends) continue;
    for (const depId of task.depends) {
      if (!completedIds.has(depId)) {
        const existing = blockerCounts.get(depId) || [];
        existing.push(task.id);
        blockerCounts.set(depId, existing);
      }
    }
  }

  const commonBlockers: Array<{
    taskId: string;
    title: string;
    blocksCount: number;
    blockedTasks: string[];
  }> = [];

  for (const [blockerId, blockedTasks] of blockerCounts) {
    if (blockedTasks.length > 1) {
      const blockerTask = taskMap.get(blockerId);
      commonBlockers.push({
        taskId: blockerId,
        title: blockerTask?.title || blockerId,
        blocksCount: blockedTasks.length,
        blockedTasks,
      });
    }
  }

  // Sort by blocksCount descending
  commonBlockers.sort((a, b) => b.blocksCount - a.blocksCount);

  return {
    success: true,
    data: {
      highImpact,
      singleBlocker,
      commonBlockers,
    },
  };
}

/**
 * Get the parallel state file path
 */
function getParallelStatePath(projectRoot?: string): string {
  const root = projectRoot || resolveProjectRoot();
  return join(root, '.cleo', 'parallel-state.json');
}

/**
 * Read parallel execution state
 */
function readParallelState(projectRoot?: string): {
  active: boolean;
  epicId?: string;
  wave?: number;
  startedAt?: string;
  tasks?: string[];
} {
  const statePath = getParallelStatePath(projectRoot);
  if (!existsSync(statePath)) {
    return { active: false };
  }
  try {
    const content = readFileSync(statePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { active: false };
  }
}

/**
 * Write parallel execution state
 */
function writeParallelState(
  state: { active: boolean; epicId?: string; wave?: number; startedAt?: string; tasks?: string[] },
  projectRoot?: string
): void {
  const statePath = getParallelStatePath(projectRoot);
  const dir = dirname(statePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * orchestrate.parallel.start - Start parallel execution for a wave
 * @task T4632
 */
export async function orchestrateParallelStart(
  epicId: string,
  wave: number,
  projectRoot?: string
): Promise<EngineResult> {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }
  if (wave === undefined || wave === null) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'wave number is required' } };
  }

  const currentState = readParallelState(projectRoot);
  if (currentState.active) {
    return {
      success: false,
      error: {
        code: 'E_PARALLEL_ACTIVE',
        message: `Parallel execution already active for epic ${currentState.epicId}, wave ${currentState.wave}`,
      },
    };
  }

  // Get wave tasks
  const tasks = await loadTasks(projectRoot);
  const epic = tasks.find((t) => t.id === epicId);
  if (!epic) {
    return { success: false, error: { code: 'E_NOT_FOUND', message: `Epic ${epicId} not found` } };
  }

  const children = getEpicChildren(epicId, tasks);
  const waves = computeWaves(children);
  const targetWave = waves.find((w) => w.waveNumber === wave);

  if (!targetWave) {
    return {
      success: false,
      error: { code: 'E_INVALID_WAVE', message: `Wave ${wave} not found for epic ${epicId}` },
    };
  }

  const state = {
    active: true,
    epicId,
    wave,
    startedAt: new Date().toISOString(),
    tasks: targetWave.tasks,
  };

  writeParallelState(state, projectRoot);

  return {
    success: true,
    data: {
      epicId,
      wave,
      tasks: targetWave.tasks,
      taskCount: targetWave.tasks.length,
      startedAt: state.startedAt,
    },
  };
}

/**
 * orchestrate.parallel.end - End parallel execution for a wave
 * @task T4632
 */
export function orchestrateParallelEnd(
  epicId: string,
  wave: number,
  projectRoot?: string
): EngineResult {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  const currentState = readParallelState(projectRoot);
  if (!currentState.active) {
    return {
      success: true,
      data: {
        epicId,
        wave,
        message: 'No parallel execution was active',
        alreadyEnded: true,
      },
    };
  }

  if (currentState.epicId !== epicId || currentState.wave !== wave) {
    return {
      success: false,
      error: {
        code: 'E_WAVE_MISMATCH',
        message: `Active parallel is for epic ${currentState.epicId} wave ${currentState.wave}, not epic ${epicId} wave ${wave}`,
      },
    };
  }

  const duration = currentState.startedAt
    ? Date.now() - new Date(currentState.startedAt).getTime()
    : 0;

  writeParallelState({ active: false }, projectRoot);

  return {
    success: true,
    data: {
      epicId,
      wave,
      tasks: currentState.tasks,
      taskCount: currentState.tasks?.length || 0,
      startedAt: currentState.startedAt,
      endedAt: new Date().toISOString(),
      durationMs: duration,
    },
  };
}

/**
 * orchestrate.check - Check current orchestration state
 * @task T4632
 */
export async function orchestrateCheck(
  projectRoot?: string
): Promise<EngineResult> {
  const parallelState = readParallelState(projectRoot);
  const tasks = await loadTasks(projectRoot);

  // Active tasks (in-progress)
  const activeTasks = tasks.filter((t) => t.status === 'active');

  // Overall progress
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'done').length;
  const pending = tasks.filter((t) => t.status === 'pending').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;

  return {
    success: true,
    data: {
      parallelExecution: {
        active: parallelState.active,
        epicId: parallelState.epicId || null,
        wave: parallelState.wave || null,
        tasks: parallelState.tasks || [],
        startedAt: parallelState.startedAt || null,
      },
      activeTasks: activeTasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
      })),
      progress: {
        total,
        done,
        pending,
        blocked,
        active: activeTasks.length,
        percentComplete: total > 0 ? Math.round((done / total) * 100) : 0,
      },
    },
  };
}

/**
 * orchestrate.skill.inject - Read skill content for injection into agent context
 * @task T4632
 */
export function orchestrateSkillInject(
  skillName: string,
  projectRoot?: string
): EngineResult {
  if (!skillName) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'skill name is required (params.skill)' } };
  }

  const root = projectRoot || resolveProjectRoot();
  const skillDir = join(root, 'skills', skillName);

  if (!existsSync(skillDir)) {
    return {
      success: false,
      error: {
        code: 'E_NOT_FOUND',
        message: `Skill '${skillName}' not found at skills/${skillName}/`,
      },
    };
  }

  const skillFilePath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillFilePath)) {
    return {
      success: false,
      error: {
        code: 'E_NOT_FOUND',
        message: `Skill file not found: skills/${skillName}/SKILL.md`,
      },
    };
  }

  try {
    const content = readFileSync(skillFilePath, 'utf-8');

    // Also check for reference files
    const refsDir = join(skillDir, 'references');
    let references: Array<{ name: string; path: string }> = [];
    if (existsSync(refsDir)) {
      try {
        references = readdirSync(refsDir)
          .filter((f) => f.endsWith('.md') || f.endsWith('.txt'))
          .map((f) => ({
            name: f,
            path: `skills/${skillName}/references/${f}`,
          }));
      } catch {
        // ignore
      }
    }

    return {
      success: true,
      data: {
        skill: skillName,
        content,
        contentLength: content.length,
        estimatedTokens: Math.ceil(content.length / 4),
        references,
        path: `skills/${skillName}/SKILL.md`,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_SKILL_READ_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
