/**
 * Public barrel for the skills CLI integration test helpers (T9836).
 *
 * @remarks
 * Import from this module:
 * ```typescript
 * import {
 *   runCli,
 *   expectFormatConflict,
 *   fixtures,
 * } from "./helpers/index.js";
 * ```
 *
 * @public
 */

export {
  type CliInvocation,
  type Registrar,
  type RunCliOptions,
  expectFormatConflict,
  runCli,
} from './skills-cli-harness.js';

import * as fixtures from './fixtures.js';

/**
 * Bundled fixture-factory namespace.
 *
 * @public
 */
export { fixtures };
