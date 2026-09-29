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

/** Physical name of the birth fingerprint column of every minted table. */
export const BIRTH_FP_COLUMN = 'birth_fp';

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
 *
 * `content` and `birthFacts` lists are FROZEN for recipe v1: changing one is a
 * new recipe version, never an edit here.
 */
export const ROW_IDENTITY: Readonly<Record<TableScope, readonly RowIdentitySpec[]>> = {
  project: [
    {
      table: TASKS,
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      birthFacts: ['title', 'type'],
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
      birthFacts: ['name'],
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
      birthFacts: ['text', '@ownerFp:task_id'],
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
      birthFacts: ['ac_id', 'previous_text', 'reason'],
      storedRefUids: [{ column: 'ac_uid', from: 'ac_id', table: ACS }],
      task: 'T12341',
    },
    {
      table: 'tasks_evidence_ac_bindings',
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      birthFacts: ['evidence_atom_id', 'binding_type', 'ac_text_hash'],
      storedRefUids: [
        { column: 'ac_uid', from: 'ac_id', table: ACS },
        { column: 'ac_text_hash', from: 'ac_id', table: ACS, source: 'text_hash' },
      ],
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
      // TASK_RELATION_TYPES (contracts/src/enums.ts): only `related` is a
      // symmetric association; blocks, duplicates, absorbs, fixes, extends,
      // supersedes and groups (grouper → member) are directional.
      symmetric: { column: 'relation_type', values: ['related'] },
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
    {
      // The uid IS the primary key: display-id-alias.ts computes it on write.
      table: 'tasks_uid_aliases',
      kind: 'natural',
      key: ['entity_table', 'old_uid', 'old_birth_fp'],
      task: 'T12341',
    },
  ],
  global: [],
};

/**
 * Tables that exist only to support row identity (added by the uid migration
 * itself). A replay of a store from before that migration leaves them out,
 * with the identity columns (`fingerprint-store.mjs --omit-row-identity`).
 * Includes the local-only AC uid graveyard (spec §6.5).
 */
export const ROW_IDENTITY_TABLES: Readonly<Record<TableScope, readonly string[]>> = {
  project: [
    'tasks_display_id_aliases',
    'tasks_uid_aliases',
    'tasks_ac_uid_graveyard',
    'tasks_row_identity_meta',
  ],
  global: [],
};

/**
 * Named syncing tables that are deliberately NOT declared yet, and why. The
 * row-identity gate counts every undeclared syncing table as pending; these
 * are the ones with a reason beyond "not reached yet".
 */
export const ROW_IDENTITY_PENDING_REASONS: Readonly<Record<string, string>> = {
  brain_sticky_tags:
    'twin-collapse slice 1 table: the degraded-mode TEMP shadow tables in store/twin-collapse.ts declare its columns and must carry uid first; that file is being edited by slice 2 (T12535)',
  brain_sticky_notes: 'parent of brain_sticky_tags; declared together with it (same reason)',
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
 * The identity columns of a table: `uid`, `birth_fp` (minted tables) and its
 * stored reference facts. Replay comparisons of a store before and after the
 * uid migration leave these out (`fingerprint-store.mjs --omit-row-identity`).
 *
 * @param scope - Store scope.
 * @param table - Physical table name.
 * @returns Column names; empty for an undeclared table.
 */
export function rowIdentityColumns(scope: TableScope, table: string): string[] {
  const spec = rowIdentitySpec(scope, table);
  if (!spec) return [];
  return [
    UID_COLUMN,
    ...(spec.kind === 'minted' ? [BIRTH_FP_COLUMN] : []),
    ...(spec.storedRefUids ?? []).map((ref) => ref.column),
  ];
}
