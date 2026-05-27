/**
 * A2A Task Lifecycle Management
 *
 * State machine enforcement, task CRUD, and LAFS integration
 * for A2A Protocol v1.0+ compliance.
 *
 * @remarks
 * Implements the A2A task state machine with valid transitions, terminal
 * state immutability, and context-based task grouping. Provides an
 * in-memory TaskManager for managing task lifecycle and LAFS envelope
 * attachment.
 *
 * Reference: A2A spec Section 6 (Task Lifecycle)
 */

import type { Artifact, Message, Task, TaskState, TaskStatus } from '@a2a-js/sdk';
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
  [
    'working',
    new Set<TaskState>(['completed', 'failed', 'canceled', 'input-required', 'auth-required']),
  ],
  ['input-required', new Set<TaskState>(['working', 'canceled', 'failed'])],
  ['auth-required', new Set<TaskState>(['working', 'canceled', 'failed'])],
  ['completed', new Set<TaskState>()],
  ['failed', new Set<TaskState>()],
  ['canceled', new Set<TaskState>()],
  ['rejected', new Set<TaskState>()],
  [
    'unknown',
    new Set<TaskState>([
      'submitted',
      'working',
      'input-required',
      'completed',
      'canceled',
      'failed',
      'rejected',
      'auth-required',
    ]),
  ],
]);

// ============================================================================
// State Functions
// ============================================================================

/**
 * Check if a transition from one state to another is valid.
 *
 * @remarks
 * Looks up the `from` state in the VALID_TRANSITIONS adjacency map and
 * checks whether `to` is in the allowed set.
 *
 * @param from - Current task state
 * @param to - Desired target state
 * @returns True if the transition is allowed by the state machine
 *
 * @example
 * ```typescript
 * if (!isValidTransition('submitted', 'completed')) {
 *   throw new Error('Cannot go directly from submitted to completed');
 * }
 * ```
 */
export function isValidTransition(from: TaskState, to: TaskState): boolean {
  const allowed = VALID_TRANSITIONS.get(from);
  return allowed ? allowed.has(to) : false;
}

/**
 * Check if a state is terminal (no further transitions allowed).
 *
 * @remarks
 * Terminal states are `completed`, `failed`, `canceled`, and `rejected`.
 *
 * @param state - Task state to check
 * @returns True if the state is terminal
 *
 * @example
 * ```typescript
 * if (isTerminalState(task.status.state)) {
 *   console.log('Task has reached a final state');
 * }
 * ```
 */
export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Check if a state is interrupted (paused awaiting input).
 *
 * @remarks
 * Interrupted states are `input-required` and `auth-required`.
 *
 * @param state - Task state to check
 * @returns True if the state indicates the task is waiting for external input
 *
 * @example
 * ```typescript
 * if (isInterruptedState(task.status.state)) {
 *   promptUserForInput(task);
 * }
 * ```
 */
export function isInterruptedState(state: TaskState): boolean {
  return INTERRUPTED_STATES.has(state);
}

// ============================================================================
// Error Classes
// ============================================================================

/**
 * Thrown when attempting an invalid state transition.
 *
 * @remarks
 * Captures the task ID, source state, and target state so callers can
 * determine which transition was rejected.
 */
export class InvalidStateTransitionError extends Error {
  /** ID of the task that failed the transition */
  readonly taskId: string;
  /** State the task was in when the transition was attempted */
  readonly fromState: TaskState;
  /** State the task was being transitioned to */
  readonly toState: TaskState;

  /**
   * Create an InvalidStateTransitionError.
   *
   * @param taskId - ID of the task that failed the transition
   * @param fromState - Current state of the task
   * @param toState - Desired target state that was rejected
   */
  constructor(taskId: string, fromState: TaskState, toState: TaskState) {
    super(`Invalid transition for task ${taskId}: ${fromState} -> ${toState}`);
    this.name = 'InvalidStateTransitionError';
    this.taskId = taskId;
    this.fromState = fromState;
    this.toState = toState;
  }
}

/**
 * Thrown when attempting to modify a task in a terminal state.
 *
 * @remarks
 * Tasks in terminal states (`completed`, `failed`, `canceled`, `rejected`)
 * are immutable and cannot be modified further.
 */
export class TaskImmutabilityError extends Error {
  /** ID of the task that cannot be modified */
  readonly taskId: string;
  /** Terminal state the task is in */
  readonly terminalState: TaskState;

  /**
   * Create a TaskImmutabilityError.
   *
   * @param taskId - ID of the task in terminal state
   * @param terminalState - The terminal state preventing modification
   */
  constructor(taskId: string, terminalState: TaskState) {
    super(`Task ${taskId} is in terminal state ${terminalState} and cannot be modified`);
    this.name = 'TaskImmutabilityError';
    this.taskId = taskId;
    this.terminalState = terminalState;
  }
}

/**
 * Thrown when a task is not found.
 *
 * @remarks
 * Indicates a lookup by task ID failed because no task with that ID exists
 * in the TaskManager's store.
 */
export class TaskNotFoundError extends Error {
  /** ID of the task that was not found */
  readonly taskId: string;

  /**
   * Create a TaskNotFoundError.
   *
   * @param taskId - ID of the task that was not found
   */
  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
    this.taskId = taskId;
  }
}

/**
 * Thrown when a refinement/follow-up task references invalid parent tasks.
 *
 * @remarks
 * Occurs when referenced tasks do not exist or belong to a different
 * context than the refinement task.
 */
export class TaskRefinementError extends Error {
  /** IDs of the referenced tasks that caused the error */
  readonly referenceTaskIds: string[];

  /**
   * Create a TaskRefinementError.
   *
   * @param message - Descriptive error message
   * @param referenceTaskIds - IDs of the invalid reference tasks
   */
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
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
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
  /**
   * Context ID for grouping related tasks.
   * @defaultValue undefined
   */
  contextId?: string;
  /**
   * Arbitrary metadata to attach to the task.
   * @defaultValue undefined
   */
  metadata?: Record<string, unknown>;
  /**
   * IDs of parent tasks this task refines or follows up on.
   * @defaultValue undefined
   */
  referenceTaskIds?: string[];
  /**
   * Whether this follow-up can run in parallel with its references.
   * @defaultValue undefined
   */
  parallelFollowUp?: boolean;
}

/** Options for listing tasks */
export interface ListTasksOptions {
  /**
   * Filter tasks by context ID.
   * @defaultValue undefined
   */
  contextId?: string;
  /**
   * Filter tasks by current state.
   * @defaultValue undefined
   */
  state?: TaskState;
  /**
   * Maximum number of tasks to return.
   * @defaultValue undefined
   */
  limit?: number;
  /**
   * Cursor token for pagination (last seen task ID).
   * @defaultValue undefined
   */
  pageToken?: string;
}

/** Paginated result from listTasks */
export interface ListTasksResult {
  /** Array of tasks matching the query */
  tasks: Task[];
  /**
   * Token for fetching the next page of results.
   * @defaultValue undefined
   */
  nextPageToken?: string;
}

/**
 * In-memory task manager implementing A2A task lifecycle.
 *
 * @remarks
 * Enforces valid state transitions and terminal state immutability.
 * Tasks are indexed by both ID and context ID for efficient lookup.
 * All returned Task objects are deep clones to prevent external mutation.
 */
export class TaskManager {
  /** Map of task ID to Task object */
  private tasks = new Map<string, Task>();
  /** Index mapping context ID to set of task IDs */
  private contextIndex = new Map<string, Set<string>>();

  /**
   * Create a new task in the submitted state.
   *
   * @remarks
   * Generates a UUID for the task and resolves the context ID from options
   * or referenced tasks. Validates that all reference tasks exist and share
   * the same context.
   *
   * @param options - Task creation options including context, metadata, and references
   * @returns Deep clone of the newly created task
   *
   * @example
   * ```typescript
   * const manager = new TaskManager();
   * const task = manager.createTask({ contextId: 'ctx-1', metadata: { source: 'api' } });
   * ```
   */
  createTask(options?: CreateTaskOptions): Task {
    const id = generateId();
    const resolvedContextId =
      options?.contextId ??
      this.resolveContextForReferenceTasks(options?.referenceTaskIds) ??
      generateId();
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

  /**
   * Create a refinement/follow-up task referencing existing task(s).
   *
   * @remarks
   * Delegates to {@link TaskManager.createTask} with the provided reference
   * task IDs. The context ID is automatically resolved from the first
   * referenced task.
   *
   * @param referenceTaskIds - IDs of parent tasks to reference
   * @param options - Additional task creation options (excluding referenceTaskIds)
   * @returns Deep clone of the newly created refinement task
   *
   * @example
   * ```typescript
   * const refined = manager.createRefinedTask(['task-1'], { parallelFollowUp: true });
   * ```
   */
  createRefinedTask(
    referenceTaskIds: string[],
    options?: Omit<CreateTaskOptions, 'referenceTaskIds'>,
  ): Task {
    return this.createTask({
      ...options,
      referenceTaskIds,
      parallelFollowUp: options?.parallelFollowUp,
    });
  }

  /**
   * Get a task by ID.
   *
   * @remarks
   * Returns a deep clone of the task to prevent external mutation.
   *
   * @param taskId - ID of the task to retrieve
   * @returns Deep clone of the requested task
   * @throws {@link TaskNotFoundError} if no task with the given ID exists
   *
   * @example
   * ```typescript
   * const task = manager.getTask('some-task-id');
   * console.log(task.status.state);
   * ```
   */
  getTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }
    return structuredClone(task);
  }

  /**
   * List tasks with optional filtering and pagination.
   *
   * @remarks
   * Supports filtering by context ID and state, with cursor-based
   * pagination using the last seen task ID as a page token. Results
   * are sorted by task ID for deterministic ordering.
   *
   * @param options - Filtering and pagination options
   * @returns Paginated result with tasks and optional next page token
   *
   * @example
   * ```typescript
   * const result = manager.listTasks({ contextId: 'ctx-1', state: 'working', limit: 10 });
   * for (const task of result.tasks) {
   *   console.log(task.id, task.status.state);
   * }
   * ```
   */
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
      taskIds = taskIds.filter((id) => {
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

    const tasks = pageTaskIds.map((id) => structuredClone(this.tasks.get(id)!));
    const nextPageToken = hasMore ? pageTaskIds[pageTaskIds.length - 1] : undefined;

    return { tasks, nextPageToken };
  }

  /**
   * Update task status. Enforces valid transitions and terminal state immutability.
   *
   * @remarks
   * Validates that the transition is allowed by the state machine before
   * applying. An optional message can be attached to the new status.
   *
   * @param taskId - ID of the task to update
   * @param state - New state to transition to
   * @param message - Optional message to attach to the status update
   * @returns Deep clone of the updated task
   * @throws {@link InvalidStateTransitionError} if the transition is not valid
   * @throws {@link TaskImmutabilityError} if the task is in a terminal state
   * @throws {@link TaskNotFoundError} if the task does not exist
   *
   * @example
   * ```typescript
   * const updated = manager.updateTaskStatus('task-1', 'working');
   * ```
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
   *
   * @remarks
   * Appends the artifact to the task's artifacts array. The task must
   * not be in a terminal state.
   *
   * @param taskId - ID of the task to add the artifact to
   * @param artifact - Artifact to add
   * @returns Deep clone of the updated task
   * @throws {@link TaskImmutabilityError} if the task is in a terminal state
   * @throws {@link TaskNotFoundError} if the task does not exist
   *
   * @example
   * ```typescript
   * const artifact = createLafsArtifact(envelope);
   * manager.addArtifact('task-1', artifact);
   * ```
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
   *
   * @remarks
   * Appends the message to the task's history array. The task must
   * not be in a terminal state.
   *
   * @param taskId - ID of the task to add the message to
   * @param message - Message to add to history
   * @returns Deep clone of the updated task
   * @throws {@link TaskImmutabilityError} if the task is in a terminal state
   * @throws {@link TaskNotFoundError} if the task does not exist
   *
   * @example
   * ```typescript
   * manager.addHistory('task-1', { role: 'agent', parts: [{ kind: 'text', text: 'Done' }] });
   * ```
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

  /**
   * Cancel a task by transitioning to canceled state.
   *
   * @remarks
   * Convenience wrapper around {@link TaskManager.updateTaskStatus} with `'canceled'`.
   *
   * @param taskId - ID of the task to cancel
   * @returns Deep clone of the canceled task
   * @throws {@link InvalidStateTransitionError} if cancellation is not valid from the current state
   * @throws {@link TaskImmutabilityError} if the task is already in a terminal state
   *
   * @example
   * ```typescript
   * const canceled = manager.cancelTask('task-1');
   * ```
   */
  cancelTask(taskId: string): Task {
    return this.updateTaskStatus(taskId, 'canceled');
  }

  /**
   * Get all tasks in a given context.
   *
   * @remarks
   * Returns deep clones of all tasks sharing the specified context ID.
   *
   * @param contextId - Context ID to look up
   * @returns Array of deep-cloned tasks in the context, or empty array if none
   *
   * @example
   * ```typescript
   * const tasks = manager.getTasksByContext('ctx-1');
   * ```
   */
  getTasksByContext(contextId: string): Task[] {
    const taskIds = this.contextIndex.get(contextId);
    if (!taskIds) return [];
    return [...taskIds].map((id) => structuredClone(this.tasks.get(id)!));
  }

  /**
   * Check if a task is in a terminal state.
   *
   * @remarks
   * Retrieves the task and checks its current state against the terminal states set.
   *
   * @param taskId - ID of the task to check
   * @returns True if the task is in a terminal state
   * @throws {@link TaskNotFoundError} if the task does not exist
   *
   * @example
   * ```typescript
   * if (manager.isTerminal('task-1')) {
   *   console.log('Task is finished');
   * }
   * ```
   */
  isTerminal(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }
    return isTerminalState(task.status.state);
  }

  /** Derive a contextId from the first referenced task, if any reference tasks are provided. */
  private resolveContextForReferenceTasks(
    referenceTaskIds: string[] | undefined,
  ): string | undefined {
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

  /** Validate that all referenced tasks exist and share the same contextId. */
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
 *
 * @remarks
 * Uses {@link createLafsArtifact} from bridge.ts to wrap the envelope
 * in a properly formatted A2A artifact, then adds it to the task.
 *
 * @param manager - TaskManager instance managing the task
 * @param taskId - ID of the task to attach the envelope to
 * @param envelope - LAFS envelope to attach as an artifact
 * @returns Deep clone of the updated task with the new artifact
 *
 * @example
 * ```typescript
 * const envelope: LAFSEnvelope = { success: true, result: { data: 'ok' }, error: null, _meta: meta };
 * const updated = attachLafsEnvelope(manager, 'task-1', envelope);
 * ```
 */
export function attachLafsEnvelope(
  manager: TaskManager,
  taskId: string,
  envelope: LAFSEnvelope,
): Task {
  const artifact = createLafsArtifact(envelope);
  return manager.addArtifact(taskId, artifact);
}
