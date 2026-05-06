/**
 * @cleocode/animations — terminal animation primitives for the cleo CLI and CleoOS.
 *
 * @remarks
 * Forked from gunnargray-dev/unicode-animations (MIT). Provides four primitive
 * surfaces, each gated by a single {@link AnimateContext} so the LAFS protocol
 * invariant ("JSON output is the default; human rendering requires explicit
 * opt-in") holds uniformly:
 *
 *   - {@link spinners}        — 18 generic braille loading spinners
 *   - {@link canonSpinners}   — CLEO-canon aliases (looming, weaving, …)
 *   - {@link progressBars}    — segmented progress renderers (tapestry / cascade / refinery)
 *   - {@link sparks}          — one-shot accents (awaken, sweep, cascade, weave)
 *
 * The {@link createAnimateContext} factory consumes a LAFS `FlagResolution`
 * plus optional TTY / NO_COLOR overrides and returns a context whose
 * `enabled` flag is the single source of truth for "render or not render".
 */

// === AnimateContext (LAFS-aware render gate) ===
export {
  type AnimateContext,
  type AnimateContextInput,
  createAnimateContext,
  type FlagResolutionLike,
  SILENT_CONTEXT,
} from './animate-context.js';
// === Spinners ===
export {
  type BrailleSpinnerName,
  CANON_TO_GENERIC,
  type CanonSpinnerName,
  canonSpinners,
  default,
  gridToBraille,
  makeGrid,
  resolveSpinner,
  type Spinner,
  spinners,
} from './braille.js';

// === Progress bars ===
export {
  type ProgressBarRenderer,
  type ProgressBarStyle,
  progressBars,
  renderProgressBar,
} from './progress.js';

// === Sparks (one-shot accents) ===
export { type Spark, type SparkName, sparkDurationMs, sparks } from './spark.js';

// === Spinner handle (canonical owner of \r writes) ===
export {
  createSpinnerHandle,
  type SpinnerHandle,
  type SpinnerHandleOptions,
} from './spinner-handle.js';
