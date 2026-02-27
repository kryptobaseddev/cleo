/**
 * Orchestrate Engine
 *
 * Thin wrapper layer that delegates to core modules.
 * All business logic lives in src/core/orchestration/.
 *
 * @task T4478
 * @task T4784
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolveProjectRoot } from './store.js';
import { getManifestPath as getCentralManifestPath } from '../../core/paths.js';
import { getAccessor } from '../../store/data-accessor.js';
import type { TaskRecord } from './task-engine.js';
import type { Task } from '../../types/task.js';
import type { BrainState } from '../../types/operations/orchestrate.js';

// Core module imports
import {
  analyzeEpic,
  getReadyTasks,
  getNextTask,
  prepareSpawn,
} from '../../core/orchestration/index.js';
import { computeWaves, getEnrichedWaves } from '../../core/orchestration/waves.js';
import { getCriticalPath } from '../../core/orchestration/critical-path.js';
import { getUnblockOpportunities } from '../../core/orchestration/unblock.js';
import { startParallelExecution, endParallelExecution, getParallelStatus } from '../../core/orchestration/parallel.js';
import { listSkills, getSkillContent } from '../../core/orchestration/skill-ops.js';
import { validateSpawnReadiness } from '../../core/orchestration/validate-spawn.js';
import { buildBrainState } from '../../core/orchestration/bootstrap.js';

/**
 * Engine result type
 */
interface EngineResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

/**
 * Load all tasks from todo.json
 */
async function loadTasks(projectRoot?: string): Promise<TaskRecord[]> {
  const root = projectRoot || resolveProjectRoot();
  try {
    const accessor = await getAccessor(root);
    const taskData = await accessor.loadTaskFile();
    return (taskData as any)?.tasks || [];
  } catch {
    return [];
  }
}

/**
 * orchestrate.status - Get orchestrator status
 * @task T4478
 */
export async function orchestrateStatus(
  epicId?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const tasks = await loadTasks(root);

    if (epicId) {
      const epic = tasks.find(t => t.id === epicId);
      if (!epic) {
        return { success: false, error: { code: 'E_NOT_FOUND', message: `Epic ${epicId} not found` } };
      }

      const children = tasks.filter(t => t.parentId === epicId);
      const waves = computeWaves(children as unknown as Task[]);

      return {
        success: true,
        data: {
          epicId,
          epicTitle: epic.title,
          totalTasks: children.length,
          byStatus: {
            pending: children.filter(t => t.status === 'pending').length,
            active: children.filter(t => t.status === 'active').length,
            blocked: children.filter(t => t.status === 'blocked').length,
            done: children.filter(t => t.status === 'done').length,
            cancelled: children.filter(t => t.status === 'cancelled').length,
          },
          waves: waves.length,
          currentWave: waves.find(w => w.status !== 'completed')?.waveNumber || null,
        },
      };
    }

    // No epicId - return overall status
    const epics = tasks.filter(
      t => !t.parentId && (t.type === 'epic' || tasks.some(c => c.parentId === t.id)),
    );

    return {
      success: true,
      data: {
        totalEpics: epics.length,
        totalTasks: tasks.length,
        byStatus: {
          pending: tasks.filter(t => t.status === 'pending').length,
          active: tasks.filter(t => t.status === 'active').length,
          blocked: tasks.filter(t => t.status === 'blocked').length,
          done: tasks.filter(t => t.status === 'done').length,
        },
      },
    };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_STATUS_FAILED', message: (err as Error).message } };
  }
}

/**
 * orchestrate.analyze - Dependency analysis
 * @task T4478
 */
export async function orchestrateAnalyze(
  epicId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await analyzeEpic(epicId, root, accessor);

    // Add dependency graph and circular dep detection that core analyzeEpic provides
    const tasks = await loadTasks(root);
    const children = tasks.filter(t => t.parentId === epicId);

    // Build dependency graph
    const graph = new Map<string, Set<string>>();
    for (const task of children) {
      if (!graph.has(task.id)) graph.set(task.id, new Set());
      if (task.depends) {
        for (const dep of task.depends) {
          graph.get(task.id)!.add(dep);
        }
      }
    }

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
      if (!visited.has(task.id)) dfs(task.id, []);
    }

    // Missing deps
    const childIds = new Set(children.map(t => t.id));
    const missingDeps: Array<{ taskId: string; missingDep: string }> = [];
    for (const task of children) {
      if (task.depends) {
        for (const dep of task.depends) {
          if (!childIds.has(dep) && !tasks.find(t => t.id === dep && t.status === 'done')) {
            missingDeps.push({ taskId: task.id, missingDep: dep });
          }
        }
      }
    }

    return {
      success: true,
      data: {
        epicId: result.epicId,
        epicTitle: tasks.find(t => t.id === epicId)?.title || epicId,
        totalTasks: result.totalTasks,
        waves: result.waves,
        circularDependencies: circularDeps,
        missingDependencies: missingDeps,
        dependencyGraph: Object.fromEntries(
          Array.from(graph.entries()).map(([k, v]) => [k, Array.from(v)]),
        ),
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_ANALYZE_FAILED';
    return { success: false, error: { code, message: (err as Error).message } };
  }
}

/**
 * orchestrate.ready - Get parallel-safe tasks (ready to execute)
 * @task T4478
 */
export async function orchestrateReady(
  epicId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const readyTasks = await getReadyTasks(epicId, root, accessor);
    const ready = readyTasks.filter(t => t.ready);

    return {
      success: true,
      data: {
        epicId,
        readyTasks: ready.map(t => ({
          id: t.taskId,
          title: t.title,
          priority: 'medium', // getReadyTasks doesn't return priority
          depends: t.blockers,
        })),
        total: ready.length,
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_READY_FAILED';
    return { success: false, error: { code, message: (err as Error).message } };
  }
}

/**
 * orchestrate.next - Next task to spawn
 * @task T4478
 */
export async function orchestrateNext(
  epicId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const nextTask = await getNextTask(epicId, root, accessor);

    if (!nextTask) {
      return {
        success: true,
        data: {
          epicId,
          nextTask: null,
          message: 'No tasks ready to spawn. All pending tasks may have unmet dependencies.',
        },
      };
    }

    // Get all ready tasks for alternatives
    const readyTasks = await getReadyTasks(epicId, root, accessor);
    const ready = readyTasks.filter(t => t.ready);

    return {
      success: true,
      data: {
        epicId,
        nextTask: { id: nextTask.taskId, title: nextTask.title, priority: 'medium' },
        alternatives: ready.slice(1, 4).map(t => ({ id: t.taskId, title: t.title, priority: 'medium' })),
        totalReady: ready.length,
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_NEXT_FAILED';
    return { success: false, error: { code, message: (err as Error).message } };
  }
}

/**
 * orchestrate.waves - Compute dependency waves
 * @task T4478
 */
export async function orchestrateWaves(
  epicId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await getEnrichedWaves(epicId, root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_WAVES_FAILED';
    return { success: false, error: { code, message: (err as Error).message } };
  }
}

/**
 * orchestrate.context - Context usage check
 * @task T4478
 */
export async function orchestrateContext(
  epicId?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const tasks = await loadTasks(root);

    let taskCount = tasks.length;
    if (epicId) {
      taskCount = tasks.filter(t => t.parentId === epicId).length;
    }

    const estimatedTokens = taskCount * 100;

    const manifestPath = getCentralManifestPath(root);
    let manifestEntries = 0;
    if (existsSync(manifestPath)) {
      try {
        const content = readFileSync(manifestPath, 'utf-8');
        manifestEntries = content.split('\n').filter(l => l.trim()).length;
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
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_CONTEXT_FAILED', message: (err as Error).message } };
  }
}

/**
 * orchestrate.skill.list - Available skills
 * @task T4478
 */
export function orchestrateSkillList(
  projectRoot?: string,
): EngineResult {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = listSkills(root);
    return {
      success: true,
      data: {
        skills: result.skills,
        total: result.total,
        ...(result.total === 0 ? { message: 'No skills directory found' } : {}),
      },
    };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_SKILL_LIST_FAILED', message: (err as Error).message } };
  }
}

/**
 * orchestrate.validate - Validate spawn readiness for a task
 * @task T4478
 */
export async function orchestrateValidate(
  taskId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId is required' } };
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await validateSpawnReadiness(taskId, root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_VALIDATE_FAILED', message: (err as Error).message } };
  }
}

/**
 * orchestrate.spawn - Generate spawn prompt for a task
 * @task T4478
 */
export async function orchestrateSpawn(
  taskId: string,
  protocolType?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId is required' } };
  }

  try {
    const root = projectRoot || resolveProjectRoot();

    // Validate readiness first
    const accessor = await getAccessor(root);
    const validation = await validateSpawnReadiness(taskId, root, accessor);
    if (!validation.ready) {
      return {
        success: false,
        error: {
          code: 'E_NOT_READY',
          message: `Task ${taskId} is not ready to spawn`,
          details: { issues: validation.issues },
        },
      };
    }

    // Prepare spawn context via core
    const spawnContext = await prepareSpawn(taskId, root, accessor);

    return {
      success: true,
      data: {
        taskId,
        spawnContext: {
          taskId: spawnContext.taskId,
          protocol: spawnContext.protocol,
          protocolType: protocolType || spawnContext.protocol,
        },
        protocolType: protocolType || spawnContext.protocol,
        tokenResolution: spawnContext.tokenResolution,
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_SPAWN_FAILED';
    return { success: false, error: { code, message: (err as Error).message } };
  }
}

/**
 * orchestrate.startup - Initialize orchestration for an epic
 * @task T4478
 */
export async function orchestrateStartup(
  epicId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);

    const tasks = await loadTasks(root);
    const epic = tasks.find(t => t.id === epicId);
    if (!epic) {
      return { success: false, error: { code: 'E_NOT_FOUND', message: `Epic ${epicId} not found` } };
    }

    const children = tasks.filter(t => t.parentId === epicId);
    const waves = computeWaves(children as unknown as Task[]);
    const readyTasks = await getReadyTasks(epicId, root, accessor);
    const ready = readyTasks.filter(t => t.ready);

    return {
      success: true,
      data: {
        epicId,
        epicTitle: epic.title,
        initialized: true,
        summary: {
          totalTasks: children.length,
          totalWaves: waves.length,
          readyTasks: ready.length,
          byStatus: {
            pending: children.filter(t => t.status === 'pending').length,
            active: children.filter(t => t.status === 'active').length,
            blocked: children.filter(t => t.status === 'blocked').length,
            done: children.filter(t => t.status === 'done').length,
          },
        },
        firstWave: waves[0] || null,
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_STARTUP_FAILED';
    return { success: false, error: { code, message: (err as Error).message } };
  }
}

/**
 * orchestrate.bootstrap - Load brain state for agent bootstrapping
 * @task T4478
 * @task T4657
 */
export async function orchestrateBootstrap(
  projectRoot?: string,
  params?: { speed?: 'fast' | 'full' | 'complete' },
): Promise<EngineResult<BrainState>> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const brain = await buildBrainState(root, params, accessor);
    return { success: true, data: brain };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_BOOTSTRAP_FAILED', message: (err as Error).message } };
  }
}

/**
 * orchestrate.critical-path - Find the longest dependency chain
 * @task T4478
 */
export async function orchestrateCriticalPath(
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await getCriticalPath(root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_CRITICAL_PATH_FAILED', message: (err as Error).message } };
  }
}

/**
 * orchestrate.unblock-opportunities - Analyze dependency graph for unblocking opportunities
 * @task T4478
 */
export async function orchestrateUnblockOpportunities(
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await getUnblockOpportunities(root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_UNBLOCK_FAILED', message: (err as Error).message } };
  }
}

/**
 * orchestrate.parallel.start - Start parallel execution for a wave
 * @task T4632
 */
export async function orchestrateParallelStart(
  epicId: string,
  wave: number,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }
  if (wave === undefined || wave === null) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'wave number is required' } };
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await startParallelExecution(epicId, wave, root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_PARALLEL_START_FAILED';
    return { success: false, error: { code, message: (err as Error).message } };
  }
}

/**
 * orchestrate.parallel.end - End parallel execution for a wave
 * @task T4632
 */
export function orchestrateParallelEnd(
  epicId: string,
  wave: number,
  projectRoot?: string,
): EngineResult {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const result = endParallelExecution(epicId, wave, root);

    if (result.alreadyEnded) {
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

    return { success: true, data: result };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_PARALLEL_END_FAILED';
    return { success: false, error: { code, message: (err as Error).message } };
  }
}

/**
 * orchestrate.check - Check current orchestration state
 * @task T4632
 */
export async function orchestrateCheck(
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const parallelState = getParallelStatus(root);
    const tasks = await loadTasks(root);

    const activeTasks = tasks.filter(t => t.status === 'active');
    const total = tasks.length;
    const done = tasks.filter(t => t.status === 'done').length;
    const pending = tasks.filter(t => t.status === 'pending').length;
    const blocked = tasks.filter(t => t.status === 'blocked').length;

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
        activeTasks: activeTasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
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
  } catch (err: unknown) {
    return { success: false, error: { code: 'E_CHECK_FAILED', message: (err as Error).message } };
  }
}

/**
 * orchestrate.skill.inject - Read skill content for injection into agent context
 * @task T4632
 */
export function orchestrateSkillInject(
  skillName: string,
  projectRoot?: string,
): EngineResult {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = getSkillContent(skillName, root);
    return { success: true, data: result };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_SKILL_INJECT_FAILED';
    return { success: false, error: { code, message: (err as Error).message } };
  }
}
