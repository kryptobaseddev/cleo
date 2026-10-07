/**
 * Whether a command may prompt (T13308): one rule for every interactive
 * question CLEO asks.
 *
 * A prompt needs both stdin and stderr on a terminal: a prompt written to a
 * redirected stderr (`cleo login 2>log`) is invisible and would wait on the
 * keyboard, an apparent hang. It never runs under CI, where nobody answers.
 *
 * @task T13308
 */

/**
 * Whether `env` says the process runs under CI (`CI` set to anything but
 * empty or `false`).
 *
 * @param env - The environment.
 * @returns True under CI.
 */
export function isCiEnv(env: NodeJS.ProcessEnv): boolean {
  return (env['CI'] ?? '') !== '' && env['CI'] !== 'false';
}

/**
 * Whether a command may ask the user something now.
 *
 * @param env - The environment. @defaultValue process.env
 * @param tty - Whether stdin and stderr are terminals. @defaultValue both `isTTY`
 * @returns True when both are terminals and the run is not under CI.
 */
export function promptAllowed(
  env: NodeJS.ProcessEnv = process.env,
  tty: boolean = process.stdin.isTTY === true && process.stderr.isTTY === true,
): boolean {
  return tty && !isCiEnv(env);
}
