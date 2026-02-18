/**
 * CLI import command - import tasks from export package.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getAccessor } from '../../store/data-accessor.js';
import { computeChecksum } from '../../store/json.js';
import { readFile, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { Task, TaskStatus, TaskPriority } from '../../types/task.js';

type DuplicateStrategy = 'skip' | 'overwrite' | 'rename';

function generateTaskId(existingIds: Set<string>): string {
  let maxNum = 0;
  for (const id of existingIds) {
    const num = parseInt(id.replace('T', ''), 10);
    if (!isNaN(num) && num > maxNum) maxNum = num;
  }
  const newId = `T${String(maxNum + 1).padStart(4, '0')}`;
  existingIds.add(newId);
  return newId;
}

export function registerImportCommand(program: Command): void {
  program
    .command('import <file>')
    .description('Import tasks from export package')
    .option('--parent <id>', 'Assign imported tasks to a parent')
    .option('--phase <phase>', 'Assign phase to imported tasks')
    .option('--on-duplicate <strategy>', 'Handle duplicates: skip, overwrite, rename', 'skip')
    .option('--add-label <label>', 'Add label to all imported tasks')
    .option('--dry-run', 'Preview import without changes')
    .action(async (file: string, opts: Record<string, unknown>) => {
      try {
        // Verify import file exists
        try {
          await access(file, fsConstants.R_OK);
        } catch {
          throw new CleoError(ExitCode.NOT_FOUND, `Import file not found: ${file}`);
        }

        const content = await readFile(file, 'utf-8');
        let importData: Record<string, unknown>;
        try {
          importData = JSON.parse(content);
        } catch {
          throw new CleoError(ExitCode.VALIDATION_ERROR, `Invalid JSON in import file: ${file}`);
        }

        // Extract tasks from various import formats
        let importTasks: Task[];
        if (Array.isArray(importData)) {
          importTasks = importData as Task[];
        } else if (Array.isArray(importData['tasks'])) {
          importTasks = importData['tasks'] as Task[];
        } else {
          throw new CleoError(ExitCode.VALIDATION_ERROR, 'Import file must contain a tasks array');
        }

        if (importTasks.length === 0) {
          console.log(formatSuccess({
            imported: 0,
            message: 'No tasks to import',
          }));
          return;
        }

        // Load existing data
        const accessor = await getAccessor();
        const data = await accessor.loadTodoFile();

        const existingIds = new Set(data.tasks.map((t) => t.id));
        const duplicateStrategy = (opts['onDuplicate'] as DuplicateStrategy) || 'skip';
        const parentId = opts['parent'] as string | undefined;
        const phase = opts['phase'] as string | undefined;
        const addLabel = opts['addLabel'] as string | undefined;

        // Build ID mapping for renamed tasks
        const idMapping = new Map<string, string>();
        const imported: Task[] = [];
        const skipped: string[] = [];
        const renamed: Array<{ oldId: string; newId: string }> = [];

        for (const importTask of importTasks) {
          const isDuplicate = existingIds.has(importTask.id);

          if (isDuplicate) {
            switch (duplicateStrategy) {
              case 'skip': {
                skipped.push(importTask.id);
                continue;
              }
              case 'overwrite': {
                const idx = data.tasks.findIndex((t) => t.id === importTask.id);
                if (idx !== -1) data.tasks[idx] = importTask;
                break;
              }
              case 'rename': {
                const newId = generateTaskId(existingIds);
                idMapping.set(importTask.id, newId);
                renamed.push({ oldId: importTask.id, newId });
                importTask.id = newId;
                break;
              }
            }
          }

          // Apply overrides
          if (parentId) importTask.parentId = parentId;
          if (phase) importTask.phase = phase;
          if (addLabel) {
            importTask.labels = importTask.labels ?? [];
            if (!importTask.labels.includes(addLabel)) {
              importTask.labels.push(addLabel);
            }
          }

          // Ensure required fields
          importTask.status = importTask.status ?? ('pending' as TaskStatus);
          importTask.priority = importTask.priority ?? ('medium' as TaskPriority);
          importTask.createdAt = importTask.createdAt ?? new Date().toISOString();
          importTask.updatedAt = new Date().toISOString();

          // Remap dependency references
          if (importTask.depends) {
            importTask.depends = importTask.depends.map((depId) => idMapping.get(depId) ?? depId);
          }
          if (importTask.parentId && idMapping.has(importTask.parentId)) {
            importTask.parentId = idMapping.get(importTask.parentId)!;
          }

          if (duplicateStrategy !== 'overwrite' || !isDuplicate) {
            data.tasks.push(importTask);
            existingIds.add(importTask.id);
          }

          imported.push(importTask);
        }

        if (opts['dryRun']) {
          console.log(formatSuccess({
            dryRun: true,
            wouldImport: imported.length,
            wouldSkip: skipped.length,
            wouldRename: renamed,
          }, 'Dry run - no changes made'));
          return;
        }

        // Save
        data._meta.checksum = computeChecksum(data.tasks);
        data.lastUpdated = new Date().toISOString();
        await accessor.saveTodoFile(data);

        console.log(formatSuccess({
          imported: imported.length,
          skipped: skipped.length,
          renamed,
          totalTasks: data.tasks.length,
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
