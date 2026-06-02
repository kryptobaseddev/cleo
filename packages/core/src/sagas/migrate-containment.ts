/**
 * saga.migrate-containment — migrate legacy groups Saga membership to parent_id containment.
 *
 * Pre-T10638, Saga membership used `task_relations.type='groups'`. PM-Core V2
 * makes `parent_id` containment canonical: member Epics carry `parentId`
 * pointing at the Saga.
 *
 * This migration:
 * 1. Finds legacy `groups` rows from Saga (`type='saga'`) to Epic (`type='epic`).
 * 2. Reparants each Epic under the Saga via `parent_id` containment.
 * 3. Removes the migrated legacy `groups` row.
 * 4. Documents non-Epic relation targets and conflicting parents for manual resolution.
 *
 * Audits every mutation to `.cleo/audit/saga-contain-migration.jsonl`.
 *
 * @task T10637
 * @epic T10548 — E10-MIGRATION-CLEANUP-DOGFOOD-RELEASE
 * @saga T10538 — SG-PM-CORE-V2
 * @see ADR-073-above-epic-naming.md §1.2 — invariant I5
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoHome } from '@cleocode/paths';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { getNativeTasksDb } from '../store/sqlite.js';
import { taskRelatesRemove } from '../tasks/engine-wrap.js';
import { coreTaskReparent } from '../tasks/task-reparent.js';
import { SAGA_GROUPS_RELATION } from './constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters for {@link migrateSagaContainment}. */
export interface MigrateSagaContainmentParams {
  /**
   * Specific Saga ID to migrate. When omitted, migrates ALL sagas.
   * Providing a specific ID is the idempotency-safe default for CLI usage.
   */
  sagaId?: string;
  /** Dry-run mode: scan only, no mutations. */
  dryRun?: boolean;
}

/** A single Epic that was successfully migrated. */
export interface MigratedEpic {
  epicId: string;
  sagaId: string;
  oldParentId: string | null;
  groupsRelation: {
    from: string;
    to: string;
    type: typeof SAGA_GROUPS_RELATION;
  };
}

/** A Task (non-Epic) with a Saga parent that needs manual resolution. */
export interface ContainmentConflict {
  taskId: string;
  sagaId: string;
  taskType: string;
  taskTitle: string;
  reason: string;
}

/** Result of {@link migrateSagaContainment}. */
export interface MigrateSagaContainmentResult {
  /** Total sagas scanned. */
  sagasScanned: number;
  /** Number of Epics successfully migrated (groups → parent_id). */
  migrated: number;
  /** Number of already-correct Epics skipped (idempotent no-op). */
  skipped: number;
  /** Detailed list of migrated Epics. */
  migratedEpics: MigratedEpic[];
  /** Tasks (non-epics) with Saga parents that need manual resolution. */
  conflicts: ContainmentConflict[];
  /** Whether this was a dry run (no mutations performed). */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

const MIGRATION_AUDIT_FILE = 'saga-contain-migration.jsonl';

function auditLine(entry: Record<string, unknown>): void {
  try {
    const cleoHome = getCleoHome();
    const dir = join(cleoHome, 'audit');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, MIGRATION_AUDIT_FILE), JSON.stringify(entry) + '\n');
  } catch {
    // Best-effort audit — never fail the migration because of audit I/O.
  }
}

// ---------------------------------------------------------------------------
// Core migration logic
// ---------------------------------------------------------------------------

/**
 * Migrate legacy `task_relations.type='groups'` Saga membership to parent_id containment.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param params - Optional sagaId and dry-run flag.
 */
export async function migrateSagaContainment(
  projectRoot: string,
  params: MigrateSagaContainmentParams = {},
): Promise<EngineResult<MigrateSagaContainmentResult>> {
  const { sagaId, dryRun = false } = params;
  // Open (or reuse) the tasks.db singleton so the native handle is available.
  await getTaskAccessor(projectRoot);
  const nativeDb = getNativeTasksDb();

  if (!nativeDb) {
    return engineError('E_GENERAL', 'Database handle not available from accessor');
  }

  // T11280: read-only scan helper over the canonical native handle. The
  // SqliteDataAccessor does not expose a raw `.db`; the native DatabaseSync's
  // prepared-statement `.all(...)` is the SSoT surface for ad-hoc reads.
  const db = {
    all: (sql: string, ...args: unknown[]): unknown[] =>
      nativeDb
        .prepare(sql)
        .all(...(args as Parameters<ReturnType<typeof nativeDb.prepare>['all']>)),
  };

  // 1. Find sagas to scan.
  const sagaFilter = sagaId ? `AND p.id = ?` : '';
  const sagaArgs: unknown[] = sagaId ? [sagaId] : [];

  const sagas = db.all(
    `SELECT DISTINCT p.id, p.title FROM tasks_tasks p WHERE p.type = 'saga' ${sagaFilter} ORDER BY p.id`,
    ...sagaArgs,
  ) as Array<{ id: string; title: string }>;

  if (sagas.length === 0) {
    return engineSuccess({
      sagasScanned: 0,
      migrated: 0,
      skipped: 0,
      migratedEpics: [],
      conflicts: [],
      dryRun,
    });
  }

  // 2. Find legacy groups relations from Saga to Epic.
  const sagaIds = sagas.map((s) => s.id);
  const sagaPlaceholders = sagaIds.map(() => '?').join(',');

  const epics = db.all(
    `SELECT t.id, t.title, t.parent_id as parentId, p.id as sagaId
     FROM tasks_task_relations r
     JOIN tasks_tasks p ON r.task_id = p.id
     JOIN tasks_tasks t ON r.related_to = t.id
     WHERE r.relation_type = 'groups'
       AND p.type = 'saga'
       AND t.type = 'epic'
       AND p.id IN (${sagaPlaceholders})
     ORDER BY t.id`,
    ...sagaIds,
  ) as Array<{ id: string; title: string; parentId: string | null; sagaId: string }>;

  // 3. Find legacy groups relations whose target is not an Epic (conflicts).
  const tasks = db.all(
    `SELECT t.id, t.title, t.type, t.parent_id as parentId, p.id as sagaId
     FROM tasks_task_relations r
     JOIN tasks_tasks p ON r.task_id = p.id
     JOIN tasks_tasks t ON r.related_to = t.id
     WHERE r.relation_type = 'groups'
       AND p.type = 'saga'
       AND t.type != 'epic'
       AND p.id IN (${sagaPlaceholders})
     ORDER BY t.id`,
    ...sagaIds,
  ) as Array<{ id: string; title: string; type: string; parentId: string | null; sagaId: string }>;

  // 4. Process epics: migrate legacy relation rows into containment.
  const migratedEpics: MigratedEpic[] = [];
  const conflicts: ContainmentConflict[] = [];
  let skipped = 0;

  for (const epic of epics) {
    if (epic.parentId === epic.sagaId) {
      if (!dryRun) {
        await taskRelatesRemove(projectRoot, epic.sagaId, epic.id, SAGA_GROUPS_RELATION);
      }
      skipped++;
      continue;
    }
    if (epic.parentId) {
      conflicts.push({
        taskId: epic.id,
        sagaId: epic.sagaId,
        taskType: 'epic',
        taskTitle: epic.title,
        reason: `Epic already has parent_id=${epic.parentId}; refusing to overwrite with Saga ${epic.sagaId}.`,
      });
      continue;
    }

    if (dryRun) {
      migratedEpics.push({
        epicId: epic.id,
        sagaId: epic.sagaId,
        oldParentId: epic.parentId,
        groupsRelation: {
          from: epic.sagaId,
          to: epic.id,
          type: SAGA_GROUPS_RELATION,
        },
      });
      continue;
    }

    // Reparent the Epic under the Saga, then remove the legacy groups relation.
    try {
      await coreTaskReparent(projectRoot, epic.id, epic.sagaId);
      await taskRelatesRemove(projectRoot, epic.sagaId, epic.id, SAGA_GROUPS_RELATION);
    } catch (err: unknown) {
      const e = err as { message?: string };
      conflicts.push({
        taskId: epic.id,
        sagaId: epic.sagaId,
        taskType: 'epic',
        taskTitle: epic.title,
        reason: `Failed to migrate groups relation to parent_id containment: ${e?.message ?? 'unknown'}`,
      });
      continue;
    }

    const migrated: MigratedEpic = {
      epicId: epic.id,
      sagaId: epic.sagaId,
      oldParentId: epic.parentId,
      groupsRelation: {
        from: epic.sagaId,
        to: epic.id,
        type: SAGA_GROUPS_RELATION,
      },
    };
    migratedEpics.push(migrated);
    auditLine({
      ts: new Date().toISOString(),
      action: 'migrate',
      ...migrated,
    });
  }

  // 5. Document non-Epic legacy groups targets.
  for (const task of tasks) {
    conflicts.push({
      taskId: task.id,
      sagaId: task.sagaId,
      taskType: task.type,
      taskTitle: task.title,
      reason: `Non-epic task (type=${task.type}) has legacy groups relation from Saga ${task.sagaId}. Saga members must be Epics. Manual cleanup required.`,
    });
  }

  return engineSuccess({
    sagasScanned: sagas.length,
    migrated: dryRun ? migratedEpics.length : migratedEpics.length,
    skipped,
    migratedEpics,
    conflicts,
    dryRun,
  });
}
