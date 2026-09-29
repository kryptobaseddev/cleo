/**
 * Declared row identity (T12341): which syncing tables carry a uid and how it
 * is made. Data only, with type-only imports, so the Gate B scripts
 * (`scripts/fingerprint-store.mjs`) load it straight from source, like the
 * Gate A registry. The uid recipes and the fill live in `row-identity.ts`.
 * Spec: `cleo docs fetch t12341-uid-scheme`.
 *
 * @module
 * @task T12341
 * @epic T12323
 */

import type { RowIdentityRef, RowIdentitySpec, TableScope } from '@cleocode/contracts';

/** Physical name of every uid column. */
export const UID_COLUMN = 'uid';

const TASKS: RowIdentityRef['table'] = 'tasks_tasks';
const SESSIONS: RowIdentityRef['table'] = 'tasks_sessions';
const ACS: RowIdentityRef['table'] = 'tasks_task_acceptance_criteria';

/**
 * Declared row identity, per scope. Every syncing table is either declared
 * here or counted as pending by the row-identity gate
 * (`__tests__/row-identity-gate.test.ts`), whose pinned pending count may
 * only shrink.
 *
 * Tables whose bare twin is still the live write target (attachments, ADRs,
 * token usage, …) are declared when their twin collapse lands (spec §10).
 */
export const ROW_IDENTITY: Readonly<Record<TableScope, readonly RowIdentitySpec[]>> = {
  project: [
    {
      table: TASKS,
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      displayId: true,
      refs: [
        { column: 'parent_id', table: TASKS },
        { column: 'session_id', table: SESSIONS },
      ],
      task: 'T12341',
    },
    {
      table: SESSIONS,
      kind: 'minted',
      key: ['id'],
      birth: 'started_at',
      refs: [
        { column: 'current_task', table: TASKS },
        { column: 'previous_session_id', table: SESSIONS },
        { column: 'next_session_id', table: SESSIONS },
        { column: 'parent_session_id', table: SESSIONS },
      ],
      jsonArrayRefs: [
        { column: 'tasks_completed_json', table: TASKS },
        { column: 'tasks_created_json', table: TASKS },
      ],
      task: 'T12341',
    },
    {
      table: ACS,
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      owners: [{ column: 'task_id', table: TASKS }],
      refs: [{ column: 'target_task_id', table: TASKS }],
      task: 'T12341',
    },
    {
      table: 'tasks_task_acceptance_criteria_history',
      kind: 'minted',
      key: ['id'],
      birth: 'recorded_at',
      content: ['ac_id', 'previous_text', 'reason'],
      storedRefUids: [{ column: 'ac_uid', from: 'ac_id', table: ACS }],
      task: 'T12341',
    },
    {
      table: 'tasks_evidence_ac_bindings',
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      storedRefUids: [{ column: 'ac_uid', from: 'ac_id', table: ACS }],
      task: 'T12341',
    },
    {
      table: 'tasks_task_dependencies',
      kind: 'natural',
      key: ['task_id', 'depends_on'],
      keyRefs: [
        { column: 'task_id', table: TASKS },
        { column: 'depends_on', table: TASKS },
      ],
      task: 'T12341',
    },
    {
      table: 'tasks_task_relations',
      kind: 'natural',
      key: ['task_id', 'related_to', 'relation_type'],
      keyRefs: [
        { column: 'task_id', table: TASKS },
        { column: 'related_to', table: TASKS },
      ],
      task: 'T12341',
    },
    {
      table: 'tasks_task_labels',
      kind: 'natural',
      key: ['task_id', 'label'],
      keyRefs: [{ column: 'task_id', table: TASKS }],
      task: 'T12341',
    },
    {
      // The uid IS the primary key: display-id-alias.ts computes it on write.
      table: 'tasks_display_id_aliases',
      kind: 'natural',
      key: ['entity_table', 'display_id', 'entity_uid'],
      task: 'T12341',
    },
  ],
  global: [],
};

/**
 * Tables that exist only to support row identity (added by the uid migration
 * itself). A replay of a store from before that migration leaves them out,
 * with the uid columns (`fingerprint-store.mjs --omit-row-identity`).
 */
export const ROW_IDENTITY_TABLES: Readonly<Record<TableScope, readonly string[]>> = {
  project: ['tasks_display_id_aliases'],
  global: [],
};

/**
 * The declared identity of a table, or `undefined` when it has none (yet).
 *
 * @param scope - Store scope.
 * @param table - Physical table name.
 * @returns The spec, or `undefined`.
 */
export function rowIdentitySpec(scope: TableScope, table: string): RowIdentitySpec | undefined {
  return ROW_IDENTITY[scope].find((spec) => spec.table === table);
}

/**
 * The identity columns of a table: `uid` plus its stored reference uids.
 * Replay comparisons of a store before and after the uid migration leave
 * these out (`fingerprint-store.mjs --omit-row-identity`).
 *
 * @param scope - Store scope.
 * @param table - Physical table name.
 * @returns Column names; empty for an undeclared table.
 */
export function rowIdentityColumns(scope: TableScope, table: string): string[] {
  const spec = rowIdentitySpec(scope, table);
  if (!spec) return [];
  return [UID_COLUMN, ...(spec.storedRefUids ?? []).map((ref) => ref.column)];
}
