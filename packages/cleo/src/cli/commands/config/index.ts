/**
 * Barrel for the `cleo config` command group.
 *
 * The dispatch wrapper lives at `packages/cleo/src/cli/commands/config.ts`
 * (so the command-manifest generator — which only scans top-level
 * `commands/*.ts` files — picks it up). The wrapper imports the individual
 * subcommands from this barrel.
 *
 * @task T9887
 * @saga T9855
 * @epic E4-DOCS-SDK-BOUNDARY
 * @adr 076
 */

export type { ConfigDriftCheckResult } from './drift-check.js';
export { configDriftCheckCommand } from './drift-check.js';
export type { ConfigGetResult } from './get.js';
export { configGetCommand } from './get.js';
export type { ConfigSetResult, ConfigSetValueType } from './set.js';
export { configSetCommand } from './set.js';
export type { ConfigShowResult } from './show.js';
export { configShowCommand } from './show.js';
export type { ConfigValidateResult } from './validate.js';
export { configValidateCommand } from './validate.js';
