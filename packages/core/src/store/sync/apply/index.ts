/**
 * The change journal's apply frame and write API (T12344, PR-2): the only way
 * apply writes synced rows, recording the apply intents the sealer subtracts.
 *
 * @module store/sync/apply
 * @task T12344
 */

export { type ApplyReport, type ApplyStagedOptions, applyStagedTxns } from './applier.js';
export {
  type ApplyApi,
  ApplyFrameError,
  runApplyFrame,
  type SyncResult,
  withApplyFrame,
} from './frame.js';
export {
  type ApplyWriteApi,
  ApplyWriteError,
  createApplyWriteApi,
  type StoredEncs,
  wireToSql,
} from './write-api.js';
