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
