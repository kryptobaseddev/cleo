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
import { listEpicsWithLifecycle } from './index.js';
import type { RcasdManifest, ManifestStageData } from './index.js';
import { readJson } from '../../store/json.js';
import { findManifestPath } from './rcasd-paths.js';

// =============================================================================
// LEGACY MANIFEST NORMALIZATION
// =============================================================================

/**
 * Normalize a manifest into canonical format, handling:
 *   - Legacy `status` key (→ `stages`)
 *   - Legacy `state` field inside each stage (→ `status`)
 *   - Legacy `taskId` field (→ `epicId`)
 *   - Legacy `pending` status (→ `not_started`)
 *   - Missing `stages` property (→ empty stages object)
 *
 * Accepts Record<string, unknown> at the boundary since on-disk manifests
 * may contain legacy keys not present in the RcasdManifest type.
 *
 * @task T5200
 */
function normalizeManifest(raw: Record<string, unknown>): RcasdManifest {
  const existingStages = raw['stages'] as Record<string, ManifestStageData> | undefined;
  let stages: Record<string, ManifestStageData> = existingStages ?? {};

  // Handle legacy `status` key instead of `stages`
  if (!existingStages && raw['status'] && typeof raw['status'] === 'object') {
    const legacyStatus = raw['status'] as Record<string, Record<string, unknown>>;
    stages = {};
    for (const [stageName, stageData] of Object.entries(legacyStatus)) {
      // Legacy format uses `state` instead of `status`
      const status = (stageData['state'] ?? stageData['status'] ?? 'not_started') as string;
      stages[stageName] = {
        status: mapLegacyStatus(status) as ManifestStageData['status'],
        completedAt: stageData['completedAt'] as string | undefined,
        skippedAt: stageData['skippedAt'] as string | undefined,
        skippedReason: stageData['skippedReason'] as string | undefined,
        artifacts: stageData['artifacts'] as string[] | undefined,
        notes: stageData['notes'] as string | undefined,
        gates: stageData['gates'] as Record<string, import('./index.js').GateData> | undefined,
      };
    }
  }

  // Map any legacy status values in the stages
  for (const stageData of Object.values(stages)) {
    stageData.status = mapLegacyStatus(stageData.status) as ManifestStageData['status'];
  }

  return {
    epicId: (raw['epicId'] as string) ?? (raw['taskId'] as string) ?? '',
    title: raw['title'] as string | undefined,
    stages,
  };
}

/**
 * Map legacy status values to canonical values.
 * - `pending` → `not_started`
 * - `active` → `in_progress`
 * - Everything else passes through.
 */
function mapLegacyStatus(status: string): string {
  switch (status) {
    case 'pending': return 'not_started';
    case 'active': return 'in_progress';
    default: return status;
  }
}

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
  const manifestPath = findManifestPath(epicId, cwd);
  if (!manifestPath) {
    throw new Error(`No manifest found for epic ${epicId}`);
  }
  const rawManifest = await readJson<Record<string, unknown>>(manifestPath);
  if (!rawManifest) {
    throw new Error(`Failed to read manifest for epic ${epicId}`);
  }
  const manifest = normalizeManifest(rawManifest);
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
  if (!manifest.stages) return 'active';
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
  if (!manifest.stages) return 'research';
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
