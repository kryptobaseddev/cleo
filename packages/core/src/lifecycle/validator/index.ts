/**
 * Validator runtime barrel — re-exports the Max-N retry runtime that
 * drives the Lead↔Worker↔Validator round-trip.
 *
 * @module lifecycle/validator
 * @task T10512
 * @epic T10383
 * @saga T10377
 */

export type {
  BackoffStrategy,
  RunValidatorMaxNOptions,
  ValidatorFault,
  ValidatorFaultFamily,
  ValidatorFaultKind,
  ValidatorRetryAuditEntry,
  ValidatorRoundResult,
  ValidatorRuntimeDeps,
  ValidatorRuntimeResult,
  ValidatorSpawnRequest,
  WorkerRespawnFn,
} from './runtime.js';
export {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  DEFAULT_VALIDATOR_RETRY_MAX,
  MAX_N_ROWS,
  resolveBackoffMs,
  runValidatorMaxN,
  VALIDATOR_RETRIES_AUDIT_FILE,
} from './runtime.js';
