/**
 * Re-export ExitCode enum and helpers from canonical source.
 * Used by packages/core/src/primitives/ to break store→core circular deps.
 *
 * @epic T5716
 */

export {
  ExitCode,
  getExitCodeName,
  isErrorCode,
  isNoChangeCode,
  isRecoverableCode,
  isSuccessCode,
} from '../types/exit-codes.js';
