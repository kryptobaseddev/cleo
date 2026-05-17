/**
 * First-run detection + setup prompt (T9422, spec §5.3 T-E3-3).
 *
 * Surfaces a one-shot reminder to TTY users who have CLEO installed but
 * have not yet configured any credentials. The detector is intentionally
 * conservative — it only flags an install as "first-run" when ALL three
 * conditions hold:
 *
 *   1. The XDG/env-paths global config file does NOT exist.
 *   2. The unified credential pool reports zero stored entries.
 *   3. `process.env.ANTHROPIC_API_KEY` is unset.
 *
 * Any one of those being non-empty is treated as "configured enough to
 * proceed" and the prompt is suppressed.
 *
 * The prompt itself is best-effort and MUST NOT block the CLI on any
 * failure path:
 *   - Non-TTY stdin → silently skip (preserves CI / piped automation).
 *   - Detection or imports throw → swallowed by the public wrapper.
 *   - User presses Enter OR 10s elapse → return immediately and continue.
 *
 * Wired into {@link startCli} (packages/cleo/src/cli/index.ts) before
 * command dispatch.
 *
 * @task T9422
 * @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-3)
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Detect whether the current install looks like a fresh, unconfigured
 * environment.
 *
 * Returns `true` only if EVERY signal points to "no credentials yet":
 *
 *   - The XDG-resolved global config (`getCleoPlatformPaths().config +
 *     '/config.json'`) does not exist on disk.
 *   - `getCredentialPool().list()` returns zero entries.
 *   - `process.env.ANTHROPIC_API_KEY` is unset (or empty string).
 *
 * The detection is read-only and side-effect free. Imports are dynamic
 * so the cold-start path of `cleo --help` / `cleo --version` is not
 * burdened with the credential-pool dependency tree.
 *
 * @returns `true` when CLEO appears to be unconfigured, `false` otherwise.
 *
 * @public
 */
export async function detectFirstRun(): Promise<boolean> {
  // ENV signal — cheapest, do it first.
  const envKey = process.env['ANTHROPIC_API_KEY'];
  if (typeof envKey === 'string' && envKey.length > 0) return false;

  // Global-config file check via the XDG/env-paths SSoT.
  const { getCleoPlatformPaths } = await import('@cleocode/paths');
  const configPath = join(getCleoPlatformPaths().config, 'config.json');
  if (existsSync(configPath)) return false;

  // Credential-pool check — last because it imports the LLM dependency
  // tree. Pool failures are NOT propagated; we treat them as "no entries"
  // so a broken pool never blocks the CLI.
  try {
    const { getCredentialPool } = await import('@cleocode/core/llm/credential-pool.js');
    const pool = getCredentialPool();
    const entries = await pool.list();
    if (entries.length > 0) return false;
  } catch {
    // Pool unavailable — be permissive and continue with the env/config
    // signals already collected. Both already point to "unconfigured", so
    // the caller will prompt.
  }

  return true;
}

/**
 * Internal: wait for either an Enter keypress on stdin OR a timeout.
 *
 * Resolves as soon as either condition fires. Cleans up the data + end
 * listeners and the timer so the process can exit cleanly after the
 * prompt returns.
 *
 * @param timeoutMs - Maximum wait, in milliseconds.
 * @internal
 */
function waitForEnterOrTimeout(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      // Best-effort: pause stdin so we do not steal input from the next
      // command. We do not call setRawMode — leaving the terminal in
      // line-buffered mode is the safer default.
      try {
        process.stdin.pause();
      } catch {
        // Some environments (e.g. detached stdin) reject pause(); ignore.
      }
      resolve();
    };

    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // Any newline counts as "press Enter to skip" — matches the prompt
      // copy and works for both \n and \r\n line endings.
      if (s.includes('\n') || s.includes('\r')) finish();
    };
    const onEnd = (): void => finish();

    const timer = setTimeout(finish, timeoutMs);
    // setTimeout returns a Timeout that keeps the event loop alive. The
    // listeners on stdin also keep it alive; finish() clears both.

    process.stdin.on('data', onData);
    process.stdin.on('end', onEnd);
    try {
      process.stdin.resume();
    } catch {
      // If stdin cannot be resumed (e.g. already ended), the timer is
      // still the fallback path — do nothing.
    }
  });
}

/**
 * Prompt the user once at CLI startup when {@link detectFirstRun} flags
 * the install as unconfigured.
 *
 * Behaviour matrix:
 *
 *   - `detectFirstRun() === true` AND stdin is a TTY:
 *       Write the reminder to stderr, then wait up to 10s OR until the
 *       user presses Enter (whichever comes first).
 *   - `detectFirstRun() === true` AND stdin is NOT a TTY:
 *       Silently skip — never block CI / piped invocations.
 *   - `detectFirstRun() === false`:
 *       No-op.
 *
 * All failures (detection throws, console writes throw, anything) are
 * swallowed: the prompt MUST NEVER block CLI startup.
 *
 * @public
 */
export async function maybePromptFirstRun(): Promise<void> {
  try {
    const isFirstRun = await detectFirstRun();
    if (!isFirstRun) return;

    // Non-TTY → silently skip. `isTTY` is `undefined` when stdin is not
    // a TTY (e.g. piped, redirected, CI runner) and `true` on an actual
    // interactive terminal. We treat anything other than `true` as
    // non-interactive.
    if (process.stdin.isTTY !== true) return;

    process.stderr.write(
      "CLEO is not configured. Run 'cleo setup' to get started. " +
        '(Press Enter to skip, or wait 10s)\n',
    );

    await waitForEnterOrTimeout(10_000);
  } catch {
    // Detection or prompt failure MUST NOT block the CLI.
  }
}
