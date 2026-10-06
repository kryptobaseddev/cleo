/**
 * CLI restore command — universal restoration (backup, archived, cancelled, completed tasks).
 *
 * Subcommands:
 *   cleo restore finalize  — apply manually-resolved conflicts from restore-conflicts.md
 *   cleo restore backup    — restore todo files from a backup snapshot
 *   cleo restore task      — restore a task from a terminal state back to active
 *
 * @task T4454
 * @task T4795
 * @task T4904
 * @task T5329
 * @task T306 — added --scope flag to restore backup (epic T299)
 * @task T365 — added restore finalize subcommand (epic T311)
 */

import fs from 'node:fs';
import path from 'node:path';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import {
  CleoError,
  getProjectRoot,
  getTaskAccessor,
  type ParsedResolution,
  parseConflictReport,
  setAtPath,
} from '@cleocode/core';
import { defineCommand, showUsage } from 'citty';
import { dispatchRaw } from '../../dispatch/adapters/cli.js';
import { CLEO_DIR_NAME, RESTORE_CONFLICTS_MD, RESTORE_DEFAULT_FILE } from '../paths.js';
import { cliError, cliOutput, humanLine } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// Re-exports for tests + downstream code (T9985 — parser lives in core)
// ---------------------------------------------------------------------------

export type { ParsedResolution } from '@cleocode/core';
export { parseConflictReport } from '@cleocode/core';

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/**
 * cleo restore finalize — apply manually-resolved conflicts from restore-conflicts.md.
 *
 * @task T365
 * @epic T311
 * @why ADR-038 §10 — finalize pending manual-review resolutions after the user
 *      (or an agent) has edited the conflict report.
 */
const finalizeCommand = defineCommand({
  meta: {
    name: 'finalize',
    description: 'Apply manually-resolved conflicts from .cleo/restore-conflicts.md',
  },
  async run() {
    const projectRoot = getProjectRoot();
    const reportPath = path.join(projectRoot, CLEO_DIR_NAME, RESTORE_CONFLICTS_MD);

    if (!fs.existsSync(reportPath)) {
      humanLine('No pending restore conflicts. Nothing to finalize.');
      return;
    }

    const content = fs.readFileSync(reportPath, 'utf-8');
    const allResolutions = parseConflictReport(content);

    // Only apply manual-section fields that have been resolved to A or B
    const pending = allResolutions.filter(
      (r) => r.section === 'manual' && (r.resolution === 'A' || r.resolution === 'B'),
    );

    if (pending.length === 0) {
      // Check whether there are still unresolved manual-review fields
      const stillPending = allResolutions.filter(
        (r) => r.section === 'manual' && r.resolution === 'manual-review',
      );
      if (stillPending.length > 0) {
        humanLine(
          'No manual resolutions found in .cleo/restore-conflicts.md.\n' +
            "Edit the file to mark resolutions, then re-run 'cleo restore finalize'.",
        );
        return;
      }
      // No manual fields at all — safe to archive
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const archivePath = path.join(
        projectRoot,
        '.cleo',
        `restore-conflicts-${timestamp}.md.finalized`,
      );
      fs.renameSync(reportPath, archivePath);
      cliOutput(
        { applied: 0, archivedTo: archivePath },
        { command: 'restore', message: 'No pending resolutions', operation: 'restore.finalize' },
      );
      return;
    }

    // Group resolved entries by target filename
    const byFile = new Map<string, ParsedResolution[]>();
    for (const r of pending) {
      const existing = byFile.get(r.filename);
      if (existing) {
        existing.push(r);
      } else {
        byFile.set(r.filename, [r]);
      }
    }

    let applied = 0;
    for (const [filename, resolutions] of byFile) {
      const filePath = path.join(projectRoot, CLEO_DIR_NAME, filename);
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const r of resolutions) {
        const value = r.resolution === 'A' ? r.localValue : r.importedValue;
        setAtPath(obj, r.fieldPath, value);
        applied++;
      }
      fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
    }

    // Archive the report
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archivePath = path.join(
      projectRoot,
      CLEO_DIR_NAME,
      `restore-conflicts-${timestamp}.md.finalized`,
    );
    fs.renameSync(reportPath, archivePath);

    cliOutput(
      { applied, archivedTo: archivePath },
      {
        command: 'restore',
        message: `Finalized ${applied} conflict resolutions. Conflict report archived.`,
        operation: 'restore.finalize',
      },
    );
  },
});

/** Store-file labels: the live store is `.cleo/cleo.db`; these restore only through --id/--snapshot (T13240). */
const STORE_FILE_LABELS = new Set(['tasks.db', 'brain.db', 'cleo.db']);

/** cleo restore backup — restore the project store or a config file from a backup */
const backupSubCommand = defineCommand({
  meta: {
    name: 'backup',
    description:
      'Restore the project store (.cleo/cleo.db: tasks and brain) from a named snapshot (--snapshot) ' +
      'or a backup id (--id): the snapshot is verified, live writers refuse it, and the replaced ' +
      'store is kept as a pre-restore backup. --file config.json restores a config file.',
  },
  args: {
    snapshot: {
      type: 'string',
      description:
        "A snapshot file of this project's store under .cleo/backups/ (e.g. cleo-identity-refill-*.db, tasks-*.db)",
    },
    id: {
      type: 'string',
      description: 'A backup id from `cleo backup list` (its store file is restored)',
    },
    'allow-external': {
      type: 'boolean',
      description: "With --snapshot: accept a file outside this project's .cleo/backups/",
      default: false,
    },
    file: {
      type: 'string',
      description:
        'Config file to restore from the newest numbered backup (config.json). The store restores only through --snapshot or --id',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview what would be restored',
      default: false,
    },
    scope: {
      type: 'string',
      description: 'Backup scope to restore from: project or global (default: project)',
      default: 'project',
    },
    'confirm-owner-store': {
      type: 'boolean',
      description:
        "From inside a git worktree: allow overwriting the owning project's LIVE store (refused without it)",
      default: false,
    },
  },
  async run({ args }) {
    try {
      if (args.snapshot !== undefined || args.id !== undefined) {
        const { restoreStoreSnapshot } = await import('@cleocode/core/store/restore-store.js');
        const result = await restoreStoreSnapshot({
          projectRoot: getProjectRoot(),
          snapshot: args.snapshot,
          backupId: args.id,
          dryRun: args['dry-run'] === true,
          allowExternal: args['allow-external'] === true,
          confirmOwnerStore: args['confirm-owner-store'] === true,
          cwd: process.cwd(),
        });
        cliOutput(result, {
          command: 'restore',
          operation: 'admin.backup.restore-store',
          ...(result.dryRun ? { message: 'Dry run - no changes made' } : {}),
        });
        return;
      }
      const fileName = args.file ?? RESTORE_DEFAULT_FILE;
      const scope = args.scope ?? 'project';
      if (STORE_FILE_LABELS.has(fileName)) {
        // The numbered-copy path wrote a file nothing reads (`.cleo/tasks.db`).
        throw new CleoError(
          ExitCode.INVALID_INPUT,
          `E_RESTORE_STORE_LABEL: --file ${fileName} cannot restore the live store (.cleo/cleo.db holds tasks and brain)`,
          {
            fix: 'cleo backup list, then cleo restore backup --id <backupId> (or --snapshot <file>)',
          },
        );
      }

      const response = await dispatchRaw('mutate', 'admin', 'backup', {
        action: 'restore.file',
        file: fileName,
        dryRun: args['dry-run'] || undefined,
        scope,
        confirmOwnerStore: args['confirm-owner-store'] || undefined,
      });

      if (!response.success) {
        const code =
          ExitCode[response.error?.code as keyof typeof ExitCode] ?? ExitCode.GENERAL_ERROR;
        throw new CleoError(code, response.error?.message ?? 'Backup restore failed');
      }

      const data = response.data as Record<string, unknown>;

      if (args['dry-run']) {
        cliOutput(
          {
            dryRun: true,
            file: fileName,
            wouldRestore: data?.from,
            targetPath: data?.targetPath,
          },
          {
            command: 'restore',
            message: 'Dry run - no changes made',
            operation: 'admin.backup.restore',
          },
        );
        return;
      }

      cliOutput(
        {
          restored: true,
          file: fileName,
          restoredFrom: data?.from,
          targetPath: data?.targetPath,
        },
        { command: 'restore', operation: 'admin.backup.restore' },
      );
    } catch (err) {
      if (err instanceof CleoError) {
        cliError(err.message, err.code, { name: 'CleoError', fix: err.fix });
        process.exit(err.code);
      }
      throw err;
    }
  },
});

/** cleo restore task — restore a task from a terminal state back to active */
const taskSubCommand = defineCommand({
  meta: {
    name: 'task',
    description:
      'Restore task from terminal state (archived, cancelled, or completed) back to active',
  },
  args: {
    taskId: {
      type: 'positional',
      description: 'Task ID to restore',
      required: true,
    },
    status: {
      type: 'string',
      description: 'Status to restore task as (default: pending)',
      default: 'pending',
    },
    'preserve-status': {
      type: 'boolean',
      description: 'Keep the original task status',
      default: false,
    },
    reason: {
      type: 'string',
      description: 'Reason for restoring/reopening the task',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview changes without applying',
      default: false,
    },
  },
  async run({ args }) {
    try {
      const taskId = args.taskId;
      const idPattern = /^T\d{3,}$/;
      if (!idPattern.test(taskId)) {
        throw new CleoError(ExitCode.INVALID_INPUT, `Invalid task ID: ${taskId}`);
      }

      const accessor = await getTaskAccessor();

      // First, check if task exists in active tasks
      const activeTask = await accessor.loadSingleTask(taskId);

      if (activeTask) {
        // Task is active but might be in terminal state (cancelled, done)
        if (activeTask.status === 'cancelled') {
          if (args['dry-run']) {
            cliOutput(
              {
                dryRun: true,
                taskId,
                title: activeTask.title,
                previousStatus: activeTask.status,
                newStatus: args['preserve-status'] ? activeTask.status : args.status,
                source: 'active-tasks',
              },
              {
                command: 'restore',
                message: 'Dry run - no changes made',
                operation: 'tasks.restore',
              },
            );
            return;
          }
          const response = await dispatchRaw('mutate', 'tasks', 'restore', { taskId });
          if (!response.success) {
            const code =
              ExitCode[response.error?.code as keyof typeof ExitCode] ?? ExitCode.GENERAL_ERROR;
            throw new CleoError(code, response.error?.message ?? 'Task restore failed');
          }
          const resultData = response.data as Record<string, unknown>;
          cliOutput(
            {
              restored: true,
              taskId: resultData?.task,
              count: resultData?.count,
              source: 'active-tasks',
            },
            { command: 'restore', operation: 'tasks.restore' },
          );
          return;
        } else if (activeTask.status === 'done') {
          if (args['dry-run']) {
            const newStatus = args['preserve-status'] ? activeTask.status : args.status;
            cliOutput(
              {
                dryRun: true,
                taskId,
                title: activeTask.title,
                previousStatus: activeTask.status,
                newStatus,
                source: 'active-tasks',
              },
              {
                command: 'restore',
                message: 'Dry run - no changes made',
                operation: 'tasks.restore',
              },
            );
            return;
          }
          const targetStatus = args['preserve-status'] ? undefined : args.status;
          const response = await dispatchRaw('mutate', 'tasks', 'restore', {
            taskId,
            from: 'done',
            status: targetStatus,
            reason: args.reason as string | undefined,
          });
          if (!response.success) {
            const code =
              ExitCode[response.error?.code as keyof typeof ExitCode] ?? ExitCode.GENERAL_ERROR;
            throw new CleoError(code, response.error?.message ?? 'Task restore failed');
          }
          const resultData = response.data as Record<string, unknown>;
          cliOutput(
            {
              restored: true,
              taskId: resultData?.task,
              previousStatus: resultData?.previousStatus,
              newStatus: resultData?.newStatus,
              source: 'active-tasks',
            },
            { command: 'restore', operation: 'tasks.restore' },
          );
          return;
        } else {
          throw new CleoError(
            ExitCode.VALIDATION_ERROR,
            `Task ${taskId} is already active with status: ${activeTask.status}`,
          );
        }
      }

      // Task not in active list - check archive
      if (args['dry-run']) {
        const archiveData = await accessor.loadArchive();
        if (archiveData) {
          const archivedTasks = archiveData.archivedTasks as
            | Array<{ id: string; title: string; status: string }>
            | undefined;
          if (Array.isArray(archivedTasks)) {
            const task = archivedTasks.find((t) => t.id === taskId);
            if (task) {
              cliOutput(
                {
                  dryRun: true,
                  taskId,
                  title: task.title,
                  previousStatus: task.status,
                  newStatus: args['preserve-status'] ? task.status : args.status,
                  source: 'archive',
                },
                {
                  command: 'restore',
                  message: 'Dry run - no changes made',
                  operation: 'tasks.restore',
                },
              );
              return;
            }
          }
        }
        throw new CleoError(
          ExitCode.NOT_FOUND,
          `Task ${taskId} not found in active tasks or archive`,
          {
            fix: `cleo find "${taskId}" to search for the task`,
          },
        );
      }

      // Delegate to unarchive via dispatch
      try {
        const targetStatus = args['preserve-status'] ? undefined : args.status;
        const response = await dispatchRaw('mutate', 'tasks', 'restore', {
          taskId,
          from: 'archive',
          status: targetStatus,
          preserveStatus: !!args['preserve-status'],
        });
        if (!response.success) {
          const code =
            ExitCode[response.error?.code as keyof typeof ExitCode] ?? ExitCode.GENERAL_ERROR;
          throw new CleoError(code, response.error?.message ?? 'Task unarchive failed');
        }
        const resultData = response.data as Record<string, unknown>;
        cliOutput(
          {
            restored: true,
            taskId: resultData?.task,
            title: resultData?.title,
            newStatus: resultData?.status,
            source: 'archive',
          },
          { command: 'restore', operation: 'tasks.restore' },
        );
      } catch {
        throw new CleoError(
          ExitCode.NOT_FOUND,
          `Task ${taskId} not found in active tasks or archive`,
          {
            fix: `cleo find "${taskId}" to search for the task`,
          },
        );
      }
    } catch (err) {
      if (err instanceof CleoError) {
        cliError(err.message, err.code, { name: 'CleoError', fix: err.fix });
        process.exit(err.code);
      }
      throw err;
    }
  },
});

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

/**
 * Root restore command group — universal restoration for backups, archived,
 * cancelled, and completed tasks.
 *
 * Delegates to `tasks.restore` and `admin.backup.restore` dispatch operations.
 */
export const restoreCommand = defineCommand({
  meta: {
    name: 'restore',
    description:
      'Restore from backup or restore tasks from terminal states (archived, cancelled, completed)',
  },
  subCommands: {
    finalize: finalizeCommand,
    backup: backupSubCommand,
    task: taskSubCommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
