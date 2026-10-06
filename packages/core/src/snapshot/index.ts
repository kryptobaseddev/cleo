/**
 * Snapshot module for multi-contributor task state sharing.
 *
 * Exports task state from SQLite to a portable JSON format suitable for
 * git commit and cross-contributor review. Imports snapshots back into
 * the local task database with last-write-wins merge.
 *
 * @task T4882
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { resolveCleoDir } from '../paths.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { SameRowPresentError } from '../store/db-helpers.js';
import { queryTasksIncludingArchived } from '../store/import-remap.js';
import { rowUidFillEnabled } from '../store/row-identity-flag.js';

/** Snapshot format version. */
/** 1.1.0 (T12806): tasks may carry `uid` / `birthFp` (row uids on). */
const SNAPSHOT_FORMAT_VERSION = '1.1.0';

/** Snapshot metadata. */
export interface SnapshotMeta {
  format: 'cleo-snapshot';
  version: string;
  createdAt: string;
  source: {
    project: string;
    cleoVersion: string;
  };
  checksum: string;
  taskCount: number;
}

/** Portable task representation (subset of Task, omitting local-only fields). */
export interface SnapshotTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  type?: string;
  parentId?: string | null;
  size?: string | null;
  phase?: string;
  description?: string;
  depends?: string[];
  labels?: string[];
  createdAt: string;
  updatedAt?: string | null;
  completedAt?: string;
  /** Row uid (T12341), when the exporting store had one: a restore carries it (T12806). */
  uid?: string;
  /** Birth fingerprint that goes with `uid`. */
  birthFp?: string;
}

/** Complete snapshot package. */
export interface Snapshot {
  $schema: string;
  _meta: SnapshotMeta;
  project: {
    name: string;
    currentPhase?: string | null;
  };
  tasks: SnapshotTask[];
}

/** Import result summary. */
export interface ImportResult {
  added: number;
  updated: number;
  skipped: number;
  conflicts: string[];
}

/**
 * Strip a Task down to its portable snapshot representation.
 * Removes local-only fields: position, positionVersion, verification,
 * provenance, notes, acceptance, files, blockedBy.
 * @task T4882
 */
function toSnapshotTask(task: Task): SnapshotTask {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    ...(task.type != null && { type: task.type }),
    ...(task.parentId != null && { parentId: task.parentId }),
    ...(task.size != null && { size: task.size }),
    ...(task.phase != null && { phase: task.phase }),
    ...(task.description != null && { description: task.description }),
    ...(task.depends != null && task.depends.length > 0 && { depends: task.depends }),
    ...(task.labels != null && task.labels.length > 0 && { labels: task.labels }),
    createdAt: task.createdAt,
    ...(task.updatedAt != null && { updatedAt: task.updatedAt }),
    ...(task.completedAt != null && { completedAt: task.completedAt }),
  };
}

/**
 * Compute SHA-256 checksum of snapshot content.
 * @task T4882
 */
function computeChecksum(tasks: SnapshotTask[]): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(tasks));
  return hash.digest('hex').slice(0, 16);
}

/**
 * Export current task state to a snapshot.
 * @task T4882
 */
// SSoT-EXEMPT: snapshot fns use file-path/cwd args, not projectRoot+params; distinct from dispatch API signature convention per ADR-057 D1
export async function exportSnapshot(cwd?: string): Promise<Snapshot> {
  const accessor = await getTaskAccessor(cwd);
  const { tasks } = await accessor.queryTasks({});
  const projectMeta = await accessor.getMetaValue<{ name?: string; currentPhase?: string | null }>(
    'project',
  );
  const version = await accessor.getMetaValue<string>('version');

  // T12806: carry each task's row identity, so a restore re-creates the same
  // row rather than a new one. Row uids off: the snapshot is unchanged.
  const identities = new Map(
    (rowUidFillEnabled()
      ? ((await accessor.getTaskIdentities?.(tasks.map((t) => t.id))) ?? [])
      : []
    ).map((r) => [r.id, r]),
  );
  const snapshotTasks = tasks.map((task) => {
    const row = toSnapshotTask(task);
    const identity = identities.get(task.id);
    if (!identity?.uid) return row;
    return {
      ...row,
      uid: identity.uid,
      ...(identity.birthFp ? { birthFp: identity.birthFp } : {}),
    };
  });
  // T13249: a snapshot that carries uids shares this store's identity (it is
  // committed and imported elsewhere), so the store records the send: a later
  // recipe bump must never re-derive uids those copies name.
  if (snapshotTasks.some((t) => t.uid)) await markIdentityShared(cwd, 'send');
  const checksum = computeChecksum(snapshotTasks);

  return {
    $schema: 'https://lafs.dev/schemas/v1/cleo-snapshot.schema.json',
    _meta: {
      format: 'cleo-snapshot',
      version: SNAPSHOT_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      source: {
        project: projectMeta?.name ?? 'unknown',
        cleoVersion: version ?? '0.0.0',
      },
      checksum,
      taskCount: snapshotTasks.length,
    },
    project: {
      name: projectMeta?.name ?? 'unknown',
      ...(projectMeta?.currentPhase != null && {
        currentPhase: projectMeta.currentPhase,
      }),
    },
    tasks: snapshotTasks,
  };
}

/**
 * Record on the store that its row identity left it, or came from elsewhere
 * (`row_identity_synced`), so the full identity refill refuses (T13249).
 * Never skipped: without a bound handle the store is opened through the
 * chokepoint, and a failure throws (T13270), since a snapshot that carries
 * uids with no marker would let a later refill re-derive them.
 */
async function markIdentityShared(
  cwd: string | undefined,
  direction: 'send' | 'receive',
): Promise<void> {
  const { getNativeTasksDb } = await import('../store/sqlite.js');
  let db = getNativeTasksDb(cwd);
  if (!db) {
    const { openDualScopeDb, getDualScopeNativeDb } = await import('../store/dual-scope-db.js');
    db = getDualScopeNativeDb(await openDualScopeDb('project', cwd));
    // The marker goes through the chokepoint writers.
    await import('../store/sqlite-data-accessor.js');
  }
  const { markRowIdentityShared } = await import('../store/row-identity.js');
  markRowIdentityShared(db, direction);
}

/**
 * Write a snapshot to a file.
 * @task T4882
 */
// SSoT-EXEMPT: snapshot fns use file-path/cwd args, not projectRoot+params; distinct from dispatch API signature convention per ADR-057 D1
export async function writeSnapshot(snapshot: Snapshot, outputPath: string): Promise<void> {
  const dir = dirname(outputPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(outputPath, JSON.stringify(snapshot, null, 2) + '\n');
}

/**
 * Read a snapshot from a file.
 * @task T4882
 */
// SSoT-EXEMPT: snapshot fns use file-path/cwd args, not projectRoot+params; distinct from dispatch API signature convention per ADR-057 D1
export async function readSnapshot(inputPath: string): Promise<Snapshot> {
  const content = await readFile(inputPath, 'utf-8');
  const parsed = JSON.parse(content) as Snapshot;

  if (parsed._meta?.format !== 'cleo-snapshot') {
    throw new Error(
      `Invalid snapshot format: expected 'cleo-snapshot', got '${parsed._meta?.format}'`,
    );
  }

  return parsed;
}

/**
 * Generate a default snapshot file path.
 * @task T4882
 */
export function getDefaultSnapshotPath(cwd?: string): string {
  const cleoDir = resolveCleoDir(cwd);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return join(cleoDir, 'snapshots', `snapshot-${timestamp}.json`);
}

/**
 * Import a snapshot into the local task database.
 * Uses last-write-wins strategy: if a task exists locally and in the snapshot,
 * the snapshot version wins only if its updatedAt is newer.
 * @task T4882
 */
// SSoT-EXEMPT: snapshot fns use file-path/cwd args, not projectRoot+params; distinct from dispatch API signature convention per ADR-057 D1
export async function importSnapshot(snapshot: Snapshot, cwd?: string): Promise<ImportResult> {
  const accessor = await getTaskAccessor(cwd);
  // Every stored task, archived included: an archived task is still local, so
  // re-importing a snapshot that holds it stays idempotent (T12724).
  const localTasks = await queryTasksIncludingArchived(accessor);

  const result: ImportResult = {
    added: 0,
    updated: 0,
    skipped: 0,
    conflicts: [],
  };

  const localTaskMap = new Map(localTasks.map((t) => [t.id, t]));
  // T12806: the row identity of the local tasks the snapshot names (uids on).
  const localUids = new Map(
    (rowUidFillEnabled()
      ? ((await accessor.getTaskIdentities?.(snapshot.tasks.map((t) => t.id))) ?? [])
      : []
    ).map((r) => [r.id, r.uid]),
  );

  // Tasks inserted with the snapshot's uid: this store now holds identity
  // minted elsewhere (T13249).
  let receivedUids = 0;
  // One transaction: a collision on any task leaves nothing half-imported (T12724).
  await accessor.transaction(async (tx) => {
    for (const snapshotTask of snapshot.tasks) {
      const localTask = localTaskMap.get(snapshotTask.id);

      if (!localTask) {
        // New task -- add it
        const newTask: Task = {
          id: snapshotTask.id,
          title: snapshotTask.title,
          status: snapshotTask.status as Task['status'],
          priority: snapshotTask.priority as Task['priority'],
          type: snapshotTask.type as Task['type'],
          parentId: snapshotTask.parentId,
          size: snapshotTask.size as Task['size'],
          phase: snapshotTask.phase,
          description: snapshotTask.description ?? '',
          depends: snapshotTask.depends,
          labels: snapshotTask.labels,
          createdAt: snapshotTask.createdAt,
          updatedAt: snapshotTask.updatedAt,
          completedAt: snapshotTask.completedAt,
        };
        // Missing locally: insert, never overwrite a task stored since (T12724).
        // A restore re-creates an existing row: it carries the snapshot's uid,
        // or leaves it to the deterministic recipe, never a new one (T12806).
        try {
          await tx.insertNewTask(newTask, {
            origin: 'imported',
            uid: snapshotTask.uid ?? null,
            birthFp: snapshotTask.birthFp ?? null,
          });
        } catch (error) {
          // The same row (uid + fingerprint) is here already, under another id
          // or held for sync: writing it again would duplicate the work.
          if (!(error instanceof SameRowPresentError)) throw error;
          result.skipped++;
          result.conflicts.push(
            `${snapshotTask.id}: already present ${error.presentAs === 'held' ? '(held for sync)' : `as ${error.presentAs}`} (same uid and birth fingerprint); not restored`,
          );
          continue;
        }
        result.added++;
        if (snapshotTask.uid) receivedUids++;
        continue;
      }

      // The same id names DIFFERENT rows here and in the snapshot (row uids
      // on): never overwrite one with the other; report it (T12806 review).
      const localUid = localUids.get(snapshotTask.id);
      if (snapshotTask.uid && localUid && localUid !== snapshotTask.uid) {
        result.skipped++;
        result.conflicts.push(
          `${snapshotTask.id}: the snapshot's task (uid ${snapshotTask.uid}) is a different row from the local one (uid ${localUid}); not overwritten`,
        );
        continue;
      }

      // Task exists locally -- compare timestamps
      const localUpdated = localTask.updatedAt ?? localTask.createdAt;
      const snapshotUpdated = snapshotTask.updatedAt ?? snapshotTask.createdAt;

      if (snapshotUpdated > localUpdated) {
        // Snapshot is newer -- update local via upsert (preserves fields not in snapshot)
        const updatedTask: Task = {
          ...localTask,
          title: snapshotTask.title,
          status: snapshotTask.status as Task['status'],
          priority: snapshotTask.priority as Task['priority'],
          ...(snapshotTask.description != null && { description: snapshotTask.description }),
          ...(snapshotTask.labels != null && { labels: snapshotTask.labels }),
          ...(snapshotTask.depends != null && { depends: snapshotTask.depends }),
          updatedAt: snapshotTask.updatedAt,
          ...(snapshotTask.completedAt != null && { completedAt: snapshotTask.completedAt }),
        };
        await tx.upsertSingleTask(updatedTask);
        result.updated++;
      } else if (snapshotUpdated === localUpdated) {
        result.skipped++;
      } else {
        // Local is newer -- skip but note conflict
        result.skipped++;
        if (localTask.title !== snapshotTask.title || localTask.status !== snapshotTask.status) {
          result.conflicts.push(
            `${snapshotTask.id}: local is newer (local: ${localUpdated}, snapshot: ${snapshotUpdated})`,
          );
        }
      }
    }
  });
  if (receivedUids > 0) await markIdentityShared(cwd, 'receive');

  return result;
}
