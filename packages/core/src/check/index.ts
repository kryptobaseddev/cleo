/**
 * `@cleocode/core` check module — local CI-gate runners.
 *
 * Currently exposes the unified pre-PR gate (`cleo check pr`, T11956). The
 * gate registry + runner live here so the CLI handler stays a thin dispatch
 * (AGENTS.md Package-Boundary Check).
 *
 * @task T11956
 * @epic T11679
 */

export {
  buildGateArgv,
  formatPrGateSummary,
  PR_GATES,
  type PrGateDef,
  type PrGateRunResult,
  type PrGateSummary,
  type RunPrGateOptions,
  resolveWorkingTree,
  runPrGate,
  selectPrGates,
} from './pr-gate.js';
