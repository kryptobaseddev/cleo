/**
 * CLI `--describe` mode context.
 *
 * Singleton that records whether the current CLI invocation requested operation
 * introspection via the global `--describe` flag. Set once in the global flag
 * parser in `cli/index.ts`; read by `dispatchFromCli()` in
 * `dispatch/adapters/cli.ts` to SHORT-CIRCUIT dispatch — instead of executing
 * the operation, it emits the operation's INPUT + OUTPUT contract as a LAFS
 * envelope (ADR-086: one envelope to stdout).
 *
 * Mirrors the output-context.ts / field-context.ts singleton pattern.
 *
 * Why a global flag rather than a `--describe` arg per command: every command
 * routes through `dispatchFromCli(gateway, domain, operation, ...)`, so that
 * single chokepoint always knows the canonical `<domain>.<operation>` triple.
 * Intercepting there gives `cleo <any-op> --describe` uniformly, with zero
 * per-command wiring.
 *
 * @task T11692 — DHQ-057: per-operation output schema SSoT
 * @epic T11679
 */

/** Whether the current invocation requested `--describe`. Defaults to false. */
let describeRequested = false;

/**
 * Record whether `--describe` was passed for this CLI invocation.
 * Called once from the global flag parser in `cli/index.ts`.
 */
export function setDescribeMode(requested: boolean): void {
  describeRequested = requested;
}

/** Whether the current invocation requested operation introspection. */
export function isDescribeMode(): boolean {
  return describeRequested;
}
