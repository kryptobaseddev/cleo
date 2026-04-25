/**
 * SDK-facing harness orchestration APIs.
 *
 * The harness submodule owns provider selection and adapter routing primitives
 * that CLI, CleoOS, MCP, TUI, and future surfaces call instead of duplicating
 * orchestration runtime decisions.
 */

export { selectHarnessSpawnProvider } from './spawn-provider-selection.js';
export type {
  HarnessSpawnCapability,
  HarnessSpawnProviderSelection,
  HarnessSpawnProviderSelectionResult,
} from './types.js';
