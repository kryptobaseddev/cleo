/**
 * Core export-tasks logic — export tasks to portable cross-project packages.
 *
 * Extracted from CLI export-tasks command for dispatch layer access.
 *
 * @task T5323, T5328
 * @epic T4545
 */

import { getAccessor } from '../../store/data-accessor.js';
import { writeFile } from 'node:fs/promises';
import type { Task } from '../../types/task.js';
import { buildExportPackage } from '../../store/export.js';

interface FilterEntry {
  key: string;
  value: string;
}

function parseFilter(filter: string): FilterEntry | null {
  const eqIdx = filter.indexOf('=');
  if (eqIdx < 1) return null;
  return { key: filter.substring(0, eqIdx), value: filter.substring(eqIdx + 1) };
}

function applyFilters(tasks: Task[], filters: FilterEntry[]): Task[] {
  let result = tasks;
  for (const filter of filters) {
    switch (filter.key) {
      case 'status': {
        const values = filter.value.split(',').map((s) => s.trim());
        result = result.filter((t) => values.includes(t.status));
        break;
      }
      case 'phase':
        result = result.filter((t) => t.phase === filter.value);
        break;
      case 'priority': {
        const values = filter.value.split(',').map((s) => s.trim());
        result = result.filter((t) => values.includes(t.priority));
        break;
      }
      case 'labels': {
        const values = filter.value.split(',').map((s) => s.trim());
        result = result.filter((t) =>
          t.labels?.some((l) => values.includes(l)) ?? false,
        );
        break;
      }
      case 'type': {
        const values = filter.value.split(',').map((s) => s.trim());
        result = result.filter((t) => values.includes(t.type ?? 'task'));
        break;
      }
    }
  }
  return result;
}

function collectSubtree(rootIds: string[], allTasks: Task[]): Task[] {
  const collected = new Map<string, Task>();
  const queue = [...rootIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (collected.has(id)) continue;
    const task = allTasks.find((t) => t.id === id);
    if (!task) continue;
    collected.set(id, task);
    const children = allTasks.filter((t) => t.parentId === id);
    queue.push(...children.map((c) => c.id));
  }
  return [...collected.values()];
}

function expandDependencies(selectedIds: Set<string>, allTasks: Task[]): Task[] {
  const expanded = new Set<string>(selectedIds);
  const queue = [...selectedIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const task = allTasks.find((t) => t.id === id);
    if (!task) continue;
    for (const dep of task.depends ?? []) {
      if (!expanded.has(dep)) {
        expanded.add(dep);
        queue.push(dep);
      }
    }
  }
  return allTasks.filter((t) => expanded.has(t.id));
}

export interface ExportTasksParams {
  taskIds?: string[];
  output?: string;
  subtree?: boolean;
  filter?: string[];
  includeDeps?: boolean;
  dryRun?: boolean;
  cwd?: string;
}

export interface ExportTasksResult {
  exportMode: string;
  taskCount: number;
  taskIds: string[];
  outputPath?: string;
  content?: string;
  dryRun?: boolean;
}

/**
 * Export tasks to a portable cross-project package.
 */
export async function exportTasksPackage(params: ExportTasksParams): Promise<ExportTasksResult> {
  const accessor = await getAccessor(params.cwd);
  const taskData = await accessor.loadTaskFile();

  const allTasks = taskData.tasks;
  const subtreeMode = params.subtree ?? false;
  const includeDeps = params.includeDeps ?? false;
  const filterStrs = params.filter;

  const parsedIds = (params.taskIds ?? [])
    .flatMap((id) => id.split(',').map((s) => s.trim()))
    .filter(Boolean);

  const filters: FilterEntry[] = [];
  if (filterStrs) {
    for (const f of filterStrs) {
      const parsed = parseFilter(f);
      if (parsed) filters.push(parsed);
    }
  }

  let selectedTasks: Task[];
  let exportMode: string;

  if (parsedIds.length > 0) {
    for (const id of parsedIds) {
      if (!allTasks.find((t) => t.id === id)) {
        throw new Error(`Task not found: ${id}`);
      }
    }
    if (subtreeMode) {
      exportMode = 'subtree';
      selectedTasks = collectSubtree(parsedIds, allTasks);
    } else {
      exportMode = 'single';
      selectedTasks = allTasks.filter((t) => parsedIds.includes(t.id));
    }
  } else if (filters.length > 0) {
    exportMode = 'filter';
    selectedTasks = applyFilters(allTasks, filters);
    if (subtreeMode) {
      const rootIds = selectedTasks.map((t) => t.id);
      selectedTasks = collectSubtree(rootIds, allTasks);
    }
  } else {
    exportMode = 'full';
    selectedTasks = allTasks;
  }

  if (includeDeps && selectedTasks.length > 0) {
    const selectedIds = new Set(selectedTasks.map((t) => t.id));
    selectedTasks = expandDependencies(selectedIds, allTasks);
  }

  if (selectedTasks.length === 0) {
    throw new Error('No tasks match selection criteria');
  }

  if (params.dryRun) {
    return {
      dryRun: true,
      exportMode,
      taskCount: selectedTasks.length,
      taskIds: selectedTasks.map((t) => t.id),
    };
  }

  const pkg = buildExportPackage(selectedTasks, taskData, {
    mode: exportMode,
    rootTaskIds: parsedIds.length > 0 ? parsedIds : selectedTasks.map((t) => t.id),
    includeChildren: subtreeMode,
    filters: filters.length > 0 ? filters : undefined,
  });

  const content = JSON.stringify(pkg, null, 2);

  if (params.output) {
    await writeFile(params.output, content);
    return {
      exportMode,
      taskCount: selectedTasks.length,
      taskIds: selectedTasks.map((t) => t.id),
      outputPath: params.output,
    };
  }

  return {
    exportMode,
    taskCount: selectedTasks.length,
    taskIds: selectedTasks.map((t) => t.id),
    content,
  };
}
