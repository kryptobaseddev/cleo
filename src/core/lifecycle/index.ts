/**
 * RCSD pipeline lifecycle - stage transitions and gate enforcement.
 * @task T4467
 * @epic T4454
 */

import { readJson, saveJson } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getCleoDirAbsolute, getBackupDir } from '../paths.js';
import { join } from 'node:path';

/** RCSD pipeline stages in order. */
export const RCSD_STAGES = ['research', 'consensus', 'specification', 'decomposition'] as const;
export type RcsdStage = typeof RCSD_STAGES[number];

/** Execution stages. */
export const EXECUTION_STAGES = ['implementation', 'contribution', 'release'] as const;
export type ExecutionStage = typeof EXECUTION_STAGES[number];

/** All lifecycle stages. */
export type LifecycleStage = RcsdStage | ExecutionStage;

/** Stage status values. */
export type StageStatus = 'not_started' | 'in_progress' | 'completed' | 'skipped';

/** RCSD manifest for an epic. */
export interface RcsdManifest {
  epicId: string;
  createdAt: string;
  updatedAt: string;
  stages: Record<LifecycleStage, {
    status: StageStatus;
    startedAt?: string;
    completedAt?: string;
    artifacts?: string[];
  }>;
}

/** Lifecycle enforcement modes. */
export type EnforcementMode = 'strict' | 'advisory' | 'off';

/** Gate check result. */
export interface GateCheckResult {
  allowed: boolean;
  mode: EnforcementMode;
  missingPrerequisites: string[];
  currentStage: LifecycleStage;
  message: string;
}

/** Stage transition result. */
export interface StageTransitionResult {
  epicId: string;
  stage: LifecycleStage;
  previousStatus: StageStatus;
  newStatus: StageStatus;
  timestamp: string;
}

/**
 * Get RCSD manifest path for an epic.
 * @task T4467
 */
function getRcsdPath(epicId: string, cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'rcsd', epicId, '_manifest.json');
}

/**
 * Read or initialize RCSD manifest for an epic.
 * @task T4467
 */
async function readRcsdManifest(epicId: string, cwd?: string): Promise<RcsdManifest> {
  const path = getRcsdPath(epicId, cwd);
  const existing = await readJson<RcsdManifest>(path);
  if (existing) return existing;

  // Initialize new manifest
  const now = new Date().toISOString();
  const allStages = [...RCSD_STAGES, ...EXECUTION_STAGES] as const;
  const stages: RcsdManifest['stages'] = {} as RcsdManifest['stages'];

  for (const stage of allStages) {
    stages[stage] = { status: 'not_started' };
  }

  return {
    epicId,
    createdAt: now,
    updatedAt: now,
    stages,
  };
}

/**
 * Save RCSD manifest.
 * @task T4467
 */
async function saveRcsdManifest(manifest: RcsdManifest, cwd?: string): Promise<void> {
  const path = getRcsdPath(manifest.epicId, cwd);
  manifest.updatedAt = new Date().toISOString();
  await saveJson(path, manifest, { backupDir: getBackupDir(cwd) });
}

/**
 * Get the current lifecycle state for an epic.
 * @task T4467
 */
export async function getLifecycleState(
  epicId: string,
  cwd?: string,
): Promise<RcsdManifest> {
  return readRcsdManifest(epicId, cwd);
}

/**
 * Start a lifecycle stage.
 * @task T4467
 */
export async function startStage(
  epicId: string,
  stage: LifecycleStage,
  cwd?: string,
): Promise<StageTransitionResult> {
  const manifest = await readRcsdManifest(epicId, cwd);

  // Gate check
  const gateResult = await checkGate(epicId, stage, cwd);
  if (!gateResult.allowed) {
    throw new CleoError(
      ExitCode.LIFECYCLE_GATE_FAILED,
      gateResult.message,
    );
  }

  const stageData = manifest.stages[stage];
  if (!stageData) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Unknown stage: ${stage}`);
  }

  const previousStatus = stageData.status;
  if (previousStatus === 'completed') {
    throw new CleoError(
      ExitCode.LIFECYCLE_TRANSITION_INVALID,
      `Stage '${stage}' is already completed`,
    );
  }

  const now = new Date().toISOString();
  stageData.status = 'in_progress';
  stageData.startedAt = now;

  await saveRcsdManifest(manifest, cwd);

  return {
    epicId,
    stage,
    previousStatus,
    newStatus: 'in_progress',
    timestamp: now,
  };
}

/**
 * Complete a lifecycle stage.
 * @task T4467
 */
export async function completeStage(
  epicId: string,
  stage: LifecycleStage,
  artifacts?: string[],
  cwd?: string,
): Promise<StageTransitionResult> {
  const manifest = await readRcsdManifest(epicId, cwd);
  const stageData = manifest.stages[stage];

  if (!stageData) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Unknown stage: ${stage}`);
  }

  const previousStatus = stageData.status;
  if (previousStatus !== 'in_progress' && previousStatus !== 'not_started') {
    throw new CleoError(
      ExitCode.LIFECYCLE_TRANSITION_INVALID,
      `Cannot complete stage '${stage}' from status '${previousStatus}'`,
    );
  }

  const now = new Date().toISOString();
  stageData.status = 'completed';
  stageData.completedAt = now;
  if (artifacts?.length) {
    stageData.artifacts = artifacts;
  }

  await saveRcsdManifest(manifest, cwd);

  return {
    epicId,
    stage,
    previousStatus,
    newStatus: 'completed',
    timestamp: now,
  };
}

/**
 * Skip a lifecycle stage.
 * @task T4467
 */
export async function skipStage(
  epicId: string,
  stage: LifecycleStage,
  _reason: string,
  cwd?: string,
): Promise<StageTransitionResult> {
  const manifest = await readRcsdManifest(epicId, cwd);
  const stageData = manifest.stages[stage];

  if (!stageData) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Unknown stage: ${stage}`);
  }

  const previousStatus = stageData.status;
  if (previousStatus === 'completed') {
    throw new CleoError(
      ExitCode.LIFECYCLE_TRANSITION_INVALID,
      `Cannot skip stage '${stage}' - already completed`,
    );
  }

  const now = new Date().toISOString();
  stageData.status = 'skipped';

  await saveRcsdManifest(manifest, cwd);

  return {
    epicId,
    stage,
    previousStatus,
    newStatus: 'skipped',
    timestamp: now,
  };
}

/**
 * Check lifecycle gate before starting a stage.
 * @task T4467
 */
export async function checkGate(
  epicId: string,
  targetStage: LifecycleStage,
  cwd?: string,
): Promise<GateCheckResult> {
  // Get enforcement mode from config
  const mode = await getEnforcementMode(cwd);

  if (mode === 'off') {
    return {
      allowed: true,
      mode,
      missingPrerequisites: [],
      currentStage: targetStage,
      message: 'Gate check disabled',
    };
  }

  const manifest = await readRcsdManifest(epicId, cwd);
  const allStages = [...RCSD_STAGES, ...EXECUTION_STAGES] as LifecycleStage[];
  const targetIndex = allStages.indexOf(targetStage);

  if (targetIndex === -1) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Unknown stage: ${targetStage}`);
  }

  // Check all prior stages are completed or skipped
  const missing: string[] = [];
  for (let i = 0; i < targetIndex; i++) {
    const stage = allStages[i]!;
    const status = manifest.stages[stage]?.status ?? 'not_started';
    if (status !== 'completed' && status !== 'skipped') {
      missing.push(stage);
    }
  }

  const allowed = mode === 'advisory' || missing.length === 0;
  const message = missing.length > 0
    ? `SPAWN BLOCKED: Lifecycle prerequisites not met. Missing: ${missing.join(', ')}`
    : 'All prerequisites met';

  return {
    allowed,
    mode,
    missingPrerequisites: missing,
    currentStage: targetStage,
    message,
  };
}

/**
 * Get lifecycle enforcement mode from config.
 * @task T4467
 */
async function getEnforcementMode(cwd?: string): Promise<EnforcementMode> {
  // Check environment variable first
  const envMode = process.env['LIFECYCLE_ENFORCEMENT_MODE'];
  if (envMode && ['strict', 'advisory', 'off'].includes(envMode)) {
    return envMode as EnforcementMode;
  }

  // Read from config
  try {
    const configPath = join(getCleoDirAbsolute(cwd), 'config.json');
    const config = await readJson<{ lifecycleEnforcement?: { mode?: string } }>(configPath);
    const mode = config?.lifecycleEnforcement?.mode;
    if (mode && ['strict', 'advisory', 'off'].includes(mode)) {
      return mode as EnforcementMode;
    }
  } catch {
    // Config may not exist
  }

  return 'strict';
}

// ============================================================================
// Engine-compatible lifecycle stages (superset including validation/testing)
// These are used by the MCP engine layer for RCSD-IVTR pipeline support.
// ============================================================================

/** Full RCSD-IVTR stage list used by the engine layer. */
export const ENGINE_LIFECYCLE_STAGES = [
  'research', 'consensus', 'specification', 'decomposition',
  'implementation', 'validation', 'testing', 'release',
] as const;

export type EngineLifecycleStage = (typeof ENGINE_LIFECYCLE_STAGES)[number];

/** Engine-compatible stage status (includes 'pending' and 'blocked'). */
export type EngineStageStatus = 'pending' | 'completed' | 'skipped' | 'blocked';

/** Gate data within a stage. */
export interface GateData {
  status: 'passed' | 'failed' | 'pending';
  agent?: string;
  notes?: string;
  reason?: string;
  timestamp?: string;
}

/** Engine-compatible stage data with extended fields. */
export interface EngineStageData {
  status: EngineStageStatus;
  completedAt?: string;
  skippedAt?: string;
  skippedReason?: string;
  artifacts?: string[];
  notes?: string;
  gates?: Record<string, GateData>;
}

/** Engine-compatible RCSD manifest with extended fields. */
export interface EngineRcsdManifest {
  epicId: string;
  title?: string;
  stages: Record<string, EngineStageData>;
}

/** Stage definition with metadata. */
export interface StageInfo {
  stage: EngineLifecycleStage;
  name: string;
  description: string;
  order: number;
  optional: boolean;
  pipeline: 'rcsd' | 'ivtr';
}

/** Stage definitions with metadata. */
export const STAGE_DEFINITIONS: StageInfo[] = [
  { stage: 'research', name: 'Research', description: 'Information gathering and exploration', order: 1, optional: false, pipeline: 'rcsd' },
  { stage: 'consensus', name: 'Consensus', description: 'Multi-agent decisions and validation', order: 2, optional: true, pipeline: 'rcsd' },
  { stage: 'specification', name: 'Specification', description: 'Document creation and RFC design', order: 3, optional: false, pipeline: 'rcsd' },
  { stage: 'decomposition', name: 'Decomposition', description: 'Task breakdown and planning', order: 4, optional: false, pipeline: 'rcsd' },
  { stage: 'implementation', name: 'Implementation', description: 'Code execution and building', order: 5, optional: false, pipeline: 'ivtr' },
  { stage: 'validation', name: 'Validation', description: 'Validation and quality checks', order: 6, optional: false, pipeline: 'ivtr' },
  { stage: 'testing', name: 'Testing', description: 'Test execution and coverage', order: 7, optional: false, pipeline: 'ivtr' },
  { stage: 'release', name: 'Release', description: 'Version management and publishing', order: 8, optional: true, pipeline: 'ivtr' },
];

/** Prerequisite map: stage -> required prior stages. */
export const STAGE_PREREQUISITES: Record<string, string[]> = {
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
 * Read engine-compatible RCSD manifest (returns null if no data exists).
 * @task T4785
 */
async function readEngineManifest(epicId: string, cwd?: string): Promise<EngineRcsdManifest | null> {
  const path = join(getCleoDirAbsolute(cwd), 'rcsd', epicId, '_manifest.json');
  return readJson<EngineRcsdManifest>(path);
}

/**
 * Save engine-compatible RCSD manifest.
 * @task T4785
 */
async function saveEngineManifest(epicId: string, manifest: EngineRcsdManifest, cwd?: string): Promise<void> {
  const path = join(getCleoDirAbsolute(cwd), 'rcsd', epicId, '_manifest.json');
  await saveJson(path, manifest, { backupDir: getBackupDir(cwd) });
}

/**
 * Get lifecycle status for an epic (engine-compatible format).
 * Returns stage progress, current/next stage, and blockers.
 * @task T4785
 */
export async function getLifecycleStatus(
  epicId: string,
  cwd?: string,
): Promise<{
  epicId: string;
  title?: string;
  currentStage: EngineLifecycleStage | null;
  stages: Array<{ stage: string; status: EngineStageStatus; completedAt?: string; notes?: string }>;
  nextStage: EngineLifecycleStage | null;
  blockedOn: string[];
  initialized: boolean;
}> {
  const manifest = await readEngineManifest(epicId, cwd);

  if (!manifest) {
    return {
      epicId,
      currentStage: null,
      stages: ENGINE_LIFECYCLE_STAGES.map(s => ({ stage: s, status: 'pending' as EngineStageStatus })),
      nextStage: 'research',
      blockedOn: [],
      initialized: false,
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
    epicId,
    title: manifest.title,
    currentStage,
    stages,
    nextStage,
    blockedOn,
    initialized: true,
  };
}

/** History entry for stage transitions. */
export interface LifecycleHistoryEntry {
  stage: string;
  action: string;
  timestamp: string;
  notes?: string;
}

/**
 * Get lifecycle history for an epic.
 * Returns stage transitions and gate events sorted by timestamp.
 * @task T4785
 */
export async function getLifecycleHistory(
  epicId: string,
  cwd?: string,
): Promise<{ epicId: string; history: LifecycleHistoryEntry[] }> {
  const manifest = await readEngineManifest(epicId, cwd);

  if (!manifest) {
    return { epicId, history: [] };
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

  return { epicId, history };
}

/**
 * Get all gate statuses for an epic.
 * @task T4785
 */
export async function getLifecycleGates(
  epicId: string,
  cwd?: string,
): Promise<Record<string, Record<string, GateData>>> {
  const manifest = await readEngineManifest(epicId, cwd);

  if (!manifest) {
    return {};
  }

  const gates: Record<string, Record<string, GateData>> = {};
  for (const [stageName, stageData] of Object.entries(manifest.stages)) {
    if (stageData.gates && Object.keys(stageData.gates).length > 0) {
      gates[stageName] = stageData.gates;
    }
  }

  return gates;
}

/**
 * Get prerequisites for a target stage.
 * Pure data function, no I/O.
 * @task T4785
 */
export function getStagePrerequisites(targetStage: string): {
  prerequisites: string[];
  stageInfo: StageInfo | undefined;
} {
  if (!ENGINE_LIFECYCLE_STAGES.includes(targetStage as EngineLifecycleStage)) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      `Invalid stage: ${targetStage}. Valid stages: ${ENGINE_LIFECYCLE_STAGES.join(', ')}`,
    );
  }

  return {
    prerequisites: STAGE_PREREQUISITES[targetStage] || [],
    stageInfo: STAGE_DEFINITIONS.find(s => s.stage === targetStage),
  };
}

/**
 * Check if a stage's prerequisites are met for an epic.
 * @task T4785
 */
export async function checkStagePrerequisites(
  epicId: string,
  targetStage: string,
  cwd?: string,
): Promise<{
  epicId: string;
  targetStage: string;
  valid: boolean;
  canProgress: boolean;
  missingPrerequisites: string[];
  issues: Array<{ stage: string; severity: string; message: string }>;
}> {
  if (!ENGINE_LIFECYCLE_STAGES.includes(targetStage as EngineLifecycleStage)) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      `Invalid stage: ${targetStage}. Valid stages: ${ENGINE_LIFECYCLE_STAGES.join(', ')}`,
    );
  }

  const manifest = await readEngineManifest(epicId, cwd);
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
    epicId,
    targetStage,
    valid: missingPrerequisites.length === 0,
    canProgress: missingPrerequisites.length === 0,
    missingPrerequisites,
    issues,
  };
}

/**
 * Record a stage status transition (progress/record).
 * @task T4785
 */
export async function recordStageProgress(
  epicId: string,
  stage: string,
  status: string,
  notes?: string,
  cwd?: string,
): Promise<{ epicId: string; stage: string; status: string; timestamp: string }> {
  if (!ENGINE_LIFECYCLE_STAGES.includes(stage as EngineLifecycleStage)) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Invalid stage: ${stage}`);
  }

  const validStatuses: EngineStageStatus[] = ['pending', 'completed', 'skipped', 'blocked'];
  if (!validStatuses.includes(status as EngineStageStatus)) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      `Invalid status: ${status}. Valid: ${validStatuses.join(', ')}`,
    );
  }

  let manifest = await readEngineManifest(epicId, cwd);
  if (!manifest) {
    manifest = { epicId, stages: {} };
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

  await saveEngineManifest(epicId, manifest, cwd);

  return { epicId, stage, status, timestamp: now };
}

/**
 * Skip a stage with a reason (engine-compatible).
 * @task T4785
 */
export async function skipStageWithReason(
  epicId: string,
  stage: string,
  reason: string,
  cwd?: string,
): Promise<{ epicId: string; stage: string; reason: string; timestamp: string }> {
  let manifest = await readEngineManifest(epicId, cwd);
  if (!manifest) {
    manifest = { epicId, stages: {} };
  }

  if (!manifest.stages[stage]) {
    manifest.stages[stage] = { status: 'pending' };
  }

  const now = new Date().toISOString();
  manifest.stages[stage].status = 'skipped';
  manifest.stages[stage].skippedAt = now;
  manifest.stages[stage].skippedReason = reason;

  await saveEngineManifest(epicId, manifest, cwd);

  return { epicId, stage, reason, timestamp: now };
}

/**
 * Reset a stage to pending (emergency).
 * @task T4785
 */
export async function resetStage(
  epicId: string,
  stage: string,
  reason: string,
  cwd?: string,
): Promise<{ epicId: string; stage: string; reason: string }> {
  const manifest = await readEngineManifest(epicId, cwd);

  if (!manifest) {
    throw new CleoError(ExitCode.NOT_FOUND, `No lifecycle data found for ${epicId}`);
  }

  if (!manifest.stages[stage]) {
    throw new CleoError(ExitCode.NOT_FOUND, `Stage '${stage}' not found for ${epicId}`);
  }

  manifest.stages[stage] = {
    status: 'pending',
    notes: `Reset: ${reason}`,
  };

  await saveEngineManifest(epicId, manifest, cwd);

  return { epicId, stage, reason };
}

/**
 * Mark a gate as passed.
 * @task T4785
 */
export async function passGate(
  epicId: string,
  gateName: string,
  agent?: string,
  notes?: string,
  cwd?: string,
): Promise<{ epicId: string; gateName: string; timestamp: string }> {
  let manifest = await readEngineManifest(epicId, cwd);
  if (!manifest) {
    manifest = { epicId, stages: {} };
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

  await saveEngineManifest(epicId, manifest, cwd);

  return { epicId, gateName, timestamp: now };
}

/**
 * Mark a gate as failed.
 * @task T4785
 */
export async function failGate(
  epicId: string,
  gateName: string,
  reason?: string,
  cwd?: string,
): Promise<{ epicId: string; gateName: string; reason?: string; timestamp: string }> {
  let manifest = await readEngineManifest(epicId, cwd);
  if (!manifest) {
    manifest = { epicId, stages: {} };
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

  await saveEngineManifest(epicId, manifest, cwd);

  return { epicId, gateName, reason, timestamp: now };
}

/**
 * List all epic IDs that have RCSD data.
 * @task T4785
 */
export async function listEpicsWithLifecycle(cwd?: string): Promise<string[]> {
  const rcsdDir = join(getCleoDirAbsolute(cwd), 'rcsd');
  try {
    const { readdirSync, existsSync } = await import('node:fs');
    if (!existsSync(rcsdDir)) {
      return [];
    }
    return readdirSync(rcsdDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('T'))
      .map(d => d.name);
  } catch {
    return [];
  }
}
