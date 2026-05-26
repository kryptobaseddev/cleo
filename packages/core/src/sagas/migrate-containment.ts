/**
 * saga.migrate-containment — migrate parent_id-based Saga membership to groups relations.
 *
 * Pre-T10636, Sagas were stored as `type='epic'` with `label='saga'`, and member
 * Epics (and sometimes Tasks) linked back to the Saga via `parent_id`. After
 * T10636 established `type='saga'` as the canonical record, those parent-child
 * edges violate ADR-073 §1.2 invariant I5 (Sagas must not use parentId for
 * membership).
 *
 * This migration:
 * 1. Finds all Epics whose `parent_id` points to a Saga (`type='saga'`)
 * 2. For each Epic without a pre-existing `groups` relation: creates the
 *    `task_relations.relation_type='groups'` edge (Saga → Epic) and clears
 *    the Epic's `parent_id`
 * 3. Documents Tasks (non-Epics) with Saga parents as conflicts — these need
 *    manual resolution since Tasks should not be direct Saga children
 * 4. Is fully idempotent — re-running on an already-migrated state returns
 *    `migrated: 0, skipped: N, conflicts: [...]`
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
import { taskRelatesAdd } from '../tasks/engine-wrap.js';
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
  /** Number of Epics successfully migrated (parent_id → groups). */
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
 * Migrate parent_id-based Saga membership to `task_relations.type='groups'`.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param params - Optional sagaId and dry-run flag.
 */
export async function migrateSagaContainment(
  projectRoot: string,
  params: MigrateSagaContainmentParams = {},
): Promise<EngineResult<MigrateSagaContainmentResult>> {
  const { sagaId, dryRun = false } = params;
  const accessor = await getTaskAccessor(projectRoot);
  const db = (accessor as { db?: { all: (sql: string, ...args: unknown[]) => unknown[] } }).db;

  if (!db) {
    return engineError('E_GENERAL', 'Database handle not available from accessor');
  }

  // 1. Find sagas to scan.
  const sagaFilter = sagaId ? `AND p.id = ?` : '';
  const sagaArgs: unknown[] = sagaId ? [sagaId] : [];

  const sagas = db.all(
    `SELECT DISTINCT p.id, p.title FROM tasks p WHERE p.type = 'saga' ${sagaFilter} ORDER BY p.id`,
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

  // 2. Find all Epics with parent_id pointing to a Saga.
  const sagaIds = sagas.map((s) => s.id);
  const sagaPlaceholders = sagaIds.map(() => '?').join(',');

  const epics = db.all(
    `SELECT t.id, t.title, t.parent_id as parentId, p.id as sagaId
     FROM tasks t
     JOIN tasks p ON t.parent_id = p.id
     WHERE p.type = 'saga'
       AND t.type = 'epic'
       AND p.id IN (${sagaPlaceholders})
     ORDER BY t.id`,
    ...sagaIds,
  ) as Array<{ id: string; title: string; parentId: string; sagaId: string }>;

  // 3. Find all non-Epic tasks with parent_id pointing to a Saga (conflicts).
  const tasks = db.all(
    `SELECT t.id, t.title, t.type, t.parent_id as parentId, p.id as sagaId
     FROM tasks t
     JOIN tasks p ON t.parent_id = p.id
     WHERE p.type = 'saga'
       AND t.type != 'epic'
       AND p.id IN (${sagaPlaceholders})
     ORDER BY t.id`,
    ...sagaIds,
  ) as Array<{ id: string; title: string; type: string; parentId: string; sagaId: string }>;

  // 4. Check which epics already have groups relations.
  const epicIds = epics.map((e) => e.id);
  const existingRelations = new Set<string>();
  if (epicIds.length > 0) {
    const epicPlaceholders = epicIds.map(() => '?').join(',');
    const rows = db.all(
      `SELECT task_id, related_to FROM task_relations
       WHERE relation_type = 'groups'
         AND task_id IN (${sagaPlaceholders})
         AND related_to IN (${epicPlaceholders})`,
      ...sagaIds,
      ...epicIds,
    ) as Array<{ task_id: string; related_to: string }>;
    for (const r of rows) {
      existingRelations.add(`${r.task_id}:${r.related_to}`);
    }
  }

  // 5. Process epics: migrate those without existing groups relations.
  const migratedEpics: MigratedEpic[] = [];
  const conflicts: ContainmentConflict[] = [];
  let skipped = 0;

  for (const epic of epics) {
    const key = `${epic.sagaId}:${epic.id}`;
    if (existingRelations.has(key)) {
      // Already migrated — just clear parent_id if it's still set.
      if (!dryRun && epic.parentId) {
        try {
          await coreTaskReparent(projectRoot, epic.id, null);
          auditLine({
            ts: new Date().toISOString(),
            action: 'reparent-only',
            epicId: epic.id,
            sagaId: epic.sagaId,
            note: 'groups relation already exists; cleared residual parent_id',
          });
        } catch {
          // Non-fatal — the groups relation is the important part.
        }
      }
      skipped++;
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

    // Create the groups relation (Saga → Epic).
    const relResult = await taskRelatesAdd(
      projectRoot,
      epic.sagaId,
      epic.id,
      SAGA_GROUPS_RELATION,
      `Migrated parent_id containment via cleo saga migrate-containment (T10637)`,
    );
    if (!relResult.success) {
      conflicts.push({
        taskId: epic.id,
        sagaId: epic.sagaId,
        taskType: 'epic',
        taskTitle: epic.title,
        reason: `Failed to create groups relation: ${relResult.error?.message ?? 'unknown'}`,
      });
      continue;
    }

    // Clear the parent_id on the Epic.
    try {
      await coreTaskReparent(projectRoot, epic.id, null);
    } catch (err: unknown) {
      const e = err as { message?: string };
      conflicts.push({
        taskId: epic.id,
        sagaId: epic.sagaId,
        taskType: 'epic',
        taskTitle: epic.title,
        reason: `Groups relation created but failed to clear parent_id: ${e?.message ?? 'unknown'}`,
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

  // 6. Document task→Saga conflicts (non-Epic tasks with Saga parents).
  for (const task of tasks) {
    conflicts.push({
      taskId: task.id,
      sagaId: task.sagaId,
      taskType: task.type,
      taskTitle: task.title,
      reason: `Non-epic task (type=${task.type}) with parent_id pointing to Saga ${task.sagaId}. Tasks should be children of member Epics, not direct Saga children. Manual reparenting required.`,
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
