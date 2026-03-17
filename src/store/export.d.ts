/**
 * Export package generation for task data interchange.
 * Ported from lib/data/export.sh
 *
 * @epic T4454
 * @task T4530
 */
import type { Task, TaskFile } from '../types/task.js';
/** Export package metadata. */
export interface ExportMeta {
    format: 'cleo-export';
    version: string;
    exportedAt: string;
    source: {
        project: string;
        cleo_version: string;
        nextId: number;
    };
    checksum: string;
    taskCount: number;
    exportMode: string;
}
/** Export selection criteria. */
export interface ExportSelection {
    mode: string;
    rootTaskIds: string[];
    includeChildren: boolean;
    filters?: unknown;
}
/** ID map entry. */
export interface IdMapEntry {
    type: string;
    title: string;
    status: string;
    parentId: string | null;
    depends: string[];
}
/** Relationship graph. */
export interface RelationshipGraph {
    hierarchy: Record<string, string[]>;
    dependencies: Record<string, string[]>;
    roots: string[];
}
/** Complete export package. */
export interface ExportPackage {
    $schema: string;
    _meta: ExportMeta;
    selection: ExportSelection;
    idMap: Record<string, IdMapEntry>;
    tasks: Task[];
    relationshipGraph: RelationshipGraph;
}
/**
 * Calculate SHA-256 checksum for export integrity (truncated to 16 hex chars).
 */
export declare function calculateExportChecksum(tasksJson: string): string;
/**
 * Verify export package checksum.
 */
export declare function verifyExportChecksum(pkg: ExportPackage): boolean;
/**
 * Build ID map from tasks.
 */
export declare function buildIdMap(tasks: Task[]): Record<string, IdMapEntry>;
/**
 * Build relationship graph from tasks.
 */
export declare function buildRelationshipGraph(tasks: Task[]): RelationshipGraph;
/**
 * Build a complete export package.
 */
export declare function buildExportPackage(tasks: Task[], taskData: TaskFile, options: {
    mode: string;
    rootTaskIds: string[];
    includeChildren: boolean;
    cleoVersion?: string;
    filters?: unknown;
}): ExportPackage;
/**
 * Export a single task.
 */
export declare function exportSingle(taskId: string, taskData: TaskFile): ExportPackage | null;
/**
 * Export a subtree (task + all descendants).
 */
export declare function exportSubtree(rootId: string, taskData: TaskFile): ExportPackage | null;
//# sourceMappingURL=export.d.ts.map