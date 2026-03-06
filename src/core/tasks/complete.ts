/**
 * Task completion logic.
 * @task T4461
 * @epic T4454
 */

import { readJsonRequired, saveJson, computeChecksum } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Task, TaskFile } from '../../types/task.js';
import { getTaskPath, getBackupDir } from '../paths.js';
import { logOperation } from './add.js';
import { getDependents, getUnresolvedDeps } from './dependency-check.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { getRawConfigValue } from '../config.js';
import type { VerificationGate } from '../../types/task.js';
import {
  safeSaveTaskData,
  safeAppendLog,
} from '../../store/data-safety-central.js';

/** Options for completing a task. */
export interface CompleteTaskOptions {
  taskId: string;
  notes?: string;
  changeset?: string;
}

/** Result of completing a task. */
export interface CompleteTaskResult {
  task: Task;
  autoCompleted?: string[];
  unblockedTasks?: Array<{ id: string; title: string }>;
}

interface CompletionEnforcement {
  acceptanceMode: 'off' | 'warn' | 'block';
  acceptanceRequiredForPriorities: string[];
  verificationEnabled: boolean;
  verificationRequiredGates: VerificationGate[];
  verificationMaxRounds: number;
  lifecycleMode: 'strict' | 'warn' | 'advisory' | 'none' | 'off';
}

const DEFAULT_VERIFICATION_REQUIRED_GATES: VerificationGate[] = [
  'implemented',
  'testsPassed',
  'qaPassed',
  'securityPassed',
  'documented',
];

const VERIFICATION_GATES = new Set<VerificationGate>([
  'implemented',
  'testsPassed',
  'qaPassed',
  'cleanupDone',
  'securityPassed',
  'documented',
]);

function isVerificationGate(value: string): value is VerificationGate {
  return VERIFICATION_GATES.has(value as VerificationGate);
}

async function loadCompletionEnforcement(cwd?: string): Promise<CompletionEnforcement> {
  const modeRaw = await getRawConfigValue('enforcement.acceptance.mode', cwd);
  const prioritiesRaw = await getRawConfigValue('enforcement.acceptance.requiredForPriorities', cwd);
  const verificationEnabledRaw = await getRawConfigValue('verification.enabled', cwd);
  const verificationRequiredGatesRaw = await getRawConfigValue('verification.requiredGates', cwd);
  const verificationMaxRoundsRaw = await getRawConfigValue('verification.maxRounds', cwd);
  const lifecycleModeRaw = await getRawConfigValue('lifecycle.mode', cwd);

  const acceptanceMode =
    modeRaw === 'off' || modeRaw === 'warn' || modeRaw === 'block'
      ? modeRaw
      : 'warn';

  const acceptanceRequiredForPriorities = Array.isArray(prioritiesRaw)
    ? prioritiesRaw.filter((p): p is string => typeof p === 'string')
    : ['critical', 'high'];

  const verificationEnabled = verificationEnabledRaw !== false;

  const verificationRequiredGates = Array.isArray(verificationRequiredGatesRaw)
    ? verificationRequiredGatesRaw
      .filter((g): g is string => typeof g === 'string')
      .filter(isVerificationGate)
    : DEFAULT_VERIFICATION_REQUIRED_GATES;

  const verificationMaxRounds =
    typeof verificationMaxRoundsRaw === 'number' && Number.isInteger(verificationMaxRoundsRaw)
      ? verificationMaxRoundsRaw
      : 5;

  const lifecycleMode =
    lifecycleModeRaw === 'strict' ||
    lifecycleModeRaw === 'warn' ||
    lifecycleModeRaw === 'advisory' ||
    lifecycleModeRaw === 'none' ||
    lifecycleModeRaw === 'off'
      ? lifecycleModeRaw
      : 'off';

  return {
    acceptanceMode,
    acceptanceRequiredForPriorities,
    verificationEnabled,
    verificationRequiredGates,
    verificationMaxRounds,
    lifecycleMode,
  };
}

/**
 * Complete a task by ID.
 * Handles dependency checking and optional auto-completion of epics.
 * @task T4461
 */
export async function completeTask(options: CompleteTaskOptions, cwd?: string, accessor?: DataAccessor): Promise<CompleteTaskResult> {
  const taskPath = getTaskPath(cwd);
  const backupDir = getBackupDir(cwd);

  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(taskPath);

  const taskIdx = data.tasks.findIndex(t => t.id === options.taskId);
  if (taskIdx === -1) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Task not found: ${options.taskId}`,
      { fix: `Use 'cleo find "${options.taskId}"' to search` },
    );
  }

  const task = data.tasks[taskIdx]!;

  const enforcement = await loadCompletionEnforcement(cwd);

  // Already done
  if (task.status === 'done') {
    throw new CleoError(
      ExitCode.TASK_COMPLETED,
      `Task ${options.taskId} is already completed`,
    );
  }

  // Check if task has incomplete dependencies
  if (task.depends?.length) {
    const incompleteDeps = task.depends.filter(depId => {
      const dep = data.tasks.find(t => t.id === depId);
      return dep && dep.status !== 'done' && dep.status !== 'cancelled';
    });
    if (incompleteDeps.length > 0) {
      throw new CleoError(
        ExitCode.DEPENDENCY_ERROR,
        `Task ${options.taskId} has incomplete dependencies: ${incompleteDeps.join(', ')}`,
        { fix: `Complete dependencies first: ${incompleteDeps.map(d => `cleo complete ${d}`).join(', ')}` },
      );
    }
  }

  if (
    enforcement.acceptanceMode === 'block' &&
    enforcement.acceptanceRequiredForPriorities.includes(task.priority)
  ) {
    if (!task.acceptance || task.acceptance.length === 0) {
      throw new CleoError(
        ExitCode.VALIDATION_ERROR,
        `Task ${options.taskId} requires acceptance criteria before completion (priority: ${task.priority})`,
        {
          fix: `Add criteria: cleo update ${options.taskId} --acceptance \"criterion 1,criterion 2\"`,
        },
      );
    }
  }

  if (enforcement.verificationEnabled && task.type !== 'epic') {
    if (!task.verification) {
      throw new CleoError(
        ExitCode.VERIFICATION_INIT_FAILED,
        `Task ${options.taskId} is missing verification metadata`,
        {
          fix: `Initialize verification for ${options.taskId} before completion`,
        },
      );
    }

    if (task.verification.round > enforcement.verificationMaxRounds) {
      throw new CleoError(
        ExitCode.MAX_ROUNDS_EXCEEDED,
        `Task ${options.taskId} exceeded verification max rounds (${enforcement.verificationMaxRounds})`,
        {
          fix: `Review failure log and resolve blockers before retrying completion`,
        },
      );
    }

    const missingRequiredGates = enforcement.verificationRequiredGates.filter(
      gate => task.verification?.gates?.[gate] !== true,
    );

    if (missingRequiredGates.length > 0 || task.verification.passed !== true) {
      const exitCode =
        enforcement.lifecycleMode === 'strict'
          ? ExitCode.LIFECYCLE_GATE_FAILED
          : ExitCode.GATE_DEPENDENCY;

      throw new CleoError(
        exitCode,
        `Task ${options.taskId} failed verification gates: ${missingRequiredGates.join(', ') || 'verification.passed=false'}`,
        {
          fix: `Set required verification gates before completion: ${enforcement.verificationRequiredGates.join(', ')}`,
        },
      );
    }
  }

  // Check if task has incomplete children
  const children = data.tasks.filter(t => t.parentId === options.taskId);
  const incompleteChildren = children.filter(c => c.status !== 'done' && c.status !== 'cancelled');
  if (incompleteChildren.length > 0 && task.type === 'epic') {
    if (!task.noAutoComplete) {
      throw new CleoError(
        ExitCode.HAS_CHILDREN,
        `Epic ${options.taskId} has ${incompleteChildren.length} incomplete children: ${incompleteChildren.map(c => c.id).join(', ')}`,
        { fix: `Complete children first or use 'cleo update ${options.taskId} --no-auto-complete'` },
      );
    }
  }

  const now = new Date().toISOString();
  const before = { ...task };

  // Update task
  task.status = 'done';
  task.completedAt = now;
  task.updatedAt = now;

  if (options.notes) {
    const timestampedNote = `${new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}: ${options.notes}`;
    if (!task.notes) task.notes = [];
    task.notes.push(timestampedNote);
  }

  if (options.changeset) {
    if (!task.notes) task.notes = [];
    task.notes.push(`Changeset: ${options.changeset}`);
  }

  data.tasks[taskIdx] = task;

  // Check if parent epic should auto-complete
  const autoCompleted: string[] = [];
  if (task.parentId) {
    const parent = data.tasks.find(t => t.id === task.parentId);
    if (parent && parent.type === 'epic' && !parent.noAutoComplete) {
      const parentChildren = data.tasks.filter(t => t.parentId === parent.id);
      const allDone = parentChildren.every(c => c.status === 'done' || c.status === 'cancelled');
      if (allDone) {
        parent.status = 'done';
        parent.completedAt = now;
        parent.updatedAt = now;
        autoCompleted.push(parent.id);
      }
    }
  }

  // Update checksum
  data._meta.checksum = computeChecksum(data.tasks);
  data.lastUpdated = now;

  if (accessor) {
    if (accessor.upsertSingleTask) {
      await accessor.upsertSingleTask(task);
      // Also upsert auto-completed parent if any
      for (const parentId of autoCompleted) {
        const parent = data.tasks.find(t => t.id === parentId);
        if (parent) await accessor.upsertSingleTask(parent);
      }
    } else {
      await safeSaveTaskData(accessor, data, cwd);
    }
    await safeAppendLog(accessor, {
      id: `log-${Math.floor(Date.now() / 1000)}-${(await import('node:crypto')).randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      action: 'task_completed',
      taskId: options.taskId,
      actor: 'system',
      details: { title: task.title, previousStatus: before.status },
      before: null,
      after: { title: task.title, previousStatus: before.status },
    }, cwd);
  } else {
    await saveJson(taskPath, data, { backupDir });
    await logOperation('task_completed', options.taskId, {
      title: task.title,
      previousStatus: before.status,
    });
  }

  // Compute newly unblocked tasks: dependents whose deps are now all satisfied
  const dependents = getDependents(options.taskId, data.tasks);
  const unblockedTasks: Array<{ id: string; title: string }> = [];
  for (const dep of dependents) {
    if (dep.status === 'done' || dep.status === 'cancelled') continue;
    const stillUnresolved = getUnresolvedDeps(dep.id, data.tasks);
    if (stillUnresolved.length === 0) {
      unblockedTasks.push({ id: dep.id, title: dep.title });
    }
  }

  return {
    task,
    ...(autoCompleted.length > 0 && { autoCompleted }),
    ...(unblockedTasks.length > 0 && { unblockedTasks }),
  };
}
