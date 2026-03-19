/**
 * Provider-agnostic task reconciliation module.
 *
 * Provides the reconciliation engine for syncing external task systems
 * (Linear, Jira, GitHub Issues, etc.) with CLEO as SSoT, plus DB-backed
 * link tracking via the external_task_links table.
 */

export {
  createLink,
  getLinkByExternalId,
  getLinksByProvider,
  getLinksByTaskId,
  removeLinksByProvider,
  touchLink,
} from './link-store.js';
export { reconcile } from './reconciliation-engine.js';
