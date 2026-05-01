/**
 * Release Engine — thin re-export shim.
 *
 * All business logic has been migrated to packages/core/src/release/engine-ops.ts
 * (ENG-MIG-5 / T1572). This file is a pure re-export shim kept for backward
 * compatibility with direct test imports. Dispatch consumers MUST use
 * @cleocode/core/internal or dispatch/lib/engine.ts instead.
 *
 * @task T1572 — ENG-MIG-5
 * @epic T1566
 */

export {
  releaseCancel,
  releaseChangelog,
  releaseChangelogSince,
  releaseCommit,
  releaseGateCheck,
  releaseGatesRun,
  releaseIvtrAutoSuggest,
  releaseList,
  releasePrepare,
  releasePush,
  releaseRollback,
  releaseRollbackFull,
  releaseShip,
  releaseShow,
  releaseTag,
} from '@cleocode/core/internal';
