/**
 * Cleo — high-level facade for @cleocode/core.
 *
 * Provides a project-bound API for task management, sessions, and memory
 * without requiring consumers to manage project roots or DataAccessor instances.
 *
 * Usage:
 *   import { Cleo } from '@cleocode/core';
 *   const cleo = Cleo.forProject('/path/to/project');
 *   const result = await cleo.tasks.add({ title: 'Build API', description: 'REST endpoints' });
 *
 * @epic T5716
 */

// Re-export namespaces for direct access
export { tasks, sessions, memory, lifecycle } from '../../../src/core/index.js';

// Import core functions for facade wiring
import type { AddTaskOptions, AddTaskResult } from '../../../src/core/tasks/add.js';
import type { FindTasksOptions, FindTasksResult } from '../../../src/core/tasks/find.js';
import type { TaskDetail } from '../../../src/core/tasks/show.js';
import type { ListTasksOptions, ListTasksResult } from '../../../src/core/tasks/list.js';
import type { UpdateTaskOptions, UpdateTaskResult } from '../../../src/core/tasks/update.js';
import type { CompleteTaskOptions, CompleteTaskResult } from '../../../src/core/tasks/complete.js';
import type { DeleteTaskOptions, DeleteTaskResult } from '../../../src/core/tasks/delete.js';

/**
 * Project-bound task operations.
 */
export interface CleoTasksApi {
  add(opts: AddTaskOptions): Promise<AddTaskResult>;
  find(opts: FindTasksOptions): Promise<FindTasksResult>;
  show(taskId: string): Promise<TaskDetail>;
  list(opts?: ListTasksOptions): Promise<ListTasksResult>;
  update(opts: UpdateTaskOptions): Promise<UpdateTaskResult>;
  complete(opts: CompleteTaskOptions): Promise<CompleteTaskResult>;
  delete(opts: DeleteTaskOptions): Promise<DeleteTaskResult>;
}

/**
 * High-level project-bound facade for CLEO core.
 *
 * All operations are scoped to the project root provided at construction.
 * For lower-level access, use the namespace exports directly:
 *   import { tasks, sessions, memory } from '@cleocode/core';
 */
export class Cleo {
  private constructor(readonly projectRoot: string) {}

  /**
   * Create a project-bound Cleo instance.
   *
   * @param projectRoot - Absolute path to the project directory
   * @returns A Cleo instance scoped to the given project
   */
  static forProject(projectRoot: string): Cleo {
    return new Cleo(projectRoot);
  }

  /**
   * Task management operations scoped to this project.
   */
  get tasks(): CleoTasksApi {
    const root = this.projectRoot;
    // Lazy-import to avoid circular initialization issues
    return {
      async add(opts: AddTaskOptions): Promise<AddTaskResult> {
        const { addTask } = await import('../../../src/core/tasks/add.js');
        return addTask(opts, root);
      },
      async find(opts: FindTasksOptions): Promise<FindTasksResult> {
        const { findTasks } = await import('../../../src/core/tasks/find.js');
        return findTasks(opts, root);
      },
      async show(taskId: string): Promise<TaskDetail> {
        const { showTask } = await import('../../../src/core/tasks/show.js');
        return showTask(taskId, root);
      },
      async list(opts?: ListTasksOptions): Promise<ListTasksResult> {
        const { listTasks } = await import('../../../src/core/tasks/list.js');
        return listTasks(opts ?? {}, root);
      },
      async update(opts: UpdateTaskOptions): Promise<UpdateTaskResult> {
        const { updateTask } = await import('../../../src/core/tasks/update.js');
        return updateTask(opts, root);
      },
      async complete(opts: CompleteTaskOptions): Promise<CompleteTaskResult> {
        const { completeTask } = await import('../../../src/core/tasks/complete.js');
        return completeTask(opts, root);
      },
      async delete(opts: DeleteTaskOptions): Promise<DeleteTaskResult> {
        const { deleteTask } = await import('../../../src/core/tasks/delete.js');
        return deleteTask(opts, root);
      },
    };
  }
}
