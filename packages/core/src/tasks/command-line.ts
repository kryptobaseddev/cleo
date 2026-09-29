/**
 * Word splitting for acceptance-gate command strings (T12718).
 *
 * A `test` gate's `command` is a single string written the way a shell user
 * writes it, but it is executed WITHOUT a shell (argv straight to `spawn`).
 * Splitting it on whitespace handed quote characters to the target verbatim:
 * `node -e "setTimeout(()=>process.exit(1),6000)"` reached node as the
 * JavaScript expression `"setTimeout(...)"` — a string literal — so node exited
 * 0 immediately and the gate recorded a false PASS in ~46 ms.
 *
 * This splitter applies POSIX `sh` quoting (single quotes, double quotes,
 * backslash escapes) so the argv is the one the author wrote, and it REFUSES
 * the shell syntax it cannot honour (operators, substitutions, variable
 * expansion). Passing `&&` or `$(...)` to the target as a literal word would
 * run a different program from the one the gate names, which is the same
 * false-verdict class. Glob characters are left as literal words, exactly as
 * before, because test runners commonly take them as filter patterns.
 *
 * @task T12718
 */

/** Characters that only mean something to a shell, which gate commands never get. */
const SHELL_OPERATORS = new Set(['|', '&', ';', '<', '>', '(', ')', '`', '$']);

/** Characters a backslash escapes inside double quotes (POSIX sh). */
const DOUBLE_QUOTE_ESCAPABLE = new Set(['"', '\\', '$', '`']);

/**
 * Split a gate command string into argv words using POSIX `sh` quoting rules.
 *
 * @param raw - The command string exactly as declared on the gate.
 * @returns The argv words, command first; empty when `raw` holds only whitespace.
 * @throws When a quote is unterminated, the string ends in a bare backslash, or
 * it contains unquoted shell syntax (`| & ; < > ( ) $` or a backtick), or a
 * `$`/backtick inside double quotes, since no shell will interpret them.
 * @example
 * ```typescript
 * splitCommandLine(`node -e "setTimeout(()=>process.exit(1),3000)"`);
 * // => ['node', '-e', 'setTimeout(()=>process.exit(1),3000)']
 * ```
 */
export function splitCommandLine(raw: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  const refuse = (what: string): never => {
    throw new Error(
      `Gate command ${JSON.stringify(raw)} uses shell syntax (${what}) but gate commands run ` +
        "without a shell. Wrap it explicitly, e.g. `sh -c '<script>'`, or move the logic into a script file.",
    );
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "'") {
      const end = raw.indexOf("'", i + 1);
      if (end === -1)
        throw new Error(`Gate command ${JSON.stringify(raw)} has an unterminated single quote`);
      word += raw.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (ch === '"') {
      let closed = false;
      for (i++; i < raw.length; i++) {
        const inner = raw[i]!;
        if (inner === '"') {
          closed = true;
          break;
        }
        if (inner === '$' || inner === '`') refuse(`${inner} inside double quotes`);
        if (inner === '\\' && i + 1 < raw.length && DOUBLE_QUOTE_ESCAPABLE.has(raw[i + 1]!)) {
          word += raw[++i]!;
        } else word += inner;
      }
      if (!closed)
        throw new Error(`Gate command ${JSON.stringify(raw)} has an unterminated double quote`);
      inWord = true;
    } else if (ch === '\\') {
      if (i + 1 >= raw.length)
        throw new Error(`Gate command ${JSON.stringify(raw)} ends in a bare backslash`);
      const next = raw[++i]!;
      // Backslash-newline is a line continuation in sh.
      if (next !== '\n') {
        word += next;
        inWord = true;
      }
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else if (SHELL_OPERATORS.has(ch)) {
      refuse(ch);
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}
