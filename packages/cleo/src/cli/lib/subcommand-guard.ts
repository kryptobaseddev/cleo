/**
 * Subcommand-dispatch guard for citty command groups.
 *
 * Citty's `runCommand` runs the matched subcommand AND THEN also invokes the
 * parent command's `run()` — by design in citty@0.2.x. When the parent's
 * `run()` emits output (default dispatch, help banner, status summary),
 * every `cleo <group> <subcommand>` call double-writes to stdout:
 *
 * 1. The subcommand's intended JSON / text output
 * 2. The parent's default behaviour appended on top
 *
 * This breaks programmatic consumers (python `json.load`, `jq`, pipelines)
 * that expect one clean JSON document per line.
 *
 * The guard below returns `true` when a known subcommand token appears in
 * `rawArgs` — callers detect this and early-return from the parent's `run()`
 * so only the subcommand's output reaches stdout.
 *
 * @task T1187-followup · v2026.4.114
 */

import type { CommandDef } from 'citty';

/**
 * Inspect `rawArgs` to determine whether citty has already dispatched (or is
 * about to dispatch) a recognised subcommand. When `true`, the parent
 * command's `run()` MUST early-return to avoid double-writing to stdout.
 *
 * @param rawArgs      - Raw CLI tokens citty passed into the command context.
 * @param subCommands  - The parent command's `subCommands` map.
 * @returns `true` iff the first non-flag token names a registered subcommand.
 *
 * @example
 * ```ts
 * const myGroup = defineCommand({
 *   meta: { name: 'my' },
 *   subCommands: { list, show, add },
 *   async run({ cmd, rawArgs }) {
 *     if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
 *     // fallthrough: default behaviour (e.g. help banner or default op)
 *     await showUsage(cmd);
 *   },
 * });
 * ```
 */
export function isSubCommandDispatch(
  rawArgs: readonly string[] | undefined,
  subCommands: CommandDef['subCommands'] | undefined,
): boolean {
  if (!rawArgs || !subCommands) return false;
  const firstArg = rawArgs.find((a) => !a.startsWith('-'));
  if (!firstArg) return false;
  // `subCommands` may be a static object, a promise, or a function in citty.
  // We only need to inspect the static map case at dispatch time.
  if (typeof subCommands !== 'object') return false;
  return firstArg in (subCommands as Record<string, unknown>);
}
