/**
 * Spark primitives — one-shot canon-themed terminal accents.
 *
 * @remarks
 * A spark is a finite frame sequence rendered exactly once, typically at
 * a meaningful command boundary: success, awaken, integrity-sweep complete.
 * Unlike spinners (which loop until stopped) and progress bars (which read
 * an external ratio), sparks own their own short timeline and decay back
 * to empty.
 *
 * Canon names align with workshop vocabulary (NEXUS-CORE-ASPECTS.md):
 *   - `awaken`  — radial bloom from center; played on `cleo init` /
 *     first daemon dream / sentient wake-up.
 *   - `sweep`   — left-to-right beam clearing the line; played when a
 *     BRAIN integrity sweep finishes.
 *   - `cascade` — diagonal fall from upper-left; played on
 *     command-success accents (release-shipped, task-complete).
 *   - `weave`   — alternating-row interlock; played on playbook stage
 *     transitions and CANT directive acceptance.
 */

/**
 * Canon spark identifier.
 */
export type SparkName = 'awaken' | 'sweep' | 'cascade' | 'weave';

/**
 * One spark: a finite frame sequence + per-frame interval.
 */
export interface Spark {
  /** Canon name. */
  readonly name: SparkName;
  /** Ordered frames; rendered exactly once, in order. */
  readonly frames: readonly string[];
  /** Milliseconds to hold each frame before advancing. */
  readonly interval: number;
}

/* -------------------------------------------
   Frame data
   ------------------------------------------- */

/**
 * `awaken` — radial bloom expanding from a single dot to a 4×2 braille cell
 * and dissolving back. Rendered on cleo init, sentient daemon wake, first
 * dream cycle.
 */
const AWAKEN_FRAMES: readonly string[] = [
  '⠀',
  '⠂',
  '⠒',
  '⠶',
  '⣶',
  '⣷',
  '⣿',
  '⣷',
  '⣶',
  '⠶',
  '⠒',
  '⠂',
  '⠀',
];

/**
 * `sweep` — left-to-right scanning beam over a 4-cell window. Mirrors the
 * `scan` spinner shape but plays once instead of looping. Rendered when a
 * BRAIN integrity sweep finishes.
 */
const SWEEP_FRAMES: readonly string[] = ['⠀⠀⠀⠀', '⡇⠀⠀⠀', '⢸⡇⠀⠀', '⠀⢸⡇⠀', '⠀⠀⢸⡇', '⠀⠀⠀⢸', '⠀⠀⠀⠀'];

/**
 * `cascade` — diagonal fall from upper-left. Same diagonal motion as the
 * `cascade` spinner, but rendered as a one-shot completion accent rather
 * than an ongoing loop. Rendered on release-shipped / task-complete.
 */
const CASCADE_FRAMES: readonly string[] = [
  '⠀⠀⠀⠀',
  '⠁⠀⠀⠀',
  '⠋⠀⠀⠀',
  '⠞⠁⠀⠀',
  '⡴⠋⠀⠀',
  '⣠⠞⠁⠀',
  '⢀⡴⠋⠀',
  '⠀⣠⠞⠁',
  '⠀⢀⡴⠋',
  '⠀⠀⣠⠞',
  '⠀⠀⢀⡴',
  '⠀⠀⠀⣠',
  '⠀⠀⠀⢀',
  '⠀⠀⠀⠀',
];

/**
 * `weave` — alternating-row interlock; two strands knit together cell-by-cell
 * and dissolve. Rendered on playbook stage transitions and CANT directive
 * acceptance.
 */
const WEAVE_FRAMES: readonly string[] = [
  '⠀⠀⠀⠀',
  '⠁⠀⠀⠀',
  '⠁⠈⠀⠀',
  '⠉⠈⠁⠀',
  '⠉⠉⠁⠈',
  '⡉⠉⠉⠈',
  '⡏⠉⠉⠉',
  '⡏⡏⠉⠉',
  '⡿⡏⡏⠉',
  '⣿⡿⡏⡏',
  '⣿⣿⡿⡏',
  '⣿⣿⣿⡿',
  '⣿⣿⣿⣿',
  '⣷⣷⣷⣷',
  '⣧⣧⣧⣧',
  '⡇⡇⡇⡇',
  '⠁⠁⠁⠁',
  '⠀⠀⠀⠀',
];

/**
 * Spark registry keyed by canon name.
 */
export const sparks: Record<SparkName, Spark> = {
  awaken: { name: 'awaken', frames: AWAKEN_FRAMES, interval: 90 },
  sweep: { name: 'sweep', frames: SWEEP_FRAMES, interval: 80 },
  cascade: { name: 'cascade', frames: CASCADE_FRAMES, interval: 70 },
  weave: { name: 'weave', frames: WEAVE_FRAMES, interval: 70 },
};

/**
 * Total wall-clock duration of a spark in milliseconds.
 *
 * @param name - Spark name
 * @returns `frames.length * interval`
 */
export function sparkDurationMs(name: SparkName): number {
  const s = sparks[name];
  return s.frames.length * s.interval;
}
