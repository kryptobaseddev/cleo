/**
 * Lifecycle Engine — Thin EngineResult Wrapper
 *
 * Delegates all business logic to src/core/lifecycle/index.ts.
 * This file only wraps core function calls in EngineResult format
 * for the MCP domain handlers.
 *
 * @task T4785
 * @task T4800 - Updated to canonical full-form stage names
 */

import {
  listEpicsWithLifecycle,
  getLifecycleStatus,
  getLifecycleHistory,
  getLifecycleGates,
  getStagePrerequisites,
  checkStagePrerequisites,
  recordStageProgress,
  skipStageWithReason,
  resetStage,
  passGate,
  failGate,
} from '../../core/lifecycle/index.js';
import { engineError, engineSuccess, type EngineResult } from './_error.js';

// ============================================================================
// Exported engine functions (thin wrappers)
// ============================================================================

/**
 * List all epic IDs that have RCASD pipeline data.
 */
export async function listRcsdEpics(projectRoot?: string): Promise<string[]> {
  return listEpicsWithLifecycle(projectRoot);
}

/**
 * lifecycle.check / lifecycle.status - Get lifecycle status for epic.
 * @task T4785
 */
export async function lifecycleStatus(
  epicId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }
  try {
    const data = await getLifecycleStatus(epicId, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_STATUS', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.history - Stage transition history.
 * @task T4785
 */
export async function lifecycleHistory(
  taskId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const data = await getLifecycleHistory(taskId, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_HISTORY', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.gates - Get all gate statuses for an epic.
 * @task T4785
 */
export async function lifecycleGates(
  taskId: string,
  projectRoot?: string,
): Promise<EngineResult> {
  try {
    const data = await getLifecycleGates(taskId, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_GATES', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.prerequisites - Get required prior stages for a target stage.
 * @task T4785
 */
export async function lifecyclePrerequisites(
  targetStage: string,
  _projectRoot?: string,
): Promise<EngineResult> {
  if (!targetStage) {
    return engineError('E_INVALID_INPUT', 'targetStage is required');
  }
  try {
    const data = await getStagePrerequisites(targetStage);
    return engineSuccess({ targetStage, ...data });
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_PREREQUISITES', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.check - Check if a stage's prerequisites are met.
 * @task T4785
 */
export async function lifecycleCheck(
  epicId: string,
  targetStage: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!epicId || !targetStage) {
    return engineError('E_INVALID_INPUT', 'epicId and targetStage are required');
  }
  try {
    const data = await checkStagePrerequisites(epicId, targetStage, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_CHECK', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.progress / lifecycle.record - Record stage completion.
 * @task T4785
 */
export async function lifecycleProgress(
  taskId: string,
  stage: string,
  status: string,
  notes?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId || !stage || !status) {
    return engineError('E_INVALID_INPUT', 'taskId, stage, and status are required');
  }
  try {
    const data = await recordStageProgress(taskId, stage, status, notes, projectRoot);
    return engineSuccess({ ...data, recorded: true });
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_PROGRESS', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.skip - Skip a stage with reason.
 * @task T4785
 */
export async function lifecycleSkip(
  taskId: string,
  stage: string,
  reason: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId || !stage || !reason) {
    return engineError('E_INVALID_INPUT', 'taskId, stage, and reason are required');
  }
  try {
    const data = await skipStageWithReason(taskId, stage, reason, projectRoot);
    return engineSuccess({ ...data, skipped: true });
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_SKIP', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.reset - Reset a stage (emergency).
 * @task T4785
 */
export async function lifecycleReset(
  taskId: string,
  stage: string,
  reason: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId || !stage || !reason) {
    return engineError('E_INVALID_INPUT', 'taskId, stage, and reason are required');
  }
  try {
    const data = await resetStage(taskId, stage, reason, projectRoot);
    return engineSuccess({ ...data, reset: 'pending' });
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_RESET', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.gate.pass - Mark gate as passed.
 * @task T4785
 */
export async function lifecycleGatePass(
  taskId: string,
  gateName: string,
  agent?: string,
  notes?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId || !gateName) {
    return engineError('E_INVALID_INPUT', 'taskId and gateName are required');
  }
  try {
    const data = await passGate(taskId, gateName, agent, notes, projectRoot);
    return engineSuccess({ ...data, status: 'passed' });
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_GATE_PASS', err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.gate.fail - Mark gate as failed.
 * @task T4785
 */
export async function lifecycleGateFail(
  taskId: string,
  gateName: string,
  reason?: string,
  projectRoot?: string,
): Promise<EngineResult> {
  if (!taskId || !gateName) {
    return engineError('E_INVALID_INPUT', 'taskId and gateName are required');
  }
  try {
    const data = await failGate(taskId, gateName, reason, projectRoot);
    return engineSuccess({ ...data, status: 'failed' });
  } catch (err) {
    if (err instanceof Error) {
      return engineError('E_LIFECYCLE_GATE_FAIL', err.message);
    }
    throw err;
  }
}
