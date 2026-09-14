/**
 * Envelope hygiene for errors thrown by citty (gh#1391).
 *
 * Lives in its own module, not in `index.ts`, for the same reason
 * `resolve-subcommand.ts` does: `index.ts` ends in `void bootstrap()`, so
 * importing it from a unit test STARTS THE CLI. A helper that cannot be
 * imported cannot be tested, and these three are pure string transforms that
 * deserve direct assertions rather than a spawned process.
 *
 * @packageDocumentation
 */

/**
 * Remove ANSI SGR sequences from a string.
 *
 * gh#1391: citty colours the offending token inside its own error message —
 * `Unknown command \x1b[36mfoo\x1b[39m` — and that message went verbatim into
 * the LAFS envelope. ADR-086 makes stdout exactly one parseable envelope, so a
 * consumer reading `.error.message` got escape bytes mid-string, and they land
 * verbatim in whatever log, issue body or task description an agent writes the
 * message into.
 *
 * The comment directly above the callsite already reasons about keeping stdout
 * parseable — it guards against citty's usage BLOCK reaching stdout, and
 * missed that citty's MESSAGE carries colour too. Colour belongs to the human
 * renderer, not to the envelope.
 *
 * @param text - Possibly colourised text.
 * @returns The same text with SGR sequences removed.
 */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Map a citty error code onto a CLEO `codeName`.
 *
 * gh#1391: this was `` `E_${code}` `` with a single special case for `EARG`.
 * Citty's own codes are not uniformly prefixed — `EARG` is bare, while
 * `E_UNKNOWN_COMMAND` already carries the prefix — so the unknown-command path
 * emitted **`E_E_UNKNOWN_COMMAND`**. Agents are instructed to branch on
 * `codeName`, and every documented code has exactly one `E_`, so a lookup table
 * built from the docs misses it entirely.
 *
 * Prefixing is therefore conditional, not unconditional. `EARG` keeps its
 * explicit mapping because `E_EARG` would be a name nothing documents either.
 *
 * @param code - Citty's `CLIError.code`.
 * @returns A single-prefixed CLEO code name.
 */
export function cittyErrorCodeName(code: string): string {
  if (code === 'EARG') return 'E_VALIDATION';
  return code.startsWith('E_') ? code : `E_${code}`;
}

/**
 * Recovery hint for a citty error.
 *
 * gh#1391: every citty error got `Run 'cleo <command> --help' to see required
 * arguments.` — true, generic, and silent about the one thing the caller needs.
 * An unknown SUBCOMMAND is a different mistake from a missing argument: the
 * caller named a group correctly and a verb wrongly, so the actionable hint is
 * the group's verb list, not a note about arguments.
 *
 * This repo has already fixed this shape once — T12127 / gh#1231 turned an
 * `E_FIELD_NOT_FOUND` into one that lists every valid pointer plus the
 * asymmetry that caused the mistake, which is why a wrong `--field` now costs
 * one read instead of a guessing round.
 *
 * @param code - Citty's `CLIError.code`.
 * @returns A hint matched to the failure.
 */
export function cittyErrorFix(code: string): string {
  if (code === 'E_UNKNOWN_COMMAND') {
    return (
      `That is not a subcommand of the command you named. ` +
      `Run 'cleo <command> --help' to list its subcommands — ` +
      `e.g. 'cleo issue --help' shows bug|feature|help|diagnostics.`
    );
  }
  return `Run 'cleo <command> --help' to see required arguments.`;
}
