/**
 * Export package generation for task data interchange.
 * Ported from lib/data/export.sh
 *
 * @epic T4454
 * @task T4530
 */
import { createHash } from 'node:crypto';
/** Export format version. */
const EXPORT_FORMAT_VERSION = '1.0.0';
/**
 * Calculate SHA-256 checksum for export integrity (truncated to 16 hex chars).
 */
export function calculateExportChecksum(tasksJson) {
    const canonical = JSON.stringify(JSON.parse(tasksJson));
    return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
/**
 * Verify export package checksum.
 */
export function verifyExportChecksum(pkg) {
    const tasksJson = JSON.stringify(pkg.tasks);
    const calculated = calculateExportChecksum(tasksJson);
    return pkg._meta.checksum === calculated;
}
/**
 * Build ID map from tasks.
 */
export function buildIdMap(tasks) {
    const map = {};
    for (const task of tasks) {
        map[task.id] = {
            type: task.type ?? 'task',
            title: task.title,
            status: task.status,
            parentId: task.parentId ?? null,
            depends: task.depends ?? [],
        };
    }
    return map;
}
/**
 * Build relationship graph from tasks.
 */
export function buildRelationshipGraph(tasks) {
    const exportedIds = new Set(tasks.map((t) => t.id));
    const hierarchy = {};
    const dependencies = {};
    for (const task of tasks) {
        // Hierarchy
        if (task.parentId && exportedIds.has(task.parentId)) {
            if (!hierarchy[task.parentId])
                hierarchy[task.parentId] = [];
            hierarchy[task.parentId].push(task.id);
        }
        // Dependencies
        if (task.depends?.length) {
            const internalDeps = task.depends.filter((d) => exportedIds.has(d));
            if (internalDeps.length > 0) {
                dependencies[task.id] = internalDeps;
            }
        }
    }
    // Roots: tasks with no parent in export and no deps in export
    const roots = tasks
        .filter((t) => {
        const hasParentInExport = t.parentId && exportedIds.has(t.parentId);
        const hasDepsInExport = t.depends?.some((d) => exportedIds.has(d));
        return !hasParentInExport && !hasDepsInExport;
    })
        .map((t) => t.id);
    return { hierarchy, dependencies, roots };
}
/**
 * Build a complete export package.
 */
export function buildExportPackage(tasks, taskData, options) {
    const now = new Date().toISOString();
    const projectName = taskData.project?.name ?? 'unknown';
    const maxId = tasks.reduce((max, t) => {
        const num = parseInt(t.id.replace('T', ''), 10);
        return num > max ? num : max;
    }, 0);
    const idMap = buildIdMap(tasks);
    const relationshipGraph = buildRelationshipGraph(tasks);
    const tasksJson = JSON.stringify(tasks);
    const checksum = calculateExportChecksum(tasksJson);
    return {
        $schema: 'https://cleo-dev.com/schemas/v1/export-package.schema.json',
        _meta: {
            format: 'cleo-export',
            version: EXPORT_FORMAT_VERSION,
            exportedAt: now,
            source: {
                project: projectName,
                cleo_version: options.cleoVersion ?? '0.95.0',
                nextId: maxId + 1,
            },
            checksum,
            taskCount: tasks.length,
            exportMode: options.mode,
        },
        selection: {
            mode: options.mode,
            rootTaskIds: options.rootTaskIds,
            includeChildren: options.includeChildren,
            filters: options.filters,
        },
        idMap,
        tasks,
        relationshipGraph,
    };
}
/**
 * Export a single task.
 */
export function exportSingle(taskId, taskData) {
    const task = taskData.tasks.find((t) => t.id === taskId);
    if (!task)
        return null;
    return buildExportPackage([task], taskData, {
        mode: 'single',
        rootTaskIds: [taskId],
        includeChildren: false,
    });
}
/**
 * Export a subtree (task + all descendants).
 */
export function exportSubtree(rootId, taskData) {
    const root = taskData.tasks.find((t) => t.id === rootId);
    if (!root)
        return null;
    // Collect all descendants
    const collected = new Map();
    const queue = [rootId];
    while (queue.length > 0) {
        const id = queue.shift();
        const task = taskData.tasks.find((t) => t.id === id);
        if (!task || collected.has(id))
            continue;
        collected.set(id, task);
        const children = taskData.tasks.filter((t) => t.parentId === id);
        queue.push(...children.map((c) => c.id));
    }
    const tasks = [...collected.values()];
    return buildExportPackage(tasks, taskData, {
        mode: 'subtree',
        rootTaskIds: [rootId],
        includeChildren: true,
    });
}
//# sourceMappingURL=export.js.map