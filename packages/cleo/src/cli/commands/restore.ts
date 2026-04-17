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
import { ExitCode } from '@cleocode/contracts';
import { CleoError, formatError, getAccessor } from '@cleocode/core';
import { getProjectRoot } from '@cleocode/core/internal';
import { defineCommand } from 'citty';
import { dispatchRaw } from '../../dispatch/adapters/cli.js';
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
  },
});

/** cleo restore backup — restore todo files from a backup snapshot */
const backupSubCommand = defineCommand({
  meta: { name: 'backup', description: 'Restore todo files from backup' },
  args: {
    file: {
      type: 'string',
      description: 'Specific file to restore (tasks.db, config.json, etc.)',
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
  },
  async run({ args }) {
    try {
      const fileName = args.file ?? 'tasks.db';
      const scope = args.scope ?? 'project';

      const response = await dispatchRaw('mutate', 'admin', 'backup', {
        action: 'restore.file',
        file: fileName,
        dryRun: args['dry-run'] || undefined,
        scope,
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
        console.error(formatError(err));
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

      const accessor = await getAccessor();

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
        console.error(formatError(err));
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
});
