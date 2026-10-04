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

/** An unquoted leading word of this shape is an `sh` environment assignment. */
const ASSIGNMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Characters a backslash escapes inside double quotes (POSIX sh). */
const DOUBLE_QUOTE_ESCAPABLE = new Set(['"', '\\', '$', '`']);

/**
 * Split a gate command string into argv words using POSIX `sh` quoting rules.
 *
 * @param raw - The command string exactly as declared on the gate.
 * @param label - What `raw` is, for error messages (e.g. `testing.command`).
 * @returns The argv words, command first; empty when `raw` holds only whitespace.
 * @throws When a quote is unterminated, the string ends in a bare backslash, or
 * it contains shell syntax no shell will interpret: unquoted `| & ; < > ( ) $`
 * or a backtick, a `$`/backtick inside double quotes, a `#` comment or `~`
 * tilde expansion at the start of a word, or a leading `NAME=value`
 * environment assignment.
 * @example
 * ```typescript
 * splitCommandLine(`node -e "setTimeout(()=>process.exit(1),3000)"`);
 * // => ['node', '-e', 'setTimeout(()=>process.exit(1),3000)']
 * ```
 */
export function splitCommandLine(raw: string, label = 'Gate command'): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  // True while every character of the current word came from unquoted,
  // unescaped text — only such a word can be an `sh` assignment.
  let wordBare = true;
  const refuse = (what: string): never => {
    throw new Error(
      `${label} ${JSON.stringify(raw)} uses shell syntax (${what}) but it runs ` +
        "without a shell. Wrap it explicitly, e.g. `sh -c '<script>'`, or move the logic into a script file.",
    );
  };
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "'") {
      const end = raw.indexOf("'", i + 1);
      if (end === -1)
        throw new Error(`${label} ${JSON.stringify(raw)} has an unterminated single quote`);
      word += raw.slice(i + 1, end);
      inWord = true;
      wordBare = false;
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
        // Backslash-newline is a line continuation inside double quotes too:
        // both characters are removed.
        if (inner === '\\' && raw[i + 1] === '\n') {
          i++;
          continue;
        }
        if (inner === '\\' && i + 1 < raw.length && DOUBLE_QUOTE_ESCAPABLE.has(raw[i + 1]!)) {
          word += raw[++i]!;
        } else word += inner;
      }
      if (!closed)
        throw new Error(`${label} ${JSON.stringify(raw)} has an unterminated double quote`);
      inWord = true;
      wordBare = false;
    } else if (ch === '\\') {
      if (i + 1 >= raw.length)
        throw new Error(`${label} ${JSON.stringify(raw)} ends in a bare backslash`);
      const next = raw[++i]!;
      // Backslash-newline is a line continuation in sh.
      if (next !== '\n') {
        word += next;
        inWord = true;
        wordBare = false;
      }
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      wordBare = true;
    } else if (SHELL_OPERATORS.has(ch)) {
      refuse(ch);
    } else if (!inWord && ch === '#') {
      refuse('# starts a comment');
    } else if (!inWord && ch === '~') {
      refuse('~ tilde expansion');
    } else if (ch === '=' && words.length === 0 && wordBare && ASSIGNMENT_NAME.test(word)) {
      refuse(`${word}= environment assignment; set it in the gate's env instead`);
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/**
 * Render argv words back into one POSIX `sh` command line — the inverse of
 * {@link splitCommandLine}, for putting a resolved command into a shell
 * context such as a workflow `run:` step.
 *
 * @param words - The argv words, command first.
 * @returns The words joined by spaces, each single-quoted when it holds a
 * character `sh` would interpret. A bare placeholder word (`{filters}`,
 * `{projects}`: braces around letters only, which no shell expands) stays bare
 * so an affected-command template keeps it as one word (T13125); any other
 * brace word (`src/{a,b}`, `{1..3}`) is quoted, since a shell would expand it.
 * @example
 * ```typescript
 * joinCommandLine(['vitest', 'run', '-t', 'my test']);
 * // => "vitest run -t 'my test'"
 * ```
 */
export function joinCommandLine(words: readonly string[]): string {
  return words
    .map((word) =>
      /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) || /^\{[a-z]+\}$/.test(word)
        ? word
        : `'${word.replace(/'/g, `'\\''`)}'`,
    )
    .join(' ');
}
