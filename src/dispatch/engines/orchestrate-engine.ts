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
import { resolveProjectRoot } from '../../core/platform.js';
import { getManifestPath as getCentralManifestPath } from '../../core/paths.js';
import { getAccessor } from '../../store/data-accessor.js';
import type { TaskRecord } from './task-engine.js';
import type { Task } from '../../types/task.js';
import type { BrainState } from '../../types/operations/orchestrate.js';
import type { CLEOSpawnAdapter, CLEOSpawnContext } from '../../types/spawn.js';
import type { Provider } from '@cleocode/caamp';

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
import { getSkillContent } from '../../core/orchestration/skill-ops.js';
import { validateSpawnReadiness } from '../../core/orchestration/validate-spawn.js';
import { buildBrainState } from '../../core/orchestration/bootstrap.js';
import { sessionContextInject } from '../../core/sessions/context-inject.js';
import { engineError, type EngineResult } from './_error.js';
import { sessionEnd, sessionStatus } from './session-engine.js';

type HandoffStepStatus = 'pending' | 'completed' | 'failed' | 'skipped';

interface HandoffStepState {
  status: HandoffStepStatus;
  operation: string;
  message?: string;
}

interface HandoffState {
  contextInject: HandoffStepState;
  sessionEnd: HandoffStepState;
  spawn: HandoffStepState;
}

interface OrchestrateHandoffParams {
  taskId: string;
  protocolType: string;
  note?: string;
  nextAction?: string;
  variant?: string;
  tier?: 0 | 1 | 2;
  idempotencyKey?: string;
}

interface HandoffFailureDetails {
  failedStep: 'session.context.inject' | 'session.end' | 'orchestrate.spawn';
  activeSessionId: string | null;
  endedSessionId: string | null;
  idempotency: {
    key: string | null;
    policy: 'non-idempotent';
    safeRetryFrom: 'start' | 'orchestrate.spawn';
    reason: string;
  };
  steps: HandoffState;
}

/**
 * Load all tasks from task data.
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
        return engineError('E_NOT_FOUND', `Epic ${epicId} not found`);
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
    return engineError('E_GENERAL', (err as Error).message);
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
    return engineError('E_INVALID_INPUT', 'epicId is required');
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
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
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
    return engineError('E_INVALID_INPUT', 'epicId is required');
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
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
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
    return engineError('E_INVALID_INPUT', 'epicId is required');
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
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
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
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await getEnrichedWaves(epicId, root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
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
    return engineError('E_GENERAL', (err as Error).message);
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
    return engineError('E_INVALID_INPUT', 'taskId is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await validateSpawnReadiness(taskId, root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    return engineError('E_VALIDATION', (err as Error).message);
  }
}

/**
 * orchestrate.spawn.select - Select best provider for spawn based on required capabilities
 * @task T5236
 */
export async function orchestrateSpawnSelectProvider(
  capabilities: Array<'supportsSubagents' | 'supportsProgrammaticSpawn' | 'supportsInterAgentComms' | 'supportsParallelSpawn'>,
  _projectRoot?: string,
): Promise<EngineResult> {
  if (!capabilities || capabilities.length === 0) {
    return engineError('E_INVALID_INPUT', 'At least one capability is required');
  }

  try {
    const { initializeDefaultAdapters, spawnRegistry } = await import('../../core/spawn/adapter-registry.js');
    const {
      getAllProviders,
      getProvidersBySpawnCapability,
      providerSupportsById,
    } = await import('@cleocode/caamp');

    await initializeDefaultAdapters();

    // Get providers matching all required capabilities
    let matchingProviders: Provider[] = [];

    if (capabilities.length === 1) {
      // Single capability - use direct filter
      matchingProviders = getProvidersBySpawnCapability(capabilities[0]);
    } else {
      // Multiple capabilities - find intersection
      const providerSets = capabilities.map(cap =>
        new Set(getProvidersBySpawnCapability(cap).map((p: Provider) => p.id))
      );

      // Find intersection of all provider IDs
      const allProviders = await spawnRegistry.listSpawnCapable();
      const intersection = allProviders
        .filter(adapter => providerSets.every(set => set.has(adapter.providerId)))
        .map(adapter => getAllProviders().find((p: Provider) => p.id === adapter.providerId))
        .filter((provider): provider is Provider => provider !== undefined);

      matchingProviders = intersection;
    }

    if (matchingProviders.length === 0) {
      return {
        success: false,
        error: {
          code: 'E_SPAWN_NO_PROVIDER',
          message: `No provider found with all required capabilities: ${capabilities.join(', ')}`,
          exitCode: 60,
        },
      };
    }

    // Get first registered adapter for the matching providers
    const adapter = matchingProviders
      .map((p: { id: string }) => spawnRegistry.getForProvider(p.id))
      .find((a: unknown): a is CLEOSpawnAdapter => a !== undefined);

    if (!adapter) {
      return {
        success: false,
        error: {
          code: 'E_SPAWN_NO_ADAPTER',
          message: 'No spawn adapter registered for matching providers',
          exitCode: 60,
        },
      };
    }

    // Verify adapter can actually spawn
    const canSpawn = await adapter.canSpawn();
    if (!canSpawn) {
      return {
        success: false,
        error: {
          code: 'E_SPAWN_ADAPTER_UNAVAILABLE',
          message: `Selected adapter '${adapter.id}' cannot spawn in current environment`,
          exitCode: 63,
        },
      };
    }

    return {
      success: true,
      data: {
        providerId: adapter.providerId,
        adapterId: adapter.id,
        capabilities: capabilities.filter(cap =>
          providerSupportsById(adapter.providerId, `spawn.${cap}`)
        ),
      },
    };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message);
  }
}

/**
 * orchestrate.spawn.execute - Execute spawn for a task using adapter registry
 * @task T5236
 */
export async function orchestrateSpawnExecute(
  taskId: string,
  adapterId?: string,
  protocolType?: string,
  projectRoot?: string,
  _tier?: 0 | 1 | 2,
): Promise<EngineResult> {
  const cwd = projectRoot ?? process.cwd();

  try {
    // Get spawn registry
    const { initializeDefaultAdapters, spawnRegistry } = await import('../../core/spawn/adapter-registry.js');
    await initializeDefaultAdapters();

    // Find adapter
    let adapter: CLEOSpawnAdapter | undefined;
    if (adapterId) {
      adapter = spawnRegistry.get(adapterId);
    } else {
      // Auto-select first capable adapter
      const capable = await spawnRegistry.listSpawnCapable();
      adapter = capable[0];
    }

    if (!adapter) {
      return {
        success: false,
        error: {
          code: 'E_SPAWN_NO_ADAPTER',
          message: 'No spawn adapter available for this provider',
          exitCode: 60,
        },
      };
    }

    // Verify provider supports subagents using providerSupportsById
    const { providerSupportsById } = await import('@cleocode/caamp');
    if (!providerSupportsById(adapter.providerId, 'spawn.supportsSubagents')) {
      return {
        success: false,
        error: {
          code: 'E_SPAWN_CAPABILITY_UNSUPPORTED',
          message: `Provider ${adapter.providerId} does not support spawning subagents`,
          exitCode: 60,
        },
      };
    }

    // Prepare spawn context (reuse existing prepareSpawn logic)
    const { prepareSpawn } = await import('../../core/orchestration/index.js');
    const accessor = await getAccessor(cwd);
    const spawnContext = await prepareSpawn(taskId, cwd, accessor);

    // Check for unresolved tokens
    if (!spawnContext.tokenResolution.fullyResolved) {
      return {
        success: false,
        error: {
          code: 'E_SPAWN_VALIDATION_FAILED',
          message: `Unresolved tokens in spawn context: ${spawnContext.tokenResolution.unresolvedTokens.join(', ')}`,
          exitCode: 63,
        },
      };
    }

    // Build CLEO spawn context from core spawn context
    const { getSpawnCapableProviders } = await import('@cleocode/caamp');
    const providers = getSpawnCapableProviders();
    const provider = providers.find((p: { id: string }) => p.id === adapter.providerId);

    if (!provider) {
      return {
        success: false,
        error: {
          code: 'E_SPAWN_NO_PROVIDER',
          message: `Provider ${adapter.providerId} not found`,
          exitCode: 60,
        },
      };
    }

    const cleoSpawnContext: CLEOSpawnContext = {
      taskId: spawnContext.taskId,
      protocol: protocolType || spawnContext.protocol,
      prompt: spawnContext.prompt,
      provider,
      options: {
        prompt: spawnContext.prompt,
      },
      workingDirectory: cwd,
      tokenResolution: {
        resolved: [],
        unresolved: spawnContext.tokenResolution.unresolvedTokens,
        totalTokens: 0,
      },
    };

    // Execute spawn
    const result = await adapter.spawn(cleoSpawnContext);

    return {
      success: true,
      data: {
        instanceId: result.instanceId,
        status: result.status,
        providerId: adapter.providerId,
        taskId,
        timing: result.timing,
      },
    };

  } catch (error) {
    return {
      success: false,
      error: {
        code: 'E_SPAWN_FAILED',
        message: error instanceof Error ? error.message : 'Unknown spawn error',
        exitCode: 60,
      },
    };
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
  tier?: 0 | 1 | 2,
): Promise<EngineResult> {
  if (!taskId) {
    return engineError('E_INVALID_INPUT', 'taskId is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();

    // Validate readiness first
    const accessor = await getAccessor(root);
    const validation = await validateSpawnReadiness(taskId, root, accessor);
    if (!validation.ready) {
      return engineError('E_SPAWN_VALIDATION_FAILED', `Task ${taskId} is not ready to spawn`, {
        details: { issues: validation.issues },
      });
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
          tier: tier ?? null,
        },
        protocolType: protocolType || spawnContext.protocol,
        tier: tier ?? null,
        tokenResolution: spawnContext.tokenResolution,
      },
    };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
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
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);

    const tasks = await loadTasks(root);
    const epic = tasks.find(t => t.id === epicId);
    if (!epic) {
      return engineError('E_NOT_FOUND', `Epic ${epicId} not found`);
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
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
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
    return engineError('E_GENERAL', (err as Error).message);
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
    return engineError('E_GENERAL', (err as Error).message);
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
    return engineError('E_GENERAL', (err as Error).message);
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
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }
  if (wave === undefined || wave === null) {
    return engineError('E_INVALID_INPUT', 'wave number is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const accessor = await getAccessor(root);
    const result = await startParallelExecution(epicId, wave, root, accessor);
    return { success: true, data: result };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
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
    return engineError('E_INVALID_INPUT', 'epicId is required');
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
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
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
    return engineError('E_GENERAL', (err as Error).message);
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
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}

/**
 * orchestrate.handoff - Composite session handoff + successor spawn
 *
 * Step order is explicit and fixed:
 * 1) session.context.inject
 * 2) session.end
 * 3) orchestrate.spawn
 *
 * Idempotency policy:
 * - Non-idempotent overall. A retry after step 2 can duplicate spawn output.
 * - Failures include exact step state and a safe retry entry point.
 */
export async function orchestrateHandoff(
  params: OrchestrateHandoffParams,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!params.taskId) {
    return engineError('E_INVALID_INPUT', 'taskId is required');
  }

  if (!params.protocolType) {
    return engineError('E_INVALID_INPUT', 'protocolType is required');
  }

  const root = projectRoot || resolveProjectRoot();

  const steps: HandoffState = {
    contextInject: { status: 'pending', operation: 'session.context.inject' },
    sessionEnd: { status: 'pending', operation: 'session.end' },
    spawn: { status: 'pending', operation: 'orchestrate.spawn' },
  };

  const idempotency = {
    key: params.idempotencyKey ?? null,
    policy: 'non-idempotent' as const,
    safeRetryFrom: 'start' as 'start' | 'orchestrate.spawn',
    reason: 'session.end and orchestrate.spawn mutate state and may be executed independently on retry',
  };

  let activeSessionId: string | null = null;
  let endedSessionId: string | null = null;

  const failWithStep = (
    code: string,
    message: string,
    failedStep: HandoffFailureDetails['failedStep'],
    safeRetryFrom: 'start' | 'orchestrate.spawn',
  ): EngineResult => {
    idempotency.safeRetryFrom = safeRetryFrom;
    return engineError(code, message, {
      details: {
        failedStep,
        activeSessionId,
        endedSessionId,
        idempotency,
        steps,
      } satisfies HandoffFailureDetails,
      fix: safeRetryFrom === 'orchestrate.spawn'
        ? 'Retry only step 3 with mutate orchestrate spawn'
        : 'Retry from step 1 with mutate orchestrate handoff',
      alternatives: [
        {
          action: 'Run canonical multi-op fallback manually',
          command: 'mutate session context.inject -> mutate session end -> mutate orchestrate spawn',
        },
      ],
    });
  };

  const preflight = await sessionStatus(root);
  if (!preflight.success) {
    return failWithStep(
      preflight.error?.code ?? 'E_NOT_INITIALIZED',
      preflight.error?.message ?? 'Unable to load session status',
      'session.context.inject',
      'start',
    );
  }

  if (!preflight.data?.hasActiveSession || !preflight.data.session?.id) {
    steps.contextInject.status = 'skipped';
    steps.contextInject.message = 'No active session available for handoff';
    steps.sessionEnd.status = 'skipped';
    steps.sessionEnd.message = 'No active session available for handoff';
    steps.spawn.status = 'skipped';
    steps.spawn.message = 'No active session available for handoff';
    return failWithStep(
      'E_SESSION_REQUIRED',
      'orchestrate.handoff requires an active session',
      'session.end',
      'start',
    );
  }

  activeSessionId = preflight.data.session.id;

  const injectResult = sessionContextInject(
    params.protocolType,
    { taskId: params.taskId, variant: params.variant },
    root,
  );

  if (!injectResult.success) {
    steps.contextInject.status = 'failed';
    steps.contextInject.message = injectResult.error?.message;
    steps.sessionEnd.status = 'skipped';
    steps.sessionEnd.message = 'Blocked by session.context.inject failure';
    steps.spawn.status = 'skipped';
    steps.spawn.message = 'Blocked by session.context.inject failure';
    return failWithStep(
      injectResult.error?.code ?? 'E_GENERAL',
      injectResult.error?.message ?? 'Failed to inject handoff context',
      'session.context.inject',
      'start',
    );
  }

  steps.contextInject.status = 'completed';
  steps.contextInject.message = 'Handoff context injected';

  const endResult = await sessionEnd(root, params.note);
  if (!endResult.success) {
    steps.sessionEnd.status = 'failed';
    steps.sessionEnd.message = endResult.error?.message;
    steps.spawn.status = 'skipped';
    steps.spawn.message = 'Blocked by session.end failure';
    return failWithStep(
      endResult.error?.code ?? 'E_GENERAL',
      endResult.error?.message ?? 'Failed to end predecessor session',
      'session.end',
      'start',
    );
  }

  endedSessionId = endResult.data?.sessionId ?? null;
  if (endedSessionId !== activeSessionId) {
    steps.sessionEnd.status = 'failed';
    steps.sessionEnd.message = `Ended session '${endedSessionId ?? 'null'}' does not match active session '${activeSessionId}'`;
    steps.spawn.status = 'skipped';
    steps.spawn.message = 'Blocked by session mismatch';
    return failWithStep(
      'E_CONCURRENT_SESSION',
      'Active session changed during orchestrate.handoff',
      'session.end',
      'start',
    );
  }

  steps.sessionEnd.status = 'completed';
  steps.sessionEnd.message = `Ended session ${endedSessionId}`;

  const spawnResult = await orchestrateSpawn(params.taskId, params.protocolType, root, params.tier);
  if (!spawnResult.success) {
    steps.spawn.status = 'failed';
    steps.spawn.message = spawnResult.error?.message;
    return failWithStep(
      spawnResult.error?.code ?? 'E_GENERAL',
      spawnResult.error?.message ?? 'Failed to prepare successor spawn context',
      'orchestrate.spawn',
      'orchestrate.spawn',
    );
  }

  steps.spawn.status = 'completed';
  steps.spawn.message = `Spawn prepared for ${params.taskId}`;

  return {
    success: true,
    data: {
      taskId: params.taskId,
      predecessorSessionId: activeSessionId,
      endedSessionId,
      protocolType: params.protocolType,
      note: params.note ?? null,
      nextAction: params.nextAction ?? null,
      idempotency,
      steps,
      contextInject: injectResult.data,
      spawn: spawnResult.data,
    },
  };
}
