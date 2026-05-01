/**
 * Session engine operations barrel.
 *
 * Re-exports all EngineResult-wrapped session functions migrated from
 * `packages/cleo/src/dispatch/engines/session-engine.ts` (ENG-MIG-6 / T1573).
 *
 * Import from `@cleocode/core/internal` for CLI dispatch layer access.
 *
 * @task T1573 — ENG-MIG-6
 * @epic T1566
 */

export {
  sessionArchive,
  sessionBriefing,
  sessionChainShow,
  sessionCleanup,
  sessionComputeDebrief,
  sessionComputeHandoff,
  sessionContextDrift,
  sessionContextInject,
  sessionDebriefShow,
  sessionDecisionLog,
  sessionEnd,
  sessionFind,
  sessionGc,
  sessionHandoff,
  sessionHistory,
  sessionList,
  sessionRecordAssumption,
  sessionRecordDecision,
  sessionResume,
  sessionShow,
  sessionStart,
  sessionStats,
  sessionStatus,
  sessionSuspend,
  sessionSwitch,
  taskCurrentGet,
  taskStart,
  taskStop,
  taskWorkHistory,
} from './engine-ops.js';
