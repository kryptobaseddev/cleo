/**
 * Interactive-command registry for the CLI output contract's interactive-output
 * class (ADR-086 amendment).
 *
 * Most `cleo` commands are agent-first and default to a JSON LAFS envelope on
 * stdout. A small class of commands exists primarily to talk to a HUMAN in real
 * time — OAuth logins, credential entry, onboarding wizards. On an interactive
 * terminal these should default to human-readable output, while still honoring
 * `--json` / `--output` for automation and ALWAYS emitting JSON when piped or
 * non-TTY (CI, agents). This preserves the agent-first JSON default everywhere
 * else — it is a scoped opt-in, not a global flip.
 *
 * {@link isInteractiveInvocation} is consulted in `startCli()` BEFORE format
 * resolution to feed the (otherwise dormant) TTY→human branch of the LAFS
 * resolver (`resolveOutputFormat`) ONLY for these command paths.
 *
 * TODO(T11670 · SG-PROVIDER-AUTH-UNIFICATION E5): replace this hand-maintained
 * list with an `interactive` flag on the OperationDef so the interactive class
 * is a projection of the registry rather than a parallel-maintained set, the
 * same way MCP exposure is a projection via `mcpExposed`.
 *
 * @epic T11672
 * @saga T11665
 */

/**
 * Command paths (leading positional tokens of the invocation) that are
 * human-default: either real-time interactive (logins, credential entry,
 * onboarding wizards) or human-facing maintenance whose result is meant for a
 * person at a terminal (catalog refresh). Each entry is matched as a PREFIX of
 * the invocation's positional tokens, so trailing args/flags do not affect the
 * match.
 *
 * `login` / `auth login` are listed ahead of their implementation
 * (SG-PROVIDER-AUTH-UNIFICATION E6) so the contract is in place when they land.
 */
export const INTERACTIVE_COMMAND_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  ['llm', 'login'],
  ['llm', 'add'],
  ['llm', 'refresh-catalog'],
  ['login'],
  ['auth', 'login'],
  ['setup'],
  ['init'],
  // The `cleo tui` cockpit (T11933) is a real-time keyboard-first terminal
  // client — human-default on a TTY, JSON when piped/non-TTY.
  ['tui'],
];

/**
 * Returns `true` when the invocation argv matches an interactive command path.
 *
 * Only positional tokens (those not starting with `-`) are considered, in order;
 * an interactive path matches when it is a prefix of those positionals. Weird
 * flag/value interleavings degrade SAFELY to `false` (i.e. the JSON default),
 * never to a false positive that would suppress an agent's envelope.
 *
 * @param argv - argv with the `cleo` binary already stripped (e.g. `process.argv.slice(2)`)
 */
export function isInteractiveInvocation(argv: readonly string[]): boolean {
  const positionals = argv.filter((token) => !token.startsWith('-'));
  if (positionals.length === 0) return false;
  return INTERACTIVE_COMMAND_PATHS.some(
    (path) => path.length <= positionals.length && path.every((seg, i) => seg === positionals[i]),
  );
}
