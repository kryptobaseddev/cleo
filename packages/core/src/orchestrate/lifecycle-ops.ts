/**
 * Orchestrate Lifecycle Operations
 *
 * Startup, bootstrap, criticalPath, unblockOpportunities, check,
 * skillInject, and parallel wrappers migrated from
 * packages/cleo/src/dispatch/engines/orchestrate-engine.ts.
 *
 * @task T1570
 * @task T4478
 * @task T4632
 */

import type { BrainState } from '@cleocode/contracts';
import { type EngineResult, engineError } from '../engine-result.js';
import { getLifecycleStatus, recordStageProgress } from '../lifecycle/index.js';
import { buildBrainState } from '../orchestration/bootstrap.js';
import { getCriticalPath } from '../orchestration/critical-path.js';
import { getReadyTasks } from '../orchestration/index.js';
import {
  endParallelExecution,
  getParallelStatus,
  startParallelExecution,
} from '../orchestration/parallel.js';
import { getSkillContent } from '../orchestration/skill-ops.js';
import { computeProgress, computeStartupSummary } from '../orchestration/status.js';
import { getUnblockOpportunities } from '../orchestration/unblock.js';
import { getAccessor } from '../store/data-accessor.js';
import { resolveProjectRoot } from '../store/file-utils.js';
import { loadTasks } from './query-ops.js';

export type { EngineResult };

/**
 * orchestrate.startup - Initialize orchestration for an epic.
 *
 * Auto-initializes the RCASD-IVTR lifecycle at the 'research' stage if the
 * epic has not already been initialized. This is idempotent — a second call
 * detects the existing pipeline and skips re-initialization.
 *
 * Result data includes:
 * - `autoInitialized`  — true if this call created the lifecycle pipeline
 * - `currentStage`     — 'research' when newly initialized, 'already-initialized' otherwise
 *
 * @param epicId - Epic to initialize orchestration for.
 * @param projectRoot - Optional project root path.
 * @returns Engine result with startup data.
 * @task T4478
 * @task T785
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
    const epic = tasks.find((t) => t.id === epicId);
    if (!epic) {
      return engineError('E_NOT_FOUND', `Epic ${epicId} not found`);
    }

    const children = tasks.filter((t) => t.parentId === epicId);
    const readyTasks = await getReadyTasks(epicId, root, accessor);
    const ready = readyTasks.filter((t) => t.ready);

    // Auto-initialize lifecycle at 'research' stage if not already initialized.
    // getLifecycleStatus returns initialized:false when no pipeline exists.
    // recordStageProgress creates the pipeline + stage record idempotently via
    // ensureLifecycleContext, so re-invoking orchestrateStartup is safe.
    const lifecycleStatus = await getLifecycleStatus(root, { epicId });
    let autoInitialized = false;
    let currentStage: string;

    if (!lifecycleStatus.initialized) {
      await recordStageProgress(root, { taskId: epicId, stage: 'research', status: 'in_progress' });
      autoInitialized = true;
      currentStage = 'research';
    } else {
      currentStage = 'already-initialized';
    }

    const summary = computeStartupSummary(epicId, epic.title, children, ready.length);
    return { success: true, data: { ...summary, autoInitialized, currentStage } };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}

/**
 * orchestrate.bootstrap - Load brain state for agent bootstrapping
 *
 * @param projectRoot - Optional project root path.
 * @param params - Bootstrap options including speed mode.
 * @returns Engine result with brain state data.
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
 *
 * @param projectRoot - Optional project root path.
 * @returns Engine result with critical path data.
 * @task T4478
 */
export async function orchestrateCriticalPath(projectRoot?: string): Promise<EngineResult> {
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
 *
 * @param projectRoot - Optional project root path.
 * @returns Engine result with unblock opportunities data.
 * @task T4478
 */
export async function orchestrateUnblockOpportunities(projectRoot?: string): Promise<EngineResult> {
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
 * orchestrate.parallel - Manage parallel execution (start/end)
 *
 * @param action - Action to perform: 'start' or 'end'.
 * @param epicId - Epic to manage parallel execution for.
 * @param wave - Wave number (required for both start and end).
 * @param projectRoot - Optional project root path.
 * @returns Engine result with parallel execution data.
 * @task T4632
 */
export async function orchestrateParallel(
  action: 'start' | 'end',
  epicId: string,
  wave?: number,
  projectRoot?: string,
): Promise<EngineResult> {
  if (action === 'start') {
    if (wave === undefined || wave === null) {
      return engineError('E_INVALID_INPUT', 'wave number is required for start action');
    }
    return orchestrateParallelStart(epicId, wave, projectRoot);
  }

  if (action === 'end') {
    if (wave === undefined || wave === null) {
      return engineError('E_INVALID_INPUT', 'wave number is required for end action');
    }
    return orchestrateParallelEnd(epicId, wave, projectRoot);
  }

  return engineError('E_INVALID_INPUT', `Unknown parallel action: ${action}`);
}

/**
 * orchestrate.parallel.start - Start parallel execution for a wave
 *
 * @param epicId - Epic to start parallel execution for.
 * @param wave - Wave number to start.
 * @param projectRoot - Optional project root path.
 * @returns Engine result with parallel start data.
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
 *
 * @param epicId - Epic to end parallel execution for.
 * @param wave - Wave number to end.
 * @param projectRoot - Optional project root path.
 * @returns Engine result with parallel end data.
 * @task T4632
 */
export async function orchestrateParallelEnd(
  epicId: string,
  wave: number,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  try {
    const root = projectRoot || resolveProjectRoot();
    const result = await endParallelExecution(epicId, wave, root);

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
 *
 * @param projectRoot - Optional project root path.
 * @returns Engine result with orchestration check data.
 * @task T4632
 */
export async function orchestrateCheck(projectRoot?: string): Promise<EngineResult> {
  try {
    const root = projectRoot || resolveProjectRoot();
    const parallelState = await getParallelStatus(root);
    const tasks = await loadTasks(root);

    const activeTasks = tasks.filter((t) => t.status === 'active');
    const progress = computeProgress(tasks);

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
        activeTasks: activeTasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
        progress,
      },
    };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message);
  }
}

/**
 * orchestrate.skill.inject - Read skill content for injection into agent context
 *
 * @param skillName - Name of the skill to inject.
 * @param projectRoot - Optional project root path.
 * @returns Engine result with skill content data.
 * @task T4632
 */
export function orchestrateSkillInject(skillName: string, projectRoot?: string): EngineResult {
  try {
    const root = projectRoot || resolveProjectRoot();
    const result = getSkillContent(skillName, root);
    return { success: true, data: result };
  } catch (err: unknown) {
    const code = (err as { code?: string }).code ?? 'E_GENERAL';
    return engineError(code, (err as Error).message);
  }
}
