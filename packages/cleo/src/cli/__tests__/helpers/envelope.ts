/**
 * Strict stdout-envelope helpers for spawned-CLI tests (T12164 · gh#1223).
 *
 * ## Why this module exists
 *
 * Twelve test files independently grew the same helper:
 *
 * ```ts
 * const envelopeLine = lines.find((l) => l.trim().startsWith('{'));
 * return JSON.parse(envelopeLine);
 * ```
 *
 * It SEARCHES stdout for something that looks like an envelope. On polluted
 * output it finds one and passes:
 *
 * ```
 * lenient helper finds an envelope in polluted output:  true
 * JSON.parse on the whole stream:                       THREW
 *   "Unexpected non-whitespace character after JSON at position 3"
 * ```
 *
 * ADR-086 says stdout is ONE envelope per call. A helper that tolerates extra
 * lines does not merely miss a defect — **it makes stdout impurity untestable
 * by construction**, across every spawned-CLI test in the repo. That is how
 * `ai@6`'s `console.info` banner (gh#1223) reached stdout and survived review:
 * it appended a sentence after the envelope, and every test looked past it.
 *
 * So the assertion here parses the WHOLE stream. Extra output is a failure,
 * which is what the contract says it is.
 *
 * @task T12164
 * @see ADR-086 — one LAFS envelope per call
 */

import { expect } from 'vitest';

/** A parsed LAFS envelope as observed on stdout. */
export interface LafsEnvelope {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { code?: number | string; message?: string; codeName?: string };
  readonly meta?: { operation?: string; requestId?: string; timestamp?: string };
}

/**
 * Parse stdout as EXACTLY ONE LAFS envelope.
 *
 * @param stdout - the spawned command's complete stdout.
 * @returns the parsed envelope.
 * @throws via `expect` when stdout is empty or carries anything besides one
 *   JSON object — including a trailing banner from a dependency.
 */
export function parseSoleEnvelope(stdout: string): LafsEnvelope {
  const trimmed = stdout.trim();
  expect(trimmed.length, 'expected a LAFS envelope on stdout, got nothing').toBeGreaterThan(0);

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    // Name the extra content: "unexpected token" alone sends the reader to the
    // envelope builder when the cause is usually a stray console.log/info.
    const extra = trimmed.split('\n').slice(1).join('\n').trim();
    expect.fail(
      `stdout was not a single JSON envelope (ADR-086).\n` +
        `  parse error: ${err instanceof Error ? err.message : String(err)}\n` +
        (extra.length > 0 ? `  content AFTER the envelope:\n    ${extra}\n` : '') +
        `  full stdout:\n${stdout}`,
    );
  }
  return parsed as LafsEnvelope;
}

/**
 * Fail when the spawned CLI never reached the command under test.
 *
 * Without this, a spawned test can pass because the process died during startup
 * — measured: a dist with an unbuilt workspace dependency exits with
 * `E_CLI_UNCAUGHT` before any command runs, and assertions about its output are
 * vacuous. **A test that cannot tell whether it exercised the path reports
 * success for work it did not do**, which is the defect these tests exist to
 * catch, one level up.
 *
 * @param stdout - the spawned command's complete stdout.
 */
export function assertSpawnReachedCommand(stdout: string): void {
  expect(stdout.trim().length, 'the spawned CLI produced no stdout at all').toBeGreaterThan(0);

  let envelope: LafsEnvelope | undefined;
  try {
    envelope = JSON.parse(stdout.trim()) as LafsEnvelope;
  } catch {
    // Unparseable stdout is itself a finding; let the caller's assertion report
    // it rather than masking it here.
    return;
  }

  expect(
    envelope?.error?.codeName,
    'the spawned CLI failed during STARTUP (unbuilt workspace dependency?), so this ' +
      'test never reached the command under test — a pass here would be vacuous',
  ).not.toBe('E_CLI_UNCAUGHT');
}
