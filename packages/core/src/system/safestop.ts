/**
 * Safestop and uncancel core module.
 * @task T4783
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ExitCode, type Task } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { getAccessor } from '../store/data-accessor.js';

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
export async function safestop(
  projectRoot: string,
  opts?: {
    reason?: string;
    commit?: boolean;
    handoff?: string;
    noSessionEnd?: boolean;
    dryRun?: boolean;
  },
): Promise<SafestopResult> {
  const dryRun = opts?.dryRun ?? false;
  const reason = opts?.reason ?? 'Manual safestop';
  let sessionEnded = false;

  if (!dryRun && !opts?.noSessionEnd) {
    try {
      const accessor = await getAccessor(projectRoot);
      const activeSession = await accessor.getActiveSession();
      if (activeSession && activeSession.id !== 'default') {
        activeSession.status = 'ended';
        activeSession.endedAt = new Date().toISOString();
        await accessor.upsertSingleSession(activeSession);
        sessionEnded = true;
      }
    } catch {
      // non-fatal — session end is best-effort during safestop
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

  const accessor = await getAccessor(projectRoot);
  let task: Task | null;
  try {
    task = await accessor.loadSingleTask(params.taskId);
  } catch {
    throw new CleoError(ExitCode.FILE_ERROR, 'Failed to read tasks.db');
  }

  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${params.taskId}`);
  }
  if (task.status !== 'cancelled') {
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      `Task ${params.taskId} is not cancelled (status: ${task.status})`,
    );
  }

  const dryRun = params.dryRun ?? false;
  let cascadeCount = 0;

  if (!dryRun) {
    const notes = task.notes ? [...task.notes] : [];
    if (params.notes) {
      notes.push(`[${new Date().toISOString()}] ${params.notes}`);
    }
    await accessor.updateTaskFields(params.taskId, {
      status: 'pending',
      notesJson: JSON.stringify(notes),
    });
    if (params.cascade) {
      const children = await accessor.getChildren(params.taskId);
      for (const child of children) {
        if (child.status === 'cancelled') {
          await accessor.updateTaskFields(child.id, { status: 'pending' });
          cascadeCount++;
        }
      }
    }
  } else if (params.cascade) {
    const children = await accessor.getChildren(params.taskId);
    cascadeCount = children.filter((t) => t.status === 'cancelled').length;
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
