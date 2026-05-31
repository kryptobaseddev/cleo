/**
 * Drizzle ORM table definitions for playbook state.
 *
 * The canonical `sqliteTable` definitions were relocated into the consolidated
 * substrate schema directory (`@cleocode/core/store/schema/playbooks`) for
 * Gate 4 (Contracts Fan-Out) compliance — T11359 · E2 · SG-DB-SUBSTRATE-V2.
 * This module is now a re-export shim so existing `from '../schema.js'` imports
 * keep working unchanged. `@cleocode/playbooks` already depends on
 * `@cleocode/core`, so importing the tables back here introduces no cycle.
 *
 * Both tables are added to tasks.db via migration at
 * packages/core/migrations/drizzle-tasks/20260417220000_t889-playbook-tables/.
 *
 * @task T889 / T904 / W4-6
 * @task T11359
 */

export type {
  PlaybookApproval,
  PlaybookApprovalStatus,
  PlaybookRun,
  PlaybookRunStatus,
} from '@cleocode/contracts';
export { playbookApprovals, playbookRuns } from '@cleocode/core/store/schema/playbooks.js';
