/**
 * @cleocode/animations — terminal animation primitives for the cleo CLI and CleoOS.
 *
 * @remarks
 * Forked from gunnargray-dev/unicode-animations (MIT). Currently re-exports the
 * upstream braille spinner registry verbatim. Future passes add canon-themed
 * spinner aliases (looming, weaving, heartbeat, awakening, sweeping, watching),
 * progress-bar primitives, spark animations, and an AnimationContext that ties
 * rendering to the LAFS FlagResolution (TTY, --quiet, NO_COLOR).
 */

export {
  type BrailleSpinnerName,
  default,
  gridToBraille,
  makeGrid,
  type Spinner,
  spinners,
} from './braille.js';
