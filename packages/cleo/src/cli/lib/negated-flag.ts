/**
 * Read a `--no-<flag>` opt-out correctly from citty's parsed args (T12528).
 *
 * citty's `parseArgs` treats every `--no-<name>` token as the NEGATION of
 * `<name>` — it yields `{ <name>: false }` and never `{ 'no-<name>': true }`,
 * even when the command explicitly declares `'no-<name>'` as its own boolean
 * arg. Measured against citty 0.2.1:
 *
 *     declare { 'no-x': boolean }       --no-x  =>  { x: false }
 *     declare { x: boolean }            --no-x  =>  { x: false }
 *     declare { noDepends: boolean }    --no-depends => { depends: false }
 *
 * A handler that reads `args['no-<name>']` therefore never sees the flag, and
 * the opt-out silently does nothing. `scripts/lint-no-negated-flag-reads.mjs`
 * forbids those raw reads; every handler routes through {@link negatedFlag}.
 *
 * @module
 * @task T12528
 */

/**
 * Report whether the operator passed `--no-<name>`.
 *
 * True when citty produced the negated positive form (`args[name] === false`,
 * the shape every real argv takes) OR when a caller supplied the literal
 * `'no-<name>'` key as `true` (programmatic invocation, `--noName` spelling —
 * which citty mirrors onto the kebab key — or a test passing args directly).
 *
 * `name` is the POSITIVE flag name without the `no-` prefix, in kebab case:
 * `negatedFlag(args, 'keep-going')` for `--no-keep-going`.
 *
 * @param args - citty's parsed args object for the command.
 * @param name - Positive flag name (e.g. `'worktree'` for `--no-worktree`).
 * @returns `true` when the opt-out was requested, otherwise `false`.
 *
 * @example
 * ```ts
 * const keepGoing = !negatedFlag(args, 'keep-going');
 * ```
 */
export function negatedFlag(args: Readonly<Record<string, unknown>>, name: string): boolean {
  if (name.startsWith('no-')) {
    throw new Error(
      `negatedFlag: pass the positive flag name ('${name.slice(3)}'), not '${name}'.`,
    );
  }
  return args[name] === false || args[`no-${name}`] === true;
}
