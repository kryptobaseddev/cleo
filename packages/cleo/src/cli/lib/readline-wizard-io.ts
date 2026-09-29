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
 * ## Bracketed-paste sanitization (T9612)
 *
 * Terminals in bracketed-paste mode wrap pasted text with `\x1b[200~` and
 * `\x1b[201~` escape sequences.  When an operator pastes an API key, these
 * sequences appear verbatim in the answer string returned by
 * `rl.question()`.  {@link stripBracketedPaste} strips them from every
 * prompt response before it is returned so callers never see raw escape
 * bytes in credential values.
 *
 * ## SIGINT / Ctrl-C handling (T9612)
 *
 * `node:readline/promises` emits a `'SIGINT'` event on `rl` when the
 * operator presses Ctrl-C.  The default node behaviour is to echo `^C` and
 * call `rl.close()`, which then fires the `'close'` event.  To give callers
 * a typed error, {@link ReadlineWizardIO} attaches a `'SIGINT'` listener
 * that throws {@link WizardInterruptError} (exported from
 * `@cleocode/core/setup`).  The matching `setup.ts` catch block prints
 * `"Setup interrupted. Run 'cleo setup' to continue."` and exits 130.
 *
 * ## Hidden secret input (T12714)
 *
 * {@link ReadlineWizardIO.secret} writes its question, then mutes the
 * {@link MutableOutput} stream readline echoes into until the answer is
 * submitted, so the characters of a typed or pasted API key never reach the
 * terminal. The interface keeps no history (`historySize: 0`) and a secret is
 * also scrubbed from any history after it is read, so an Up-arrow can never
 * redraw a key. Terminal mode follows the INPUT stream: when stdin is a TTY
 * the terminal itself would echo a key typed with terminal mode off, so
 * {@link ReadlineWizardIO.secret} refuses in that state and points to the
 * `--key-stdin` / `--api-key-stdin` flags instead.
 *
 * @task T9421
 * @task T9599
 * @task T9612
 * @task T12714
 * @epic E-CONFIG-AUTH-UNIFY (E3 §5.3 T-E3-2)
 * @epic E-CLEO-SETUP-V2 (§3.5 T-SETUP-V2-6)
 */

import { stdin as input, stdout as output } from 'node:process';
import * as readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import type { WizardIO } from '@cleocode/core/setup';
import { WizardFatalError, WizardInterruptError } from '@cleocode/core/setup';

// ---------------------------------------------------------------------------
// Bracketed-paste sanitization (T9612)
// ---------------------------------------------------------------------------

/**
 * Strip bracketed-paste escape sequences from a terminal input string.
 *
 * Terminals in bracketed-paste mode wrap pasted text with the sequences
 * `\x1b[200~` (open) and `\x1b[201~` (close).  When an operator pastes an
 * API key at a readline prompt these markers appear verbatim inside the
 * answer string.  This helper removes them so callers never receive raw
 * escape bytes inside credential values.
 *
 * The function is deliberately simple — it strips ALL occurrences of either
 * sequence and then trims surrounding whitespace (pasted lines often carry
 * a trailing space from the terminal).
 *
 * @param raw - The raw string returned by `rl.question()`.
 * @returns The sanitized string with bracketed-paste markers removed.
 * @task T9612
 */
export function stripBracketedPaste(raw: string): string {
  // \x1b[200~ opens bracketed-paste mode; \x1b[201~ closes it.
  return raw
    .replace(/\x1b\[200~/g, '')
    .replace(/\x1b\[201~/g, '')
    .trim();
}

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
 * Extends {@link WizardFatalError} so `WizardRunner.invokeSection` re-throws
 * it instead of swallowing it into a failed summary — the CLI `setup.ts`
 * then catches this and converts it to a LAFS error envelope with
 * `codeName: "E_SETUP_STDIN_CLOSED"` before calling `process.exit(1)`.
 *
 * @task T9599
 */
export class StdinClosedError extends WizardFatalError {
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

/**
 * Message of the error {@link ReadlineWizardIO.secret} throws when stdin is a
 * terminal but readline runs with terminal mode off (the terminal's own echo
 * would then print the key).
 *
 * @task T12714
 */
export const SECRET_ECHO_REFUSED_MESSAGE =
  'Refusing to read a secret: stdin is a terminal but terminal mode is off, so the key would be echoed. ' +
  'Pipe it instead: printf %s "$KEY" | cleo decide config --provider layahost --key-stdin ' +
  '(or cleo llm add <provider> --api-key-stdin).';

/**
 * Options for {@link ReadlineWizardIO}.
 *
 * @task T12714
 */
export interface ReadlineWizardIOOptions {
  /**
   * Force readline's terminal mode. Defaults to the INPUT stream's `isTTY`,
   * because echo and line editing are properties of the keyboard side.
   */
  readonly terminal?: boolean;
}

/**
 * Whether a stream reports itself as a TTY.
 *
 * @param stream - Any Node stream.
 * @returns `true` only when `stream.isTTY === true`.
 */
function streamIsTTY(stream: NodeJS.ReadableStream | NodeJS.WritableStream): boolean {
  return 'isTTY' in stream && stream.isTTY === true;
}

// ---------------------------------------------------------------------------
// Muted output (T12714)
// ---------------------------------------------------------------------------

/**
 * Output stream readline echoes into. While {@link MutableOutput.muted} is
 * true every write is dropped, so a secret being typed is never echoed.
 * Otherwise writes pass through to the wrapped stream. `isTTY` and `columns`
 * mirror the wrapped stream so readline keeps its terminal behaviour.
 *
 * @task T12714
 */
export class MutableOutput extends Writable {
  /** When true, writes are dropped. */
  muted = false;
  /** Mirrors the wrapped stream: readline enables terminal mode (and echo) from it. */
  readonly isTTY: boolean;

  /** @param target - Stream that receives writes while unmuted. */
  constructor(private readonly target: NodeJS.WritableStream) {
    super();
    this.isTTY = 'isTTY' in target && target.isTTY === true;
  }

  /** Terminal width of the wrapped stream, when it reports one. */
  get columns(): number | undefined {
    return 'columns' in this.target && typeof this.target.columns === 'number'
      ? this.target.columns
      : undefined;
  }

  /** Forward a chunk unless muted. */
  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.muted) {
      callback();
      return;
    }
    const done = (): void => callback();
    if (typeof chunk === 'string') this.target.write(chunk, encoding, done);
    else this.target.write(chunk, done);
  }

  /** Write straight to the wrapped stream, bypassing the mute. */
  writeUnmuted(text: string): void {
    this.target.write(text);
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
 * Pasted API keys are automatically sanitized via {@link stripBracketedPaste}
 * before being returned from `prompt()` and the `select()` input path —
 * callers always receive clean strings.
 *
 * Ctrl-C (SIGINT) throws {@link WizardInterruptError} instead of silently
 * closing readline — `setup.ts` catches this to print a friendly message and
 * exit 130.
 *
 * @task T9421
 * @task T9599
 * @task T9612
 */
export class ReadlineWizardIO implements WizardIO {
  /**
   * Underlying readline interface.
   *
   * Exposed as `protected` (not `private`) so tests can emit `'SIGINT'` on it
   * to simulate Ctrl-C without requiring a real TTY. Production code MUST NOT
   * access this field directly.
   *
   * @internal
   */
  protected readonly rl: readline.Interface;
  /** The stream readline echoes into; muted while a secret is typed. */
  private readonly output: MutableOutput;
  /** Whether the input stream is a TTY (the terminal echoes unless readline owns it). */
  private readonly inputIsTTY: boolean;
  /** AbortController aborted when stdin closes — surfaced as {@link StdinClosedError}. */
  private readonly eofController: AbortController;
  /**
   * Whether a SIGINT was received. Set before throwing so `rethrowEof` does
   * not mistakenly wrap the AbortError as a `StdinClosedError`.
   */
  private sigintReceived = false;

  /**
   * Construct a readline interface bound to the supplied streams.
   *
   * The defaults (`process.stdin` / `process.stdout`) are correct for
   * production use; tests inject in-memory streams.
   *
   * @param inStream - Input stream; defaults to `process.stdin`.
   * @param outStream - Output stream passed to readline for terminal-echo
   *   purposes only; informational output goes to stderr. CLI commands pass
   *   `process.stderr` so prompts never reach a redirected stdout.
   * @param options - See {@link ReadlineWizardIOOptions}; terminal mode
   *   defaults to the input stream's `isTTY`.
   */
  constructor(
    inStream: NodeJS.ReadableStream = input,
    outStream: NodeJS.WritableStream = output,
    options: ReadlineWizardIOOptions = {},
  ) {
    this.eofController = new AbortController();
    this.output = new MutableOutput(outStream);
    this.inputIsTTY = streamIsTTY(inStream);
    this.rl = readline.createInterface({
      input: inStream,
      output: this.output,
      terminal: options.terminal ?? this.inputIsTTY,
      // No history: a secret must never be recallable with Up-arrow.
      historySize: 0,
    });
    // When stdin closes, abort the controller so all pending question()
    // calls throw an AbortError that we wrap into StdinClosedError.
    this.rl.on('close', () => {
      if (!this.eofController.signal.aborted) {
        this.eofController.abort(new StdinClosedError());
      }
    });
    // When Ctrl-C is pressed, readline emits 'SIGINT'. Abort the controller
    // with a WizardInterruptError so in-flight question() calls surface the
    // interrupt to callers instead of hanging.
    this.rl.on('SIGINT', () => {
      this.sigintReceived = true;
      if (!this.eofController.signal.aborted) {
        this.eofController.abort(new WizardInterruptError('interrupted by user'));
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
   * Wrap an AbortError thrown by `rl.question()` into the appropriate
   * typed error.
   *
   * - SIGINT received → throw {@link WizardInterruptError}
   * - Stdin EOF → throw {@link StdinClosedError}
   * - Any other error → re-throw as-is.
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
      // Distinguish SIGINT (interrupt) from ordinary EOF (stdin closed).
      if (this.sigintReceived) {
        throw new WizardInterruptError('interrupted by user');
      }
      throw new StdinClosedError();
    }
    throw err;
  }

  async prompt(question: string): Promise<string> {
    try {
      const raw = await this.rl.question(`${question} `, {
        signal: this.eofController.signal,
      });
      return stripBracketedPaste(raw);
    } catch (err) {
      this.rethrowEof(err);
    }
  }

  /**
   * Ask for a secret without echoing it: the question is written, then the
   * output stream is muted until the answer is submitted. Bracketed-paste
   * markers are stripped like {@link prompt}. The answer is removed from
   * readline's history afterwards.
   *
   * @param question - The question, e.g. `API key:`.
   * @returns The trimmed answer; `''` when none was given.
   * @throws Error with {@link SECRET_ECHO_REFUSED_MESSAGE} when stdin is a
   *   terminal but terminal mode is off (the terminal would echo the key).
   * @task T12714
   */
  async secret(question: string): Promise<string> {
    if (this.inputIsTTY && !this.rl.terminal) throw new Error(SECRET_ECHO_REFUSED_MESSAGE);
    this.output.writeUnmuted(`${question} `);
    this.output.muted = true;
    let raw: string | undefined;
    try {
      raw = await this.rl.question('', { signal: this.eofController.signal });
      return stripBracketedPaste(raw);
    } catch (err) {
      return this.rethrowEof(err);
    } finally {
      this.output.muted = false;
      this.output.writeUnmuted('\n');
      if (raw !== undefined) this.scrubHistory(raw);
    }
  }

  /**
   * Remove every history entry equal to `line`. `history` is a runtime field
   * of `readline.Interface` that `@types/node` does not declare, so it is
   * read reflectively and checked before use.
   *
   * @param line - The exact line readline recorded.
   */
  private scrubHistory(line: string): void {
    const history: unknown = Reflect.get(this.rl, 'history');
    if (!Array.isArray(history)) return;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i] === line) history.splice(i, 1);
    }
  }

  async confirm(question: string, defaultValue?: boolean): Promise<boolean> {
    const hint = defaultValue === undefined ? '[y/n]' : defaultValue ? '[Y/n]' : '[y/N]';
    let raw: string;
    try {
      raw = stripBracketedPaste(
        await this.rl.question(`${question} ${hint} `, { signal: this.eofController.signal }),
      ).toLowerCase();
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
        raw = stripBracketedPaste(
          await this.rl.question(`Choose [1-${options.length}]: `, {
            signal: this.eofController.signal,
          }),
        );
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
