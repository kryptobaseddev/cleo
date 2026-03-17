/**
 * SQLite-backed task store operations.
 *
 * CRUD operations for tasks, dependencies, and relations backed by tasks.db.
 * Implements the same interface as the JSON store for StoreProvider compatibility.
 *
 * @epic T4454
 * @task W1-T3
 */
import type { Task, TaskStatus, TaskType } from '../types/task.js';
import { type SafetyConfig } from './data-safety.js';
/** Create a new task. */
export declare function createTask(task: Task, cwd?: string): Promise<Task>;
/** Get a task by ID, including its dependencies. */
export declare function getTask(taskId: string, cwd?: string): Promise<Task | null>;
/** Update an existing task. */
export declare function updateTask(taskId: string, updates: Partial<Task>, cwd?: string): Promise<Task | null>;
/** Delete a task by ID. */
export declare function deleteTask(taskId: string, cwd?: string): Promise<boolean>;
/** List tasks with optional filters. */
export declare function listTasks(filters?: {
    status?: TaskStatus;
    parentId?: string | null;
    type?: TaskType;
    phase?: string;
    limit?: number;
}, cwd?: string): Promise<Task[]>;
/** Find tasks by fuzzy text search. */
export declare function findTasks(query: string, limit?: number, cwd?: string): Promise<Task[]>;
/** Archive a task (sets status to 'archived' with metadata). */
export declare function archiveTask(taskId: string, reason?: string, cwd?: string): Promise<boolean>;
/** Add a dependency between tasks. */
export declare function addDependency(taskId: string, dependsOn: string, cwd?: string): Promise<void>;
/** Remove a dependency. */
export declare function removeDependency(taskId: string, dependsOn: string, cwd?: string): Promise<void>;
/** Add a relation between tasks. */
export declare function addRelation(taskId: string, relatedTo: string, relationType?: 'related' | 'blocks' | 'duplicates' | 'absorbs' | 'fixes' | 'extends' | 'supersedes', cwd?: string, reason?: string): Promise<void>;
/** Get relations for a task. */
export declare function getRelations(taskId: string, cwd?: string): Promise<Array<{
    relatedTo: string;
    type: string;
    reason?: string;
}>>;
/** Get the dependency chain (blockers) for a task using recursive CTE. */
export declare function getBlockerChain(taskId: string, cwd?: string): Promise<string[]>;
/** Get children of a task (hierarchy). */
export declare function getChildren(parentId: string, cwd?: string): Promise<Task[]>;
/** Build a tree from a root task using recursive CTE. */
export declare function getSubtree(rootId: string, cwd?: string): Promise<Task[]>;
/** Count tasks by status. */
export declare function countByStatus(cwd?: string): Promise<Record<string, number>>;
/** Get total task count (excluding archived). */
export declare function countTasks(cwd?: string): Promise<number>;
/** Configuration for safe operations. */
export type { SafetyConfig } from './data-safety.js';
/**
 * Create a task with full safety protections.
 * Includes: collision detection, write verification, sequence validation, auto-checkpoint.
 */
export declare function createTaskSafe(task: Task, cwd?: string, config?: Partial<SafetyConfig>): Promise<Task>;
/**
 * Update a task with full safety protections.
 * Includes: write verification, auto-checkpoint.
 */
export declare function updateTaskSafe(taskId: string, updates: Partial<Task>, cwd?: string, config?: Partial<SafetyConfig>): Promise<Task | null>;
/**
 * Delete a task with full safety protections.
 * Includes: delete verification, auto-checkpoint.
 */
export declare function deleteTaskSafe(taskId: string, cwd?: string, config?: Partial<SafetyConfig>): Promise<boolean>;
//# sourceMappingURL=task-store.d.ts.map