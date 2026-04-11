/**
 * CLI restore command - universal restoration (backup, archived, cancelled, completed tasks).
 * Delegates to dispatch operations (tasks.restore, admin.backup.restore).
 * @task T4454
 * @task T4795
 * @task T4904
 * @task T5329
 * @task T306 — added --scope flag to restore backup (epic T299)
 * @task T365 — added restore finalize subcommand (epic T311)
 */

import fs from 'node:fs';
import path from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { CleoError, formatError, getAccessor } from '@cleocode/core';
import { getProjectRoot } from '@cleocode/core/internal';
import { dispatchRaw } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';
import { cliOutput } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// Types for conflict report parsing
// ---------------------------------------------------------------------------

/** A single field entry parsed from the conflict report. */
interface ParsedResolution {
  /** Which section of the report this came from. */
  section: 'auto' | 'manual';
  /** The target JSON file on disk. */
  filename: 'config.json' | 'project-info.json' | 'project-context.json';
  /** Dot-separated field path (e.g. "hooks.preCommit"). */
  fieldPath: string;
  /** The local (A) value, may be undefined if not present. */
  localValue: unknown;
  /** The imported (B) value, may be undefined if not present. */
  importedValue: unknown;
  /** The chosen resolution. */
  resolution: 'A' | 'B' | 'manual-review';
}

// ---------------------------------------------------------------------------
// Parser helpers (private to this module)
// ---------------------------------------------------------------------------

/**
 * Parse a backtick-quoted value from a markdown line such as:
 *   `"openai"` → "openai"
 *   `true`     → true
 *   `42`       → 42
 *   _(not present)_ → undefined
 */
function parseMarkdownValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '_(not present)_' || trimmed === '') return undefined;
  // Strip surrounding backticks if present
  const stripped = trimmed.replace(/^`([\s\S]*)`$/, '$1').trim();
  // Try JSON parse for booleans, numbers, quoted strings, objects, arrays
  try {
    return JSON.parse(stripped);
  } catch {
    // Return as-is string if JSON parse fails
    return stripped;
  }
}

/**
 * Set a value at a dot-separated path within a plain object tree,
 * creating intermediate objects as needed.
 */
function setAtPath(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const parts = dotPath.split('.');
  let curr: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i] as string;
    if (curr[key] === undefined || typeof curr[key] !== 'object' || curr[key] === null) {
      curr[key] = {};
    }
    curr = curr[key] as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1] as string;
  curr[lastKey] = value;
}

/**
 * Parse a restore-conflicts.md markdown report into an array of
 * {@link ParsedResolution} entries.
 *
 * The format produced by T357 is:
 * ```
 * ## config.json
 * ### Resolved (auto-applied)
 * - `field.path`
 *   - Local (A): `value`
 *   - Imported (B): `value`
 *   - Resolution: **A**
 *   - Rationale: ...
 * ### Manual review needed
 * - `field.path`
 *   - Local (A): `value`
 *   - Imported (B): `value`
 *   - Resolution: **manual-review**
 *   - Rationale: ...
 * ```
 *
 * @task T365
 * @epic T311
 */
export function parseConflictReport(md: string): ParsedResolution[] {
  const results: ParsedResolution[] = [];

  const VALID_FILENAMES = new Set(['config.json', 'project-info.json', 'project-context.json']);

  // Split into lines for state-machine parsing
  const lines = md.split('\n');

  let currentFilename: ParsedResolution['filename'] | null = null;
  let currentSection: 'auto' | 'manual' | null = null;

  // State for the current field entry being accumulated
  let entryField: string | null = null;
  let entryLocalRaw: string | null = null;
  let entryImportedRaw: string | null = null;
  let entryResolution: 'A' | 'B' | 'manual-review' | null = null;

  /** Flush the current accumulated entry if complete. */
  function flushEntry(): void {
    if (
      entryField !== null &&
      entryResolution !== null &&
      currentFilename !== null &&
      currentSection !== null
    ) {
      results.push({
        section: currentSection,
        filename: currentFilename,
        fieldPath: entryField,
        localValue: entryLocalRaw !== null ? parseMarkdownValue(entryLocalRaw) : undefined,
        importedValue: entryImportedRaw !== null ? parseMarkdownValue(entryImportedRaw) : undefined,
        resolution: entryResolution,
      });
    }
    entryField = null;
    entryLocalRaw = null;
    entryImportedRaw = null;
    entryResolution = null;
  }

  for (const line of lines) {
    // ## <filename> heading
    const fileHeading = /^##\s+(.+\.json)\s*$/.exec(line);
    if (fileHeading) {
      flushEntry();
      const name = fileHeading[1]?.trim() ?? '';
      currentFilename = VALID_FILENAMES.has(name) ? (name as ParsedResolution['filename']) : null;
      currentSection = null;
      continue;
    }

    // ### section heading
    const sectionHeading = /^###\s+(.+)$/.exec(line);
    if (sectionHeading) {
      flushEntry();
      const headingText = (sectionHeading[1] ?? '').toLowerCase();
      if (headingText.includes('manual')) {
        currentSection = 'manual';
      } else if (headingText.includes('resolved') || headingText.includes('auto')) {
        currentSection = 'auto';
      } else {
        currentSection = null;
      }
      continue;
    }

    if (currentFilename === null || currentSection === null) continue;

    // - `field.path`  — starts a new field entry
    const fieldLine = /^-\s+`([^`]+)`\s*$/.exec(line);
    if (fieldLine) {
      flushEntry();
      entryField = fieldLine[1] ?? null;
      continue;
    }

    if (entryField === null) continue;

    // Sub-bullets:  - Local (A): `value`
    const localLine = /^\s+-\s+Local\s+\(A\):\s+(.+)$/.exec(line);
    if (localLine) {
      entryLocalRaw = localLine[1] ?? '';
      continue;
    }

    // - Imported (B): `value`
    const importedLine = /^\s+-\s+Imported\s+\(B\):\s+(.+)$/.exec(line);
    if (importedLine) {
      entryImportedRaw = importedLine[1] ?? '';
      continue;
    }

    // - Resolution: **X**
    const resolutionLine = /^\s+-\s+Resolution:\s+\*\*([^*]+)\*\*/.exec(line);
    if (resolutionLine) {
      const resText = (resolutionLine[1] ?? '').trim();
      if (resText === 'A') {
        entryResolution = 'A';
      } else if (resText === 'B') {
        entryResolution = 'B';
      } else {
        entryResolution = 'manual-review';
      }
    }
  }

  // Flush the last accumulated entry
  flushEntry();

  return results;
}

export function registerRestoreCommand(program: Command): void {
  const restoreCmd = program
    .command('restore')
    .description(
      'Restore from backup or restore tasks from terminal states (archived, cancelled, completed)',
    );

  // ---------------------------------------------------------------------------
  // Subcommand: restore finalize
  // Apply manually-resolved conflict entries from .cleo/restore-conflicts.md.
  // @task T365
  // @epic T311
  // @why ADR-038 §10 — finalize pending manual-review resolutions from the
  //      conflict report after the user (or an agent) has edited it.
  // ---------------------------------------------------------------------------
  restoreCmd
    .command('finalize')
    .description('Apply manually-resolved conflicts from .cleo/restore-conflicts.md')
    .action(async () => {
      const projectRoot = getProjectRoot();
      const reportPath = path.join(projectRoot, '.cleo', 'restore-conflicts.md');

      if (!fs.existsSync(reportPath)) {
        console.log('No pending restore conflicts. Nothing to finalize.');
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
          console.log(
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
        const filePath = path.join(projectRoot, '.cleo', filename);
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
        '.cleo',
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
    });

  // Subcommand: restore backup
  restoreCmd
    .command('backup')
    .description('Restore todo files from backup')
    .option('--file <name>', 'Specific file to restore (tasks.db, config.json, etc.)')
    .option('--dry-run', 'Preview what would be restored')
    .option(
      '--scope <scope>',
      'Backup scope to restore from: project or global (default: project)',
      'project',
    )
    .action(async (opts: Record<string, unknown>) => {
      try {
        const fileName = (opts['file'] as string) || 'tasks.db';
        const scope = (opts['scope'] as string) || 'project';

        const response = await dispatchRaw('mutate', 'admin', 'backup', {
          action: 'restore.file',
          file: fileName,
          dryRun: opts['dryRun'] as boolean | undefined,
          scope,
        });

        if (!response.success) {
          const code =
            ExitCode[response.error?.code as keyof typeof ExitCode] ?? ExitCode.GENERAL_ERROR;
          throw new CleoError(code, response.error?.message ?? 'Backup restore failed');
        }

        const data = response.data as Record<string, unknown>;

        if (opts['dryRun']) {
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
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });

  // Universal task restore - handles archived, cancelled, and completed tasks
  restoreCmd
    .command('task <task-id>')
    .description(
      'Restore task from terminal state (archived, cancelled, or completed) back to active',
    )
    .option('--status <status>', 'Status to restore task as (default: pending)', 'pending')
    .option('--preserve-status', 'Keep the original task status')
    .option('--reason <reason>', 'Reason for restoring/reopening the task')
    .option('--dry-run', 'Preview changes without applying')
    .action(async (taskId: string, opts: Record<string, unknown>) => {
      try {
        const idPattern = /^T\d{3,}$/;
        if (!idPattern.test(taskId)) {
          throw new CleoError(ExitCode.INVALID_INPUT, `Invalid task ID: ${taskId}`);
        }

        const accessor = await getAccessor();

        // First, check if task exists in active tasks
        const activeTask = await accessor.loadSingleTask(taskId);

        if (activeTask) {
          // Task is active but might be in terminal state (cancelled, done)
          if (activeTask.status === 'cancelled') {
            if (opts['dryRun']) {
              cliOutput(
                {
                  dryRun: true,
                  taskId,
                  title: activeTask.title,
                  previousStatus: activeTask.status,
                  newStatus: opts['preserveStatus']
                    ? activeTask.status
                    : (opts['status'] as string),
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
            if (opts['dryRun']) {
              const newStatus = opts['preserveStatus']
                ? activeTask.status
                : (opts['status'] as string);
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
            const targetStatus = opts['preserveStatus'] ? undefined : (opts['status'] as string);
            const response = await dispatchRaw('mutate', 'tasks', 'restore', {
              taskId,
              from: 'done',
              status: targetStatus,
              reason: opts['reason'] as string | undefined,
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
        if (opts['dryRun']) {
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
                    newStatus: opts['preserveStatus'] ? task.status : (opts['status'] as string),
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
          const targetStatus = opts['preserveStatus'] ? undefined : (opts['status'] as string);
          const response = await dispatchRaw('mutate', 'tasks', 'restore', {
            taskId,
            from: 'archive',
            status: targetStatus,
            preserveStatus: !!opts['preserveStatus'],
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
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
