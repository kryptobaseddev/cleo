/**
 * Barrel for the `cleo auth` command group.
 *
 * The dispatch wrapper lives at `packages/cleo/src/cli/commands/auth.ts`
 * (so the command-manifest generator — which only scans top-level
 * `commands/*.ts` files — picks it up). The wrapper imports the individual
 * subcommands from this barrel.
 *
 * @task T9416
 * @epic E-CONFIG-AUTH-UNIFY (E2b)
 */

export type { AuthListEntry } from './list.js';
export { authListCommand } from './list.js';
export type { AuthRemoveResult } from './remove.js';
export { authRemoveCommand } from './remove.js';
