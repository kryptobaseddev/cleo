/**
 * The merge engine of the change journal's apply side (T12344): pure merge
 * decisions ({@link applyOp}), the typed rule registry and their types.
 *
 * @module store/sync/merge
 * @task T12344
 */

export {
  applyOp,
  checkSchemaVersion,
  MergeEngineError,
  type RankCandidate,
  rankMaxFrontier,
  type SchemaRefusal,
} from './engine.js';
export {
  implementedMergeRuleIds,
  type MergeRuleSet,
  mergeSpecFor,
  SYNC_MERGE_RULES,
  TASK_STAGE_RESTORE_OPS,
  TASK_STATUS_LEAVE_OPS,
} from './rules.js';
export * from './types.js';
