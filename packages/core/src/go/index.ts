/**
 * `cleo go` autopilot driver — public barrel.
 *
 * Re-exports the {@link cleoGo} orchestration sequencer and its result types.
 * Consumed by the thin CLI handler in `packages/cleo/src/cli/commands/go.ts`.
 *
 * @module @cleocode/core/go
 *
 * @task T11494 — E2-CLEO-GO
 * @saga T11492 — SG-AUTOPILOT
 */

export {
  CLEO_GO_VIA_PLAYBOOK_ENV,
  type CleoGoAction,
  type CleoGoParams,
  type CleoGoResult,
  cleoGo,
  type IvtrRunner,
  type IvtrRunnerOptions,
  type IvtrRunResult,
} from './driver.js';
