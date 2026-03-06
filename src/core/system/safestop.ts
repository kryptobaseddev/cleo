/**
 * Safestop and uncancel core module.
 * @task T4783
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getAccessor } from '../../store/data-accessor.js';

export interface SafestopResult {
  stopped: boolean;
  reason: string;
  sessionEnded: boolean;
  handoff?: string;
  dryRun: boolean;
}

export interface UncancelResult {
  taskId: string;
  uncancelled: boolean;
  previousStatus: string;
  newStatus: string;
  cascadeCount: number;
  dryRun: boolean;
}

/** Safe stop: signal clean shutdown for agents. */
export function safestop(
  projectRoot: string,
  opts?: { reason?: string; commit?: boolean; handoff?: string; noSessionEnd?: boolean; dryRun?: boolean },
): SafestopResult {
  const dryRun = opts?.dryRun ?? false;
  const reason = opts?.reason ?? 'Manual safestop';
  let sessionEnded = false;

  if (!dryRun && !opts?.noSessionEnd) {
    const sessPath = join(projectRoot, '.cleo', 'sessions.json');
    if (existsSync(sessPath)) {
      try {
        const data = JSON.parse(readFileSync(sessPath, 'utf-8'));
        const sessions = data.sessions ?? [];
        let changed = false;
        for (const s of sessions) {
          if (s.status === 'active') {
            s.status = 'ended';
            s.endedAt = new Date().toISOString();
            s.endNote = `Safestop: ${reason}`;
            changed = true;
            sessionEnded = true;
          }
        }
        if (changed) {
          writeFileSync(sessPath, JSON.stringify(data, null, 2), 'utf-8');
        }
      } catch {
        // non-fatal
      }
    }
  }

  return { stopped: !dryRun, reason, sessionEnded, handoff: opts?.handoff, dryRun };
}

/** Uncancel a cancelled task (restore to pending). */
export async function uncancelTask(
  projectRoot: string,
  params: { taskId: string; cascade?: boolean; notes?: string; dryRun?: boolean },
): Promise<UncancelResult> {
  if (!params.taskId) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'taskId is required');
  }

  const taskDbPath = join(projectRoot, '.cleo', 'tasks.db');
  if (!existsSync(taskDbPath)) {
    throw new CleoError(ExitCode.CONFIG_ERROR, 'No tasks.db found');
  }

  let taskFile: { tasks: Array<{ id: string; status: string; parentId?: string | null; notes?: Array<{ text: string; timestamp: string }> }> };
  const accessor = await getAccessor(projectRoot);
  try {
    taskFile = await accessor.loadTaskFile() as unknown as { tasks: Array<{ id: string; status: string; parentId?: string | null; notes?: Array<{ text: string; timestamp: string }> }> };
  } catch {
    throw new CleoError(ExitCode.FILE_ERROR, 'Failed to read tasks.db');
  }

  const task = taskFile.tasks.find(t => t.id === params.taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${params.taskId}`);
  }
  if (task.status !== 'cancelled') {
    throw new CleoError(ExitCode.INVALID_INPUT, `Task ${params.taskId} is not cancelled (status: ${task.status})`);
  }

  const dryRun = params.dryRun ?? false;
  let cascadeCount = 0;

  if (!dryRun) {
    task.status = 'pending';
    if (params.notes) {
      if (!task.notes) task.notes = [];
      task.notes.push({ text: params.notes, timestamp: new Date().toISOString() });
    }
    if (params.cascade) {
      for (const t of taskFile.tasks) {
        if (t.parentId === params.taskId && t.status === 'cancelled') {
          t.status = 'pending';
          cascadeCount++;
        }
      }
    }
    await accessor.saveTaskFile(taskFile as unknown as Awaited<ReturnType<typeof accessor.loadTaskFile>>);
  } else if (params.cascade) {
    cascadeCount = taskFile.tasks.filter(t => t.parentId === params.taskId && t.status === 'cancelled').length;
  }

  return {
    taskId: params.taskId,
    uncancelled: !dryRun,
    previousStatus: 'cancelled',
    newStatus: dryRun ? 'cancelled' : 'pending',
    cascadeCount,
    dryRun,
  };
}
