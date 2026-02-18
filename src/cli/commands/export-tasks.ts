/**
 * CLI export-tasks command - export tasks to portable package for cross-project transfer.
 * Ported from scripts/export-tasks.sh
 * @task T4551
 * @epic T4545
 */

import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getAccessor } from '../../store/data-accessor.js';
import type { Task } from '../../types/task.js';
import {
  buildExportPackage,
} from '../../store/export.js';

/** Filter key-value pair (e.g., "status=pending"). */
interface FilterEntry {
  key: string;
  value: string;
}

/**
 * Parse filter string "key=value" into FilterEntry.
 * @task T4551
 */
function parseFilter(filter: string): FilterEntry | null {
  const eqIdx = filter.indexOf('=');
  if (eqIdx < 1) return null;
  return { key: filter.substring(0, eqIdx), value: filter.substring(eqIdx + 1) };
}

/**
 * Apply filters to task list.
 * @task T4551
 */
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

/**
 * Collect all descendants of given task IDs.
 * @task T4551
 */
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

/**
 * Expand dependencies of selected tasks.
 * @task T4551
 */
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

/**
 * Register the export-tasks command.
 * @task T4551
 */
export function registerExportTasksCommand(program: Command): void {
  program
    .command('export-tasks [taskIds...]')
    .description('Export tasks to portable .cleo-export.json package for cross-project transfer')
    .option('-o, --output <file>', 'Output file path (stdout if omitted)')
    .option('--subtree', 'Include all descendants of specified task(s)')
    .option('--filter <filters...>', 'Filter tasks by criteria (key=value, repeatable)')
    .option('--include-deps', 'Auto-include task dependencies')
    .option('--dry-run', 'Preview selection without creating export file')
    .action(async (taskIds: string[], opts: Record<string, unknown>) => {
      try {
        const accessor = await getAccessor();
        const todoData = await accessor.loadTodoFile();

        const allTasks = todoData.tasks;
        const subtreeMode = opts['subtree'] as boolean ?? false;
        const includeDeps = opts['includeDeps'] as boolean ?? false;
        const dryRun = opts['dryRun'] as boolean ?? false;
        const outputFile = opts['output'] as string | undefined;
        const filterStrs = opts['filter'] as string[] | undefined;

        // Parse task IDs (may be comma-separated)
        const parsedIds = taskIds.flatMap((id) => id.split(',').map((s) => s.trim())).filter(Boolean);

        // Parse filters
        const filters: FilterEntry[] = [];
        if (filterStrs) {
          for (const f of filterStrs) {
            const parsed = parseFilter(f);
            if (parsed) filters.push(parsed);
          }
        }

        // Determine export mode and select tasks
        let selectedTasks: Task[];
        let exportMode: string;

        if (parsedIds.length > 0) {
          // Validate task IDs exist
          for (const id of parsedIds) {
            if (!allTasks.find((t) => t.id === id)) {
              throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${id}`);
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

        // Expand dependencies if requested
        if (includeDeps && selectedTasks.length > 0) {
          const selectedIds = new Set(selectedTasks.map((t) => t.id));
          selectedTasks = expandDependencies(selectedIds, allTasks);
        }

        if (selectedTasks.length === 0) {
          throw new CleoError(ExitCode.VALIDATION_ERROR, 'No tasks match selection criteria');
        }

        // Dry run
        if (dryRun) {
          console.log(formatSuccess({
            dryRun: true,
            exportMode,
            taskCount: selectedTasks.length,
            taskIds: selectedTasks.map((t) => t.id),
          }, `Would export ${selectedTasks.length} task(s)`));
          return;
        }

        // Build export package
        const pkg = buildExportPackage(selectedTasks, todoData, {
          mode: exportMode,
          rootTaskIds: parsedIds.length > 0 ? parsedIds : selectedTasks.map((t) => t.id),
          includeChildren: subtreeMode,
          filters: filters.length > 0 ? filters : undefined,
        });

        const output = JSON.stringify(pkg, null, 2);

        if (outputFile) {
          await writeFile(outputFile, output);
          console.log(formatSuccess({
            exportMode,
            taskCount: selectedTasks.length,
            outputPath: outputFile,
          }));
        } else {
          process.stdout.write(output);
          if (!output.endsWith('\n')) process.stdout.write('\n');
        }
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
