/**
 * Export package generation for task data interchange.
 * Ported from lib/data/export.sh
 *
 * @epic T4454
 * @task T4530
 */

import { createHash } from 'node:crypto';
import type { Task, TodoFile } from '../types/task.js';

/** Export format version. */
const EXPORT_FORMAT_VERSION = '1.0.0';

/** Export package metadata. */
export interface ExportMeta {
  format: 'cleo-export';
  version: string;
  exportedAt: string;
  source: {
    project: string;
    cleo_version: string;
    nextId: number;
  };
  checksum: string;
  taskCount: number;
  exportMode: string;
}

/** Export selection criteria. */
export interface ExportSelection {
  mode: string;
  rootTaskIds: string[];
  includeChildren: boolean;
  filters?: unknown;
}

/** ID map entry. */
export interface IdMapEntry {
  type: string;
  title: string;
  status: string;
  parentId: string | null;
  depends: string[];
}

/** Relationship graph. */
export interface RelationshipGraph {
  hierarchy: Record<string, string[]>;
  dependencies: Record<string, string[]>;
  roots: string[];
}

/** Complete export package. */
export interface ExportPackage {
  $schema: string;
  _meta: ExportMeta;
  selection: ExportSelection;
  idMap: Record<string, IdMapEntry>;
  tasks: Task[];
  relationshipGraph: RelationshipGraph;
}

/**
 * Calculate SHA-256 checksum for export integrity (truncated to 16 hex chars).
 */
export function calculateExportChecksum(tasksJson: string): string {
  const canonical = JSON.stringify(JSON.parse(tasksJson));
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Verify export package checksum.
 */
export function verifyExportChecksum(pkg: ExportPackage): boolean {
  const tasksJson = JSON.stringify(pkg.tasks);
  const calculated = calculateExportChecksum(tasksJson);
  return pkg._meta.checksum === calculated;
}

/**
 * Build ID map from tasks.
 */
export function buildIdMap(tasks: Task[]): Record<string, IdMapEntry> {
  const map: Record<string, IdMapEntry> = {};
  for (const task of tasks) {
    map[task.id] = {
      type: task.type ?? 'task',
      title: task.title,
      status: task.status,
      parentId: task.parentId ?? null,
      depends: task.depends ?? [],
    };
  }
  return map;
}

/**
 * Build relationship graph from tasks.
 */
export function buildRelationshipGraph(tasks: Task[]): RelationshipGraph {
  const exportedIds = new Set(tasks.map((t) => t.id));

  const hierarchy: Record<string, string[]> = {};
  const dependencies: Record<string, string[]> = {};

  for (const task of tasks) {
    // Hierarchy
    if (task.parentId && exportedIds.has(task.parentId)) {
      if (!hierarchy[task.parentId]) hierarchy[task.parentId] = [];
      hierarchy[task.parentId].push(task.id);
    }

    // Dependencies
    if (task.depends?.length) {
      const internalDeps = task.depends.filter((d) => exportedIds.has(d));
      if (internalDeps.length > 0) {
        dependencies[task.id] = internalDeps;
      }
    }
  }

  // Roots: tasks with no parent in export and no deps in export
  const roots = tasks
    .filter((t) => {
      const hasParentInExport = t.parentId && exportedIds.has(t.parentId);
      const hasDepsInExport = t.depends?.some((d) => exportedIds.has(d));
      return !hasParentInExport && !hasDepsInExport;
    })
    .map((t) => t.id);

  return { hierarchy, dependencies, roots };
}

/**
 * Build a complete export package.
 */
export function buildExportPackage(
  tasks: Task[],
  todoData: TodoFile,
  options: {
    mode: string;
    rootTaskIds: string[];
    includeChildren: boolean;
    cleoVersion?: string;
    filters?: unknown;
  },
): ExportPackage {
  const now = new Date().toISOString();
  const projectName = todoData.project?.name ?? 'unknown';
  const maxId = tasks.reduce((max, t) => {
    const num = parseInt(t.id.replace('T', ''), 10);
    return num > max ? num : max;
  }, 0);

  const idMap = buildIdMap(tasks);
  const relationshipGraph = buildRelationshipGraph(tasks);
  const tasksJson = JSON.stringify(tasks);
  const checksum = calculateExportChecksum(tasksJson);

  return {
    $schema: 'https://cleo-dev.com/schemas/v1/export-package.schema.json',
    _meta: {
      format: 'cleo-export',
      version: EXPORT_FORMAT_VERSION,
      exportedAt: now,
      source: {
        project: projectName,
        cleo_version: options.cleoVersion ?? '0.95.0',
        nextId: maxId + 1,
      },
      checksum,
      taskCount: tasks.length,
      exportMode: options.mode,
    },
    selection: {
      mode: options.mode,
      rootTaskIds: options.rootTaskIds,
      includeChildren: options.includeChildren,
      filters: options.filters,
    },
    idMap,
    tasks,
    relationshipGraph,
  };
}

/**
 * Export a single task.
 */
export function exportSingle(taskId: string, todoData: TodoFile): ExportPackage | null {
  const task = todoData.tasks.find((t) => t.id === taskId);
  if (!task) return null;

  return buildExportPackage([task], todoData, {
    mode: 'single',
    rootTaskIds: [taskId],
    includeChildren: false,
  });
}

/**
 * Export a subtree (task + all descendants).
 */
export function exportSubtree(rootId: string, todoData: TodoFile): ExportPackage | null {
  const root = todoData.tasks.find((t) => t.id === rootId);
  if (!root) return null;

  // Collect all descendants
  const collected = new Map<string, Task>();
  const queue = [rootId];

  while (queue.length > 0) {
    const id = queue.shift()!;
    const task = todoData.tasks.find((t) => t.id === id);
    if (!task || collected.has(id)) continue;
    collected.set(id, task);
    const children = todoData.tasks.filter((t) => t.parentId === id);
    queue.push(...children.map((c) => c.id));
  }

  const tasks = [...collected.values()];
  return buildExportPackage(tasks, todoData, {
    mode: 'subtree',
    rootTaskIds: [rootId],
    includeChildren: true,
  });
}
