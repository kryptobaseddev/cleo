/**
 * CLI import-tasks command - import tasks from export package with ID remapping.
 * Ported from scripts/import-tasks.sh
 * @task T4551
 * @epic T4545
 */

import { Command } from 'commander';
import { readFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getAccessor } from '../../store/data-accessor.js';
import { computeChecksum } from '../../store/json.js';
import type { Task, TaskStatus } from '../../types/task.js';
import {
  generateRemapTable,
  remapTaskReferences,
  detectDuplicateTitles,
  resolveDuplicateTitle,
} from '../../store/import-remap.js';
import type { ExportPackage } from '../../store/export.js';

/** Conflict resolution strategies. */
type OnConflict = 'duplicate' | 'rename' | 'skip' | 'fail';
type OnMissingDep = 'strip' | 'placeholder' | 'fail';

/**
 * Topologically sort tasks so parents come before children.
 * @task T4551
 */
function topologicalSort(tasks: Task[]): Task[] {
  const idSet = new Set(tasks.map((t) => t.id));
  const sorted: Task[] = [];
  const visited = new Set<string>();

  function visit(task: Task): void {
    if (visited.has(task.id)) return;
    visited.add(task.id);

    // Visit parent first if in export
    if (task.parentId && idSet.has(task.parentId)) {
      const parent = tasks.find((t) => t.id === task.parentId);
      if (parent) visit(parent);
    }

    // Visit dependencies first if in export
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

/**
 * Register the import-tasks command.
 * @task T4551
 */
export function registerImportTasksCommand(program: Command): void {
  program
    .command('import-tasks <file>')
    .description('Import tasks from .cleo-export.json package with ID remapping')
    .option('--dry-run', 'Preview import without writing to todo.json')
    .option('--parent <id>', 'Attach all imported tasks under existing parent')
    .option('--phase <phase>', 'Override phase for all imported tasks')
    .option('--add-label <label>', 'Add label to all imported tasks')
    .option('--no-provenance', 'Skip adding provenance notes')
    .option('--reset-status <status>', 'Reset all task statuses (pending|active|blocked)')
    .option('--on-conflict <mode>', 'Handle duplicate titles: duplicate|rename|skip|fail', 'fail')
    .option('--on-missing-dep <mode>', 'Handle missing deps: strip|placeholder|fail', 'strip')
    .option('--force', 'Skip conflict detection')
    .action(async (file: string, opts: Record<string, unknown>) => {
      try {
        // Validate file exists
        try {
          await access(file, fsConstants.R_OK);
        } catch {
          throw new CleoError(ExitCode.NOT_FOUND, `Export file not found: ${file}`);
        }

        // Parse export package
        const content = await readFile(file, 'utf-8');
        let exportPkg: ExportPackage;
        try {
          exportPkg = JSON.parse(content) as ExportPackage;
        } catch {
          throw new CleoError(ExitCode.VALIDATION_ERROR, `Invalid JSON in: ${file}`);
        }

        // Validate format
        if (exportPkg._meta?.format !== 'cleo-export') {
          throw new CleoError(ExitCode.VALIDATION_ERROR,
            `Invalid export format (expected 'cleo-export', got '${exportPkg._meta?.format}')`);
        }

        if (!exportPkg.tasks?.length) {
          throw new CleoError(ExitCode.VALIDATION_ERROR, 'Export package contains no tasks');
        }

        // Load existing data
        const accessor = await getAccessor();
        const todoData = await accessor.loadTodoFile();

        const onConflict = (opts['onConflict'] as OnConflict) ?? 'fail';
        const onMissingDep = (opts['onMissingDep'] as OnMissingDep) ?? 'strip';
        const force = opts['force'] as boolean ?? false;
        const dryRun = opts['dryRun'] as boolean ?? false;
        const parentId = opts['parent'] as string | undefined;
        const phaseOverride = opts['phase'] as string | undefined;
        const addLabel = opts['addLabel'] as string | undefined;
        const resetStatus = opts['resetStatus'] as TaskStatus | undefined;
        const addProvenance = opts['provenance'] !== false;

        // Validate parent exists if specified
        if (parentId) {
          const parentExists = todoData.tasks.some((t) => t.id === parentId);
          if (!parentExists) {
            throw new CleoError(ExitCode.PARENT_NOT_FOUND, `Parent task not found: ${parentId}`);
          }
        }

        // Generate remap table
        const sourceIds = exportPkg.tasks.map((t) => t.id);
        const remapTable = generateRemapTable(sourceIds, todoData.tasks);

        // Detect conflicts
        if (!force && onConflict === 'fail') {
          const duplicates = detectDuplicateTitles(exportPkg.tasks, todoData.tasks);
          if (duplicates.length > 0) {
            throw new CleoError(ExitCode.VALIDATION_ERROR,
              `${duplicates.length} duplicate title(s) detected. Use --on-conflict to resolve.`);
          }
        }

        // Topologically sort
        const sortedTasks = topologicalSort(exportPkg.tasks);

        // Transform tasks
        const existingIds = new Set(todoData.tasks.map((t) => t.id));
        const existingTitles = new Set(todoData.tasks.map((t) => t.title.toLowerCase()));
        const transformed: Task[] = [];
        const skipped: string[] = [];
        const idRemapJson: Record<string, string> = {};

        for (const [src, dst] of remapTable.forward) {
          idRemapJson[src] = dst;
        }

        for (const task of sortedTasks) {
          // Handle duplicate titles
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
                  break; // Allow duplicates
                case 'fail':
                  // Already checked above
                  break;
              }
            }
          }

          // Remap IDs ('placeholder' falls back to 'strip' for core remap logic)
          const remapStrategy: 'strip' | 'fail' = onMissingDep === 'fail' ? 'fail' : 'strip';
          const remapped = remapTaskReferences(task, remapTable, existingIds, remapStrategy);

          // Apply overrides
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

          // Add provenance note
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

        // Dry run
        if (dryRun) {
          console.log(formatSuccess({
            dryRun: true,
            summary: {
              tasksToImport: transformed.length,
              skipped: skipped.length,
              wouldWrite: false,
            },
            preview: {
              idRemap: idRemapJson,
              tasks: transformed.map((t) => ({ id: t.id, title: t.title, type: t.type ?? 'task' })),
            },
          }));
          return;
        }

        // Write to todo.json
        todoData.tasks.push(...transformed);
        todoData._meta.checksum = computeChecksum(todoData.tasks);
        todoData.lastUpdated = new Date().toISOString();
        await accessor.saveTodoFile(todoData);

        console.log(formatSuccess({
          summary: {
            imported: transformed.length,
            skipped: skipped.length,
          },
          idRemap: idRemapJson,
        }));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
