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
import { getCleoDirAbsolute } from '../paths.js';
import { getAccessor } from '../store/data-accessor.js';

/** Snapshot format version. */
const SNAPSHOT_FORMAT_VERSION = '1.0.0';

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
export async function exportSnapshot(cwd?: string): Promise<Snapshot> {
  const accessor = await getAccessor(cwd);
  const { tasks } = await accessor.queryTasks({});
  const projectMeta = await accessor.getMetaValue<{ name?: string; currentPhase?: string | null }>(
    'project',
  );
  const version = await accessor.getMetaValue<string>('version');

  const snapshotTasks = tasks.map(toSnapshotTask);
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
 * Write a snapshot to a file.
 * @task T4882
 */
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
  const cleoDir = getCleoDirAbsolute(cwd);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return join(cleoDir, 'snapshots', `snapshot-${timestamp}.json`);
}

/**
 * Import a snapshot into the local task database.
 * Uses last-write-wins strategy: if a task exists locally and in the snapshot,
 * the snapshot version wins only if its updatedAt is newer.
 * @task T4882
 */
export async function importSnapshot(snapshot: Snapshot, cwd?: string): Promise<ImportResult> {
  const accessor = await getAccessor(cwd);
  const { tasks: localTasks } = await accessor.queryTasks({});

  const result: ImportResult = {
    added: 0,
    updated: 0,
    skipped: 0,
    conflicts: [],
  };

  const localTaskMap = new Map(localTasks.map((t) => [t.id, t]));

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
      await accessor.upsertSingleTask(newTask);
      result.added++;
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
      await accessor.upsertSingleTask(updatedTask);
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

  return result;
}
