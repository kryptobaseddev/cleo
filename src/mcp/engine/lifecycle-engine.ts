/**
 * Lifecycle Engine
 *
 * Native TypeScript implementation of lifecycle domain operations.
 * Manages RCSD-IVTR pipeline stages, gate checks, and stage transitions
 * by reading/writing .cleo/rcsd/ data directly.
 *
 * @task T4475
 */

import { existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { resolveProjectRoot, readJsonFile, writeJsonFileAtomic } from './store.js';

/**
 * RCSD-IVTR lifecycle stages in order
 */
export const LIFECYCLE_STAGES = [
  'research',
  'consensus',
  'specification',
  'decomposition',
  'implementation',
  'validation',
  'testing',
  'release',
] as const;

export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

/**
 * Stage status values
 */
export type StageStatus = 'pending' | 'completed' | 'skipped' | 'blocked';

/**
 * Stage info with metadata
 */
export interface StageInfo {
  stage: LifecycleStage;
  name: string;
  description: string;
  order: number;
  optional: boolean;
  pipeline: 'rcsd' | 'ivtr';
}

/**
 * RCSD manifest stored in .cleo/rcsd/{EPIC_ID}/_manifest.json
 */
export interface RcsdManifest {
  epicId: string;
  title?: string;
  stages: Record<string, {
    status: StageStatus;
    completedAt?: string;
    skippedAt?: string;
    skippedReason?: string;
    artifacts?: string[];
    notes?: string;
    gates?: Record<string, {
      status: 'passed' | 'failed' | 'pending';
      agent?: string;
      notes?: string;
      reason?: string;
      timestamp?: string;
    }>;
  }>;
}

/**
 * Engine result type
 */
interface EngineResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

/**
 * Stage definitions with metadata
 */
const STAGE_DEFINITIONS: StageInfo[] = [
  { stage: 'research', name: 'Research', description: 'Information gathering and exploration', order: 1, optional: false, pipeline: 'rcsd' },
  { stage: 'consensus', name: 'Consensus', description: 'Multi-agent decisions and validation', order: 2, optional: true, pipeline: 'rcsd' },
  { stage: 'specification', name: 'Specification', description: 'Document creation and RFC design', order: 3, optional: false, pipeline: 'rcsd' },
  { stage: 'decomposition', name: 'Decomposition', description: 'Task breakdown and planning', order: 4, optional: false, pipeline: 'rcsd' },
  { stage: 'implementation', name: 'Implementation', description: 'Code execution and building', order: 5, optional: false, pipeline: 'ivtr' },
  { stage: 'validation', name: 'Validation', description: 'Validation and quality checks', order: 6, optional: false, pipeline: 'ivtr' },
  { stage: 'testing', name: 'Testing', description: 'Test execution and coverage', order: 7, optional: false, pipeline: 'ivtr' },
  { stage: 'release', name: 'Release', description: 'Version management and publishing', order: 8, optional: true, pipeline: 'ivtr' },
];

/**
 * Prerequisite map: stage -> required prior stages
 */
const PREREQUISITES: Record<string, string[]> = {
  research: [],
  consensus: ['research'],
  specification: ['research'],
  decomposition: ['research', 'specification'],
  implementation: ['research', 'specification', 'decomposition'],
  validation: ['implementation'],
  testing: ['implementation'],
  release: ['implementation', 'validation', 'testing'],
};

/**
 * Get RCSD directory for an epic
 */
function getRcsdDir(epicId: string, projectRoot?: string): string {
  const root = projectRoot || resolveProjectRoot();
  return join(root, '.cleo', 'rcsd', epicId);
}

/**
 * Get RCSD manifest path for an epic
 */
function getRcsdManifestPath(epicId: string, projectRoot?: string): string {
  return join(getRcsdDir(epicId, projectRoot), '_manifest.json');
}

/**
 * Read RCSD manifest for an epic
 */
function readRcsdManifest(epicId: string, projectRoot?: string): RcsdManifest | null {
  const manifestPath = getRcsdManifestPath(epicId, projectRoot);
  return readJsonFile<RcsdManifest>(manifestPath);
}

/**
 * Write RCSD manifest for an epic
 */
function writeRcsdManifest(epicId: string, manifest: RcsdManifest, projectRoot?: string): void {
  const dir = getRcsdDir(epicId, projectRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const manifestPath = getRcsdManifestPath(epicId, projectRoot);
  writeJsonFileAtomic(manifestPath, manifest);
}

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
      .filter((d) => d.isDirectory() && d.name.startsWith('T'))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * lifecycle.check / lifecycle.status - Get lifecycle status for epic
 * @task T4475
 */
export function lifecycleStatus(
  epicId: string,
  projectRoot?: string
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
        stages: LIFECYCLE_STAGES.map((s) => ({
          stage: s,
          status: 'pending' as StageStatus,
        })),
        nextStage: 'research',
        blockedOn: [],
        initialized: false,
      },
    };
  }

  // Build stage progress
  const stages = LIFECYCLE_STAGES.map((s) => {
    const stageData = manifest.stages[s];
    return {
      stage: s,
      status: (stageData?.status || 'pending') as StageStatus,
      completedAt: stageData?.completedAt,
      notes: stageData?.notes,
    };
  });

  // Find current stage (last completed + 1)
  let currentStage: LifecycleStage | null = null;
  let nextStage: LifecycleStage | null = null;

  for (let i = LIFECYCLE_STAGES.length - 1; i >= 0; i--) {
    const s = LIFECYCLE_STAGES[i];
    const status = manifest.stages[s]?.status;
    if (status === 'completed' || status === 'skipped') {
      currentStage = s;
      if (i < LIFECYCLE_STAGES.length - 1) {
        nextStage = LIFECYCLE_STAGES[i + 1];
      }
      break;
    }
  }

  if (!currentStage) {
    nextStage = 'research';
  }

  // Find blockers
  const blockedOn: string[] = [];
  if (nextStage) {
    const prereqs = PREREQUISITES[nextStage] || [];
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
 * @task T4475
 */
export function lifecycleHistory(
  taskId: string,
  projectRoot?: string
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

  // Build history from manifest stages
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

    // Include gate history
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

  // Sort by timestamp
  history.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return {
    success: true,
    data: {
      taskId,
      history,
    },
  };
}

/**
 * lifecycle.gates - Get all gate statuses for an epic
 * @task T4475
 */
export function lifecycleGates(
  taskId: string,
  projectRoot?: string
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

  const gates: Record<string, Record<string, { status: string; agent?: string; notes?: string; reason?: string; timestamp?: string }>> = {};

  for (const [stageName, stageData] of Object.entries(manifest.stages)) {
    if (stageData.gates && Object.keys(stageData.gates).length > 0) {
      gates[stageName] = stageData.gates;
    }
  }

  return {
    success: true,
    data: {
      taskId,
      gates,
    },
  };
}

/**
 * lifecycle.prerequisites - Get required prior stages for a target stage
 * @task T4475
 */
export function lifecyclePrerequisites(
  targetStage: string,
  _projectRoot?: string
): EngineResult {
  if (!targetStage) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'targetStage is required' } };
  }

  if (!LIFECYCLE_STAGES.includes(targetStage as LifecycleStage)) {
    return {
      success: false,
      error: {
        code: 'E_INVALID_STAGE',
        message: `Invalid stage: ${targetStage}. Valid stages: ${LIFECYCLE_STAGES.join(', ')}`,
      },
    };
  }

  const prereqs = PREREQUISITES[targetStage] || [];

  return {
    success: true,
    data: {
      targetStage,
      prerequisites: prereqs,
      stageInfo: STAGE_DEFINITIONS.find((s) => s.stage === targetStage),
    },
  };
}

/**
 * lifecycle.check - Check if a stage's prerequisites are met
 * @task T4475
 */
export function lifecycleCheck(
  epicId: string,
  targetStage: string,
  projectRoot?: string
): EngineResult {
  if (!epicId || !targetStage) {
    return { success: false, error: { code: 'E_INVALID_INPUT', message: 'epicId and targetStage are required' } };
  }

  if (!LIFECYCLE_STAGES.includes(targetStage as LifecycleStage)) {
    return {
      success: false,
      error: {
        code: 'E_INVALID_STAGE',
        message: `Invalid stage: ${targetStage}. Valid stages: ${LIFECYCLE_STAGES.join(', ')}`,
      },
    };
  }

  const manifest = readRcsdManifest(epicId, projectRoot);
  const prereqs = PREREQUISITES[targetStage] || [];

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
 * @task T4475
 */
export function lifecycleProgress(
  taskId: string,
  stage: string,
  status: string,
  notes?: string,
  projectRoot?: string
): EngineResult {
  if (!taskId || !stage || !status) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'taskId, stage, and status are required' },
    };
  }

  if (!LIFECYCLE_STAGES.includes(stage as LifecycleStage)) {
    return {
      success: false,
      error: { code: 'E_INVALID_STAGE', message: `Invalid stage: ${stage}` },
    };
  }

  const validStatuses: StageStatus[] = ['pending', 'completed', 'skipped', 'blocked'];
  if (!validStatuses.includes(status as StageStatus)) {
    return {
      success: false,
      error: { code: 'E_INVALID_STATUS', message: `Invalid status: ${status}. Valid: ${validStatuses.join(', ')}` },
    };
  }

  let manifest = readRcsdManifest(taskId, projectRoot);

  if (!manifest) {
    manifest = {
      epicId: taskId,
      stages: {},
    };
  }

  if (!manifest.stages[stage]) {
    manifest.stages[stage] = { status: 'pending' };
  }

  const now = new Date().toISOString();
  manifest.stages[stage].status = status as StageStatus;

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
 * @task T4475
 */
export function lifecycleSkip(
  taskId: string,
  stage: string,
  reason: string,
  projectRoot?: string
): EngineResult {
  if (!taskId || !stage || !reason) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'taskId, stage, and reason are required' },
    };
  }

  let manifest = readRcsdManifest(taskId, projectRoot);

  if (!manifest) {
    manifest = {
      epicId: taskId,
      stages: {},
    };
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
 * @task T4475
 */
export function lifecycleReset(
  taskId: string,
  stage: string,
  reason: string,
  projectRoot?: string
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
 * @task T4475
 */
export function lifecycleGatePass(
  taskId: string,
  gateName: string,
  agent?: string,
  notes?: string,
  projectRoot?: string
): EngineResult {
  if (!taskId || !gateName) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'taskId and gateName are required' },
    };
  }

  let manifest = readRcsdManifest(taskId, projectRoot);

  if (!manifest) {
    manifest = {
      epicId: taskId,
      stages: {},
    };
  }

  // Determine which stage this gate belongs to (extract from gateName convention)
  // Gates are typically named like "research-complete" or "spec-review"
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
 * @task T4475
 */
export function lifecycleGateFail(
  taskId: string,
  gateName: string,
  reason?: string,
  projectRoot?: string
): EngineResult {
  if (!taskId || !gateName) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'taskId and gateName are required' },
    };
  }

  let manifest = readRcsdManifest(taskId, projectRoot);

  if (!manifest) {
    manifest = {
      epicId: taskId,
      stages: {},
    };
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
