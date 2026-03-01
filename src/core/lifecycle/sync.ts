/**
 * JSON-to-SQLite lifecycle synchronizer.
 *
 * Reads RCASD pipeline manifests from `.cleo/rcasd/<epicId>/_manifest.json`
 * and upserts them into the SQLite lifecycle tables. JSON manifests remain
 * canonical; SQLite is a best-effort queryable mirror.
 *
 * @task T5112
 * @epic T4454
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../../store/sqlite.js';
import * as schema from '../../store/schema.js';
import { PIPELINE_STAGES, STAGE_ORDER } from './stages.js';
import type { Stage } from './stages.js';
import { getLifecycleState, listEpicsWithLifecycle } from './index.js';
import type { RcasdManifest, ManifestStageData } from './index.js';

// =============================================================================
// SYNC: Full manifest → SQLite
// =============================================================================

/**
 * Synchronize a single epic's JSON manifest into the SQLite lifecycle tables.
 *
 * Reads the `_manifest.json` for this epic and upserts records into
 * `lifecycle_pipelines`, `lifecycle_stages`, and `lifecycle_gate_results`.
 *
 * ID conventions:
 * - Pipeline: `pipeline-${epicId}`
 * - Stage:    `stage-${epicId}-${stageName}`
 * - Gate:     `gate-${epicId}-${stageName}-${gateName}`
 *
 * @param epicId - Epic task ID (e.g. 'T4881')
 * @param cwd    - Optional working directory
 */
export async function syncManifestToDb(
  epicId: string,
  cwd?: string,
): Promise<void> {
  const manifest = await getLifecycleState(epicId, cwd);
  const db = await getDb(cwd);

  const pipelineId = `pipeline-${epicId}`;
  const pipelineStatus = derivePipelineStatus(manifest);
  const now = new Date().toISOString();

  // --- Upsert pipeline ---------------------------------------------------
  const existingPipeline = await db
    .select()
    .from(schema.lifecyclePipelines)
    .where(eq(schema.lifecyclePipelines.id, pipelineId))
    .limit(1)
    .all();

  const currentStageId = deriveCurrentStageName(manifest);

  if (existingPipeline.length > 0) {
    await db
      .update(schema.lifecyclePipelines)
      .set({
        status: pipelineStatus,
        currentStageId,
        completedAt: pipelineStatus === 'completed' ? now : null,
      })
      .where(eq(schema.lifecyclePipelines.id, pipelineId))
      .run();
  } else {
    await db
      .insert(schema.lifecyclePipelines)
      .values({
        id: pipelineId,
        taskId: epicId,
        status: pipelineStatus,
        currentStageId,
        startedAt: now,
        completedAt: pipelineStatus === 'completed' ? now : undefined,
      })
      .run();
  }

  // --- Upsert stages ------------------------------------------------------
  for (const stageName of PIPELINE_STAGES) {
    const stageData = manifest.stages[stageName];
    if (!stageData) continue;

    const stageId = `stage-${epicId}-${stageName}`;
    const sequence = STAGE_ORDER[stageName];

    const existingStage = await db
      .select()
      .from(schema.lifecycleStages)
      .where(eq(schema.lifecycleStages.id, stageId))
      .limit(1)
      .all();

    const stageValues = buildStageValues(stageId, pipelineId, stageName, sequence, stageData);

    if (existingStage.length > 0) {
      await db
        .update(schema.lifecycleStages)
        .set(stageValues)
        .where(eq(schema.lifecycleStages.id, stageId))
        .run();
    } else {
      await db
        .insert(schema.lifecycleStages)
        .values(stageValues)
        .run();
    }

    // --- Upsert gates for this stage --------------------------------------
    if (stageData.gates) {
      for (const [gateName, gateData] of Object.entries(stageData.gates)) {
        const gateId = `gate-${epicId}-${stageName}-${gateName}`;

        // Map manifest gate status to DB result enum
        const result = mapGateStatusToResult(gateData.status);

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
          result,
          checkedAt: gateData.timestamp ?? now,
          checkedBy: gateData.agent ?? 'system',
          details: gateData.notes ?? null,
          reason: gateData.reason ?? null,
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
      }
    }
  }
}

// =============================================================================
// SYNC: All epics backfill
// =============================================================================

/**
 * Backfill all epics with lifecycle data into SQLite.
 *
 * Iterates over every epic that has a `_manifest.json` on disk and calls
 * `syncManifestToDb()` for each. Returns counts of successes and errors.
 *
 * @param cwd - Optional working directory
 */
export async function backfillAllEpics(
  cwd?: string,
): Promise<{ synced: number; errors: number }> {
  const epicIds = await listEpicsWithLifecycle(cwd);
  let synced = 0;
  let errors = 0;

  for (const epicId of epicIds) {
    try {
      await syncManifestToDb(epicId, cwd);
      synced++;
    } catch (err) {
      errors++;
      console.warn(`[lifecycle-sync] Failed to sync ${epicId}:`, err);
    }
  }

  return { synced, errors };
}

// =============================================================================
// SYNC: Single gate result (dual-write helper)
// =============================================================================

/**
 * Write a gate result directly to SQLite.
 *
 * Intended for use by `passGate`/`failGate` to enable dual-write.
 * Creates or updates the gate result row and ensures the parent stage
 * row exists (creating a stub if necessary).
 *
 * @param epicId    - Epic task ID
 * @param stageName - Stage the gate belongs to
 * @param gateName  - Gate identifier
 * @param result    - Gate result ('pass' | 'fail' | 'warn')
 * @param agent     - Agent/user who checked the gate
 * @param notes     - Optional notes
 */
export async function syncGateToDb(
  epicId: string,
  stageName: string,
  gateName: string,
  result: 'pass' | 'fail' | 'warn',
  agent?: string,
  notes?: string,
): Promise<void> {
  try {
    const db = await getDb();
    const now = new Date().toISOString();
    const pipelineId = `pipeline-${epicId}`;
    const stageId = `stage-${epicId}-${stageName}`;
    const gateId = `gate-${epicId}-${stageName}-${gateName}`;

    // Ensure pipeline exists (stub if not)
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
          currentStageId: stageName,
          startedAt: now,
        })
        .run();
    }

    // Ensure stage exists (stub if not)
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
          status: 'in_progress',
          sequence,
          startedAt: now,
        })
        .run();
    }

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
      result,
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
  } catch (err) {
    console.warn(`[lifecycle-sync] Failed to sync gate ${gateName} for ${epicId}:`, err);
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Derive overall pipeline status from manifest stage data.
 * - All stages completed → 'completed'
 * - Any stage blocked    → 'blocked'
 * - Otherwise            → 'active'
 */
function derivePipelineStatus(
  manifest: RcasdManifest,
): typeof schema.LIFECYCLE_PIPELINE_STATUSES[number] {
  let allCompleted = true;

  for (const stageName of PIPELINE_STAGES) {
    const status = manifest.stages[stageName]?.status;
    if (status === 'blocked') {
      return 'blocked';
    }
    if (status !== 'completed' && status !== 'skipped') {
      allCompleted = false;
    }
  }

  return allCompleted ? 'completed' : 'active';
}

/**
 * Derive the current stage name from the manifest.
 * Returns the last in-progress or first not-started stage.
 */
function deriveCurrentStageName(manifest: RcasdManifest): string | null {
  // Find the first stage that is in_progress
  for (const stageName of PIPELINE_STAGES) {
    const status = manifest.stages[stageName]?.status;
    if (status === 'in_progress') {
      return stageName;
    }
  }

  // Fall back to the first not_started stage
  for (const stageName of PIPELINE_STAGES) {
    const status = manifest.stages[stageName]?.status;
    if (status === 'not_started' || !status) {
      return stageName;
    }
  }

  // All stages are terminal (completed/skipped)
  return PIPELINE_STAGES[PIPELINE_STAGES.length - 1];
}

/**
 * Build the values object for a lifecycle_stages upsert.
 */
function buildStageValues(
  stageId: string,
  pipelineId: string,
  stageName: string,
  sequence: number,
  data: ManifestStageData,
): schema.NewLifecycleStageRow {
  return {
    id: stageId,
    pipelineId,
    stageName: stageName as typeof schema.LIFECYCLE_STAGE_NAMES[number],
    status: data.status as typeof schema.LIFECYCLE_STAGE_STATUSES[number],
    sequence,
    startedAt: null,
    completedAt: data.completedAt ?? null,
    blockedAt: null,
    blockReason: null,
    skippedAt: data.skippedAt ?? null,
    skipReason: data.skippedReason ?? null,
    notesJson: data.notes ? JSON.stringify([data.notes]) : '[]',
    metadataJson: data.artifacts ? JSON.stringify({ artifacts: data.artifacts }) : '{}',
  };
}

/**
 * Map manifest gate status ('passed'|'failed'|'pending') to DB result ('pass'|'fail'|'warn').
 */
function mapGateStatusToResult(
  status: string,
): typeof schema.LIFECYCLE_GATE_RESULTS[number] {
  switch (status) {
    case 'passed': return 'pass';
    case 'failed': return 'fail';
    case 'pending': return 'warn';
    default: return 'warn';
  }
}

/**
 * Check if a string is a valid pipeline stage name.
 */
function isValidStage(name: string): name is Stage {
  return (PIPELINE_STAGES as readonly string[]).includes(name);
}
