/**
 * Deriver module — public exports.
 *
 * Provides the durable background derivation worker queue for CLEO BRAIN.
 * Wave 5 (T1145) of the PSYCHE integration.
 *
 * @task T1145
 * @epic T1145
 */

export {
  DEFAULT_BATCH_SIZE,
  type DeriverBatchOptions,
  type DeriverBatchResult,
  runDeriverBatch,
} from './consumer.js';
export {
  type DerivationResult,
  type DeriveOptions,
  deriveItem,
} from './deriver.js';
export {
  type EnqueueOptions,
  type EnqueueResult,
  enqueueDerivation,
  enqueueObservationBatch,
} from './enqueue.js';
export {
  type ClaimedItem,
  type ClaimOptions,
  type CompleteOptions,
  claimNextItem,
  completeItem,
  failItem,
  MAX_RETRY_COUNT,
  recoverStaleItems,
  STALE_CLAIM_MINUTES,
  type StaleRecoveryResult,
} from './queue-manager.js';
export {
  type DeriverQueueItem,
  type DeriverQueueStatusCounts,
  type GetQueueStatusOptions,
  getQueueStatus,
  hasQueuePending,
  listQueueItems,
} from './status.js';
