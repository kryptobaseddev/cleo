/**
 * Re-export CleoError and related types from canonical source.
 * Used by src/store/ to break store→core circular deps.
 *
 * @epic T5716
 */

export type { ProblemDetails } from '../core/errors.js';
export { CleoError } from '../core/errors.js';
export {
  ExitCode,
  getExitCodeName,
  isErrorCode,
  isNoChangeCode,
  isRecoverableCode,
  isSuccessCode,
} from './exit-codes.js';
