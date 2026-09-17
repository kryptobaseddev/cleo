/**
 * Strict flag validator for citty-based CLI commands.
 *
 * citty 0.2.1 hard-codes `parseArgs({ strict: false })` (see
 * `node_modules/.pnpm/citty@0.2.1/node_modules/citty/dist/index.mjs:81`),
 * which causes unknown flags to be silently absorbed as positional values.
 * That behaviour is the root cause of T10238 — `cleo docs add T123 path.md
 * --title 'X' --slug s` accepted `--title` as a positional and silently
 * dropped it instead of failing loudly.
 *
 * This module provides {@link assertKnownFlags}: a pre-parse pass over the
 * raw argv that checks every long flag (`--name`) and short flag (`-x`)
 * against the citty `args:` schema for the current command and throws a
 * structured `E_UNKNOWN_FLAG` error with Levenshtein "did you mean"
 * suggestions when an unknown flag is found.
 *
 * Usage pattern in a citty command's `run` block:
 *
 * ```ts
 * async run({ args, rawArgs }) {
 *   try {
 *     assertKnownFlags(rawArgs, addCommand.args, 'docs add');
 *   } catch (err) {
 *     if (err instanceof UnknownFlagError) {
 *       cliError(err.message, ExitCode.VALIDATION_ERROR, {
 *         name: err.code,
 *         fix: err.fix,
 *         alternatives: err.suggestions.map((s) => ({ action: s, command: s })),
 *       });
 *       process.exit(ExitCode.VALIDATION_ERROR);
 *     }
 *     throw err;
 *   }
 *   // ...rest of the handler
 * }
 * ```
 *
 * @task T10359 (T-E3.1)
 * @epic T10291 (E3-DOCS-CLI-HARDENING)
 * @saga T10288 (SG-DOCS-INTEGRITY)
 * @adr ADR-083
 * @closes T10238
 */

import type { ArgDef } from 'citty';
import { didYouMean } from './did-you-mean.js';

/**
 * Loose schema shape accepted by {@link assertKnownFlags}.
 *
 * citty types `command.args` as `Resolvable<ArgsDef>` (i.e.
 * `ArgsDef | Promise<ArgsDef> | (() => ArgsDef) | (() => Promise<ArgsDef>)`)
 * even though in practice every consumer in this repo declares `args:` as a
 * literal object. We accept the looser shape here so callers can pass
 * `commandName.args` directly without a cast — the runtime narrows to the
 * literal record before scanning.
 *
 * @task T10359
 */
export type CittyArgsSchema =
  | Record<string, ArgDef>
  | Promise<Record<string, ArgDef>>
  | (() => Record<string, ArgDef>)
  | (() => Promise<Record<string, ArgDef>>)
  | undefined;

/**
 * Stable LAFS error code emitted when a CLI command receives a flag that
 * is not declared in its citty `args:` schema.
 *
 * @task T10359
 */
export const E_UNKNOWN_FLAG = 'E_UNKNOWN_FLAG' as const;

/**
 * Flags consumed by the CLI entry point rather than by any single command.
 *
 * `packages/cleo/src/cli/index.ts` strips these from argv before citty ever
 * sees them, so no command declares them in its own `args` — which means a
 * generic strict-flag guard MUST treat them as known or it would reject every
 * invocation that passes `--json`.
 *
 * This is the SSoT for that set. `index.ts` is asserted against it by
 * `strict-flags-chokepoint.test.ts`, because a second hand-maintained list of
 * global flags is exactly the divergence this whole cluster has been about —
 * a guard whose allowlist drifts from the parser would start rejecting valid
 * flags, which is worse than the silence it replaced.
 *
 * @task T12139
 */
/**
 * Flags REMOVED from a command, mapped to the guidance that replaces them.
 *
 * A retired flag is REJECTED like any other unknown flag — but with the
 * remedy substituted for the did-you-mean, because the caller's problem is
 * not a typo: the mechanism they remember is gone.
 *
 * @remarks
 * T12139 — my first attempt let these flags PASS THROUGH, on the assumption
 * that dispatch's purpose-built `E_FLAG_REMOVED` would fire and say something
 * better. Measured against the built binary, it does not:
 * `packages/cleo/src/cli/commands/complete.ts` never forwards `force` to
 * dispatch at all, so `E_FLAG_REMOVED` (`dispatch/domains/tasks.ts`) is
 * reachable only by direct SDK/dispatch callers. From the CLI, `--force` was
 * silently ignored and the caller then got an unrelated failure — an evidence
 * gate or pending-children error that says nothing about the flag they passed.
 *
 * Passing it through would therefore have restored EXACTLY the defect this
 * guard exists to remove: a flag accepted and silently discarded. So the flag
 * is rejected, and the rejection carries the replacement mechanism instead of
 * a spelling suggestion.
 *
 * That `E_FLAG_REMOVED` is unreachable from the CLI is its own defect, filed
 * separately — surfacing removal guidance from the CLI is a different change
 * from validating flags.
 *
 * @task T12139
 */
export const RETIRED_FLAG_GUIDANCE: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [
    'complete',
    new Map([
      [
        '--force',
        '--force was removed by ADR-051. Record evidence instead: `cleo verify <id> --gate <gate> --evidence "<atoms>"`, then `cleo complete <id>`. For an audited emergency bypass, set CLEO_OWNER_OVERRIDE=1 on verify.',
      ],
    ]),
  ],
]);

/** `complete`'s alias shares its retired-flag guidance. */
const RETIRED_FLAG_ALIASES: ReadonlyMap<string, string> = new Map([['done', 'complete']]);

/**
 * Resolve the removal guidance for a flag, if it is a retired one.
 *
 * @internal
 */
function retiredGuidanceFor(commandName: string, flag: string): string | undefined {
  const key = RETIRED_FLAG_ALIASES.get(commandName) ?? commandName;
  return RETIRED_FLAG_GUIDANCE.get(key)?.get(flag);
}

export const CLI_GLOBAL_FLAGS: readonly string[] = Object.freeze([
  '--json',
  '--human',
  '--quiet',
  '--field',
  '--fields',
  '--mvi',
  '--verbose',
  '--full',
  '--output',
  '--summary',
  '--describe',
  '--idempotency-key',
  '--help',
  '--version',
]);

/**
 * The subset of {@link CLI_GLOBAL_FLAGS} whose value is a SEPARATE argv token.
 *
 * The entry point's global scan consumes `--output id` / `--field /data/title`
 * but leaves both tokens in the argv citty parses. citty 0.2.1 parses with
 * `strict: false`, so an undeclared `--output` is read as a BOOLEAN and its
 * value stays in the positional stream. On a command that declares a
 * positional — `find`'s optional `query` is the reported case — the value was
 * bound to that positional instead of the flag: `cleo find --status pending
 * --output id` ran as a fuzzy search for `"id"` and returned a confident
 * subset of the matches (GH #1438).
 *
 * Kept in this module beside {@link CLI_GLOBAL_FLAGS} so the two global-flag
 * facts stay one import away from each other;
 * `commands/__tests__/find-global-flag-swallow.test.ts` derives the value-taking
 * set from `index.ts` source and fails if this list drifts from it.
 *
 * @task T12139
 */
export const CLI_GLOBAL_VALUE_FLAGS: readonly string[] = Object.freeze([
  '--field',
  '--fields',
  '--mvi',
  '--output',
]);

/**
 * Rewrite value-taking global flags into their `--flag=value` form.
 *
 * The `=` form binds the value to the flag inside citty's parser, so the value
 * never reaches the positional stream, while the flag and its value stay in the
 * argv for the few commands that declare the same name (`find --fields`, and
 * `export`/`inject`/`snapshot`'s `--output <path>`). Callers keep the ORIGINAL
 * argv for the global scan — it matches the space form — and hand only the
 * normalized vector to citty.
 *
 * Tokens already in `--flag=value` form, a value-taking flag at the end of argv
 * with no value, and every non-global token pass through unchanged. Everything
 * after a `--` terminator is positional by definition and is copied verbatim.
 *
 * @param argv - Raw argv tokens after the executable and script name.
 * @returns A new argv vector with value-taking global flags normalized.
 *
 * @task T12139
 */
export function normalizeGlobalValueFlags(argv: readonly string[]): string[] {
  const normalized: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      normalized.push(...argv.slice(i));
      break;
    }
    if (token !== undefined && CLI_GLOBAL_VALUE_FLAGS.includes(token) && i + 1 < argv.length) {
      normalized.push(`${token}=${argv[i + 1]}`);
      i++;
      continue;
    }
    if (token !== undefined) {
      normalized.push(token);
    }
  }
  return normalized;
}

/**
 * Structured error thrown by {@link assertKnownFlags} when an unknown flag
 * is encountered in `rawArgs`. Carries the offending token, the command
 * context, and an array of Levenshtein-ranked suggestions so the calling
 * CLI handler can render an actionable envelope.
 *
 * @remarks
 * The error message is built deterministically:
 * `E_UNKNOWN_FLAG: unknown flag '<flag>' for '<command>'.[ Did you mean: <s1>, <s2>?]`
 *
 * @example
 * ```ts
 * throw new UnknownFlagError({
 *   flag: '--titel',
 *   command: 'docs add',
 *   suggestions: ['--title'],
 *   knownFlags: ['--title', '--slug', '--type'],
 * });
 * ```
 *
 * @task T10359
 */
export class UnknownFlagError extends Error {
  /** Stable LAFS error code string for envelope emission. */
  readonly code = E_UNKNOWN_FLAG;
  /** The unknown flag token as it appeared in `rawArgs` (e.g. `--titel`, `-X`). */
  readonly flag: string;
  /** Human-readable command label (e.g. `'docs add'`). */
  readonly command: string;
  /** Did-you-mean suggestions, sorted by Levenshtein distance ascending. */
  readonly suggestions: readonly string[];
  /** The full list of known flags accepted by the command (long form + short). */
  readonly knownFlags: readonly string[];
  /** Suggested fix string for {@link CliErrorDetails.fix}. */
  readonly fix: string;
  /** Set when the flag was REMOVED rather than mistyped. @task T12139 */
  readonly retiredGuidance?: string;

  /**
   * @param input - Structured failure context: offending flag, command
   *   label, ranked suggestions, and the full known-flag set.
   */
  constructor(input: {
    flag: string;
    command: string;
    suggestions: readonly string[];
    knownFlags: readonly string[];
    /**
     * Replacement guidance for a flag that was REMOVED rather than mistyped.
     * When present it supersedes the did-you-mean `fix`, because the caller
     * needs the new mechanism, not a spelling correction.
     * @task T12139
     */
    retiredGuidance?: string;
  }) {
    const suggestionPart =
      input.suggestions.length > 0 ? ` Did you mean: ${input.suggestions.join(', ')}?` : '';
    super(
      `${E_UNKNOWN_FLAG}: unknown flag '${input.flag}' for '${input.command}'.${suggestionPart}`,
    );
    this.name = 'UnknownFlagError';
    this.flag = input.flag;
    this.command = input.command;
    this.suggestions = input.suggestions;
    this.knownFlags = input.knownFlags;
    this.retiredGuidance = input.retiredGuidance;
    this.fix = input.retiredGuidance
      ? input.retiredGuidance
      : input.suggestions.length > 0
        ? `Try one of: ${input.suggestions.join(', ')}. ` +
          `Run \`cleo ${input.command} --help\` for the full flag list.`
        : `Run \`cleo ${input.command} --help\` for the full flag list.`;
  }
}

/**
 * Build the set of long-form (`--name`) flags accepted by a citty `args:`
 * schema. Positional entries are skipped; named entries contribute
 * `--<key>` plus any aliases declared in `arg.alias` (citty supports
 * `alias: string` or `alias: string[]`).
 *
 * @internal
 * @task T10359
 */
function collectKnownLongFlags(schema: Record<string, ArgDef>): Set<string> {
  const known = new Set<string>();
  for (const [name, def] of Object.entries(schema)) {
    if (!def) continue;
    // T12139 — a POSITIONAL parameter is still accepted in `--name value`
    // form, because citty's non-strict parseArgs populates `args.<name>` for
    // both spellings and the handler reads `args.<name>` either way.
    //
    // This is not a concession: `cleo add`'s `title` is declared
    // `type: 'positional'`, and `cleo add --title "..."` is the form
    // CLEO-INJECTION.md documents EVERYWHERE and that every agent uses. It
    // works today. Skipping positionals here would have made this guard reject
    // the single most-used documented invocation in the system — inventing a
    // restriction the command does not actually have, while claiming to
    // enforce the command's real surface.
    //
    // Measured before this line existed:
    //   $ cleo add --type task --parent T12119 --title smoke --acceptance a --dry-run
    //   E_UNKNOWN_FLAG: unknown flag '--title' for 'add'.
    //                   Did you mean: --files, --note, --size, --type?
    known.add(`--${name}`);
    if (def.type === 'positional') continue;
    // citty boolean flags accept a --no-<name> form for explicit false.
    if (def.type === 'boolean') {
      known.add(`--no-${name}`);
    }
    // Alias can be a single string or an array.
    const alias = (def as { alias?: string | string[] }).alias;
    if (typeof alias === 'string' && alias.length > 0) {
      known.add(alias.length === 1 ? `-${alias}` : `--${alias}`);
    } else if (Array.isArray(alias)) {
      for (const a of alias) {
        if (typeof a !== 'string' || a.length === 0) continue;
        known.add(a.length === 1 ? `-${a}` : `--${a}`);
      }
    }
  }
  return known;
}

/**
 * Build the human-facing candidate list passed to {@link didYouMean} when
 * an unknown flag is encountered. Returns the SORTED long-form flag set
 * (short single-letter aliases are excluded — they're rarely useful for
 * suggestions and pollute the ranking).
 *
 * @internal
 * @task T10359
 */
function collectSuggestionCandidates(schema: Record<string, ArgDef>): string[] {
  const candidates: string[] = [];
  for (const [name, def] of Object.entries(schema)) {
    if (!def || def.type === 'positional') continue;
    candidates.push(`--${name}`);
  }
  return candidates.sort();
}

/**
 * Walk `rawArgs` and reject any flag (long or short) that is not declared
 * in the citty `args:` schema for the current command.
 *
 * Handling rules:
 *   - `--` terminator stops scanning; everything after is positional.
 *   - `--name`, `--name=value`, and `--no-name` (booleans) are recognised.
 *   - Combined short flags like `-abc` are split into `-a`, `-b`, `-c`.
 *   - Single-dash `-x` and `-xVALUE` are recognised; `--name=value` and
 *     `-x=value` strip the `=value` suffix before lookup.
 *
 * Throws {@link UnknownFlagError} on the FIRST unknown flag encountered so
 * the caller surfaces one clear error rather than a noisy multi-error
 * envelope. The CLI handler is expected to render the error via
 * `cliError(..., ExitCode.VALIDATION_ERROR, ...)` and exit 6.
 *
 * @param rawArgs - The `ctx.rawArgs` array citty passes to `run({...})`.
 * @param schema  - The command's `args:` schema (e.g. `addCommand.args`).
 * @param commandName - Human-readable command label for the error message
 *   (e.g. `'docs add'`).
 *
 * @throws {UnknownFlagError} when an unknown flag is found.
 *
 * @example
 * ```ts
 * assertKnownFlags(
 *   ['T123', 'file.md', '--titel', 'X'],
 *   addCommand.args,
 *   'docs add',
 * );
 * // throws UnknownFlagError { flag: '--titel', suggestions: ['--title'] }
 * ```
 *
 * @task T10359
 */
export function assertKnownFlags(
  rawArgs: readonly string[] | undefined,
  schema: CittyArgsSchema,
  commandName: string,
): void {
  if (!rawArgs || rawArgs.length === 0) return;
  if (schema === undefined) return;

  // Narrow the Resolvable<ArgsDef> shape to its plain-record form.
  // citty's literal-object case is the only one we ever see in practice;
  // promise/thunk forms are rejected at the type boundary because the
  // validator is synchronous and the caller's `args:` is always literal.
  if (
    typeof schema === 'function' ||
    (typeof schema === 'object' && schema !== null && 'then' in schema)
  ) {
    // Resolvable forms are not supported synchronously — bail out without
    // attempting validation rather than throwing, so we never break a
    // command that opts into the lazy-args feature.
    return;
  }
  const resolved = schema as Record<string, ArgDef>;

  const known = collectKnownLongFlags(resolved);
  // T12139: entry-point flags are stripped by `index.ts` and declared by no
  // command, so a generic guard must treat them as known. Deliberately NOT
  // added to the did-you-mean candidates — suggesting `--json` for a mistyped
  // domain flag would be noise.
  for (const global of CLI_GLOBAL_FLAGS) known.add(global);
  const candidates = collectSuggestionCandidates(resolved);

  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (token === undefined) continue;
    // `--` terminator — everything after is positional.
    if (token === '--') break;

    // Skip non-flag tokens.
    if (!token.startsWith('-')) continue;
    // Bare '-' is conventional shorthand for stdin — never a flag.
    if (token === '-') continue;

    if (token.startsWith('--')) {
      // Long flag: strip `=value` suffix if present.
      const eqIdx = token.indexOf('=');
      const flagName = eqIdx >= 0 ? token.slice(0, eqIdx) : token;
      if (!known.has(flagName)) {
        throw new UnknownFlagError({
          retiredGuidance: retiredGuidanceFor(commandName, flagName),
          flag: flagName,
          command: commandName,
          suggestions: didYouMean(flagName, candidates, 3),
          knownFlags: [...known].sort(),
        });
      }
    } else {
      // Short flag(s): may be `-x`, `-xVALUE`, `-x=VALUE`, or combined `-abc`.
      const eqIdx = token.indexOf('=');
      const body = eqIdx >= 0 ? token.slice(1, eqIdx) : token.slice(1);
      // For `-xVALUE` we can't distinguish between combined-flag and
      // value-attached forms without consulting the schema's boolean-ness.
      // To stay simple + correct for the common case we check the FIRST
      // letter; if it's not a known short flag, surface that as the unknown.
      // If it IS known and is a boolean, treat the rest as more short flags.
      const first = `-${body[0]}`;
      if (!known.has(first)) {
        throw new UnknownFlagError({
          flag: first,
          command: commandName,
          suggestions: didYouMean(first, candidates, 3),
          knownFlags: [...known].sort(),
        });
      }
      // If multi-letter combined form, check the remaining short flags.
      if (eqIdx < 0 && body.length > 1) {
        // Detect whether `first` is a boolean alias; if not, the rest of
        // `body` is its value (e.g. `-oFILE`) and we stop here.
        const isBooleanShort = isBooleanAlias(resolved, body[0]);
        if (isBooleanShort) {
          for (let k = 1; k < body.length; k++) {
            const ch = body[k];
            if (ch === undefined) continue;
            const short = `-${ch}`;
            if (!known.has(short)) {
              throw new UnknownFlagError({
                flag: short,
                command: commandName,
                suggestions: didYouMean(short, candidates, 3),
                knownFlags: [...known].sort(),
              });
            }
          }
        }
      }
    }
  }
}

/**
 * Is `letter` registered as a single-letter alias for a boolean arg in the
 * given citty schema? Used to disambiguate combined short flags like
 * `-abc` from value-attached forms like `-oFILE`.
 *
 * @internal
 * @task T10359
 */
function isBooleanAlias(schema: Record<string, ArgDef>, letter: string | undefined): boolean {
  if (!letter) return false;
  for (const def of Object.values(schema)) {
    if (!def || def.type !== 'boolean') continue;
    const alias = (def as { alias?: string | string[] }).alias;
    if (alias === letter) return true;
    if (Array.isArray(alias) && alias.includes(letter)) return true;
  }
  return false;
}
