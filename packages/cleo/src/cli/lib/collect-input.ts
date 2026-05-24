/**
 * collectMutateInput — thin CLI transport adapter for mutate operations.
 *
 * Collects structured input for any CLEO mutate operation from the four
 * standard CLI input channels with a documented precedence order
 * (higher wins, first-match returns):
 *
 *   1. `--params <json-string>` — inline JSON string
 *   2. `--file <path>`          — JSON file on disk
 *   3. stdin                    — piped JSON (when `!stdin.isTTY`)
 *   4. positional               — raw positional args (no parse)
 *
 * This module is intentionally THIN: it collects and parses, it does NOT
 * validate against any schema. Schema validation is owned by CORE via
 * `validateOperationInput()` (T9915) using the {@link OperationInputContract}
 * surface from `@cleocode/contracts/operations/input-contract` (T9914).
 *
 * Designed to be reused from every mutate CLI command: `add`, `add-batch`,
 * `update`, `complete`, `delete`, etc.
 *
 * @packageDocumentation
 * @module @cleocode/cleo/cli/lib/collect-input
 *
 * @task T9916
 * @epic E7.3 — CLI mutate-input transport
 * @saga T9855
 * @adr ADR-076
 */

import { readFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal subset of `NodeJS.ReadableStream` plus the `isTTY` discriminator
 * used to detect piped (non-TTY) stdin.
 *
 * Accepting this loose shape (instead of `NodeJS.ReadStream`) lets tests
 * pass a plain `Readable.from(...)` with a manually-set `isTTY` flag and
 * keeps the public signature free of process-bound types.
 */
export type StdinLike = NodeJS.ReadableStream & { isTTY?: boolean };

/**
 * Argument bag passed by a CLI command handler to {@link collectMutateInput}.
 *
 * Every field is optional — the adapter walks the four channels in
 * precedence order and returns the first one that resolves.
 */
export interface CollectMutateInputArgs {
  /** Inline JSON string from `--params`. Parsed via {@link JSON.parse}. */
  params?: string;
  /** Filesystem path from `--file`. File is read as UTF-8 then parsed. */
  file?: string;
  /** Raw positional args — returned as-is (no parse, no validation). */
  positional?: unknown[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Maximum snippet length included in JSON parse-error messages.
 *
 * Snippets are clamped so a multi-megabyte malformed payload does not
 * blow up the error message that gets logged or surfaced via cliError.
 */
const PARSE_ERROR_SNIPPET_MAX_LENGTH = 80;

/**
 * Wraps a {@link SyntaxError} from {@link JSON.parse} into a descriptive
 * {@link Error} that names the source channel (`--params`, `--file <path>`,
 * `stdin`) and includes a truncated snippet of the offending input.
 *
 * The returned error is a plain `Error` (not a subclass) so callers can
 * surface the `.message` directly through `cliError()` without losing
 * the source-label context.
 *
 * @param rawInput   - The raw input string that failed to parse.
 * @param parseErr   - The {@link SyntaxError} thrown by {@link JSON.parse}.
 * @param sourceLabel - Human-readable label naming the input channel
 *                     (e.g. `'--params'`, `"--file /tmp/x.json"`, `'stdin'`).
 *
 * @returns A new {@link Error} with a structured, human-readable message.
 *
 * @example
 * ```ts
 * try {
 *   JSON.parse(raw);
 * } catch (err) {
 *   throw wrapParseError(raw, err as SyntaxError, '--params');
 * }
 * ```
 */
export function wrapParseError(
  rawInput: string,
  parseErr: SyntaxError,
  sourceLabel: string,
): Error {
  const snippet =
    rawInput.length > PARSE_ERROR_SNIPPET_MAX_LENGTH
      ? `${rawInput.slice(0, PARSE_ERROR_SNIPPET_MAX_LENGTH)}…`
      : rawInput;
  return new Error(`Invalid JSON in ${sourceLabel}: ${parseErr.message} (got: ${snippet})`);
}

/**
 * Reads all bytes from a {@link StdinLike} stream, concatenates them as
 * UTF-8, and parses the result as JSON.
 *
 * Resolves with the parsed value (typed as `unknown` — CORE validates).
 * Rejects with a descriptive {@link Error} (via {@link wrapParseError})
 * when the stream contents are not valid JSON. Also rejects if the
 * underlying stream emits an `error` event.
 *
 * The stream is consumed in object-mode-friendly fashion: each chunk is
 * coerced to a `Buffer` (already-buffer or string) before concatenation,
 * so callers can pass either a real process stream or a test double
 * built from `Readable.from([Buffer.from('...')])`.
 *
 * @param stdin - The readable stream to drain.
 *
 * @returns A promise resolving to the parsed JSON value.
 *
 * @example
 * ```ts
 * const value = await readStdinJson(process.stdin);
 * ```
 */
export function readStdinJson(stdin: NodeJS.ReadableStream): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stdin.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    stdin.on('error', (err: Error) => {
      reject(err);
    });
    stdin.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(wrapParseError(raw, err as SyntaxError, 'stdin'));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Collects structured input for a mutate operation from the four standard
 * CLI input channels, returning the first match in precedence order.
 *
 * Precedence (highest wins, first match returns immediately — later
 * channels are NOT inspected once a higher-precedence channel resolves):
 *
 *   1. `args.params`     — inline JSON string from `--params`
 *   2. `args.file`       — filesystem path from `--file`
 *   3. stdin             — piped input (when `!stdin.isTTY`)
 *   4. `args.positional` — raw positional args (returned as-is)
 *
 * If no channel matches (no `params`, no `file`, stdin is a TTY, and
 * `positional` is undefined or empty), the function returns `undefined`.
 *
 * Schema validation is NOT performed here. CORE owns validation via
 * `validateOperationInput()` (T9915). This adapter exists purely to
 * normalize the four CLI input shapes into a single parsed value.
 *
 * @param args  - Argument bag from the citty command handler.
 * @param stdin - The stdin stream to inspect. In production this is
 *                `process.stdin`; in tests pass a `Readable.from(...)`
 *                double with `isTTY: false` set explicitly.
 *
 * @returns A promise resolving to the parsed input value (typed as
 *          `unknown` — CORE validates), or `undefined` when no channel
 *          provides input.
 *
 * @throws {Error} When `--params` contains invalid JSON
 *                 (message includes source label + snippet).
 * @throws {Error} When `--file` contains invalid JSON or the file cannot
 *                 be read (ENOENT and friends propagate).
 * @throws {Error} When piped stdin contains invalid JSON.
 *
 * @example
 * ```ts
 * // From a citty command's `run` block:
 * const input = await collectMutateInput(
 *   { params: args.params, file: args.file, positional: args._ },
 *   process.stdin,
 * );
 * const result = await validateOperationInput(contract, input);
 * ```
 */
export async function collectMutateInput(
  args: CollectMutateInputArgs,
  stdin: StdinLike,
): Promise<unknown> {
  // 1. --params (highest precedence)
  if (typeof args.params === 'string' && args.params.length > 0) {
    try {
      return JSON.parse(args.params);
    } catch (err) {
      throw wrapParseError(args.params, err as SyntaxError, '--params');
    }
  }

  // 2. --file
  if (typeof args.file === 'string' && args.file.length > 0) {
    const raw = await readFile(args.file, 'utf8');
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw wrapParseError(raw, err as SyntaxError, `--file ${args.file}`);
    }
  }

  // 3. stdin (only when piped — i.e. not a TTY)
  if (stdin.isTTY !== true) {
    return readStdinJson(stdin);
  }

  // 4. positional (no parse) — undefined when not supplied
  if (args.positional !== undefined && args.positional.length > 0) {
    return args.positional;
  }

  return undefined;
}
