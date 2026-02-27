/**
 * Lifecycle Engine — Thin EngineResult Wrapper
 *
 * Delegates all business logic to src/core/lifecycle/engine.ts.
 * This file only wraps core function calls in EngineResult format
 * for the MCP domain handlers.
 *
 * @task T4785
 * @task T4800 - Updated to canonical full-form stage names
 */

import {
  listRcsdEpics as coreListRcsdEpics,
  getStatusSync,
  getHistorySync,
  getGatesSync,
  getPrerequisitesSync,
  checkPrerequisitesSync,
  recordProgressSync,
  skipStageSync,
  resetStageSync,
  passGateSync,
  failGateSync,
  LifecycleEngineError,
} from '../../core/lifecycle/engine.js';
import { engineError, engineSuccess, type EngineResult } from './_error.js';

// ============================================================================
// Exported engine functions (thin wrappers)
// ============================================================================

/**
 * List all epic IDs that have RCASD pipeline data.
 */
export function listRcsdEpics(projectRoot?: string): string[] {
  return coreListRcsdEpics(projectRoot);
}

/**
 * lifecycle.check / lifecycle.status - Get lifecycle status for epic.
 * @task T4785
 */
export function lifecycleStatus(
  epicId: string,
  projectRoot?: string,
): EngineResult {
  try {
    const data = getStatusSync(epicId, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof LifecycleEngineError) {
      return engineError(err.code, err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.history - Stage transition history.
 * @task T4785
 */
export function lifecycleHistory(
  taskId: string,
  projectRoot?: string,
): EngineResult {
  try {
    const data = getHistorySync(taskId, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof LifecycleEngineError) {
      return engineError(err.code, err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.gates - Get all gate statuses for an epic.
 * @task T4785
 */
export function lifecycleGates(
  taskId: string,
  projectRoot?: string,
): EngineResult {
  try {
    const data = getGatesSync(taskId, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof LifecycleEngineError) {
      return engineError(err.code, err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.prerequisites - Get required prior stages for a target stage.
 * @task T4785
 */
export function lifecyclePrerequisites(
  targetStage: string,
  _projectRoot?: string,
): EngineResult {
  try {
    const data = getPrerequisitesSync(targetStage);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof LifecycleEngineError) {
      return engineError(err.code, err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.check - Check if a stage's prerequisites are met.
 * @task T4785
 */
export function lifecycleCheck(
  epicId: string,
  targetStage: string,
  projectRoot?: string,
): EngineResult {
  try {
    const data = checkPrerequisitesSync(epicId, targetStage, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof LifecycleEngineError) {
      return engineError(err.code, err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.progress / lifecycle.record - Record stage completion.
 * @task T4785
 */
export function lifecycleProgress(
  taskId: string,
  stage: string,
  status: string,
  notes?: string,
  projectRoot?: string,
): EngineResult {
  try {
    const data = recordProgressSync(taskId, stage, status, notes, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof LifecycleEngineError) {
      return engineError(err.code, err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.skip - Skip a stage with reason.
 * @task T4785
 */
export function lifecycleSkip(
  taskId: string,
  stage: string,
  reason: string,
  projectRoot?: string,
): EngineResult {
  try {
    const data = skipStageSync(taskId, stage, reason, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof LifecycleEngineError) {
      return engineError(err.code, err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.reset - Reset a stage (emergency).
 * @task T4785
 */
export function lifecycleReset(
  taskId: string,
  stage: string,
  reason: string,
  projectRoot?: string,
): EngineResult {
  try {
    const data = resetStageSync(taskId, stage, reason, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof LifecycleEngineError) {
      return engineError(err.code, err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.gate.pass - Mark gate as passed.
 * @task T4785
 */
export function lifecycleGatePass(
  taskId: string,
  gateName: string,
  agent?: string,
  notes?: string,
  projectRoot?: string,
): EngineResult {
  try {
    const data = passGateSync(taskId, gateName, agent, notes, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof LifecycleEngineError) {
      return engineError(err.code, err.message);
    }
    throw err;
  }
}

/**
 * lifecycle.gate.fail - Mark gate as failed.
 * @task T4785
 */
export function lifecycleGateFail(
  taskId: string,
  gateName: string,
  reason?: string,
  projectRoot?: string,
): EngineResult {
  try {
    const data = failGateSync(taskId, gateName, reason, projectRoot);
    return engineSuccess(data);
  } catch (err) {
    if (err instanceof LifecycleEngineError) {
      return engineError(err.code, err.message);
    }
    throw err;
  }
}
