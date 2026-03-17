/**
 * Store provider abstraction layer.
 *
 * Defines the StoreProvider interface backed by SQLite (ADR-006).
 * CLI and MCP engine use StoreProvider for all data access.
 *
 * @epic T4454
 * @task W1-T6
 */
import type { TaskCurrentResult, TaskStartResult, TaskWorkHistoryEntry } from '../core/task-work/index.js';
import type { AddTaskOptions, AddTaskResult } from '../core/tasks/add.js';
import type { AnalysisResult } from '../core/tasks/analyze.js';
import type { ArchiveTasksOptions, ArchiveTasksResult } from '../core/tasks/archive.js';
import type { CompleteTaskOptions, CompleteTaskResult } from '../core/tasks/complete.js';
import type { DeleteTaskOptions, DeleteTaskResult } from '../core/tasks/delete.js';
import type { FindTasksOptions, FindTasksResult } from '../core/tasks/find.js';
import type { ListTasksOptions, ListTasksResult } from '../core/tasks/list.js';
import type { UpdateTaskOptions, UpdateTaskResult } from '../core/tasks/update.js';
import type { Session } from '../types/session.js';
import type { Task, TaskStatus, TaskType } from '../types/task.js';
export type { AddTaskOptions, AddTaskResult, CompleteTaskOptions, CompleteTaskResult, UpdateTaskOptions, UpdateTaskResult, DeleteTaskOptions, DeleteTaskResult, FindTasksOptions, FindTasksResult, ListTasksOptions, ListTasksResult, ArchiveTasksOptions, ArchiveTasksResult, TaskCurrentResult, TaskStartResult, TaskWorkHistoryEntry, AnalysisResult, };
/**
 * Store engine type. SQLite is the only supported engine (ADR-006).
 * @task T4647
 */
export type StoreEngine = 'sqlite';
/** Common task filter options. */
export interface TaskFilters {
    status?: TaskStatus;
    parentId?: string | null;
    type?: TaskType;
    phase?: string;
    limit?: number;
}
/** Common session filter options. */
export interface SessionFilters {
    active?: boolean;
    limit?: number;
}
/**
 * Store provider interface.
 * Backed by SQLite (ADR-006 canonical storage).
 */
export interface StoreProvider {
    readonly engine: StoreEngine;
    createTask(task: Task): Promise<Task>;
    getTask(taskId: string): Promise<Task | null>;
    updateTask(taskId: string, updates: Partial<Task>): Promise<Task | null>;
    deleteTask(taskId: string): Promise<boolean>;
    listTasks(filters?: TaskFilters): Promise<Task[]>;
    findTasks(query: string, limit?: number): Promise<Task[]>;
    archiveTask(taskId: string, reason?: string): Promise<boolean>;
    createSession(session: Session): Promise<Session>;
    getSession(sessionId: string): Promise<Session | null>;
    updateSession(sessionId: string, updates: Partial<Session>): Promise<Session | null>;
    listSessions(filters?: SessionFilters): Promise<Session[]>;
    endSession(sessionId: string, note?: string): Promise<Session | null>;
    startTaskOnSession(sessionId: string, taskId: string): Promise<void>;
    getCurrentTaskForSession(sessionId: string): Promise<{
        taskId: string | null;
        since: string | null;
    }>;
    stopTaskOnSession(sessionId: string): Promise<void>;
    close(): Promise<void>;
    /** Add a task with full validation, ID generation, and logging. */
    addTask(options: AddTaskOptions): Promise<AddTaskResult>;
    /** Complete a task with dependency checks and optional auto-completion. */
    completeTask(options: CompleteTaskOptions): Promise<CompleteTaskResult>;
    /** Update a task with rich options (addLabels, removeDepends, etc.). */
    richUpdateTask(options: UpdateTaskOptions): Promise<UpdateTaskResult>;
    /** Show a task by ID (throws CleoError if not found). */
    showTask(taskId: string): Promise<Task>;
    /** Delete a task with force/cascade options. */
    richDeleteTask(options: DeleteTaskOptions): Promise<DeleteTaskResult>;
    /** Find tasks with fuzzy/ID/exact search and filtering. */
    richFindTasks(options: FindTasksOptions): Promise<FindTasksResult>;
    /** List tasks with full filtering and pagination. */
    richListTasks(options: ListTasksOptions): Promise<ListTasksResult>;
    /** Archive tasks in batch with filtering options. */
    richArchiveTasks(options: ArchiveTasksOptions): Promise<ArchiveTasksResult>;
    /** Start a new session with scope, auto-start, etc. */
    startSession(options: {
        name: string;
        scope: string;
        autoStart?: boolean;
        startTask?: string;
        agent?: string;
    }): Promise<Session>;
    /** End a session, optionally by ID with a note. */
    richEndSession(options?: {
        sessionId?: string;
        note?: string;
    }): Promise<Session>;
    /** Get the current active session status. */
    sessionStatus(): Promise<Session | null>;
    /** Resume a previously ended session. */
    resumeSession(sessionId: string): Promise<Session>;
    /** List sessions with status/limit filters. */
    richListSessions(options?: {
        status?: string;
        limit?: number;
    }): Promise<Session[]>;
    /** Garbage collect old sessions. */
    gcSessions(maxAgeHours?: number): Promise<{
        orphaned: string[];
        removed: string[];
    }>;
    /** Show current task work state. */
    currentTask(): Promise<TaskCurrentResult>;
    /** Start working on a task by ID. */
    startTask(taskId: string): Promise<TaskStartResult>;
    /** Stop working on the current task. */
    stopTask(): Promise<{
        previousTask: string | null;
    }>;
    /** Get task work history. */
    getWorkHistory(): Promise<TaskWorkHistoryEntry[]>;
    /** List all labels with task counts. */
    listLabels(): Promise<Array<{
        label: string;
        count: number;
        statuses: Record<string, number>;
    }>>;
    /** Show tasks with a specific label. */
    showLabelTasks(label: string): Promise<Record<string, unknown>>;
    /** Get detailed label statistics. */
    getLabelStats(): Promise<Record<string, unknown>>;
    /** Suggest related tasks based on shared attributes. */
    suggestRelated(taskId: string, opts?: {
        threshold?: number;
    }): Promise<Record<string, unknown>>;
    /** Add a relationship between two tasks. */
    addRelation(from: string, to: string, type: string, reason: string): Promise<Record<string, unknown>>;
    /** Discover related tasks using various methods. */
    discoverRelated(taskId: string): Promise<Record<string, unknown>>;
    /** List existing relations for a task. */
    listRelations(taskId: string): Promise<Record<string, unknown>>;
    /** Analyze task priority with leverage scoring. */
    analyzeTaskPriority(opts?: {
        autoStart?: boolean;
    }): Promise<AnalysisResult>;
}
/**
 * Create a store provider. Always creates SQLite provider (ADR-006).
 * @task T4647
 */
export declare function createStoreProvider(_engine?: StoreEngine, cwd?: string): Promise<StoreProvider>;
//# sourceMappingURL=provider.d.ts.map