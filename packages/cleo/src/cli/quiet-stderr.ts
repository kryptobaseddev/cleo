/**
 * Quiet-aware stderr helper.
 *
 * Single SSoT for advisory / progress / warning stderr writes that MUST be
 * suppressed under `--quiet`. Critical errors that cause non-zero exit
 * continue to use `process.stderr.write` directly — they are the one signal
 * `--quiet` MUST NOT silence.
 *
 * @task T9933
 * @epic Saga T9855
 */

import { isQuiet } from './format-context.js';

/**
 * Write advisory text to stderr unless `--quiet` is active.
 *
 * Use for: progress lines, deprecation hints, "did you mean", routing logs,
 * pino fallback warnings, and any other diagnostic noise that an operator
 * piping JSON output expects to see absent under `--quiet`.
 *
 * Do NOT use for: fatal error envelopes (those go through `cliError`) or
 * the LAFS stdout envelope itself.
 */
export function quietStderrWrite(text: string): void {
  if (isQuiet()) return;
  process.stderr.write(text);
}
