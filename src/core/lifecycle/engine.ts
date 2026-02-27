/**
 * Synchronous lifecycle engine operations.
 *
 * Business logic for lifecycle pipeline operations: status checks,
 * stage progress recording, gate management, and prerequisite validation.
 *
 * These functions use synchronous I/O and are the canonical implementation
 * for the dispatch engine layer. The dispatch/engines/lifecycle-engine.ts
 * file is a thin EngineResult wrapper over these functions.
 *
 * @task T4785
 * @task T4800 - Updated to canonical full-form stage names
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDirAbsolute } from '../paths.js';
import { readJsonFile, writeJsonFileAtomic } from '../../store/file-utils.js';
import { LIFECYCLE_STAGE_STATUSES } from '../../store/schema.js';
import {
  PIPELINE_STAGES,
  STAGE_DEFINITIONS,
  STAGE_PREREQUISITES,
  type Stage,
} from './stages.js';
import type {
  RcasdManifest,
  GateData,
  ManifestStageData,
} from './index.js';

// ============================================================================
// Internal I/O helpers (synchronous)
// ============================================================================

const LIFECYCLE_DATA_DIRS = ['rcasd', 'rcsd'] as const;
const DEFAULT_LIFECYCLE_DATA_DIR = 'rcasd' as const;

function resolveLifecycleDir(epicId: string, cwd?: string): string {
  const cleoDir = getCleoDirAbsolute(cwd);
  for (const dirName of LIFECYCLE_DATA_DIRS) {
    if (existsSync(join(cleoDir, dirName, epicId))) {
      return dirName;
    }
  }
  return DEFAULT_LIFECYCLE_DATA_DIR;
}

function getRcsdDir(epicId: string, cwd?: string): string {
  const cleoDir = getCleoDirAbsolute(cwd);
  const dirName = resolveLifecycleDir(epicId, cwd);
  return join(cleoDir, dirName, epicId);
}

function getRcsdManifestPath(epicId: string, cwd?: string): string {
  return join(getRcsdDir(epicId, cwd), '_manifest.json');
}

function readManifestSync(epicId: string, cwd?: string): RcasdManifest | null {
  return readJsonFile<RcasdManifest>(getRcsdManifestPath(epicId, cwd));
}

function writeManifestSync(epicId: string, manifest: RcasdManifest, cwd?: string): void {
  const dir = getRcsdDir(epicId, cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeJsonFileAtomic(getRcsdManifestPath(epicId, cwd), manifest);
}

// ============================================================================
// Result types
// ============================================================================

/** Status result for a lifecycle query. */
export interface LifecycleStatusResult {
  epicId: string;
  title?: string;
  currentStage: Stage | null;
  stages: Array<{ stage: string; status: string; completedAt?: string; notes?: string }>;
  nextStage: Stage | null;
  blockedOn: string[];
  initialized: boolean;
}

/** History entry for lifecycle transitions. */
export interface LifecycleHistoryEntry {
  stage: string;
  action: string;
  timestamp: string;
  notes?: string;
}

/** Prerequisites result. */
export interface LifecyclePrerequisitesResult {
  targetStage: string;
  prerequisites: string[];
  stageInfo?: { stage: string; name: string; description: string; order: number };
}

/** Check result for stage prerequisites. */
export interface LifecycleCheckResult {
  epicId: string;
  targetStage: string;
  valid: boolean;
  canProgress: boolean;
  missingPrerequisites: string[];
  issues: Array<{ stage: string; severity: string; message: string }>;
}

/** Progress recording result. */
export interface LifecycleProgressResult {
  epicId: string;
  stage: string;
  status: string;
  recorded: boolean;
  timestamp: string;
}

/** Skip result. */
export interface LifecycleSkipResult {
  epicId: string;
  stage: string;
  skipped: boolean;
  reason: string;
  timestamp: string;
}

/** Reset result. */
export interface LifecycleResetResult {
  taskId: string;
  stage: string;
  reset: string;
  reason: string;
  warning: string;
}

/** Gate operation result. */
export interface LifecycleGateResult {
  taskId: string;
  gateName: string;
  status: string;
  reason?: string;
  timestamp: string;
}

// ============================================================================
// Error class for lifecycle operations
// ============================================================================

export class LifecycleEngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LifecycleEngineError';
  }
}

// ============================================================================
// Exported business logic functions
// ============================================================================

/**
 * List all epic IDs that have RCASD pipeline data.
 * @task T4785
 */
export function listRcsdEpics(cwd?: string): string[] {
  try {
    const cleoDir = getCleoDirAbsolute(cwd);
    const taskIds = new Set<string>();

    for (const dirName of LIFECYCLE_DATA_DIRS) {
      const lifecycleDir = join(cleoDir, dirName);
      if (!existsSync(lifecycleDir)) {
        continue;
      }

      for (const entry of readdirSync(lifecycleDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('T')) {
          taskIds.add(entry.name);
        }
      }
    }

    return Array.from(taskIds).sort();
  } catch {
    return [];
  }
}

/**
 * Get lifecycle status for an epic.
 * @task T4785
 */
export function getStatusSync(
  epicId: string,
  cwd?: string,
): LifecycleStatusResult {
  if (!epicId) {
    throw new LifecycleEngineError('E_INVALID_INPUT', 'epicId is required');
  }

  const manifest = readManifestSync(epicId, cwd);

  if (!manifest) {
    return {
      epicId,
      currentStage: null,
      stages: PIPELINE_STAGES.map(s => ({
        stage: s,
        status: 'not_started',
      })),
      nextStage: 'research',
      blockedOn: [],
      initialized: false,
    };
  }

  const stages = PIPELINE_STAGES.map(s => {
    const stageData = manifest.stages[s];
    return {
      stage: s,
      status: stageData?.status || 'not_started',
      completedAt: stageData?.completedAt,
      notes: stageData?.notes,
    };
  });

  let currentStage: Stage | null = null;
  let nextStage: Stage | null = null;

  for (let i = PIPELINE_STAGES.length - 1; i >= 0; i--) {
    const s = PIPELINE_STAGES[i];
    const status = manifest.stages[s]?.status;
    if (status === 'completed' || status === 'skipped') {
      currentStage = s;
      if (i < PIPELINE_STAGES.length - 1) {
        nextStage = PIPELINE_STAGES[i + 1];
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
    epicId,
    title: manifest.title,
    currentStage,
    stages,
    nextStage,
    blockedOn,
    initialized: true,
  };
}

/**
 * Get lifecycle history for an epic.
 * @task T4785
 */
export function getHistorySync(
  taskId: string,
  cwd?: string,
): { taskId: string; history: LifecycleHistoryEntry[] } {
  if (!taskId) {
    throw new LifecycleEngineError('E_INVALID_INPUT', 'taskId is required');
  }

  const manifest = readManifestSync(taskId, cwd);

  if (!manifest) {
    return {
      taskId,
      history: [],
    };
  }

  const history: LifecycleHistoryEntry[] = [];

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

  return { taskId, history };
}

/**
 * Get all gate statuses for an epic.
 * @task T4785
 */
export function getGatesSync(
  taskId: string,
  cwd?: string,
): { taskId: string; gates: Record<string, Record<string, GateData>> } {
  if (!taskId) {
    throw new LifecycleEngineError('E_INVALID_INPUT', 'taskId is required');
  }

  const manifest = readManifestSync(taskId, cwd);

  if (!manifest) {
    return {
      taskId,
      gates: {},
    };
  }

  const gates: Record<string, Record<string, GateData>> = {};

  for (const [stageName, stageData] of Object.entries(manifest.stages)) {
    if (stageData.gates && Object.keys(stageData.gates).length > 0) {
      gates[stageName] = stageData.gates;
    }
  }

  return { taskId, gates };
}

/**
 * Get prerequisites for a target stage.
 * @task T4785
 */
export function getPrerequisitesSync(
  targetStage: string,
): LifecyclePrerequisitesResult {
  if (!targetStage) {
    throw new LifecycleEngineError('E_INVALID_INPUT', 'targetStage is required');
  }

  if (!PIPELINE_STAGES.includes(targetStage as Stage)) {
    throw new LifecycleEngineError(
      'E_INVALID_INPUT',
      `Invalid stage: ${targetStage}. Valid stages: ${PIPELINE_STAGES.join(', ')}`,
    );
  }

  const prereqs = STAGE_PREREQUISITES[targetStage as Stage] || [];
  const def = STAGE_DEFINITIONS[targetStage as Stage];

  return {
    targetStage,
    prerequisites: prereqs,
    stageInfo: def ? { stage: def.stage, name: def.name, description: def.description, order: def.order } : undefined,
  };
}

/**
 * Check if a stage's prerequisites are met for an epic.
 * @task T4785
 */
export function checkPrerequisitesSync(
  epicId: string,
  targetStage: string,
  cwd?: string,
): LifecycleCheckResult {
  if (!epicId || !targetStage) {
    throw new LifecycleEngineError('E_INVALID_INPUT', 'epicId and targetStage are required');
  }

  if (!PIPELINE_STAGES.includes(targetStage as Stage)) {
    throw new LifecycleEngineError(
      'E_INVALID_INPUT',
      `Invalid stage: ${targetStage}. Valid stages: ${PIPELINE_STAGES.join(', ')}`,
    );
  }

  const manifest = readManifestSync(epicId, cwd);
  const prereqs = STAGE_PREREQUISITES[targetStage as Stage] || [];

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
    epicId,
    targetStage,
    valid: missingPrerequisites.length === 0,
    canProgress: missingPrerequisites.length === 0,
    missingPrerequisites,
    issues,
  };
}

/**
 * Record stage progress/completion.
 * @task T4785
 */
export function recordProgressSync(
  taskId: string,
  stage: string,
  status: string,
  notes?: string,
  cwd?: string,
): LifecycleProgressResult {
  if (!taskId || !stage || !status) {
    throw new LifecycleEngineError('E_INVALID_INPUT', 'taskId, stage, and status are required');
  }

  if (!PIPELINE_STAGES.includes(stage as Stage)) {
    throw new LifecycleEngineError('E_INVALID_INPUT', `Invalid stage: ${stage}`);
  }

  const validStatuses = [...LIFECYCLE_STAGE_STATUSES];
  if (!validStatuses.includes(status as (typeof LIFECYCLE_STAGE_STATUSES)[number])) {
    throw new LifecycleEngineError('E_VALIDATION', `Invalid status: ${status}. Valid: ${validStatuses.join(', ')}`);
  }

  let manifest = readManifestSync(taskId, cwd);

  if (!manifest) {
    manifest = { epicId: taskId, stages: {} };
  }

  if (!manifest.stages[stage]) {
    manifest.stages[stage] = { status: 'not_started' };
  }

  const now = new Date().toISOString();
  manifest.stages[stage].status = status as ManifestStageData['status'];

  if (status === 'completed') {
    manifest.stages[stage].completedAt = now;
  }

  if (notes) {
    manifest.stages[stage].notes = notes;
  }

  writeManifestSync(taskId, manifest, cwd);

  return {
    epicId: taskId,
    stage,
    status,
    recorded: true,
    timestamp: now,
  };
}

/**
 * Skip a stage with reason.
 * @task T4785
 */
export function skipStageSync(
  taskId: string,
  stage: string,
  reason: string,
  cwd?: string,
): LifecycleSkipResult {
  if (!taskId || !stage || !reason) {
    throw new LifecycleEngineError('E_INVALID_INPUT', 'taskId, stage, and reason are required');
  }

  let manifest = readManifestSync(taskId, cwd);

  if (!manifest) {
    manifest = { epicId: taskId, stages: {} };
  }

  if (!manifest.stages[stage]) {
    manifest.stages[stage] = { status: 'not_started' };
  }

  const now = new Date().toISOString();
  manifest.stages[stage].status = 'skipped';
  manifest.stages[stage].skippedAt = now;
  manifest.stages[stage].skippedReason = reason;

  writeManifestSync(taskId, manifest, cwd);

  return {
    epicId: taskId,
    stage,
    skipped: true,
    reason,
    timestamp: now,
  };
}

/**
 * Reset a stage to pending (emergency).
 * @task T4785
 */
export function resetStageSync(
  taskId: string,
  stage: string,
  reason: string,
  cwd?: string,
): LifecycleResetResult {
  if (!taskId || !stage || !reason) {
    throw new LifecycleEngineError('E_INVALID_INPUT', 'taskId, stage, and reason are required');
  }

  const manifest = readManifestSync(taskId, cwd);

  if (!manifest) {
    throw new LifecycleEngineError('E_NOT_FOUND', `No lifecycle data found for ${taskId}`);
  }

  if (!manifest.stages[stage]) {
    throw new LifecycleEngineError('E_NOT_FOUND', `Stage '${stage}' not found for ${taskId}`);
  }

  manifest.stages[stage] = {
    status: 'not_started',
    notes: `Reset: ${reason}`,
  };

  writeManifestSync(taskId, manifest, cwd);

  return {
    taskId,
    stage,
    reset: 'pending',
    reason,
    warning: 'Stage has been reset to pending. Previous data was cleared.',
  };
}

/**
 * Mark a gate as passed.
 * @task T4785
 */
export function passGateSync(
  taskId: string,
  gateName: string,
  agent?: string,
  notes?: string,
  cwd?: string,
): LifecycleGateResult {
  if (!taskId || !gateName) {
    throw new LifecycleEngineError('E_INVALID_INPUT', 'taskId and gateName are required');
  }

  let manifest = readManifestSync(taskId, cwd);

  if (!manifest) {
    manifest = { epicId: taskId, stages: {} };
  }

  const stageParts = gateName.split('-');
  const stageName = stageParts[0];

  if (!manifest.stages[stageName]) {
    manifest.stages[stageName] = { status: 'not_started' };
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

  writeManifestSync(taskId, manifest, cwd);

  return {
    taskId,
    gateName,
    status: 'passed',
    timestamp: now,
  };
}

/**
 * Mark a gate as failed.
 * @task T4785
 */
export function failGateSync(
  taskId: string,
  gateName: string,
  reason?: string,
  cwd?: string,
): LifecycleGateResult {
  if (!taskId || !gateName) {
    throw new LifecycleEngineError('E_INVALID_INPUT', 'taskId and gateName are required');
  }

  let manifest = readManifestSync(taskId, cwd);

  if (!manifest) {
    manifest = { epicId: taskId, stages: {} };
  }

  const stageParts = gateName.split('-');
  const stageName = stageParts[0];

  if (!manifest.stages[stageName]) {
    manifest.stages[stageName] = { status: 'not_started' };
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

  writeManifestSync(taskId, manifest, cwd);

  return {
    taskId,
    gateName,
    status: 'failed',
    reason,
    timestamp: now,
  };
}
