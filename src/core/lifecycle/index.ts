/**
 * RCASD-IVTR pipeline lifecycle - stage transitions and gate enforcement.
 *
 * CANONICAL EXPORTS: `stages.ts` is the single source of truth for stage
 * definitions, ordering, prerequisites, and transition rules. This file
 * re-exports canonical types and provides SQLite-native lifecycle operations
 * backed by `lifecycle_pipelines`, `lifecycle_stages`, and
 * `lifecycle_gate_results` tables.
 *
 * @task T4467
 * @task T4800 - Unified lifecycle barrel export
 * @task T4798 - RCASD rename (Phase 1: code-only, no disk paths)
 * @epic T4454
 */

import { readJson } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getCleoDirAbsolute, getProjectRoot } from '../paths.js';
import { join } from 'node:path';
import { LIFECYCLE_STAGE_STATUSES } from '../../store/schema.js';
import { getDb } from '../../store/sqlite.js';
import * as schema from '../../store/schema.js';
import { eq } from 'drizzle-orm';
import { ensureStageArtifact } from './stage-artifacts.js';
import { linkProvenance } from './evidence.js';
import { syncAdrsToDb } from '../adrs/sync.js';
import { linkPipelineAdr } from '../adrs/link-pipeline.js';

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

import { PIPELINE_STAGES, STAGE_ORDER, STAGE_DEFINITIONS, STAGE_PREREQUISITES, isValidStage } from './stages.js';
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
 * Canonical RCASD manifest-shaped interface for compatibility payloads.
 * Lifecycle persistence is SQLite-native; this shape is used for API
 * responses that present stage+gate state in a manifest-like structure.
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
// LIFECYCLE DATA DISCOVERY
// =============================================================================

/**
 * Get the current lifecycle state for an epic.
 * @task T4467
 */
export async function getLifecycleState(
  epicId: string,
  cwd?: string,
): Promise<RcasdManifest> {
  const status = await getLifecycleStatus(epicId, cwd);
  const gates = await getLifecycleGates(epicId, cwd);

  const stages: Record<string, ManifestStageData> = {};
  for (const stage of status.stages) {
    stages[stage.stage] = {
      status: stage.status as ManifestStageData['status'],
      completedAt: stage.completedAt,
      notes: stage.notes,
      gates: gates[stage.stage],
    };
  }

  return { epicId, title: status.title, stages };
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
  // Gate check
  const gateResult = await checkGate(epicId, stage, cwd);
  if (!gateResult.allowed) {
    throw new CleoError(
      ExitCode.LIFECYCLE_GATE_FAILED,
      gateResult.message,
    );
  }

  if (!PIPELINE_STAGES.includes(stage as Stage)) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Unknown stage: ${stage}`);
  }

  const current = await getLifecycleStatus(epicId, cwd);
  const previousStatus = current.stages.find(s => s.stage === stage)?.status ?? 'not_started';
  if (previousStatus === 'completed') {
    throw new CleoError(
      ExitCode.LIFECYCLE_TRANSITION_INVALID,
      `Stage '${stage}' is already completed`,
    );
  }

  const result = await recordStageProgress(epicId, stage, 'completed', undefined, cwd);

  return {
    epicId,
    stage,
    previousStatus,
    newStatus: 'completed',
    timestamp: result.timestamp,
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
  if (!PIPELINE_STAGES.includes(stage as Stage)) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Unknown stage: ${stage}`);
  }

  const current = await getLifecycleStatus(epicId, cwd);
  const previousStatus = current.stages.find(s => s.stage === stage)?.status ?? 'not_started';
  if (previousStatus === 'completed') {
    throw new CleoError(
      ExitCode.LIFECYCLE_TRANSITION_INVALID,
      `Cannot complete stage '${stage}' from status '${previousStatus}'`,
    );
  }

  const notes = artifacts?.length ? `Artifacts: ${artifacts.join(', ')}` : undefined;
  const result = await recordStageProgress(epicId, stage, 'completed', notes, cwd);

  return {
    epicId,
    stage,
    previousStatus,
    newStatus: 'completed',
    timestamp: result.timestamp,
  };
}

/**
 * Skip a lifecycle stage.
 * @task T4467
 */
export async function skipStage(
  epicId: string,
  stage: string,
  reason: string,
  cwd?: string,
): Promise<StageTransitionResult> {
  if (!PIPELINE_STAGES.includes(stage as Stage)) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Unknown stage: ${stage}`);
  }

  const current = await getLifecycleStatus(epicId, cwd);
  const previousStatus = current.stages.find(s => s.stage === stage)?.status ?? 'not_started';
  if (previousStatus === 'completed') {
    throw new CleoError(
      ExitCode.LIFECYCLE_TRANSITION_INVALID,
      `Cannot skip stage '${stage}' - already completed`,
    );
  }

  const result = await recordStageProgress(epicId, stage, 'skipped', reason, cwd);

  return {
    epicId,
    stage,
    previousStatus,
    newStatus: 'skipped',
    timestamp: result.timestamp,
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

  if (!PIPELINE_STAGES.includes(targetStage as Stage)) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Unknown stage: ${targetStage}`);
  }

  const prereqResult = await checkStagePrerequisites(epicId, targetStage, cwd);
  const missing = prereqResult.missingPrerequisites;

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

/**
 * Get lifecycle status for an epic from SQLite.
 * Returns stage progress, current/next stage, and blockers.
 * @task T4801 - SQLite-native implementation
 */
export async function getLifecycleStatus(
  epicId: string,
  cwd?: string,
): Promise<{
  epicId: string;
  title?: string;
  currentStage: Stage | null;
  stages: Array<{
    stage: string;
    status: string;
    completedAt?: string;
    notes?: string;
    outputFile?: string;
    provenanceChain?: Record<string, unknown>;
  }>;
  nextStage: Stage | null;
  blockedOn: string[];
  initialized: boolean;
}> {
  const db = await getDb(cwd);

  // Query pipeline and task for this epic
  const pipelineResult = await db
    .select({
      pipeline: schema.lifecyclePipelines,
      task: schema.tasks,
    })
    .from(schema.lifecyclePipelines)
    .innerJoin(schema.tasks, eq(schema.lifecyclePipelines.taskId, schema.tasks.id))
    .where(eq(schema.lifecyclePipelines.taskId, epicId))
    .limit(1);

  // If no pipeline exists, return uninitialized status with default stages
  if (pipelineResult.length === 0) {
    return {
      epicId,
      currentStage: null,
      stages: PIPELINE_STAGES.map(s => ({ stage: s, status: 'not_started' })),
      nextStage: 'research',
      blockedOn: [],
      initialized: false,
    };
  }

  const task = pipelineResult[0].task;

  // Query all stages for this pipeline
  const pipelineId = `pipeline-${epicId}`;
  const stageRows = await db
    .select()
    .from(schema.lifecycleStages)
    .where(eq(schema.lifecycleStages.pipelineId, pipelineId))
    .orderBy(schema.lifecycleStages.sequence);

  // Build a lookup map of stage data from DB
  const stageDataMap = new Map<
    string,
    {
      status: string;
      completedAt?: string;
      notes?: string;
      outputFile?: string;
      provenanceChain?: Record<string, unknown>;
    }
  >();
  for (const row of stageRows) {
    let parsedChain: Record<string, unknown> | undefined;
    if (row.provenanceChainJson) {
      try {
        parsedChain = JSON.parse(row.provenanceChainJson) as Record<string, unknown>;
      } catch {
        parsedChain = undefined;
      }
    }

    stageDataMap.set(row.stageName, {
      status: row.status,
      completedAt: row.completedAt ?? undefined,
      notes: row.notesJson ? JSON.parse(row.notesJson)[0] : undefined,
      outputFile: row.outputFile ?? undefined,
      provenanceChain: parsedChain,
    });
  }

  // Build stages array in PIPELINE_STAGES order
  const stages = PIPELINE_STAGES.map(s => {
    const data = stageDataMap.get(s);
    return {
      stage: s,
      status: data?.status || 'not_started',
      completedAt: data?.completedAt,
      notes: data?.notes,
      outputFile: data?.outputFile,
      provenanceChain: data?.provenanceChain,
    };
  });

  // Calculate currentStage and nextStage
  let currentStage: Stage | null = null;
  let nextStage: Stage | null = null;

  for (let i = PIPELINE_STAGES.length - 1; i >= 0; i--) {
    const s = PIPELINE_STAGES[i];
    const data = stageDataMap.get(s);
    if (data?.status === 'completed' || data?.status === 'skipped') {
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

  // Calculate blockedOn based on prerequisites
  const blockedOn: string[] = [];
  if (nextStage) {
    const prereqs = STAGE_PREREQUISITES[nextStage] || [];
    for (const prereq of prereqs) {
      const prereqData = stageDataMap.get(prereq);
      const prereqStatus = prereqData?.status;
      if (prereqStatus !== 'completed' && prereqStatus !== 'skipped') {
        blockedOn.push(prereq);
      }
    }
  }

  return {
    epicId,
    title: task.title,
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
 * SQLite-native implementation - queries lifecycle_stages and lifecycle_gate_results tables.
 * @task T4785
 * @task T4801
 */
export async function getLifecycleHistory(
  epicId: string,
  cwd?: string,
): Promise<{ epicId: string; history: LifecycleHistoryEntry[] }> {
  const db = await getDb(cwd);
  const pipelineId = `pipeline-${epicId}`;

  // Query stages for this pipeline
  const stages = await db
    .select()
    .from(schema.lifecycleStages)
    .where(eq(schema.lifecycleStages.pipelineId, pipelineId));

  if (stages.length === 0) {
    return { epicId, history: [] };
  }

  const history: LifecycleHistoryEntry[] = [];

  // Build a map of stageId -> stageName for gate lookups
  const stageIdToName = new Map<string, string>();
  for (const stage of stages) {
    stageIdToName.set(stage.id, stage.stageName);
  }

  // Add stage completion and skip events
  for (const stage of stages) {
    if (stage.status === 'completed' && stage.completedAt) {
      const notes = stage.notesJson
        ? JSON.parse(stage.notesJson).join(', ')
        : undefined;
      history.push({
        stage: stage.stageName,
        action: 'completed',
        timestamp: stage.completedAt,
        notes,
      });
    }

    if (stage.status === 'skipped' && stage.skippedAt) {
      history.push({
        stage: stage.stageName,
        action: 'skipped',
        timestamp: stage.skippedAt,
        notes: stage.skipReason ?? undefined,
      });
    }
  }

  // Query gate results for all stages in this pipeline
  const stageIds = stages.map(s => s.id);
  if (stageIds.length > 0) {
    const gateResults = await db
      .select()
      .from(schema.lifecycleGateResults)
      .where(eq(schema.lifecycleGateResults.stageId, stageIds[0]!));

    // Add gate events
    for (const gate of gateResults) {
      const stageName = stageIdToName.get(gate.stageId);
      if (stageName) {
        history.push({
          stage: stageName,
          action: `gate.${gate.result}: ${gate.gateName}`,
          timestamp: gate.checkedAt,
          notes: (gate.details || gate.reason) ?? undefined,
        });
      }
    }

    // Query remaining stages
    for (let i = 1; i < stageIds.length; i++) {
      const additionalGates = await db
        .select()
        .from(schema.lifecycleGateResults)
        .where(eq(schema.lifecycleGateResults.stageId, stageIds[i]!));

      for (const gate of additionalGates) {
        const stageName = stageIdToName.get(gate.stageId);
        if (stageName) {
          history.push({
            stage: stageName,
            action: `gate.${gate.result}: ${gate.gateName}`,
            timestamp: gate.checkedAt,
            notes: (gate.details || gate.reason) ?? undefined,
          });
        }
      }
    }
  }

  // Sort by timestamp
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
  const db = await getDb(cwd);
  const pipelineId = `pipeline-${epicId}`;

  const stages = await db
    .select()
    .from(schema.lifecycleStages)
    .where(eq(schema.lifecycleStages.pipelineId, pipelineId));

  if (stages.length === 0) {
    return {};
  }

  const gates: Record<string, Record<string, GateData>> = {};

  for (const stage of stages) {
    const gateRows = await db
      .select()
      .from(schema.lifecycleGateResults)
      .where(eq(schema.lifecycleGateResults.stageId, stage.id));

    if (gateRows.length > 0) {
      gates[stage.stageName] = {};
      for (const gateRow of gateRows) {
        const status: GateData['status'] = gateRow.result === 'pass'
          ? 'passed'
          : gateRow.result === 'fail'
            ? 'failed'
            : 'pending';

        gates[stage.stageName][gateRow.gateName] = {
          status,
          agent: gateRow.checkedBy,
          notes: gateRow.details ?? undefined,
          reason: gateRow.reason ?? undefined,
          timestamp: gateRow.checkedAt,
        };
      }
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

  const lifecycleStatus = await getLifecycleStatus(epicId, cwd);
  const prereqs: string[] = STAGE_PREREQUISITES[targetStage as Stage] || [];

  const stageStatusMap = new Map(
    lifecycleStatus.stages.map(s => [s.stage, s.status]),
  );

  const missingPrerequisites: string[] = [];
  const issues: Array<{ stage: string; severity: string; message: string }> = [];

  for (const prereq of prereqs) {
    const prereqStatus = stageStatusMap.get(prereq);
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

interface EnsureLifecycleContextOptions {
  now: string;
  stageStatusOnCreate: typeof schema.LIFECYCLE_STAGE_STATUSES[number];
  updateCurrentStage: boolean;
}

async function ensureLifecycleContext(
  epicId: string,
  stageName: string,
  cwd: string | undefined,
  options: EnsureLifecycleContextOptions,
): Promise<{ db: Awaited<ReturnType<typeof getDb>>; pipelineId: string; stageId: string }> {
  const db = await getDb(cwd);
  const pipelineId = `pipeline-${epicId}`;
  const stageId = `stage-${epicId}-${stageName}`;

  const { getNativeDb } = await import('../../store/sqlite.js');
  getNativeDb()!.prepare(
    `INSERT OR IGNORE INTO tasks (id, title, status, priority, created_at) VALUES (?, ?, 'pending', 'medium', datetime('now'))`,
  ).run(epicId, `Task ${epicId}`);

  const existingPipeline = await db
    .select()
    .from(schema.lifecyclePipelines)
    .where(eq(schema.lifecyclePipelines.id, pipelineId))
    .limit(1)
    .all();

  if (existingPipeline.length === 0) {
    await db
      .insert(schema.lifecyclePipelines)
      .values({
        id: pipelineId,
        taskId: epicId,
        status: 'active',
        currentStageId: null,
        startedAt: options.now,
      })
      .run();
  }

  const existingStage = await db
    .select()
    .from(schema.lifecycleStages)
    .where(eq(schema.lifecycleStages.id, stageId))
    .limit(1)
    .all();

  if (existingStage.length === 0) {
    const sequence = isValidStage(stageName) ? STAGE_ORDER[stageName as Stage] : 0;
    await db
      .insert(schema.lifecycleStages)
      .values({
        id: stageId,
        pipelineId,
        stageName: stageName as typeof schema.LIFECYCLE_STAGE_NAMES[number],
        status: options.stageStatusOnCreate,
        sequence,
        startedAt: options.now,
      })
      .run();
  }

  if (options.updateCurrentStage) {
    await db
      .update(schema.lifecyclePipelines)
      .set({ currentStageId: stageId })
      .where(eq(schema.lifecyclePipelines.id, pipelineId))
      .run();
  }

  return { db, pipelineId, stageId };
}

/**
 * Record a stage status transition (progress/record).
 * SQLite-native implementation - T4801
 * @task T4785
 * @task T4801
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

  const now = new Date().toISOString();
  const stageName = stage as Stage;
  const { db, stageId, pipelineId } = await ensureLifecycleContext(epicId, stage, cwd, {
    now,
    stageStatusOnCreate: status as typeof schema.LIFECYCLE_STAGE_STATUSES[number],
    updateCurrentStage: true,
  });

  const artifact = await ensureStageArtifact(epicId, stageName, cwd);
  const provenanceChain = {
    recordedAt: now,
    source: 'pipeline.stage.record',
    stage,
    status,
    related: artifact.related,
  };

  // Upsert stage record
  const existingStage = await db
    .select()
    .from(schema.lifecycleStages)
    .where(eq(schema.lifecycleStages.id, stageId))
    .limit(1)
    .all();

  const sequence = STAGE_ORDER[stage as Stage];
  const stageValues: Partial<schema.NewLifecycleStageRow> = {
    status: status as typeof schema.LIFECYCLE_STAGE_STATUSES[number],
    completedAt: status === 'completed' ? now : null,
    skippedAt: status === 'skipped' ? now : null,
    skipReason: status === 'skipped' ? (notes ?? null) : null,
    notesJson: notes ? JSON.stringify([notes]) : '[]',
    outputFile: artifact.outputFile,
    provenanceChainJson: JSON.stringify(provenanceChain),
  };

  if (existingStage.length === 0) {
    // Insert new stage
    await db
      .insert(schema.lifecycleStages)
      .values({
        id: stageId,
        pipelineId,
        stageName: stage as typeof schema.LIFECYCLE_STAGE_NAMES[number],
        status: status as typeof schema.LIFECYCLE_STAGE_STATUSES[number],
        sequence,
        startedAt: now,
        completedAt: status === 'completed' ? now : null,
        skippedAt: status === 'skipped' ? now : null,
        skipReason: status === 'skipped' ? (notes ?? null) : null,
        notesJson: notes ? JSON.stringify([notes]) : '[]',
        outputFile: artifact.outputFile,
        provenanceChainJson: JSON.stringify(provenanceChain),
      })
      .run();
  } else {
    // Update existing stage
    await db
      .update(schema.lifecycleStages)
      .set(stageValues)
      .where(eq(schema.lifecycleStages.id, stageId))
      .run();
  }

  if (status === 'completed') {
    await linkProvenance(epicId, stageName, artifact.absolutePath, cwd);

    if (stageName === 'architecture_decision') {
      const projectRoot = getProjectRoot(cwd);
      await syncAdrsToDb(projectRoot);
      await linkPipelineAdr(projectRoot, epicId);
    }
  }

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
  const result = await recordStageProgress(epicId, stage, 'skipped', reason, cwd);
  return { epicId, stage, reason, timestamp: result.timestamp };
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
  if (!PIPELINE_STAGES.includes(stage as Stage)) {
    throw new CleoError(ExitCode.INVALID_INPUT, `Invalid stage: ${stage}`);
  }

  const now = new Date().toISOString();
  const { db, stageId } = await ensureLifecycleContext(epicId, stage, cwd, {
    now,
    stageStatusOnCreate: 'not_started',
    updateCurrentStage: false,
  });

  await db
    .update(schema.lifecycleStages)
    .set({
      status: 'not_started',
      completedAt: null,
      skippedAt: null,
      skipReason: null,
      notesJson: JSON.stringify([`Reset: ${reason}`]),
    })
    .where(eq(schema.lifecycleStages.id, stageId))
    .run();

  return { epicId, stage, reason };
}

/**
 * Mark a gate as passed.
 * SQLite-native implementation - T4801
 * @task T4785
 * @task T4801
 */
export async function passGate(
  epicId: string,
  gateName: string,
  agent?: string,
  notes?: string,
  cwd?: string,
): Promise<{ epicId: string; gateName: string; timestamp: string }> {
  const now = new Date().toISOString();
  const stageName = gateName.split('-')[0];
  const gateId = `gate-${epicId}-${stageName}-${gateName}`;
  const { db, stageId } = await ensureLifecycleContext(epicId, stageName, cwd, {
    now,
    stageStatusOnCreate: 'in_progress',
    updateCurrentStage: true,
  });

  // Upsert gate result
  const existingGate = await db
    .select()
    .from(schema.lifecycleGateResults)
    .where(eq(schema.lifecycleGateResults.id, gateId))
    .limit(1)
    .all();

  const gateValues = {
    id: gateId,
    stageId,
    gateName,
    result: 'pass' as const,
    checkedAt: now,
    checkedBy: agent ?? 'system',
    details: notes ?? null,
    reason: null as string | null,
  };

  if (existingGate.length > 0) {
    await db
      .update(schema.lifecycleGateResults)
      .set(gateValues)
      .where(eq(schema.lifecycleGateResults.id, gateId))
      .run();
  } else {
    await db
      .insert(schema.lifecycleGateResults)
      .values(gateValues)
      .run();
  }

  return { epicId, gateName, timestamp: now };
}

/**
 * Mark a gate as failed.
 * SQLite-native implementation - T4801
 * @task T4785
 * @task T4801
 */
export async function failGate(
  epicId: string,
  gateName: string,
  reason?: string,
  cwd?: string,
): Promise<{ epicId: string; gateName: string; reason?: string; timestamp: string }> {
  const now = new Date().toISOString();
  const stageName = gateName.split('-')[0];
  const gateId = `gate-${epicId}-${stageName}-${gateName}`;
  const { db, stageId } = await ensureLifecycleContext(epicId, stageName, cwd, {
    now,
    stageStatusOnCreate: 'in_progress',
    updateCurrentStage: true,
  });

  // Upsert gate result
  const existingGate = await db
    .select()
    .from(schema.lifecycleGateResults)
    .where(eq(schema.lifecycleGateResults.id, gateId))
    .limit(1)
    .all();

  const gateValues = {
    id: gateId,
    stageId,
    gateName,
    result: 'fail' as const,
    checkedAt: now,
    checkedBy: 'system',
    details: null as string | null,
    reason: reason ?? null,
  };

  if (existingGate.length > 0) {
    await db
      .update(schema.lifecycleGateResults)
      .set(gateValues)
      .where(eq(schema.lifecycleGateResults.id, gateId))
      .run();
  } else {
    await db
      .insert(schema.lifecycleGateResults)
      .values(gateValues)
      .run();
  }

  return { epicId, gateName, reason, timestamp: now };
}

/**
 * List all epic IDs that have lifecycle data.
 * @task T4785
 */
export async function listEpicsWithLifecycle(cwd?: string): Promise<string[]> {
  try {
    const db = await getDb(cwd);
    const rows = await db
      .select({ taskId: schema.lifecyclePipelines.taskId })
      .from(schema.lifecyclePipelines)
      .all();

    return rows.map(r => r.taskId).sort();
  } catch {
    return [];
  }
}
