/**
 * Re-export for T11015 AC1 compliance — the actual rename logic lives in
 * project.ts as part of the project command group.
 *
 * @task T11015
 * @epic T10298
 */
export { projectCommand as projectRenameCommand } from './project.js';
