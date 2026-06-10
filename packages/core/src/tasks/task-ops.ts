/**
 * Core task non-CRUD operations — barrel re-export.
 *
 * This file was decomposed from a 3408-LOC god module into 10 single-concern
 * files. All public exports are preserved here for zero import-site churn
 * across 60+ consumers.
 *
 * @see task-tree.ts      — buildTaskTree + hierarchy helpers
 * @see task-next.ts      — coreTaskNext
 * @see task-blockers.ts  — coreTaskBlockers
 * @see task-analyze.ts   — coreTaskAnalyze + complexity helpers
 * @see task-reparent.ts  — coreTaskReparent/Restore/Reopen/Reorder/Unarchive
 * @see task-data.ts      — coreTaskDeps/Relates/Stats/DepsOverview/DepsCycles/Depends
 * @see task-import.ts    — coreTaskImport/Export/Lint/BatchValidate
 * @see tree-render.ts    — text/mermaid dep-tree renderers
 * @see engine-wrap.ts    — core EngineResult wrappers + coreTaskCancel
 * @see engine-wrap-ops.ts — data/query EngineResult wrappers
 *
 * @task T10064
 * @epic T9834
 */

export {
  coreTaskCancel,
  taskAnalyze,
  // T11786 (epic T11556) — bulk task mutate ops Studio's Kanban binds to.
  taskAssignee,
  taskBlockers,
  taskBulkMove,
  taskCancel,
  taskDeps,
  taskImpact,
  taskNext,
  taskPromote,
  taskRelates,
  taskRelatesAdd,
  taskRelatesAddBatch,
  taskRelatesFind,
  taskRelatesRemove,
  taskReopen,
  taskReorder,
  taskReorderRank,
  taskReparent,
  taskRestore,
  taskTree,
  taskUnarchive,
} from './engine-wrap.js';
export {
  taskBatchValidate,
  taskClaim,
  taskComplexityEstimate,
  taskDepends,
  taskDepsCycles,
  taskDepsOverview,
  taskDepsTree,
  taskDepsValidate,
  taskExport,
  taskHistory,
  taskImport,
  taskLint,
  taskSlice,
  taskStats,
  taskUnclaim,
} from './engine-wrap-ops.js';
export type { ComplexityFactor } from './task-analyze.js';
export {
  coreTaskAnalyze,
  coreTaskComplexityEstimate,
  measureDependencyDepth,
} from './task-analyze.js';
export { coreTaskBlockers } from './task-blockers.js';

export {
  coreTaskDepends,
  coreTaskDeps,
  coreTaskDepsCycles,
  coreTaskDepsOverview,
  coreTaskRelates,
  coreTaskRelatesAdd,
  coreTaskRelatesRemove,
  coreTaskSlice,
  coreTaskStats,
} from './task-data.js';

export {
  coreTaskBatchValidate,
  coreTaskExport,
  coreTaskHistory,
  coreTaskImport,
  coreTaskLint,
} from './task-import.js';

export { coreTaskNext } from './task-next.js';

export {
  coreTaskPromote,
  coreTaskReopen,
  coreTaskReorder,
  coreTaskReparent,
  coreTaskRestore,
  coreTaskUnarchive,
} from './task-reparent.js';

export type { FlatTreeNode } from './task-tree.js';
export {
  buildTreeNode,
  buildUpstreamTree,
  coreTaskTree,
  countNodes,
  getHierarchyLimits,
} from './task-tree.js';

export {
  computeCriticalPath,
  renderMermaidTree,
  renderTextTree,
} from './tree-render.js';
