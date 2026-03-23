/**
 * Task completion logic.
 * @task T4461
 * @epic T4454
 */

import type { Task, TaskRef, VerificationGate } from '@cleocode/contracts';
// safeAppendLog replaced by tx.appendLog inside transaction (T023)
import { ExitCode } from '@cleocode/contracts';
import { loadConfig } from '../config.js';
import { CleoError } from '../errors.js';
import { requireActiveSession } from '../sessions/session-enforcement.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { createAcceptanceEnforcement } from './enforcement.js';

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
  unblockedTasks?: Array<Pick<TaskRef, 'id' | 'title'>>;
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
  // In VITEST, use permissive defaults when config keys are absent.
  // Tests that need enforcement write their own config, which overrides these defaults.
  const isTest = !!process.env.VITEST;

  const config = await loadConfig(cwd);
  const acceptance = config.enforcement?.acceptance;
  const verificationCfg = config.verification;
  const acceptanceMode = acceptance?.mode ?? (isTest ? 'off' : 'block');
  const acceptanceRequiredForPriorities =
    acceptance?.requiredForPriorities ?? (isTest ? [] : ['critical', 'high', 'medium', 'low']);
  const verificationEnabled = verificationCfg?.enabled ?? !isTest;
  const verificationRequiredGates =
    (verificationCfg?.requiredGates ?? []).filter(isVerificationGate).length > 0
      ? (verificationCfg?.requiredGates ?? []).filter(isVerificationGate)
      : DEFAULT_VERIFICATION_REQUIRED_GATES;
  const verificationMaxRounds = verificationCfg?.maxRounds ?? 5;
  const lifecycleMode = config.lifecycle?.mode ?? (isTest ? 'off' : 'strict');

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
export async function completeTask(
  options: CompleteTaskOptions,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<CompleteTaskResult> {
  const acc = accessor ?? (await getAccessor(cwd));
  const task = await acc.loadSingleTask(options.taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${options.taskId}`, {
      fix: `Use 'cleo find "${options.taskId}"' to search`,
    });
  }

  await requireActiveSession('tasks.complete', cwd);

  const enforcement = await loadCompletionEnforcement(cwd);

  // Already done
  if (task.status === 'done') {
    throw new CleoError(ExitCode.TASK_COMPLETED, `Task ${options.taskId} is already completed`);
  }

  // Check if task has incomplete dependencies
  if (task.depends?.length) {
    const deps = await acc.loadTasks(task.depends);
    const incompleteDeps = deps
      .filter((d) => d.status !== 'done' && d.status !== 'cancelled')
      .map((d) => d.id);
    if (incompleteDeps.length > 0) {
      throw new CleoError(
        ExitCode.DEPENDENCY_ERROR,
        `Task ${options.taskId} has incomplete dependencies: ${incompleteDeps.join(', ')}`,
        {
          fix: `Complete dependencies first: ${incompleteDeps.map((d) => `cleo complete ${d}`).join(', ')}`,
        },
      );
    }
  }

  const acceptanceEnforcement = await createAcceptanceEnforcement(cwd);
  const completionValidation = acceptanceEnforcement.validateCompletion(task);
  if (!completionValidation.valid) {
    throw new CleoError(
      completionValidation.exitCode ?? ExitCode.VALIDATION_ERROR,
      completionValidation.error!,
      { fix: completionValidation.fix },
    );
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
      (gate) => task.verification?.gates?.[gate] !== true,
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
  const children = await acc.getChildren(options.taskId);
  const incompleteChildren = children.filter(
    (c) => c.status !== 'done' && c.status !== 'cancelled',
  );
  if (incompleteChildren.length > 0 && task.type === 'epic') {
    if (!task.noAutoComplete) {
      throw new CleoError(
        ExitCode.HAS_CHILDREN,
        `Epic ${options.taskId} has ${incompleteChildren.length} incomplete children: ${incompleteChildren.map((c) => c.id).join(', ')}`,
        {
          fix: `Complete children first or use 'cleo update ${options.taskId} --no-auto-complete'`,
        },
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
    const timestampedNote = `${new Date()
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, ' UTC')}: ${options.notes}`;
    if (!task.notes) task.notes = [];
    task.notes.push(timestampedNote);
  }

  if (options.changeset) {
    if (!task.notes) task.notes = [];
    task.notes.push(`Changeset: ${options.changeset}`);
  }

  // Check if parent epic should auto-complete
  const autoCompleted: string[] = [];
  const autoCompletedTasks: Task[] = [];
  if (task.parentId) {
    const parent = await acc.loadSingleTask(task.parentId);
    if (parent && parent.type === 'epic' && !parent.noAutoComplete) {
      const siblings = await acc.getChildren(parent.id);
      // The current task is not yet 'done' in DB, so check by ID
      const allDone = siblings.every(
        (c) => c.id === task.id || c.status === 'done' || c.status === 'cancelled',
      );
      if (allDone) {
        parent.status = 'done';
        parent.completedAt = now;
        parent.updatedAt = now;
        autoCompleted.push(parent.id);
        autoCompletedTasks.push(parent);
      }
    }
  }

  // Wrap writes in a transaction for TOCTOU safety (T023)
  await acc.transaction(async (tx) => {
    await tx.upsertSingleTask(task);
    for (const parentTask of autoCompletedTasks) {
      await tx.upsertSingleTask(parentTask);
    }
    await tx.appendLog({
      id: `log-${Math.floor(Date.now() / 1000)}-${(await import('node:crypto')).randomBytes(3).toString('hex')}`,
      timestamp: new Date().toISOString(),
      action: 'task_completed',
      taskId: options.taskId,
      actor: 'system',
      details: { title: task.title, previousStatus: before.status },
      before: null,
      after: { title: task.title, previousStatus: before.status },
    });
  });

  // Compute newly unblocked tasks: dependents whose deps are now all satisfied
  const dependents = await acc.getDependents(options.taskId);
  const unblockedTasks: Array<Pick<TaskRef, 'id' | 'title'>> = [];
  for (const dep of dependents) {
    if (dep.status === 'done' || dep.status === 'cancelled') continue;
    if (dep.depends?.length) {
      const depDeps = await acc.loadTasks(dep.depends);
      const stillUnresolved = depDeps.filter(
        (d) => d.id !== options.taskId && d.status !== 'done' && d.status !== 'cancelled',
      );
      if (stillUnresolved.length === 0) {
        unblockedTasks.push({ id: dep.id, title: dep.title });
      }
    } else {
      unblockedTasks.push({ id: dep.id, title: dep.title });
    }
  }

  // Regenerate .cleo/memory-bridge.md (best-effort, T5240)
  import('../memory/memory-bridge.js')
    .then(({ refreshMemoryBridge }) => refreshMemoryBridge(cwd ?? process.cwd()))
    .catch(() => {
      /* Memory bridge refresh is best-effort */
    });

  // Auto-extract memory from task completion (best-effort, T-audit)
  import('../memory/auto-extract.js')
    .then(({ extractTaskCompletionMemory }) =>
      extractTaskCompletionMemory(cwd ?? process.cwd(), task),
    )
    .catch(() => {
      /* Memory extraction is best-effort */
    });

  return {
    task,
    ...(autoCompleted.length > 0 && { autoCompleted }),
    ...(unblockedTasks.length > 0 && { unblockedTasks }),
  };
}
