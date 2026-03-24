/**
 * A2A Task Lifecycle Management
 *
 * State machine enforcement, task CRUD, and LAFS integration
 * for A2A Protocol v1.0+ compliance.
 *
 * Reference: A2A spec Section 6 (Task Lifecycle)
 */

import type { Task, TaskState, TaskStatus, Artifact, Message } from '@a2a-js/sdk';
import type { LAFSEnvelope } from '../types.js';
import { createLafsArtifact } from './bridge.js';

// ============================================================================
// State Constants
// ============================================================================

/** States from which no further transitions are possible */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  'completed',
  'failed',
  'canceled',
  'rejected',
]);

/** States where the task is paused awaiting external input */
export const INTERRUPTED_STATES: ReadonlySet<TaskState> = new Set([
  'input-required',
  'auth-required',
]);

/** Valid state transitions (adjacency map). Terminal states have empty outgoing sets. */
export const VALID_TRANSITIONS: ReadonlyMap<TaskState, ReadonlySet<TaskState>> = new Map([
  ['submitted', new Set<TaskState>(['working', 'canceled', 'rejected', 'failed'])],
  ['working', new Set<TaskState>(['completed', 'failed', 'canceled', 'input-required', 'auth-required'])],
  ['input-required', new Set<TaskState>(['working', 'canceled', 'failed'])],
  ['auth-required', new Set<TaskState>(['working', 'canceled', 'failed'])],
  ['completed', new Set<TaskState>()],
  ['failed', new Set<TaskState>()],
  ['canceled', new Set<TaskState>()],
  ['rejected', new Set<TaskState>()],
  ['unknown', new Set<TaskState>(['submitted', 'working', 'input-required', 'completed', 'canceled', 'failed', 'rejected', 'auth-required'])],
]);

// ============================================================================
// State Functions
// ============================================================================

/** Check if a transition from one state to another is valid */
export function isValidTransition(from: TaskState, to: TaskState): boolean {
  const allowed = VALID_TRANSITIONS.get(from);
  return allowed ? allowed.has(to) : false;
}

/** Check if a state is terminal (no further transitions allowed) */
export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Check if a state is interrupted (paused awaiting input) */
export function isInterruptedState(state: TaskState): boolean {
  return INTERRUPTED_STATES.has(state);
}

// ============================================================================
// Error Classes
// ============================================================================

/** Thrown when attempting an invalid state transition */
export class InvalidStateTransitionError extends Error {
  readonly taskId: string;
  readonly fromState: TaskState;
  readonly toState: TaskState;

  constructor(taskId: string, fromState: TaskState, toState: TaskState) {
    super(`Invalid transition for task ${taskId}: ${fromState} -> ${toState}`);
    this.name = 'InvalidStateTransitionError';
    this.taskId = taskId;
    this.fromState = fromState;
    this.toState = toState;
  }
}

/** Thrown when attempting to modify a task in a terminal state */
export class TaskImmutabilityError extends Error {
  readonly taskId: string;
  readonly terminalState: TaskState;

  constructor(taskId: string, terminalState: TaskState) {
    super(`Task ${taskId} is in terminal state ${terminalState} and cannot be modified`);
    this.name = 'TaskImmutabilityError';
    this.taskId = taskId;
    this.terminalState = terminalState;
  }
}

/** Thrown when a task is not found */
export class TaskNotFoundError extends Error {
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
    this.taskId = taskId;
  }
}

/** Thrown when a refinement/follow-up task references invalid parent tasks */
export class TaskRefinementError extends Error {
  readonly referenceTaskIds: string[];

  constructor(message: string, referenceTaskIds: string[]) {
    super(message);
    this.name = 'TaskRefinementError';
    this.referenceTaskIds = referenceTaskIds;
  }
}

// ============================================================================
// ID Generation
// ============================================================================

function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ============================================================================
// TaskManager
// ============================================================================

/** Options for creating a new task */
export interface CreateTaskOptions {
  contextId?: string;
  metadata?: Record<string, unknown>;
  referenceTaskIds?: string[];
  parallelFollowUp?: boolean;
}

/** Options for listing tasks */
export interface ListTasksOptions {
  contextId?: string;
  state?: TaskState;
  limit?: number;
  pageToken?: string;
}

/** Paginated result from listTasks */
export interface ListTasksResult {
  tasks: Task[];
  nextPageToken?: string;
}

/**
 * In-memory task manager implementing A2A task lifecycle.
 * Enforces valid state transitions and terminal state immutability.
 */
export class TaskManager {
  private tasks = new Map<string, Task>();
  private contextIndex = new Map<string, Set<string>>();

  /** Create a new task in the submitted state */
  createTask(options?: CreateTaskOptions): Task {
    const id = generateId();
    const resolvedContextId =
      options?.contextId ?? this.resolveContextForReferenceTasks(options?.referenceTaskIds) ?? generateId();
    const contextId: string = resolvedContextId;

    const referenceTaskIds = options?.referenceTaskIds ?? [];
    this.validateReferenceTasks(referenceTaskIds, contextId);

    const metadata: Record<string, unknown> = {
      ...(options?.metadata ?? {}),
      ...(referenceTaskIds.length > 0 ? { referenceTaskIds } : {}),
      ...(options?.parallelFollowUp ? { parallelFollowUp: true } : {}),
    };

    const task: Task = {
      id,
      contextId,
      kind: 'task',
      status: {
        state: 'submitted',
        timestamp: new Date().toISOString(),
      },
      ...(Object.keys(metadata).length > 0 && { metadata }),
    };

    this.tasks.set(id, task);

    // Index by contextId
    let contextTasks = this.contextIndex.get(contextId);
    if (!contextTasks) {
      contextTasks = new Set();
      this.contextIndex.set(contextId, contextTasks);
    }
    contextTasks.add(id);

    return structuredClone(task);
  }

  /** Create a refinement/follow-up task referencing existing task(s). */
  createRefinedTask(referenceTaskIds: string[], options?: Omit<CreateTaskOptions, 'referenceTaskIds'>): Task {
    return this.createTask({
      ...options,
      referenceTaskIds,
      parallelFollowUp: options?.parallelFollowUp,
    });
  }

  /** Get a task by ID. Throws TaskNotFoundError if not found. */
  getTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }
    return structuredClone(task);
  }

  /** List tasks with optional filtering and pagination */
  listTasks(options?: ListTasksOptions): ListTasksResult {
    let taskIds: string[];

    if (options?.contextId) {
      const contextTasks = this.contextIndex.get(options.contextId);
      taskIds = contextTasks ? [...contextTasks] : [];
    } else {
      taskIds = [...this.tasks.keys()];
    }

    // Filter by state
    if (options?.state) {
      taskIds = taskIds.filter(id => {
        const task = this.tasks.get(id);
        return task && task.status.state === options.state;
      });
    }

    // Sort for deterministic pagination
    taskIds.sort();

    // Apply page token (cursor-based: token is the last seen task ID)
    if (options?.pageToken) {
      const startIdx = taskIds.indexOf(options.pageToken);
      if (startIdx >= 0) {
        taskIds = taskIds.slice(startIdx + 1);
      }
    }

    // Apply limit
    const limit = options?.limit ?? taskIds.length;
    const pageTaskIds = taskIds.slice(0, limit);
    const hasMore = taskIds.length > limit;

    const tasks = pageTaskIds.map(id => structuredClone(this.tasks.get(id)!));
    const nextPageToken = hasMore ? pageTaskIds[pageTaskIds.length - 1] : undefined;

    return { tasks, nextPageToken };
  }

  /**
   * Update task status. Enforces valid transitions and terminal state immutability.
   * @throws InvalidStateTransitionError if the transition is not valid
   * @throws TaskImmutabilityError if the task is in a terminal state
   */
  updateTaskStatus(taskId: string, state: TaskState, message?: Message): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    const currentState = task.status.state;

    if (isTerminalState(currentState)) {
      throw new TaskImmutabilityError(taskId, currentState);
    }

    if (!isValidTransition(currentState, state)) {
      throw new InvalidStateTransitionError(taskId, currentState, state);
    }

    const status: TaskStatus = {
      state,
      timestamp: new Date().toISOString(),
      ...(message && { message }),
    };

    task.status = status;
    return structuredClone(task);
  }

  /**
   * Add an artifact to a task.
   * @throws TaskImmutabilityError if the task is in a terminal state
   */
  addArtifact(taskId: string, artifact: Artifact): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    if (isTerminalState(task.status.state)) {
      throw new TaskImmutabilityError(taskId, task.status.state);
    }

    if (!task.artifacts) {
      task.artifacts = [];
    }
    task.artifacts.push(artifact);

    return structuredClone(task);
  }

  /**
   * Add a message to task history.
   * @throws TaskImmutabilityError if the task is in a terminal state
   */
  addHistory(taskId: string, message: Message): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    if (isTerminalState(task.status.state)) {
      throw new TaskImmutabilityError(taskId, task.status.state);
    }

    if (!task.history) {
      task.history = [];
    }
    task.history.push(message);

    return structuredClone(task);
  }

  /** Cancel a task by transitioning to canceled state */
  cancelTask(taskId: string): Task {
    return this.updateTaskStatus(taskId, 'canceled');
  }

  /** Get all tasks in a given context */
  getTasksByContext(contextId: string): Task[] {
    const taskIds = this.contextIndex.get(contextId);
    if (!taskIds) return [];
    return [...taskIds].map(id => structuredClone(this.tasks.get(id)!));
  }

  /** Check if a task is in a terminal state */
  isTerminal(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }
    return isTerminalState(task.status.state);
  }

  private resolveContextForReferenceTasks(referenceTaskIds: string[] | undefined): string | undefined {
    if (!referenceTaskIds || referenceTaskIds.length === 0) {
      return undefined;
    }
    const firstId = referenceTaskIds[0];
    if (!firstId) {
      return undefined;
    }
    const first = this.tasks.get(firstId);
    return first?.contextId;
  }

  private validateReferenceTasks(referenceTaskIds: string[], contextId: string): void {
    if (referenceTaskIds.length === 0) {
      return;
    }

    for (const refId of referenceTaskIds) {
      const refTask = this.tasks.get(refId);
      if (!refTask) {
        throw new TaskRefinementError(`Referenced task not found: ${refId}`, referenceTaskIds);
      }
      if (refTask.contextId !== contextId) {
        throw new TaskRefinementError(
          `Referenced task ${refId} has different contextId (${refTask.contextId}) than refinement (${contextId})`,
          referenceTaskIds,
        );
      }
    }
  }
}

// ============================================================================
// LAFS Integration
// ============================================================================

/**
 * Attach a LAFS envelope as an artifact to an A2A task.
 * Uses createLafsArtifact() from bridge.ts to wrap the envelope.
 */
export function attachLafsEnvelope(
  manager: TaskManager,
  taskId: string,
  envelope: LAFSEnvelope
): Task {
  const artifact = createLafsArtifact(envelope);
  return manager.addArtifact(taskId, artifact);
}
