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
