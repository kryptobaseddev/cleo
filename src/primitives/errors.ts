/**
 * Re-export CleoError and related types from canonical source.
 * Used by src/store/ to break store→core circular deps.
 *
 * @epic T5716
 */

export { CleoError } from '../core/errors.js';
export type { ProblemDetails } from '../core/errors.js';
export { ExitCode, getExitCodeName, isErrorCode, isRecoverableCode, isSuccessCode, isNoChangeCode } from './exit-codes.js';
