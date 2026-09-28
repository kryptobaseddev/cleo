/**
 * Shared constants for probing the OS process table with `ps`.
 *
 * @module process-probe
 * @task T12500
 * @task T12506
 */

/**
 * Environment overrides for every `ps` probe (T12500): UTC and the C locale make
 * the `lstart` start time independent of the caller's `TZ` / `LANG`. The
 * terminal-identity ppid-chain keys (core) and the per-task worktree lock
 * holder identity (`@cleocode/worktree`, T12506) both compare `lstart` strings
 * written by one process and read by another, so both must render them the
 * same way.
 */
export const PS_STABLE_ENV: Readonly<Record<'TZ' | 'LC_ALL' | 'LANG', string>> = {
  TZ: 'UTC',
  LC_ALL: 'C',
  LANG: 'C',
};
