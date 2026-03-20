/**
 * Core import-tasks logic — import tasks from cross-project export packages.
 *
 * Extracted from CLI import-tasks command for dispatch layer access.
 *
 * @task T5323, T5328, T046
 * @epic T4545
 */

import { constants as fsConstants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import type { Task, TaskStatus } from '@cleocode/contracts';
import type { ImportFromPackageOptions, ImportFromPackageResult } from '../nexus/transfer-types.js';
import { getAccessor } from '../store/data-accessor.js';
import type { ExportPackage } from '../store/export.js';
import {
  detectDuplicateTitles,
  generateRemapTable,
  remapTaskReferences,
  resolveDuplicateTitle,
} from '../store/import-remap.js';

type OnConflict = 'duplicate' | 'rename' | 'skip' | 'fail';
type OnMissingDep = 'strip' | 'placeholder' | 'fail';

function topologicalSort(tasks: Task[]): Task[] {
  const idSet = new Set(tasks.map((t) => t.id));
  const sorted: Task[] = [];
  const visited = new Set<string>();

  function visit(task: Task): void {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    if (task.parentId && idSet.has(task.parentId)) {
      const parent = tasks.find((t) => t.id === task.parentId);
      if (parent) visit(parent);
    }
    for (const dep of task.depends ?? []) {
      if (idSet.has(dep)) {
        const depTask = tasks.find((t) => t.id === dep);
        if (depTask) visit(depTask);
      }
    }
    sorted.push(task);
  }

  for (const task of tasks) {
    visit(task);
  }
  return sorted;
}

export interface ImportTasksParams {
  file: string;
  dryRun?: boolean;
  parent?: string;
  phase?: string;
  addLabel?: string;
  provenance?: boolean;
  resetStatus?: TaskStatus;
  onConflict?: OnConflict;
  onMissingDep?: OnMissingDep;
  force?: boolean;
  cwd?: string;
}

export interface ImportTasksResult {
  imported: number;
  skipped: number;
  idRemap: Record<string, string>;
  dryRun?: boolean;
  preview?: {
    tasks: Array<{ id: string; title: string; type: string }>;
  };
}

/**
 * Import tasks from an in-memory ExportPackage with ID remapping.
 * Core logic extracted from importTasksPackage for reuse by transfer engine.
 */
export async function importFromPackage(
  exportPkg: ExportPackage,
  options: ImportFromPackageOptions = {},
): Promise<ImportFromPackageResult> {
  if (exportPkg._meta?.format !== 'cleo-export') {
    throw new Error(
      `Invalid export format (expected 'cleo-export', got '${exportPkg._meta?.format}')`,
    );
  }

  if (!exportPkg.tasks?.length) {
    throw new Error('Export package contains no tasks');
  }

  const accessor = await getAccessor(options.cwd);
  const { tasks: existingTasks } = await accessor.queryTasks({});

  const onConflict: OnConflict = options.onConflict ?? 'fail';
  const onMissingDep: OnMissingDep = options.onMissingDep === 'fail' ? 'fail' : 'strip';
  const force = options.force ?? false;
  const parentId = options.parent;
  const phaseOverride = options.phase;
  const addLabel = options.addLabel;
  const resetStatus = options.resetStatus;
  const addProvenance = options.provenance !== false;

  if (parentId) {
    const parentExists = existingTasks.some((t) => t.id === parentId);
    if (!parentExists) {
      throw new Error(`Parent task not found: ${parentId}`);
    }
  }

  const sourceIds = exportPkg.tasks.map((t) => t.id);
  const remapTable = generateRemapTable(sourceIds, existingTasks);

  if (!force && onConflict === 'fail') {
    const duplicates = detectDuplicateTitles(exportPkg.tasks, existingTasks);
    if (duplicates.length > 0) {
      throw new Error(
        `${duplicates.length} duplicate title(s) detected. Use onConflict to resolve.`,
      );
    }
  }

  const sortedTasks = topologicalSort(exportPkg.tasks);

  const existingIds = new Set(existingTasks.map((t) => t.id));
  const existingTitles = new Set(existingTasks.map((t) => t.title.toLowerCase()));
  const transformed: Task[] = [];
  const skipped: string[] = [];
  const idRemapJson: Record<string, string> = {};

  for (const [src, dst] of remapTable.forward) {
    idRemapJson[src] = dst;
  }

  for (const task of sortedTasks) {
    if (!force) {
      const titleLower = task.title.toLowerCase();
      if (existingTitles.has(titleLower)) {
        switch (onConflict) {
          case 'skip':
            skipped.push(task.id);
            continue;
          case 'rename':
            task.title = resolveDuplicateTitle(task.title, existingTitles);
            break;
          case 'duplicate':
            break;
          case 'fail':
            break;
        }
      }
    }

    const remapStrategy: 'strip' | 'fail' = onMissingDep === 'fail' ? 'fail' : 'strip';
    const remapped = remapTaskReferences(task, remapTable, existingIds, remapStrategy);

    if (parentId) remapped.parentId = parentId;
    if (phaseOverride) remapped.phase = phaseOverride;
    if (addLabel) {
      remapped.labels = remapped.labels ?? [];
      if (!remapped.labels.includes(addLabel)) {
        remapped.labels.push(addLabel);
      }
    }
    if (resetStatus) {
      remapped.status = resetStatus;
    }

    if (addProvenance) {
      const originalId = remapTable.reverse.get(remapped.id) ?? remapped.id;
      const sourceProject = exportPkg._meta?.source?.project ?? 'unknown';
      const importDate = new Date().toISOString().split('T')[0];
      remapped.notes = remapped.notes ?? [];
      remapped.notes.push(`[Imported from ${sourceProject} as ${originalId} on ${importDate}]`);
    }

    remapped.updatedAt = new Date().toISOString();

    transformed.push(remapped);
    existingTitles.add(remapped.title.toLowerCase());
    existingIds.add(remapped.id);
  }

  if (options.dryRun) {
    return {
      imported: transformed.length,
      skipped: skipped.length,
      idRemap: idRemapJson,
      dryRun: true,
      preview: {
        tasks: transformed.map((t) => ({ id: t.id, title: t.title, type: t.type ?? 'task' })),
      },
    };
  }

  for (const task of transformed) {
    await accessor.upsertSingleTask(task);
  }

  return {
    imported: transformed.length,
    skipped: skipped.length,
    idRemap: idRemapJson,
  };
}

/**
 * Import tasks from a cross-project export package file with ID remapping.
 * Thin wrapper around importFromPackage that handles file I/O.
 */
export async function importTasksPackage(params: ImportTasksParams): Promise<ImportTasksResult> {
  const { file } = params;

  try {
    await access(file, fsConstants.R_OK);
  } catch {
    throw new Error(`Export file not found: ${file}`);
  }

  const content = await readFile(file, 'utf-8');
  let exportPkg: ExportPackage;
  try {
    exportPkg = JSON.parse(content) as ExportPackage;
  } catch {
    throw new Error(`Invalid JSON in: ${file}`);
  }

  return importFromPackage(exportPkg, {
    cwd: params.cwd,
    dryRun: params.dryRun,
    parent: params.parent,
    phase: params.phase,
    addLabel: params.addLabel,
    provenance: params.provenance,
    resetStatus: params.resetStatus,
    onConflict: params.onConflict,
    onMissingDep: params.onMissingDep === 'placeholder' ? 'strip' : params.onMissingDep,
    force: params.force,
  });
}
