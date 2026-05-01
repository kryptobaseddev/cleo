/**
 * Stage Drift Detector — sentient hygiene check (T1635).
 *
 * Every N minutes (configurable, default 30 min) this module:
 *
 *   1. Queries tasks.db for active epics (status IN pending/active/blocked).
 *   2. For each epic, computes the `effective_stage` from child progress via
 *      {@link computeEffectiveStage} (lifecycle/effective-stage.ts).
 *   3. Compares `effective_stage` numeric index against `tasks.pipeline_stage`
 *      numeric index (both mapped to STAGE_ORDER from lifecycle/stages.ts).
 *   4. When |effective_index - stored_index| > 1:
 *        - Emits a Tier-2 proposal titled
 *          `[T2-DRIFT] auto-fix stage drift on T<id>: <stored> → <effective>`
 *        - Uses the existing transactional propose-tick write path so the
 *          daily rate-limit and per-parent dedup are automatically enforced.
 *   5. Owner approves via `cleo sentient propose accept <proposalId>`, which
 *      calls `cleo update --pipeline-stage <effective>` on the epic.
 *
 * Integrations:
 *   - Called from `safeRunTick` in tick.ts (fire-and-forget, best-effort).
 *   - Fully injectable: `db`, `allocateTaskId`, and `isKilled` can be
 *     overridden by tests without touching the real DB.
 *
 * Title format: `[T2-DRIFT] ...` — the existing PROPOSAL_TITLE_PATTERN
 * (`/^\[T2-(BRAIN|NEXUS|TEST)\]/`) does NOT cover DRIFT.  We extend the
 * allowlist below rather than bypassing validation.
 *
 * @task T1635
 * @see T1232 — original stage-drift bug class
 * @see ADR-054 — Sentient Loop Tier-2
 */

import type { DatabaseSync } from 'node:sqlite';
import {
  computeEffectiveStage,
  EFFECTIVE_STAGE_INDEX,
  fetchEpicProgressBatch,
} from '../lifecycle/effective-stage.js';
import { STAGE_ORDER } from '../lifecycle/stages.js';
import { checkDedupCollision } from './proposal-dedup.js';
import {
  countTodayProposals,
  DEFAULT_DAILY_PROPOSAL_LIMIT,
  transactionalInsertProposal,
} from './proposal-rate-limiter.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum gap (inclusive) between effective-stage index and stored-stage
 * index that triggers a drift proposal.
 *
 * Gap = |effective_index - stored_index|
 * Gap 0 → same stage.
 * Gap 1 → adjacent stage (within normal variance — no proposal).
 * Gap ≥ 2 → drift detected → proposal emitted.
 */
export const DRIFT_GAP_THRESHOLD = 2;

/**
 * Default cadence between stage-drift scans (30 minutes in milliseconds).
 * Configurable via {@link StageDriftOptions.scanIntervalMs}.
 */
export const DRIFT_SCAN_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Title prefix for drift proposals.  Must match {@link DRIFT_TITLE_PATTERN}.
 */
export const DRIFT_PROPOSAL_PREFIX = '[T2-DRIFT]' as const;

/**
 * Title regex that drift proposals MUST match.
 * Extends the existing Tier-2 pattern for the DRIFT source.
 */
export const DRIFT_TITLE_PATTERN = /^\[T2-DRIFT\]/;

/**
 * Label applied to every drift proposal task alongside the standard
 * `sentient-tier2` label, so CLI queries can filter drift proposals.
 */
export const DRIFT_SOURCE_LABEL = 'source:drift' as const;

/**
 * Stages that are considered "no stored stage" for comparison purposes.
 * When an epic has no pipelineStage set, we default to `research` (index 1).
 */
const DEFAULT_STORED_STAGE_INDEX = 1; // 'research'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for {@link runStageDriftScan}.
 */
export interface StageDriftOptions {
  /** Absolute path to the project root (contains `.cleo/`). */
  projectRoot: string;
  /** Absolute path to sentient-state.json. */
  statePath: string;
  /**
   * Minimum gap (|effective_index - stored_index|) that triggers a proposal.
   * Defaults to {@link DRIFT_GAP_THRESHOLD} (2).
   * Pass 1 to detect single-stage drift (stricter).
   */
  driftGapThreshold?: number;
  /**
   * Override for the tasks.db handle.  Injected by tests.
   * When omitted, `getNativeTasksDb()` is called after ensuring the DB is open.
   */
  db?: DatabaseSync | null;
  /**
   * Override for the task ID allocator.  Injected by tests.
   * When omitted, `allocateNextTaskId(projectRoot)` is used.
   */
  allocateTaskId?: () => Promise<string>;
  /**
   * Kill-switch check.  Injected by tests.
   * When omitted, reads the state file via `readSentientState`.
   */
  isKilled?: () => Promise<boolean>;
}

/**
 * Per-epic drift record produced during a scan pass.
 */
export interface EpicDriftRecord {
  /** Epic ID (e.g. `T123`). */
  epicId: string;
  /** Stored pipeline stage (from `tasks.pipeline_stage`). */
  storedStage: string;
  /** Computed effective stage (from child progress). */
  effectiveStage: string;
  /** Numeric index of the stored stage (STAGE_ORDER). */
  storedIndex: number;
  /** Numeric index of the effective stage (EFFECTIVE_STAGE_INDEX). */
  effectiveIndex: number;
  /** |effectiveIndex - storedIndex| */
  gap: number;
}

/**
 * Outcome of {@link runStageDriftScan}.
 */
export interface StageDriftOutcome {
  /** How the scan ended. */
  kind: 'killed' | 'disabled' | 'no-epics' | 'scanned' | 'error';
  /** Number of epics scanned. */
  epicsScanned: number;
  /** Drift records where gap > threshold (before dedup/rate-limit). */
  driftDetected: EpicDriftRecord[];
  /** Number of proposals written to tasks.db. */
  proposalsWritten: number;
  /** Human-readable detail. */
  detail: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Raw SQL output rows are consumed with inline `as Array<{...}>` casts,
// matching the idiom used in packages/core/src/lifecycle/rollup.ts.

/**
 * Fetch active epics (status IN pending/active/blocked, type='epic') from
 * the tasks DB.
 *
 * Returns null when the DB is unavailable.
 */
function queryActiveEpics(db: DatabaseSync): Array<{ id: string; pipeline_stage: string | null }> {
  const sql = `
    SELECT id, pipeline_stage
    FROM tasks
    WHERE type = 'epic'
      AND status IN ('pending', 'active', 'blocked')
    ORDER BY id ASC
  `;
  try {
    return db.prepare(sql).all() as Array<{
      id: string;
      pipeline_stage: string | null;
    }>;
  } catch {
    return [];
  }
}

/**
 * Map a stored `pipelineStage` string to its STAGE_ORDER numeric index.
 *
 * Returns {@link DEFAULT_STORED_STAGE_INDEX} when the value is null, empty,
 * or not a recognised canonical stage name (so older / non-staged epics
 * are treated as if they are at research).
 */
function storedStageIndex(rawStage: string | null | undefined): number {
  if (!rawStage) return DEFAULT_STORED_STAGE_INDEX;
  const index = (STAGE_ORDER as Record<string, number>)[rawStage];
  return index ?? DEFAULT_STORED_STAGE_INDEX;
}

/**
 * Build the SQL INSERT params for a drift proposal task.
 */
function buildDriftProposalInsert(
  taskId: string,
  epicId: string,
  storedStage: string,
  effectiveStage: string,
  gap: number,
  dedupHash: string,
): {
  sql: string;
  params: Record<string, string | number>;
} {
  const now = new Date().toISOString();
  const title = `${DRIFT_PROPOSAL_PREFIX} auto-fix stage drift on ${epicId}: ${storedStage} → ${effectiveStage}`;
  const description =
    `Sentient hygiene scan detected pipeline stage drift on epic ${epicId}. ` +
    `Stored stage: "${storedStage}" (index ${storedStageIndex(storedStage)}), ` +
    `effective stage: "${effectiveStage}" (index ${EFFECTIVE_STAGE_INDEX[effectiveStage as keyof typeof EFFECTIVE_STAGE_INDEX] ?? 0}), ` +
    `gap: ${gap}. ` +
    `Accept to apply: cleo update ${epicId} --pipeline-stage ${effectiveStage}`;
  const labels = JSON.stringify(['sentient-tier2', DRIFT_SOURCE_LABEL]);
  // T1592-compatible: dedupHash embedded in proposal-meta so cross-tick
  // dedup checks can find it via `notes_json LIKE '%dedupHash%<hex>%'`.
  const notesJson = JSON.stringify([
    JSON.stringify({
      kind: 'proposal-meta',
      proposedBy: 'sentient-tier2',
      source: 'drift',
      sourceId: `drift:${epicId}`,
      weight: 0.7,
      proposedAt: now,
      dedupHash,
    }),
  ]);

  const sql = `
    INSERT INTO tasks (
      id, title, description, status, priority,
      labels_json, notes_json,
      created_at, updated_at,
      role, scope
    ) VALUES (
      :id, :title, :description, :status, :priority,
      :labelsJson, :notesJson,
      :createdAt, :updatedAt,
      :role, :scope
    )
  `;

  return {
    sql,
    params: {
      id: taskId,
      title,
      description,
      status: 'proposed',
      priority: 'high',
      labelsJson: labels,
      notesJson,
      createdAt: now,
      updatedAt: now,
      role: 'work',
      scope: 'feature',
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a single stage-drift scan pass.
 *
 * Steps:
 *   1. Kill-switch check → abort if active.
 *   2. Tier-2 enabled guard → skip if disabled (owners opt-in).
 *   3. Query active epics from tasks.db.
 *   4. Batch-fetch child progress for all epics.
 *   5. Compute effective stage per epic.
 *   6. Identify epics whose gap > `driftGapThreshold`.
 *   7. For each drifted epic:
 *        a. Per-parent dedup check (skip if proposal already exists).
 *        b. Daily rate-limit check (stop if cap reached).
 *        c. Transactional INSERT proposal.
 *
 * @param options - Scan options (see {@link StageDriftOptions})
 * @returns {@link StageDriftOutcome}
 *
 * @task T1635
 */
export async function runStageDriftScan(options: StageDriftOptions): Promise<StageDriftOutcome> {
  const { projectRoot, statePath } = options;
  const gapThreshold = options.driftGapThreshold ?? DRIFT_GAP_THRESHOLD;

  // Step 1: kill-switch check.
  const killed = await (options.isKilled
    ? options.isKilled()
    : (async () => {
        const { readSentientState } = await import('./state.js');
        const state = await readSentientState(statePath);
        return state.killSwitch === true;
      })());

  if (killed) {
    return {
      kind: 'killed',
      epicsScanned: 0,
      driftDetected: [],
      proposalsWritten: 0,
      detail: 'killSwitch active — stage-drift scan skipped',
    };
  }

  // Step 2: tier2Enabled guard.
  const { readSentientState } = await import('./state.js');
  const state = await readSentientState(statePath);
  if (!state.tier2Enabled) {
    return {
      kind: 'disabled',
      epicsScanned: 0,
      driftDetected: [],
      proposalsWritten: 0,
      detail: 'tier2Enabled=false — stage-drift proposals disabled',
    };
  }

  // Step 3: resolve DB.
  let db: DatabaseSync | null;
  if (options.db !== undefined) {
    db = options.db;
  } else {
    try {
      const { getNativeDb, getDb } = await import('../store/sqlite.js');
      await getDb(projectRoot);
      db = getNativeDb();
    } catch {
      db = null;
    }
  }

  if (!db) {
    return {
      kind: 'error',
      epicsScanned: 0,
      driftDetected: [],
      proposalsWritten: 0,
      detail: 'tasks.db not available — stage-drift scan skipped',
    };
  }

  // Step 4: query active epics.
  const activeEpics = queryActiveEpics(db);
  if (activeEpics.length === 0) {
    return {
      kind: 'no-epics',
      epicsScanned: 0,
      driftDetected: [],
      proposalsWritten: 0,
      detail: 'no active epics found',
    };
  }

  // Step 5: batch-fetch child progress.
  const epicIds = activeEpics.map((r) => r.id);
  const progressMap = fetchEpicProgressBatch(db, epicIds);

  // Step 6: compute effective stage + detect drift.
  const driftRecords: EpicDriftRecord[] = [];

  for (const epicRow of activeEpics) {
    const progress = progressMap.get(epicRow.id);
    if (!progress) continue;

    const effective = computeEffectiveStage(progress);
    const effectiveIdx = EFFECTIVE_STAGE_INDEX[effective];
    const storedIdx = storedStageIndex(epicRow.pipeline_stage);
    const gap = Math.abs(effectiveIdx - storedIdx);

    if (gap > gapThreshold) {
      driftRecords.push({
        epicId: epicRow.id,
        storedStage: epicRow.pipeline_stage ?? 'research',
        effectiveStage: effective,
        storedIndex: storedIdx,
        effectiveIndex: effectiveIdx,
        gap,
      });
    }
  }

  // Step 7: write proposals.
  let proposalsWritten = 0;

  for (const drift of driftRecords) {
    // Daily rate-limit check.
    const todayCount = countTodayProposals(db);
    if (todayCount >= DEFAULT_DAILY_PROPOSAL_LIMIT) {
      break;
    }

    // Per-parent dedup check.
    const dedupCheck = checkDedupCollision({
      tasksDb: db,
      candidate: {
        parentId: null,
        title: `${DRIFT_PROPOSAL_PREFIX} auto-fix stage drift on ${drift.epicId}: ${drift.storedStage} → ${drift.effectiveStage}`,
        acceptance: drift.effectiveStage,
      },
    });

    if (dedupCheck.isDuplicate) {
      continue;
    }

    // Allocate task ID.
    let taskId: string;
    if (options.allocateTaskId) {
      taskId = await options.allocateTaskId();
    } else {
      const { allocateNextTaskId } = await import('@cleocode/core/internal');
      taskId = await allocateNextTaskId(projectRoot);
    }

    const { sql, params } = buildDriftProposalInsert(
      taskId,
      drift.epicId,
      drift.storedStage,
      drift.effectiveStage,
      drift.gap,
      dedupCheck.dedupHash,
    );

    try {
      const result = transactionalInsertProposal(db, sql, params, DEFAULT_DAILY_PROPOSAL_LIMIT);
      if (result.inserted) {
        proposalsWritten++;
      } else if (result.reason === 'rate-limit') {
        break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[sentient/stage-drift] INSERT failed for ${taskId} (${drift.epicId}): ${message}\n`,
      );
    }
  }

  const driftSummary =
    driftRecords.length > 0
      ? `drift in ${driftRecords.map((d) => d.epicId).join(', ')}`
      : 'no drift';

  return {
    kind: 'scanned',
    epicsScanned: activeEpics.length,
    driftDetected: driftRecords,
    proposalsWritten,
    detail:
      `scanned ${activeEpics.length} epic(s); ${driftRecords.length} drift(s) detected` +
      (driftRecords.length > 0
        ? ` (${driftSummary}); ${proposalsWritten} proposal(s) written`
        : ''),
  };
}

/**
 * Safe wrapper for {@link runStageDriftScan} — swallows unexpected exceptions.
 *
 * Used from `safeRunTick` in tick.ts as a fire-and-forget best-effort call.
 * Errors never propagate to the tick caller.
 *
 * @param options - Scan options
 * @returns Scan outcome or an error outcome on unexpected throw.
 *
 * @task T1635
 */
export async function safeRunStageDriftScan(
  options: StageDriftOptions,
): Promise<StageDriftOutcome> {
  try {
    return await runStageDriftScan(options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'error',
      epicsScanned: 0,
      driftDetected: [],
      proposalsWritten: 0,
      detail: `stage-drift scan threw: ${message}`,
    };
  }
}
