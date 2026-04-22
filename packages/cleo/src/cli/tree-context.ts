/**
 * CLI tree command rendering context.
 *
 * Singleton that carries per-invocation flags for `cleo tree` and any command
 * that delegates to {@link renderTree}.  Set by the `treeCommand` handler
 * before dispatching; read by `renderTree` in `system.ts`.
 *
 * The pattern mirrors {@link format-context.ts} and {@link field-context.ts}:
 * a module-level store set once at command entry and read by the renderer so
 * that the renderer signature (`data`, `quiet`) stays stable.
 *
 * @task T1205
 * @task T1206
 * @epic T1187
 */

/**
 * Per-invocation options for tree rendering.
 */
export interface TreeContext {
  /**
   * When `true`, each task in the tree output has its direct dependency chain
   * inlined below it.  Corresponds to the `--with-deps` CLI flag.
   *
   * @defaultValue `false`
   */
  withDeps: boolean;

  /**
   * When `true`, each blocked task in the tree output has its transitive
   * blocker chain rendered below it.  Corresponds to the `--blockers` CLI flag.
   *
   * The data layer must have been called with `withBlockers: true` so that
   * `blockerChain` and `leafBlockers` fields are present on the nodes.
   *
   * @defaultValue `false`
   */
  withBlockers: boolean;
}

/** Module-level singleton — reset on each invocation. */
let currentContext: TreeContext = {
  withDeps: false,
  withBlockers: false,
};

/**
 * Set the tree rendering context for this CLI invocation.
 *
 * Called by the `treeCommand` handler after parsing `--with-deps` and
 * `--blockers`.
 *
 * @param ctx - Partial context; missing keys keep their defaults.
 */
export function setTreeContext(ctx: Partial<TreeContext>): void {
  currentContext = {
    withDeps: ctx.withDeps ?? false,
    withBlockers: ctx.withBlockers ?? false,
  };
}

/**
 * Get the current tree rendering context.
 *
 * @returns The active {@link TreeContext} for this invocation.
 */
export function getTreeContext(): TreeContext {
  return currentContext;
}
