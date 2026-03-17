/**
 * ID remapping logic for import system.
 * Ported from lib/data/import-remap.sh
 *
 * @epic T4454
 * @task T4530
 */
import type { Task } from '../types/task.js';
/** Forward and reverse remap tables. */
export interface RemapTable {
    forward: Map<string, string>;
    reverse: Map<string, string>;
}
/**
 * Get the next available task ID number from existing tasks.
 */
export declare function getNextAvailableId(tasks: Task[]): number;
/**
 * Generate a remap table for importing tasks.
 * Maps source task IDs to new sequential IDs starting from nextAvailable.
 */
export declare function generateRemapTable(sourceTaskIds: string[], existingTasks: Task[]): RemapTable;
/**
 * Validate that a remap table is complete and consistent.
 */
export declare function validateRemapTable(table: RemapTable, expectedSourceIds: string[]): {
    valid: boolean;
    errors: string[];
};
/**
 * Remap a single task ID, returning original if not in table.
 */
export declare function remapTaskId(taskId: string | null, table: RemapTable): string | null;
/**
 * Remap all ID references in a task.
 */
export declare function remapTaskReferences(task: Task, table: RemapTable, existingTaskIds: Set<string>, missingDepStrategy?: 'strip' | 'fail'): Task;
/**
 * Detect duplicate titles between import and target.
 */
export declare function detectDuplicateTitles(importTasks: Task[], existingTasks: Task[]): Array<{
    sourceId: string;
    title: string;
    existingId: string;
}>;
/**
 * Resolve duplicate title by appending suffix.
 */
export declare function resolveDuplicateTitle(title: string, existingTitles: Set<string>): string;
//# sourceMappingURL=import-remap.d.ts.map