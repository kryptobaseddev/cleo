/**
 * ct-lean levels — shared types (T13663).
 *
 * The lean-change rules (the `ct-lean` skill, adapted from Ponytail 5.1.0,
 * DietrichGebert, MIT) run at one of four levels. The level resolves from the
 * `CLEO_LEAN_LEVEL` environment variable, then the session-scoped level set by
 * `cleo lean level <l> --session`, then the `lean.level` config key (project
 * over global), then `full`.
 *
 * @task T13663
 * @epic T13418
 */

/**
 * How strictly the lean-change rules apply.
 *
 * - `off` — no lean rules are emitted.
 * - `lite` — build what was asked; name the smaller option in one line.
 * - `full` — DEFAULT. The smallest complete change (the full ct-lean rules).
 * - `ultra` — `full`, and also question the request before building.
 */
export type LeanLevel = 'off' | 'lite' | 'full' | 'ultra';

/** Where a resolved lean level came from. */
export type LeanLevelSource = 'env' | 'session' | 'config' | 'default';

/** The `lean` section of `.cleo/config.json`. */
export interface LeanConfig {
  /**
   * Default lean level for this project (or, in the global config, every
   * project). `CLEO_LEAN_LEVEL` and a session-scoped level override it.
   *
   * @defaultValue 'full'
   */
  level?: LeanLevel;
}

/**
 * One deliberate shortcut, read from a `shortcut: <ceiling>, <upgrade trigger>`
 * comment (or the older `ponytail:` marker) in a git-tracked file (T13664).
 */
export interface LeanDebtItem {
  /** Repo-relative path. */
  readonly file: string;
  /** 1-based line number. */
  readonly line: number;
  /** The marker word that matched (`shortcut`, `ponytail`, or a custom marker). */
  readonly marker: string;
  /** The comment text after the marker. */
  readonly text: string;
  /** The limit the shortcut names (text before the first comma). */
  readonly ceiling: string;
  /** When to revisit it (text after the first comma), or `null` when none is named. */
  readonly upgrade: string | null;
  /** `true` when no upgrade trigger is named: the rows that silently rot. */
  readonly noTrigger: boolean;
  /** Stable id from file + marker text, independent of the line number. */
  readonly key: string;
}

/** The ledger `cleo lean debt` prints. */
export interface LeanDebtReport {
  /** Every marker found, grouped by file in path order. */
  readonly items: readonly LeanDebtItem[];
  /** How many markers name no upgrade trigger. */
  readonly noTriggerCount: number;
  /** Tasks filed by `--file-tasks` (empty otherwise). */
  readonly filed: readonly { readonly key: string; readonly taskId: string }[];
  /** Keys that already had a `lean-debt` task, so none was filed. */
  readonly alreadyFiled: readonly string[];
}

/** One measured metric on the `cleo lean gain` scoreboard (T13669). */
export interface LeanGainMetric {
  /** What was measured, e.g. `Source lines of code`. */
  readonly name: string;
  /** ct-lean as a share of the no-skill baseline (0.35 = 35%). */
  readonly ctLeanShare: number;
  /** Ponytail 5.1.0 as a share of the same baseline, for comparison. */
  readonly ponytailShare: number;
}

/** The measured scoreboard `cleo lean gain` prints: benchmark numbers, never per-repo ones. */
export interface LeanGainReport {
  /** Scoreboard heading naming the run the numbers come from. */
  readonly heading: string;
  /** Canonical research doc the numbers come from (`cleo docs fetch <slug>`). */
  readonly source: string;
  /** How the numbers were measured, in one line. */
  readonly method: string;
  /** Size, cost and time metrics. */
  readonly metrics: readonly LeanGainMetric[];
  /** Hidden checks passed per arm, e.g. `{ baseline: '23/24', ponytail: '24/24', ctLean: '24/24' }`. */
  readonly hiddenChecks: {
    readonly baseline: string;
    readonly ponytail: string;
    readonly ctLean: string;
  };
  /** The honesty boundary, always present. */
  readonly note: string;
}
