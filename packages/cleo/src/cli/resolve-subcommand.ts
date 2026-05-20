/**
 * Subcommand resolution helper for `--help` rendering (T9765).
 *
 * Citty 0.2.1's `runMain` walks the subcommand tree before calling
 * `showUsage` so `cleo <group> <verb> --help` renders the verb-specific help
 * — but our LAFS-wrapped `runMainWithLafsEnvelope` (packages/cleo/src/cli/index.ts)
 * needs the same behaviour. Citty exports neither `resolveSubCommand` nor
 * `resolveValue`, so we mirror them here.
 *
 * Lives in its own module so the unit test (`__tests__/resolve-subcommand.test.ts`)
 * can import the helper without triggering `index.ts`'s top-level
 * `void startCli()` invocation.
 *
 * @packageDocumentation
 */

import type { CommandDef } from 'citty';

/**
 * Resolve a lazily-defined value (function, promise, or plain) — mirrors
 * citty's internal `resolveValue` helper. Used by {@link resolveSubCommandForHelp}
 * to read `cmd.subCommands` which may be a function thunk or promise
 * (see `lazyCommand`).
 *
 * @internal
 */
async function resolveLazyValue<T>(input: T | (() => T | Promise<T>) | Promise<T>): Promise<T> {
  if (typeof input === 'function') {
    return resolveLazyValue((input as () => T | Promise<T>)());
  }
  return Promise.resolve(input as T | Promise<T>);
}

/**
 * Walk the subcommand tree to locate the leaf command referenced by `rawArgs`,
 * returning `[leafCmd, parentCmd]` for citty's `showUsage`.
 *
 * Mirrors citty 0.2.1's internal `resolveSubCommand` (which is NOT re-exported)
 * so we can render verb-specific `--help` for nested groups like
 * `cleo release plan --help`. Each step:
 *
 *   1. Resolve `cmd.subCommands` (possibly lazy via `lazyCommand`).
 *   2. Find the first non-flag token in `rawArgs` — that names the subcommand.
 *   3. If it matches a known subcommand, recurse one level deeper with the
 *      remainder of `rawArgs` (slice past the matched token).
 *   4. Stop when no further subcommand matches, returning the current node.
 *
 * Bare `--help` (e.g. `cleo --help`) resolves to `[rootCmd, undefined]`
 * unchanged. Unknown subcommand names also stop the walk — citty's runCommand
 * surfaces the "Unknown command" error elsewhere.
 *
 * @param cmd     - The root command definition.
 * @param rawArgs - Argument vector to inspect (typically `process.argv.slice(2)`).
 * @returns Tuple of `[matched-command, its-immediate-parent | undefined]`.
 *          The parent is `undefined` when the match is the root itself.
 */
export async function resolveSubCommandForHelp(
  cmd: CommandDef,
  rawArgs: string[],
): Promise<[CommandDef, CommandDef | undefined]> {
  let current: CommandDef = cmd;
  let parent: CommandDef | undefined;
  let remaining: string[] = [...rawArgs];

  while (true) {
    const subCommands = (await resolveLazyValue(current.subCommands)) as
      | Record<string, CommandDef>
      | undefined;
    if (!subCommands || Object.keys(subCommands).length === 0) return [current, parent];

    const subIndex = remaining.findIndex((arg) => !arg.startsWith('-'));
    if (subIndex < 0) return [current, parent];

    const subName = remaining[subIndex];
    if (subName === undefined || !(subName in subCommands)) return [current, parent];

    const next = (await resolveLazyValue(subCommands[subName])) as CommandDef | undefined;
    if (!next) return [current, parent];

    parent = current;
    current = next;
    remaining = remaining.slice(subIndex + 1);
  }
}
