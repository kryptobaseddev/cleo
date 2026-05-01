/**
 * Init module — project initialization engine operations.
 *
 * Public surface for `packages/core/src/init/`:
 *   - EngineResult-wrapped operations for the CLI dispatch layer
 *
 * @module init
 * @task T1581 — ENG-MIG-14
 * @epic T1566
 */

export {
  ensureInitialized,
  getVersion,
  initProject,
  isAutoInitEnabled,
} from './engine-ops.js';
