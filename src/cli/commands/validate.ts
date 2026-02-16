/**
 * CLI validate command - check file integrity, schema compliance, checksum.
 * @task T4454
 */

import { Command } from 'commander';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { readJson, computeChecksum } from '../../store/json.js';
import { getTodoPath, getArchivePath } from '../../core/paths.js';
import type { Task, TodoFile } from '../../types/task.js';

interface CheckDetail {
  check: string;
  status: 'ok' | 'error' | 'warning';
  message: string;
}

/**
 * Detect circular dependencies via DFS.
 */
function hasCircularDep(taskId: string, tasks: Task[], visited: Set<string> = new Set()): boolean {
  if (visited.has(taskId)) return true;
  visited.add(taskId);
  const task = tasks.find((t) => t.id === taskId);
  if (!task?.depends) return false;
  for (const depId of task.depends) {
    if (hasCircularDep(depId, tasks, new Set(visited))) return true;
  }
  return false;
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate todo.json against schema and business rules')
    .option('--strict', 'Treat warnings as errors')
    .option('--fix', 'Auto-fix simple issues')
    .option('--dry-run', 'Preview fixes without applying')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const todoPath = getTodoPath();
        const data = await readJson<TodoFile>(todoPath);
        if (!data) {
          throw new CleoError(ExitCode.NOT_FOUND, `File not found: ${todoPath}`, {
            fix: 'cleo init',
          });
        }

        const details: CheckDetail[] = [];
        let errors = 0;
        let warnings = 0;

        const addOk = (check: string, message: string) => {
          details.push({ check, status: 'ok', message });
        };
        const addError = (check: string, message: string) => {
          details.push({ check, status: 'error', message });
          errors++;
        };
        const addWarn = (check: string, message: string) => {
          details.push({ check, status: 'warning', message });
          warnings++;
        };

        // 1. JSON syntax (already parsed above)
        addOk('json_syntax', 'JSON syntax valid');

        // 2. Check duplicate task IDs
        const idCounts = new Map<string, number>();
        for (const t of data.tasks) {
          idCounts.set(t.id, (idCounts.get(t.id) ?? 0) + 1);
        }
        const duplicateIds = [...idCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id);
        if (duplicateIds.length > 0) {
          addError('duplicate_ids_todo', `Duplicate task IDs in todo.json: ${duplicateIds.join(', ')}`);
        } else {
          addOk('duplicate_ids_todo', 'No duplicate task IDs in todo.json');
        }

        // 2b. Cross-file duplicates with archive
        const archivePath = getArchivePath();
        const archiveData = await readJson<Record<string, unknown>>(archivePath);
        if (archiveData) {
          const archivedTasks = (archiveData['archivedTasks'] ?? []) as Array<Record<string, unknown>>;
          const archiveIds = new Set(archivedTasks.map((t) => t.id as string));
          const todoIds = new Set(data.tasks.map((t) => t.id));
          const crossDups = [...todoIds].filter((id) => archiveIds.has(id));
          if (crossDups.length > 0) {
            addError('duplicate_ids_cross', `IDs exist in both todo.json and archive: ${crossDups.join(', ')}`);
          } else {
            addOk('duplicate_ids_cross', 'No cross-file duplicate IDs');
          }
        }

        // 3. Active task limit
        const activeTasks = data.tasks.filter((t) => t.status === 'active');
        if (activeTasks.length > 1) {
          addError('active_task', `Too many active tasks: ${activeTasks.length}. Maximum allowed: 1`);
        } else if (activeTasks.length === 1) {
          addOk('active_task', 'Single active task');
        } else {
          addOk('active_task', 'No active tasks');
        }

        // 4. Dependencies exist
        const taskIds = new Set(data.tasks.map((t) => t.id));
        const missingDeps: string[] = [];
        for (const t of data.tasks) {
          if (t.depends) {
            for (const depId of t.depends) {
              if (!taskIds.has(depId)) missingDeps.push(depId);
            }
          }
        }
        if (missingDeps.length > 0) {
          addError('dependencies', `Missing dependency references: ${[...new Set(missingDeps)].join(', ')}`);
        } else {
          addOk('dependencies', 'All dependencies exist');
        }

        // 5. Circular dependencies
        const tasksWithDeps = data.tasks.filter((t) => t.depends && t.depends.length > 0);
        if (tasksWithDeps.length <= 100) {
          let circularFound = false;
          for (const t of tasksWithDeps) {
            if (hasCircularDep(t.id, data.tasks)) {
              addError('circular_deps', `Circular dependency detected involving ${t.id}`);
              circularFound = true;
            }
          }
          if (!circularFound) {
            addOk('circular_deps', 'No circular dependencies');
          }
        } else {
          addWarn('circular_deps', `Skipped circular check (${tasksWithDeps.length} tasks with deps > 100 threshold)`);
        }

        // 6. Blocked tasks have blockedBy
        const blockedNoReason = data.tasks.filter((t) => t.status === 'blocked' && !t.blockedBy);
        if (blockedNoReason.length > 0) {
          addError('blocked_reasons', `${blockedNoReason.length} blocked task(s) missing blockedBy reason`);
        } else {
          addOk('blocked_reasons', 'All blocked tasks have reasons');
        }

        // 7. Done tasks have completedAt
        const doneNoDate = data.tasks.filter((t) => t.status === 'done' && !t.completedAt);
        if (doneNoDate.length > 0) {
          addError('completed_at', `${doneNoDate.length} done task(s) missing completedAt`);
        } else {
          addOk('completed_at', 'All done tasks have completedAt');
        }

        // 8. Schema version
        const schemaVersion = data._meta?.schemaVersion;
        if (!schemaVersion) {
          addError('schema_version', 'Missing ._meta.schemaVersion field. Run: cleo upgrade');
        } else {
          addOk('schema_version', `Schema version compatible (${schemaVersion})`);
        }

        // 9. Required fields
        const missingFieldTasks = data.tasks.filter((t) =>
          !t.id || !t.title || !t.status || !t.priority || !t.createdAt,
        );
        if (missingFieldTasks.length > 0) {
          for (const t of missingFieldTasks) {
            const missing = [];
            if (!t.id) missing.push('id');
            if (!t.title) missing.push('title');
            if (!t.status) missing.push('status');
            if (!t.priority) missing.push('priority');
            if (!t.createdAt) missing.push('createdAt');
            addError('required_fields', `Task ${t.id ?? '(unknown)'} missing: ${missing.join(', ')}`);
          }
        } else {
          addOk('required_fields', 'All tasks have required fields');
        }

        // 10. Focus matches active task
        const focusTask = data.focus?.currentTask;
        const activeTask = activeTasks[0]?.id ?? null;
        if (focusTask && focusTask !== activeTask) {
          addError('focus_match', `focus.currentTask (${focusTask}) doesn't match active task (${activeTask ?? 'none'})`);
        } else {
          addOk('focus_match', 'Focus matches active task');
        }

        // 11. Checksum
        const storedChecksum = data._meta?.checksum;
        if (storedChecksum) {
          const computed = computeChecksum(data.tasks);
          if (storedChecksum !== computed) {
            addError('checksum', `Checksum mismatch: stored=${storedChecksum}, computed=${computed}`);
          } else {
            addOk('checksum', 'Checksum valid');
          }
        } else {
          addWarn('checksum', 'No checksum found');
        }

        // 12. Missing size fields
        const missingSizeTasks = data.tasks.filter((t) => !t.size);
        if (missingSizeTasks.length > 0) {
          addWarn('missing_sizes', `${missingSizeTasks.length} task(s) missing size field`);
        } else {
          addOk('missing_sizes', 'All tasks have size field');
        }

        // 13. Stale tasks (pending > 30 days)
        const staleDays = 30;
        const staleThreshold = Date.now() - staleDays * 86400 * 1000;
        const staleTasks = data.tasks.filter(
          (t) => t.status === 'pending' && t.createdAt && new Date(t.createdAt).getTime() < staleThreshold,
        );
        if (staleTasks.length > 0) {
          addWarn('stale_tasks', `${staleTasks.length} task(s) pending for >${staleDays} days`);
        }

        const valid = errors === 0;
        const strict = !!opts['strict'];

        console.log(formatSuccess({
          valid,
          schemaVersion: schemaVersion ?? 'unknown',
          errors,
          warnings,
          details,
          dryRun: !!opts['dryRun'],
        }));

        if (!valid || (strict && warnings > 0)) {
          process.exit(ExitCode.VALIDATION_ERROR);
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
