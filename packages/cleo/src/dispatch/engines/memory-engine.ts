/**
 * Memory Engine
 *
 * Dispatch layer adapter for brain.db cognitive memory operations.
 * Delegates to src/core/memory/engine-compat.ts which implements the EngineResult pattern.
 *
 * @task T5674
 */

export {
  memoryBrainStats,
  memoryContradictions,
  memoryDecisionFind,
  memoryDecisionStore,
  memoryFetch,
  memoryFind,
  memoryGraphAdd,
  memoryGraphContext,
  memoryGraphNeighbors,
  memoryGraphRelated,
  memoryGraphRemove,
  memoryGraphShow,
  memoryGraphStatsFull,
  memoryGraphTrace,
  memoryLearningFind,
  memoryLearningStats,
  memoryLearningStore,
  memoryLink,
  memoryObserve,
  memoryPatternFind,
  memoryPatternStats,
  memoryPatternStore,
  memoryQualityReport,
  memoryReasonSimilar,
  memoryReasonWhy,
  memorySearchHybrid,
  memoryShow,
  memorySuperseded,
  memoryTimeline,
  memoryUnlink,
} from '@cleocode/core/internal';
