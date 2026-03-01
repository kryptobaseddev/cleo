/**
 * RCASD-IVTR pipeline lifecycle - stage transitions and gate enforcement.
 *
 * CANONICAL EXPORTS: `stages.ts` is the single source of truth for stage
 * definitions, ordering, prerequisites, and transition rules. This file
 * re-exports canonical types and provides JSON manifest I/O for on-disk
 * `.cleo/rcasd/<epicId>/_manifest.json` (canonical) and legacy
 * `.cleo/rcasd/<epicId>/_manifest.json` files (canonical) and legacy
 * `.cleo/rcsd/<epicId>/_manifest.json` files.
 *
 * @task T4467
 * @task T4800 - Unified lifecycle barrel export
 * @task T4798 - RCASD rename (Phase 1: code-only, no disk paths)
 * @epic T4454
 */

import { readJson, saveJson } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getCleoDirAbsolute, getBackupDir } from '../paths.js';
import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { LIFECYCLE_STAGE_STATUSES } from '../../store/schema.js';
import { syncManifestToDb, syncGateToDb } from './sync.js';

// =============================================================================
// CANONICAL RE-EXPORTS from stages.ts (single source of truth)
// =============================================================================

export {
  PIPELINE_STAGES,
  CONTRIBUTION_STAGE,
  type Stage,
  type StageStatus,
  type StageCategory,
  type StageDefinition,
  STAGE_DEFINITIONS as CANONICAL_STAGE_DEFINITIONS,
  STAGE_PREREQUISITES as CANONICAL_PREREQUISITES,
  STAGE_ORDER,
  STAGE_COUNT,
  FIRST_STAGE,
  LAST_STAGE,
  PLANNING_STAGES,
  DECISION_STAGES,
  EXECUTION_STAGES,
  VALIDATION_STAGES,
  DELIVERY_STAGES,
  getStageOrder,
  getPrerequisites,
  isPrerequisite,
  getDependents,
  checkTransition,
  validateStage,
  isValidStage,
  isValidStageStatus,
  getNextStage,
  getPreviousStage,
  getStagesBetween,
  isStageBefore,
  isStageAfter,
  getStagesByCategory,
  getSkippableStages,
} from './stages.js';

import { PIPELINE_STAGES } from './stages.js';
import type { Stage } from './stages.js';

// =============================================================================
// MANIFEST TYPES (canonical on-disk format with legacy path compatibility)
// =============================================================================

/** Lifecycle enforcement modes. */
export type EnforcementMode = 'strict' | 'advisory' | 'off';

/** Gate data within a stage. */
export interface GateData {
  status: 'passed' | 'failed' | 'pending';
  agent?: string;
  notes?: string;
  reason?: string;
  timestamp?: string;
}

/** Stage data in an on-disk manifest. */
export interface ManifestStageData {
  status: typeof LIFECYCLE_STAGE_STATUSES[number];
  completedAt?: string;
  skippedAt?: string;
  skippedReason?: string;
  artifacts?: string[];
  notes?: string;
  gates?: Record<string, GateData>;
}

/**
 * Canonical RCASD manifest interface for on-disk pipeline data.
 * Used by lifecycle-engine.ts and rcasd-index.ts for `.cleo/rcasd/` manifests
 * with fallback support for legacy `.cleo/rcsd/` manifests.
 *
 * Stage keys use full canonical names matching the DB CHECK constraint:
 * research, consensus, architecture_decision, specification, decomposition,
 * implementation, validation, testing, release.
 *
 * @task T4798
 */
export interface RcasdManifest {
  epicId: string;
  title?: string;
  stages: Record<string, ManifestStageData>;
}

/** Gate check result. */
export interface GateCheckResult {
  allowed: boolean;
  mode: EnforcementMode;
  missingPrerequisites: string[];
  currentStage: string;
  message: string;
}

/** Stage transition result. */
export interface StageTransitionResult {
  epicId: string;
  stage: string;
  previousStatus: string;
  newStatus: string;
  timestamp: string;
}

// =============================================================================
// ON-DISK MANIFEST I/O (.cleo/rcasd/ + legacy .cleo/rcsd/ JSON files)
// =============================================================================

const LIFECYCLE_DATA_DIRS = ['rcasd', 'rcsd'] as const;
const DEFAULT_LIFECYCLE_DATA_DIR = 'rcasd' as const;

function getManifestReadPath(epicId: string, cwd?: string): string | null {
  const cleoDir = getCleoDirAbsolute(cwd);
  for (const dirName of LIFECYCLE_DATA_DIRS) {
    const path = join(cleoDir, dirName, epicId, '_manifest.json');
    if (existsSync(path)) {
      return path;
    }
  }
  return null;
}

function getManifestWritePath(epicId: string, cwd?: string): string {
  const cleoDir = getCleoDirAbsolute(cwd);
  for (const dirName of LIFECYCLE_DATA_DIRS) {
    if (existsSync(join(cleoDir, dirName, epicId))) {
      return join(cleoDir, dirName, epicId, '_manifest.json');
    }
  }
  return join(cleoDir, DEFAULT_LIFECYCLE_DATA_DIR, epicId, '_manifest.json');
}

/**
 * Get lifecycle manifest path for an epic.
 * @task T4467
 */
function getRcsdPath(epicId: string, cwd?: string): string {
  return getManifestWritePath(epicId, cwd);
}

/**
 * Read or initialize lifecycle manifest for an epic.
 * On-disk manifests use full-form stage names (matching DB schema).
 * @task T4467
 */
async function readRcsdManifest(epicId: string, cwd?: string): Promise<RcasdManifest> {
  const path = getManifestReadPath(epicId, cwd) ?? getRcsdPath(epicId, cwd);
  const existing = await readJson<RcasdManifest>(path);
  if (existing) return existing;

  // Initialize new manifest with all 9 pipeline stages
  const stages: RcasdManifest['stages'] = {};

  for (const stage of PIPELINE_STAGES) {
    stages[stage] = { status: 'not_started' };
  }

  return {
    epicId,
    stages,
  };
}

/**
 * Save lifecycle manifest.
 * @task T4467
 */
async function saveRcsdManifest(manifest: RcasdManifest, cwd?: string): Promise<void> {
  const path = getRcsdPath(manifest.epicId, cwd);
  await saveJson(path, manifest, { backupDir: getBackupDir(cwd) });
  // Dual-write: mirror to SQLite (best-effort)
  try {
    await syncManifestToDb(manifest.epicId, cwd);
  } catch (err) {
    console.warn(`[lifecycle] SQLite sync failed for ${manifest.epicId}: ${err}`);
  }
}

/**
 * Get the current lifecycle state for an epic.
 * @task T4467
 */
export async function getLifecycleState(
  epicId: string,
  cwd?: string,
): Promise<RcasdManifest> {
  return readRcsdManifest(epicId, cwd);
}

/**
 * Start a lifecycle stage.
 * @task T4467
 */
export async function startStage(
  epicId: string,
  stage: string,
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
  stageData.status = 'completed';

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
 * Complete a lifecycle stage.
 * @task T4467
 */
export async function completeStage(
  epicId: string,
  stage: string,
  artifacts?: string[],
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
  stage: string,
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
  targetStage: string,
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
  const targetIndex = PIPELINE_STAGES.indexOf(targetStage as Stage);

  if (targetIndex === -1) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Unknown stage: ${targetStage}`);
  }

  // Check all prior stages are completed or skipped
  const missing: string[] = [];
  for (let i = 0; i < targetIndex; i++) {
    const stage = PIPELINE_STAGES[i]!;
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
// ENGINE-COMPATIBLE LIFECYCLE STATUS (reads on-disk manifests)
// ============================================================================

/**
 * Read engine-compatible RCASD manifest (returns null if no data exists).
 * @task T4785
 */
async function readEngineManifest(epicId: string, cwd?: string): Promise<RcasdManifest | null> {
  const path = getManifestReadPath(epicId, cwd);
  if (!path) {
    return null;
  }
  return readJson<RcasdManifest>(path);
}

/**
 * Save engine-compatible RCASD manifest.
 * @task T4785
 */
async function saveEngineManifest(epicId: string, manifest: RcasdManifest, cwd?: string): Promise<void> {
  const path = getManifestWritePath(epicId, cwd);
  await saveJson(path, manifest, { backupDir: getBackupDir(cwd) });
  // Dual-write: mirror to SQLite (best-effort)
  try {
    await syncManifestToDb(epicId, cwd);
  } catch (err) {
    console.warn(`[lifecycle] SQLite sync failed for ${epicId}: ${err}`);
  }
}

/**
 * Get lifecycle status for an epic (on-disk manifest format).
 * Returns stage progress, current/next stage, and blockers.
 * @task T4785
 */
export async function getLifecycleStatus(
  epicId: string,
  cwd?: string,
): Promise<{
  epicId: string;
  title?: string;
  currentStage: Stage | null;
  stages: Array<{ stage: string; status: string; completedAt?: string; notes?: string }>;
  nextStage: Stage | null;
  blockedOn: string[];
  initialized: boolean;
}> {
  const manifest = await readEngineManifest(epicId, cwd);

  if (!manifest) {
    return {
      epicId,
      currentStage: null,
      stages: PIPELINE_STAGES.map(s => ({ stage: s, status: 'not_started' })),
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
    const { STAGE_PREREQUISITES: prereqMap } = await import('./stages.js');
    const prereqs = prereqMap[nextStage] || [];
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
  stageInfo: { stage: string; name: string; description: string; order: number } | undefined;
} {
  if (!PIPELINE_STAGES.includes(targetStage as Stage)) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      `Invalid stage: ${targetStage}. Valid stages: ${PIPELINE_STAGES.join(', ')}`,
    );
  }

  // Use dynamic import to avoid circular reference at module level
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { STAGE_DEFINITIONS, STAGE_PREREQUISITES } = require('./stages.js');
  const def = STAGE_DEFINITIONS[targetStage as Stage];
  return {
    prerequisites: STAGE_PREREQUISITES[targetStage as Stage] || [],
    stageInfo: def ? { stage: def.stage, name: def.name, description: def.description, order: def.order } : undefined,
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
  if (!PIPELINE_STAGES.includes(targetStage as Stage)) {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      `Invalid stage: ${targetStage}. Valid stages: ${PIPELINE_STAGES.join(', ')}`,
    );
  }

  const manifest = await readEngineManifest(epicId, cwd);
  const { STAGE_PREREQUISITES: prereqMap } = await import('./stages.js');
  const prereqs: string[] = prereqMap[targetStage as Stage] || [];

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
  if (!PIPELINE_STAGES.includes(stage as Stage)) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Invalid stage: ${stage}`);
  }

  const validStatuses = [...LIFECYCLE_STAGE_STATUSES];
  if (!validStatuses.includes(status as (typeof LIFECYCLE_STAGE_STATUSES)[number])) {
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
    manifest.stages[stage] = { status: 'not_started' };
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
    status: 'not_started',
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

  await saveEngineManifest(epicId, manifest, cwd);

  // Dual-write: sync gate result to SQLite (best-effort)
  try {
    await syncGateToDb(epicId, stageName!, gateName, 'pass', agent, notes);
  } catch (err) {
    console.warn(`[lifecycle] Gate sync failed: ${err}`);
  }

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

  await saveEngineManifest(epicId, manifest, cwd);

  // Dual-write: sync gate result to SQLite (best-effort)
  try {
    await syncGateToDb(epicId, stageName!, gateName, 'fail', undefined, reason);
  } catch (err) {
    console.warn(`[lifecycle] Gate sync failed: ${err}`);
  }

  return { epicId, gateName, reason, timestamp: now };
}

/**
 * List all epic IDs that have lifecycle data.
 * @task T4785
 */
export async function listEpicsWithLifecycle(cwd?: string): Promise<string[]> {
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
