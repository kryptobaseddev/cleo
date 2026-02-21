/**
 * Lifecycle Engine
 *
 * Thin wrapper over src/core/lifecycle/ for MCP engine layer.
 * Types, constants, and business logic are defined in core;
 * this file provides synchronous EngineResult-wrapped access
 * for the MCP domain handlers.
 *
 * @task T4785
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectRoot, readJsonFile, writeJsonFileAtomic } from './store.js';
import {
  ENGINE_LIFECYCLE_STAGES,
  STAGE_DEFINITIONS,
  STAGE_PREREQUISITES,
  type EngineLifecycleStage,
  type EngineStageStatus,
  type EngineRcsdManifest,
  type GateData,
  type StageInfo,
} from '../../core/lifecycle/index.js';

/**
 * Re-export types and constants for consumers that import from engine.
 */
export { ENGINE_LIFECYCLE_STAGES as LIFECYCLE_STAGES };
export type LifecycleStage = EngineLifecycleStage;
export type StageStatus = EngineStageStatus;
export type { StageInfo, GateData };
export type RcsdManifest = EngineRcsdManifest;

/**
 * Engine result type
 */
interface EngineResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

// ============================================================================
// Internal I/O helpers (synchronous, using store.ts)
// ============================================================================

function getRcsdDir(epicId: string, projectRoot?: string): string {
  const root = projectRoot || resolveProjectRoot();
  return join(root, '.cleo', 'rcsd', epicId);
}

function getRcsdManifestPath(epicId: string, projectRoot?: string): string {
  return join(getRcsdDir(epicId, projectRoot), '_manifest.json');
}

function readRcsdManifest(epicId: string, projectRoot?: string): EngineRcsdManifest | null {
  return readJsonFile<EngineRcsdManifest>(getRcsdManifestPath(epicId, projectRoot));
}

function writeRcsdManifest(epicId: string, manifest: EngineRcsdManifest, projectRoot?: string): void {
  const dir = getRcsdDir(epicId, projectRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeJsonFileAtomic(getRcsdManifestPath(epicId, projectRoot), manifest);
}

// ============================================================================
// Exported engine functions
// ============================================================================

/**
 * List all epic IDs that have RCSD data
 */
export function listRcsdEpics(projectRoot?: string): string[] {
  const root = projectRoot || resolveProjectRoot();
  const rcsdDir = join(root, '.cleo', 'rcsd');

  if (!existsSync(rcsdDir)) {
    return [];
  }

  try {
    return readdirSync(rcsdDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('T'))
      .map(d => d.name);
  } catch {
    return [];
  }
}

/**
 * lifecycle.check / lifecycle.status - Get lifecycle status for epic
 * @task T4785
 */
export function lifecycleStatus(
  epicId: string,
  projectRoot?: string,
): EngineResult {
  if (!epicId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId is required' } };
  }

  const manifest = readRcsdManifest(epicId, projectRoot);

  if (!manifest) {
    return {
      success: true,
      data: {
        epicId,
        currentStage: null,
        stages: ENGINE_LIFECYCLE_STAGES.map(s => ({
          stage: s,
          status: 'pending' as EngineStageStatus,
        })),
        nextStage: 'research',
        blockedOn: [],
        initialized: false,
      },
    };
  }

  const stages = ENGINE_LIFECYCLE_STAGES.map(s => {
    const stageData = manifest.stages[s];
    return {
      stage: s,
      status: (stageData?.status || 'pending') as EngineStageStatus,
      completedAt: stageData?.completedAt,
      notes: stageData?.notes,
    };
  });

  let currentStage: EngineLifecycleStage | null = null;
  let nextStage: EngineLifecycleStage | null = null;

  for (let i = ENGINE_LIFECYCLE_STAGES.length - 1; i >= 0; i--) {
    const s = ENGINE_LIFECYCLE_STAGES[i];
    const status = manifest.stages[s]?.status;
    if (status === 'completed' || status === 'skipped') {
      currentStage = s;
      if (i < ENGINE_LIFECYCLE_STAGES.length - 1) {
        nextStage = ENGINE_LIFECYCLE_STAGES[i + 1];
      }
      break;
    }
  }

  if (!currentStage) {
    nextStage = 'research';
  }

  const blockedOn: string[] = [];
  if (nextStage) {
    const prereqs = STAGE_PREREQUISITES[nextStage] || [];
    for (const prereq of prereqs) {
      const prereqStatus = manifest.stages[prereq]?.status;
      if (prereqStatus !== 'completed' && prereqStatus !== 'skipped') {
        blockedOn.push(prereq);
      }
    }
  }

  return {
    success: true,
    data: {
      epicId,
      title: manifest.title,
      currentStage,
      stages,
      nextStage,
      blockedOn,
      initialized: true,
    },
  };
}

/**
 * lifecycle.history - Stage transition history
 * @task T4785
 */
export function lifecycleHistory(
  taskId: string,
  projectRoot?: string,
): EngineResult {
  if (!taskId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId is required' } };
  }

  const manifest = readRcsdManifest(taskId, projectRoot);

  if (!manifest) {
    return {
      success: true,
      data: {
        taskId,
        history: [],
        message: 'No lifecycle data found for this task',
      },
    };
  }

  const history: Array<{
    stage: string;
    action: string;
    timestamp: string;
    notes?: string;
  }> = [];

  for (const [stageName, stageData] of Object.entries(manifest.stages)) {
    if (stageData.status === 'completed' && stageData.completedAt) {
      history.push({
        stage: stageName,
        action: 'completed',
        timestamp: stageData.completedAt,
        notes: stageData.notes,
      });
    }
    if (stageData.status === 'skipped' && stageData.skippedAt) {
      history.push({
        stage: stageName,
        action: 'skipped',
        timestamp: stageData.skippedAt,
        notes: stageData.skippedReason,
      });
    }

    if (stageData.gates) {
      for (const [gateName, gateData] of Object.entries(stageData.gates)) {
        if (gateData.timestamp) {
          history.push({
            stage: stageName,
            action: `gate.${gateData.status}: ${gateName}`,
            timestamp: gateData.timestamp,
            notes: gateData.notes || gateData.reason,
          });
        }
      }
    }
  }

  history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    success: true,
    data: { taskId, history },
  };
}

/**
 * lifecycle.gates - Get all gate statuses for an epic
 * @task T4785
 */
export function lifecycleGates(
  taskId: string,
  projectRoot?: string,
): EngineResult {
  if (!taskId) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'taskId is required' } };
  }

  const manifest = readRcsdManifest(taskId, projectRoot);

  if (!manifest) {
    return {
      success: true,
      data: {
        taskId,
        gates: {},
        message: 'No lifecycle data found for this task',
      },
    };
  }

  const gates: Record<string, Record<string, GateData>> = {};

  for (const [stageName, stageData] of Object.entries(manifest.stages)) {
    if (stageData.gates && Object.keys(stageData.gates).length > 0) {
      gates[stageName] = stageData.gates;
    }
  }

  return {
    success: true,
    data: { taskId, gates },
  };
}

/**
 * lifecycle.prerequisites - Get required prior stages for a target stage
 * @task T4785
 */
export function lifecyclePrerequisites(
  targetStage: string,
  _projectRoot?: string,
): EngineResult {
  if (!targetStage) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'targetStage is required' } };
  }

  if (!ENGINE_LIFECYCLE_STAGES.includes(targetStage as EngineLifecycleStage)) {
    return {
      success: false,
      error: {
        code: 'E_INVALID_STAGE',
        message: `Invalid stage: ${targetStage}. Valid stages: ${ENGINE_LIFECYCLE_STAGES.join(', ')}`,
      },
    };
  }

  const prereqs = STAGE_PREREQUISITES[targetStage] || [];

  return {
    success: true,
    data: {
      targetStage,
      prerequisites: prereqs,
      stageInfo: STAGE_DEFINITIONS.find(s => s.stage === targetStage),
    },
  };
}

/**
 * lifecycle.check - Check if a stage's prerequisites are met
 * @task T4785
 */
export function lifecycleCheck(
  epicId: string,
  targetStage: string,
  projectRoot?: string,
): EngineResult {
  if (!epicId || !targetStage) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId and targetStage are required' } };
  }

  if (!ENGINE_LIFECYCLE_STAGES.includes(targetStage as EngineLifecycleStage)) {
    return {
      success: false,
      error: {
        code: 'E_INVALID_STAGE',
        message: `Invalid stage: ${targetStage}. Valid stages: ${ENGINE_LIFECYCLE_STAGES.join(', ')}`,
      },
    };
  }

  const manifest = readRcsdManifest(epicId, projectRoot);
  const prereqs = STAGE_PREREQUISITES[targetStage] || [];

  const missingPrerequisites: string[] = [];
  const issues: Array<{ stage: string; severity: string; message: string }> = [];

  for (const prereq of prereqs) {
    const prereqStatus = manifest?.stages[prereq]?.status;
    if (prereqStatus !== 'completed' && prereqStatus !== 'skipped') {
      missingPrerequisites.push(prereq);
      issues.push({
        stage: prereq,
        severity: 'error',
        message: `Stage '${prereq}' must be completed or skipped before '${targetStage}'`,
      });
    }
  }

  return {
    success: true,
    data: {
      epicId,
      targetStage,
      valid: missingPrerequisites.length === 0,
      canProgress: missingPrerequisites.length === 0,
      missingPrerequisites,
      issues,
    },
  };
}

/**
 * lifecycle.progress / lifecycle.record - Record stage completion
 * @task T4785
 */
export function lifecycleProgress(
  taskId: string,
  stage: string,
  status: string,
  notes?: string,
  projectRoot?: string,
): EngineResult {
  if (!taskId || !stage || !status) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'taskId, stage, and status are required' },
    };
  }

  if (!ENGINE_LIFECYCLE_STAGES.includes(stage as EngineLifecycleStage)) {
    return {
      success: false,
      error: { code: 'E_INVALID_STAGE', message: `Invalid stage: ${stage}` },
    };
  }

  const validStatuses: EngineStageStatus[] = ['pending', 'completed', 'skipped', 'blocked'];
  if (!validStatuses.includes(status as EngineStageStatus)) {
    return {
      success: false,
      error: { code: 'E_INVALID_STATUS', message: `Invalid status: ${status}. Valid: ${validStatuses.join(', ')}` },
    };
  }

  let manifest = readRcsdManifest(taskId, projectRoot);

  if (!manifest) {
    manifest = { epicId: taskId, stages: {} };
  }

  if (!manifest.stages[stage]) {
    manifest.stages[stage] = { status: 'pending' };
  }

  const now = new Date().toISOString();
  manifest.stages[stage].status = status as EngineStageStatus;

  if (status === 'completed') {
    manifest.stages[stage].completedAt = now;
  }

  if (notes) {
    manifest.stages[stage].notes = notes;
  }

  writeRcsdManifest(taskId, manifest, projectRoot);

  return {
    success: true,
    data: {
      epicId: taskId,
      stage,
      status,
      recorded: true,
      timestamp: now,
    },
  };
}

/**
 * lifecycle.skip - Skip a stage with reason
 * @task T4785
 */
export function lifecycleSkip(
  taskId: string,
  stage: string,
  reason: string,
  projectRoot?: string,
): EngineResult {
  if (!taskId || !stage || !reason) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'taskId, stage, and reason are required' },
    };
  }

  let manifest = readRcsdManifest(taskId, projectRoot);

  if (!manifest) {
    manifest = { epicId: taskId, stages: {} };
  }

  if (!manifest.stages[stage]) {
    manifest.stages[stage] = { status: 'pending' };
  }

  const now = new Date().toISOString();
  manifest.stages[stage].status = 'skipped';
  manifest.stages[stage].skippedAt = now;
  manifest.stages[stage].skippedReason = reason;

  writeRcsdManifest(taskId, manifest, projectRoot);

  return {
    success: true,
    data: {
      epicId: taskId,
      stage,
      skipped: true,
      reason,
      timestamp: now,
    },
  };
}

/**
 * lifecycle.reset - Reset a stage (emergency)
 * @task T4785
 */
export function lifecycleReset(
  taskId: string,
  stage: string,
  reason: string,
  projectRoot?: string,
): EngineResult {
  if (!taskId || !stage || !reason) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'taskId, stage, and reason are required' },
    };
  }

  const manifest = readRcsdManifest(taskId, projectRoot);

  if (!manifest) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `No lifecycle data found for ${taskId}` },
    };
  }

  if (!manifest.stages[stage]) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Stage '${stage}' not found for ${taskId}` },
    };
  }

  manifest.stages[stage] = {
    status: 'pending',
    notes: `Reset: ${reason}`,
  };

  writeRcsdManifest(taskId, manifest, projectRoot);

  return {
    success: true,
    data: {
      taskId,
      stage,
      reset: 'pending',
      reason,
      warning: 'Stage has been reset to pending. Previous data was cleared.',
    },
  };
}

/**
 * lifecycle.gate.pass - Mark gate as passed
 * @task T4785
 */
export function lifecycleGatePass(
  taskId: string,
  gateName: string,
  agent?: string,
  notes?: string,
  projectRoot?: string,
): EngineResult {
  if (!taskId || !gateName) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'taskId and gateName are required' },
    };
  }

  let manifest = readRcsdManifest(taskId, projectRoot);

  if (!manifest) {
    manifest = { epicId: taskId, stages: {} };
  }

  const stageParts = gateName.split('-');
  const stageName = stageParts[0];

  if (!manifest.stages[stageName]) {
    manifest.stages[stageName] = { status: 'pending' };
  }

  if (!manifest.stages[stageName].gates) {
    manifest.stages[stageName].gates = {};
  }

  const now = new Date().toISOString();
  manifest.stages[stageName].gates![gateName] = {
    status: 'passed',
    agent,
    notes,
    timestamp: now,
  };

  writeRcsdManifest(taskId, manifest, projectRoot);

  return {
    success: true,
    data: {
      taskId,
      gateName,
      status: 'passed',
      timestamp: now,
    },
  };
}

/**
 * lifecycle.gate.fail - Mark gate as failed
 * @task T4785
 */
export function lifecycleGateFail(
  taskId: string,
  gateName: string,
  reason?: string,
  projectRoot?: string,
): EngineResult {
  if (!taskId || !gateName) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'taskId and gateName are required' },
    };
  }

  let manifest = readRcsdManifest(taskId, projectRoot);

  if (!manifest) {
    manifest = { epicId: taskId, stages: {} };
  }

  const stageParts = gateName.split('-');
  const stageName = stageParts[0];

  if (!manifest.stages[stageName]) {
    manifest.stages[stageName] = { status: 'pending' };
  }

  if (!manifest.stages[stageName].gates) {
    manifest.stages[stageName].gates = {};
  }

  const now = new Date().toISOString();
  manifest.stages[stageName].gates![gateName] = {
    status: 'failed',
    reason,
    timestamp: now,
  };

  writeRcsdManifest(taskId, manifest, projectRoot);

  return {
    success: true,
    data: {
      taskId,
      gateName,
      status: 'failed',
      reason,
      timestamp: now,
    },
  };
}
