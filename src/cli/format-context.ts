/**
 * CLI output format resolution context.
 *
 * Singleton that holds the resolved output format for the current CLI invocation.
 * Set once in the Commander.js preAction hook; read by cliOutput() and renderers.
 *
 * @task T4665
 * @epic T4663
 */

import type { FlagResolution } from '@cleocode/lafs-protocol';

/**
 * Current resolved format for this CLI invocation.
 * Defaults to JSON (agent-first) until resolved by preAction hook.
 */
let currentResolution: FlagResolution = {
  format: 'json',
  source: 'default',
  quiet: false,
};

/**
 * Set the resolved format for this CLI invocation.
 * Called once from the preAction hook in src/cli/index.ts.
 */
export function setFormatContext(resolution: FlagResolution): void {
  currentResolution = resolution;
}

/**
 * Get the current resolved format.
 */
export function getFormatContext(): FlagResolution {
  return currentResolution;
}

/**
 * Check if output should be JSON format.
 */
export function isJsonFormat(): boolean {
  return currentResolution.format === 'json';
}

/**
 * Check if output should be human-readable format.
 */
export function isHumanFormat(): boolean {
  return currentResolution.format === 'human';
}

/**
 * Check if quiet mode is enabled (suppress non-essential output).
 */
export function isQuiet(): boolean {
  return currentResolution.quiet;
}
