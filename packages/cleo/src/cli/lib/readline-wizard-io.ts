/**
 * Readline-backed {@link WizardIO} implementation for `cleo setup` (T9421).
 *
 * Wraps `node:readline/promises` so the core setup wizard engine
 * ({@link WizardRunner} from `@cleocode/core/setup`) can prompt the
 * operator over a TTY without the engine itself importing `node:readline`.
 *
 * Lives in `packages/cleo/src/cli/lib/` (not under `commands/`) so the
 * command-manifest generator — which scans top-level `commands/*.ts` for
 * `defineCommand` blocks — never tries to register this as a command.
 *
 * ## Stdout discipline (T9599 — bugs #1 + #10)
 *
 * `info`, `warn` and `error` all write to **stderr** so JSON consumers
 * reading stdout never see informational chatter mixed into the structured
 * LAFS envelope.  The ONLY bytes that reach stdout are the final LAFS JSON
 * envelope emitted by the CLI command after the wizard completes.
 *
 * ## EOF handling (T9599 — bug #10)
 *
 * When stdin closes before a section finishes, `node:readline/promises`'s
 * `rl.question()` silently abandons its internal callback — the promise
 * never settles and the process exits 0 with no JSON output.  To surface
 * this as a real error the implementation uses an {@link AbortController}
 * whose signal is wired to every `rl.question()` call.  The readline
 * `'close'` event aborts the controller so in-flight `question()` calls
 * throw an `AbortError`, which propagates out of the wizard as a typed
 * {@link StdinClosedError} that `setup.ts` converts to a LAFS error
 * envelope with `codeName: "E_SETUP_STDIN_CLOSED"`.
 *
 * @task T9421
 * @task T9599
 * @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-2)
 */

import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import type { WizardIO } from '@cleocode/core/setup';

// ---------------------------------------------------------------------------
// EOF sentinel
// ---------------------------------------------------------------------------

/**
 * Error codeName emitted when stdin closes before a wizard section completes.
 *
 * Referenced by both {@link ReadlineWizardIO} and `setup.ts` so the two
 * sides share the exact string without a runtime dependency on each other.
 *
 * @task T9599
 */
export const SETUP_STDIN_CLOSED_CODE = 'E_SETUP_STDIN_CLOSED' as const;

/**
 * Thrown by {@link ReadlineWizardIO} when stdin closes mid-prompt.
 *
 * `setup.ts` catches this and converts it to a LAFS error envelope with
 * `codeName: "E_SETUP_STDIN_CLOSED"` before calling `process.exit(1)`.
 *
 * @task T9599
 */
export class StdinClosedError extends Error {
  readonly codeName = SETUP_STDIN_CLOSED_CODE;

  constructor() {
    super('stdin closed before section completed');
    this.name = 'StdinClosedError';
  }

  /**
   * Type-guard so callers can identify this error without `instanceof`.
   *
   * @param err - Value caught from a `catch` block.
   */
  static is(err: unknown): err is StdinClosedError {
    return err instanceof StdinClosedError;
  }
}

// ---------------------------------------------------------------------------
// ReadlineWizardIO
// ---------------------------------------------------------------------------

/**
 * `WizardIO` backed by `node:readline/promises` and the parent process's
 * `stdin`/`stdout`.
 *
 * The instance owns a single long-lived `readline.Interface` so that
 * sequential prompts do not race for control of the TTY. {@link close}
 * MUST be called when the wizard finishes so the process can exit cleanly.
 *
 * `info`, `warn` and `error` all write to stderr so JSON consumers reading
 * stdout never see informational chatter mixed into their structured envelope.
 * The ONLY bytes that reach stdout are the final LAFS JSON envelope emitted by
 * the CLI command after the wizard completes.
 *
 * @task T9421
 * @task T9599
 */
export class ReadlineWizardIO implements WizardIO {
  private readonly rl: readline.Interface;
  /** AbortController aborted when stdin closes — surfaced as {@link StdinClosedError}. */
  private readonly eofController: AbortController;

  /**
   * Construct a readline interface bound to the supplied streams.
   *
   * The defaults (`process.stdin` / `process.stdout`) are correct for
   * production use; tests inject in-memory streams.
   *
   * @param inStream - Input stream; defaults to `process.stdin`.
   * @param outStream - Output stream passed to readline for terminal-echo
   *   purposes only; informational output goes to stderr.
   */
  constructor(inStream: NodeJS.ReadableStream = input, outStream: NodeJS.WritableStream = output) {
    this.eofController = new AbortController();
    this.rl = readline.createInterface({ input: inStream, output: outStream });
    // When stdin closes, abort the controller so all pending question()
    // calls throw an AbortError that we wrap into StdinClosedError.
    this.rl.on('close', () => {
      if (!this.eofController.signal.aborted) {
        this.eofController.abort(new StdinClosedError());
      }
    });
  }

  /**
   * Release the underlying readline interface.
   *
   * Safe to call multiple times — `readline.Interface.close()` is
   * idempotent.
   */
  close(): void {
    this.rl.close();
  }

  /**
   * Wrap an AbortError thrown by `rl.question()` into a {@link StdinClosedError}.
   *
   * `rl.question({ signal })` throws an `AbortError` when the signal fires.
   * Re-throw it as a typed `StdinClosedError` so setup.ts can detect EOF
   * without pattern-matching on error names.
   *
   * @internal
   */
  private rethrowEof(err: unknown): never {
    // AbortError thrown by readline when our eofController fires.
    if (
      err instanceof Error &&
      (err.name === 'AbortError' || err.name === 'AbortSignal') &&
      this.eofController.signal.aborted
    ) {
      throw new StdinClosedError();
    }
    throw err;
  }

  async prompt(question: string): Promise<string> {
    try {
      const answer = await this.rl.question(`${question} `, {
        signal: this.eofController.signal,
      });
      return answer.trim();
    } catch (err) {
      this.rethrowEof(err);
    }
  }

  async confirm(question: string, defaultValue?: boolean): Promise<boolean> {
    const hint = defaultValue === undefined ? '[y/n]' : defaultValue ? '[Y/n]' : '[y/N]';
    let raw: string;
    try {
      raw = (await this.rl.question(`${question} ${hint} `, { signal: this.eofController.signal }))
        .trim()
        .toLowerCase();
    } catch (err) {
      this.rethrowEof(err);
    }
    if (raw === '') {
      if (defaultValue === undefined) {
        // No default provided and operator hit enter — re-prompt once.
        return this.confirm(question, defaultValue);
      }
      return defaultValue;
    }
    if (raw === 'y' || raw === 'yes') return true;
    if (raw === 'n' || raw === 'no') return false;
    // Unrecognised answer — re-prompt.
    return this.confirm(question, defaultValue);
  }

  async select<T extends string>(question: string, options: readonly T[]): Promise<T> {
    if (options.length === 0) {
      throw new Error(`ReadlineWizardIO.select: option list is empty for '${question}'`);
    }
    // Print the menu once, then loop until a valid choice arrives. The loop
    // is bounded by a hard retry cap so a stuck pipe cannot spin indefinitely.
    // All output goes to stderr so it never corrupts the stdout LAFS envelope.
    process.stderr.write(`${question}\n`);
    options.forEach((opt, idx) => {
      process.stderr.write(`  ${idx + 1}) ${opt}\n`);
    });
    const MAX_RETRIES = 10;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      let raw: string;
      try {
        raw = (
          await this.rl.question(`Choose [1-${options.length}]: `, {
            signal: this.eofController.signal,
          })
        ).trim();
      } catch (err) {
        this.rethrowEof(err);
      }
      // Allow both numeric index and verbatim option name.
      if (/^\d+$/.test(raw)) {
        const idx = Number.parseInt(raw, 10) - 1;
        if (idx >= 0 && idx < options.length) return options[idx] as T;
      }
      if (options.includes(raw as T)) return raw as T;
      process.stderr.write(`Invalid choice '${raw}'. Try again.\n`);
    }
    throw new Error(
      `ReadlineWizardIO.select: gave up after ${MAX_RETRIES} invalid responses for '${question}'`,
    );
  }

  /** Informational message — goes to stderr, never stdout. */
  info(message: string): void {
    process.stderr.write(`${message}\n`);
  }

  /** Non-fatal warning — goes to stderr. */
  warn(message: string): void {
    process.stderr.write(`${message}\n`);
  }

  /** Error message — goes to stderr. */
  error(message: string): void {
    process.stderr.write(`${message}\n`);
  }
}
