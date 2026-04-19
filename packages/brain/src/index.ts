/**
 * Public entry point for `@cleocode/brain` — the unified-graph substrate for CLEO.
 *
 * Exports:
 * - Wire-format types (BrainNode, BrainEdge, BrainGraph, BrainQueryOptions, BrainStreamEvent, BrainConnectionStatus, BrainNodeKind, BrainSubstrate)
 * - Unified query function (`getAllSubstrates`)
 * - Individual substrate adapters (`getBrainSubstrate`, `getNexusSubstrate`, `getTasksSubstrate`, `getConduitSubstrate`, `getSignaldockSubstrate`)
 * - Project context helpers (`ProjectContext`, `resolveDefaultProjectContext`)
 * - Path helpers (`getCleoHome`, `getCleoProjectDir`, `getBrainDbPath`, etc.)
 *
 * @remarks
 * T973 renamed the `LB*` prefix to `Brain*` to align the runtime naming with
 * the `@cleocode/contracts/operations/brain` wire format and the operator's
 * BRAIN super-graph mental model. The runtime shapes (fields, unions) remain
 * intentionally distinct from the contracts shapes — these are the types
 * produced by the substrate adapters in this package.
 *
 * @task T969 (original extraction) · T973 (LB* → Brain* rename)
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
// Wire-format types (Brain* runtime shapes — see types.ts for the distinction
// from the contracts wire-format types)
export type {
  BrainConnectionStatus,
  BrainEdge,
  BrainGraph,
  BrainNode,
  BrainNodeKind,
  BrainQueryOptions,
  BrainStreamEvent,
  BrainSubstrate,
} from './types.js';
