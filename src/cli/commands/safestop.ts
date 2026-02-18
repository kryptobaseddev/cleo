/**
 * CLI safestop command - graceful shutdown for agents approaching context limits.
 * Ported from scripts/safestop.sh
 * @task T4551
 * @epic T4545
 */

import { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { getCleoDir } from '../../core/paths.js';
import { readJson, computeChecksum } from '../../store/json.js';
import { getAccessor } from '../../store/data-accessor.js';

/**
 * Check if inside a git repository.
 * @task T4551
 */
function isGitRepo(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get git status summary.
 * @task T4551
 */
function getGitStatus(): { changedFiles: number; summary: string } {
  if (!isGitRepo()) return { changedFiles: 0, summary: 'not a git repo' };
  try {
    const output = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' });
    const lines = output.trim().split('\n').filter(Boolean);
    return {
      changedFiles: lines.length,
      summary: lines.length > 0 ? `${lines.length} files changed` : 'clean',
    };
  } catch {
    return { changedFiles: 0, summary: 'error' };
  }
}

/**
 * Get modified file list from git.
 * @task T4551
 */
function getModifiedFiles(): string[] {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf-8' });
    return output.trim().split('\n')
      .filter(Boolean)
      .map((line) => line.substring(3))
      .slice(0, 20);
  } catch {
    return [];
  }
}

/**
 * Get context percentage from state file.
 * @task T4551
 */
async function getContextPercentage(cleoDir: string): Promise<number> {
  try {
    const stateFile = join(cleoDir, 'context', 'state.json');
    const data = await readJson<Record<string, unknown>>(stateFile);
    if (!data) return 0;
    const cw = data['contextWindow'] as Record<string, unknown> | undefined;
    return typeof cw?.['percentage'] === 'number' ? cw['percentage'] : 0;
  } catch {
    return 0;
  }
}

/**
 * Register the safestop command.
 * @task T4551
 */
export function registerSafestopCommand(program: Command): void {
  program
    .command('safestop')
    .description('Graceful shutdown for agents approaching context limits')
    .requiredOption('--reason <reason>', 'Reason for stopping')
    .option('--commit', 'Commit pending git changes with WIP message')
    .option('--handoff <file>', 'Generate handoff document (use - for stdout)')
    .option('--no-session-end', 'Update notes but do not end session')
    .option('--dry-run', 'Show actions without executing')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const reason = opts['reason'] as string;
        const doCommit = opts['commit'] as boolean ?? false;
        const handoffFile = opts['handoff'] as string | undefined;
        const endSession = opts['sessionEnd'] !== false;
        const dryRun = opts['dryRun'] as boolean ?? false;

        const cleoDir = getCleoDir();
        const percentage = await getContextPercentage(cleoDir);

        // Get focused task
        const accessor = await getAccessor();
        const todoData = await accessor.loadTodoFile();
        const taskId = todoData?.focus?.currentTask ?? null;
        const taskTitle = taskId
          ? todoData?.tasks.find((t) => t.id === taskId)?.title ?? null
          : null;

        const gitStatus = getGitStatus();

        if (dryRun) {
          const actions: string[] = [];
          if (taskId) actions.push(`Update task ${taskId} notes`);
          if (doCommit) actions.push('Git commit with WIP message');
          if (handoffFile) actions.push(`Generate handoff to ${handoffFile}`);
          if (endSession) actions.push('End CLEO session');

          console.log(formatSuccess({
            dryRun: true,
            reason,
            contextPercentage: percentage,
            focusedTask: taskId ? { id: taskId, title: taskTitle } : null,
            gitStatus: gitStatus.summary,
            wouldPerform: actions,
          }));
          return;
        }

        const performed: string[] = [];

        // 1. Update task notes
        if (taskId && todoData) {
          const task = todoData.tasks.find((t) => t.id === taskId);
          if (task) {
            task.notes = task.notes ?? [];
            task.notes.push(`SAFESTOP (${percentage}%): ${reason}`);
            task.updatedAt = new Date().toISOString();
            performed.push(`Updated task ${taskId} notes`);
          }
        }

        // 2. Git commit if requested
        if (doCommit && isGitRepo() && gitStatus.changedFiles > 0) {
          try {
            execFileSync('git', ['add', '-A'], { stdio: 'ignore' });
            const commitMsg = `WIP: ${taskTitle ?? 'safestop'} - ${reason}`;
            execFileSync('git', ['commit', '-m', commitMsg, '--no-verify'], { stdio: 'ignore' });
            performed.push(`Committed: ${commitMsg}`);
          } catch {
            performed.push('Git commit failed');
          }
        }

        // 3. Generate handoff
        if (handoffFile) {
          const sessionFile = join(cleoDir, '.current-session');
          let sessionId = '';
          try {
            sessionId = (await readFile(sessionFile, 'utf-8')).trim();
          } catch {
            // No session
          }

          const handoff = {
            $schema: 'https://cleo-dev.com/schemas/v1/handoff.schema.json',
            version: '1.0.0',
            generatedAt: new Date().toISOString(),
            reason,
            contextPercentage: percentage,
            session: { cleoSessionId: sessionId },
            focusedTask: {
              id: taskId ?? '',
              title: taskTitle ?? '',
              progressNote: todoData?.focus?.sessionNote ?? '',
            },
            workInProgress: {
              gitStatus: gitStatus.summary,
              filesModified: getModifiedFiles(),
            },
            resumeCommand: `cleo session resume ${sessionId}`,
          };

          const handoffJson = JSON.stringify(handoff, null, 2);

          if (handoffFile === '-') {
            process.stdout.write(handoffJson + '\n');
          } else {
            await writeFile(handoffFile, handoffJson);
          }
          performed.push(`Handoff saved to ${handoffFile}`);
        }

        // 4. End session (mark in notes, actual session end delegated to session command)
        if (endSession) {
          performed.push('Session marked for end');
        }

        // Save todo data if we modified it
        if (taskId && todoData) {
          todoData._meta.checksum = computeChecksum(todoData.tasks);
          todoData.lastUpdated = new Date().toISOString();
          await accessor.saveTodoFile(todoData);
        }

        console.log(formatSuccess({
          reason,
          contextPercentage: percentage,
          focusedTask: taskId ? { id: taskId, title: taskTitle } : null,
          performed,
        }, 'Safestop complete'));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
