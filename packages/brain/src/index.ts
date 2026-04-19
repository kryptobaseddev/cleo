/**
 * Public entry point for `@cleocode/brain` — the unified-graph substrate for CLEO.
 *
 * Exports:
 * - Wire-format types (LBNode, LBEdge, LBGraph, LBQueryOptions, LBStreamEvent, LBConnectionStatus, LBNodeKind, LBSubstrate)
 * - Unified query function (`getAllSubstrates`)
 * - Individual substrate adapters (`getBrainSubstrate`, `getNexusSubstrate`, `getTasksSubstrate`, `getConduitSubstrate`, `getSignaldockSubstrate`)
 * - Project context helpers (`ProjectContext`, `resolveDefaultProjectContext`)
 * - Path helpers (`getCleoHome`, `getCleoProjectDir`, `getBrainDbPath`, etc.)
 *
 * The `LB*` naming is preserved for a stable extraction diff. T973 will rename
 * to `Brain*` across contracts and studio in a separate focused change.
 *
 * @task T969
 */

// Substrate adapters and unified query
export {
  getAllSubstrates,
  getBrainSubstrate,
  getConduitSubstrate,
  getNexusSubstrate,
  getSignaldockSubstrate,
  getTasksSubstrate,
} from './adapters/index.js';
// Path helpers (re-exported for downstream consumers that need to resolve
// DB paths without importing the connection helpers directly)
export {
  dbExists,
  getBrainDbPath,
  getCleoHome,
  getCleoProjectDir,
  getConduitDbPath,
  getNexusDbPath,
  getSignaldockDbPath,
  getTasksDbPath,
} from './cleo-home.js';
// Low-level connection getters (for advanced consumers; studio typically uses
// its own connection helpers and passes ProjectContext to the adapters instead)
export {
  getBrainDb,
  getConduitDb,
  getNexusDb,
  getSignaldockDb,
  getTasksDb,
} from './db-connections.js';
// Project context
export type { ProjectContext } from './project-context.js';
export { resolveDefaultProjectContext } from './project-context.js';
// Wire-format types
export type {
  LBConnectionStatus,
  LBEdge,
  LBGraph,
  LBNode,
  LBNodeKind,
  LBQueryOptions,
  LBStreamEvent,
  LBSubstrate,
} from './types.js';
