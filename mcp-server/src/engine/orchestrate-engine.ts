/**
 * Orchestrate Engine
 *
 * Native TypeScript implementation of orchestrate domain operations.
 * Handles dependency analysis, wave computation, spawn readiness,
 * and orchestration context.
 *
 * @task T4478
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { resolveProjectRoot, readJsonFile, getDataPath } from './store.js';
import type { TaskRecord } from './task-engine.js';

/**
 * Engine result type
 */
interface EngineResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

/**
 * Task with computed dependency info
 */
interface TaskWithDeps {
  id: string;
  title: string;
  status: string;
  parentId?: string | null;
  depends?: string[];
  blockedBy?: string[];
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
function loadTasks(projectRoot?: string): TaskRecord[] {
  const root = projectRoot || resolveProjectRoot();
  const todoPath = getDataPath(root, 'todo.json');
  const todoData = readJsonFile<{ tasks: TaskRecord[] }>(todoPath);
  return todoData?.tasks || [];
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
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
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
export function orchestrateStatus(
  epicId?: string,
  projectRoot?: string
): EngineResult {
  const tasks = loadTasks(projectRoot);

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
export function orchestrateAnalyze(
  epicId: string,
  projectRoot?: string
): EngineResult {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  const tasks = loadTasks(projectRoot);
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
export function orchestrateReady(
  epicId: string,
  projectRoot?: string
): EngineResult {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  const tasks = loadTasks(projectRoot);
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
export function orchestrateNext(
  epicId: string,
  projectRoot?: string
): EngineResult {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  const readyResult = orchestrateReady(epicId, projectRoot);
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
export function orchestrateWaves(
  epicId: string,
  projectRoot?: string
): EngineResult {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  const tasks = loadTasks(projectRoot);
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
export function orchestrateContext(
  epicId?: string,
  projectRoot?: string
): EngineResult {
  const tasks = loadTasks(projectRoot);
  const root = projectRoot || resolveProjectRoot();

  // Estimate context usage
  let taskCount = tasks.length;
  if (epicId) {
    taskCount = getEpicChildren(epicId, tasks).length;
  }

  // Estimate token usage (rough: ~100 tokens per task summary)
  const estimatedTokens = taskCount * 100;

  // Check manifest size
  const manifestPath = resolve(root, 'claudedocs/agent-outputs/MANIFEST.jsonl');
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
export function orchestrateValidate(
  taskId: string,
  projectRoot?: string
): EngineResult {
  if (!taskId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId is required' } };
  }

  const tasks = loadTasks(projectRoot);
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
export function orchestrateSpawn(
  taskId: string,
  protocolType?: string,
  projectRoot?: string
): EngineResult {
  if (!taskId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId is required' } };
  }

  // First validate readiness
  const validation = orchestrateValidate(taskId, projectRoot);
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

  const tasks = loadTasks(projectRoot);
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
 * orchestrate.start - Initialize orchestration for an epic
 * @task T4478
 */
export function orchestrateStartup(
  epicId: string,
  projectRoot?: string
): EngineResult {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  const tasks = loadTasks(projectRoot);
  const epic = tasks.find((t) => t.id === epicId);

  if (!epic) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Epic ${epicId} not found` },
    };
  }

  const children = getEpicChildren(epicId, tasks);
  const waves = computeWaves(children);
  const readyResult = orchestrateReady(epicId, projectRoot);
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
