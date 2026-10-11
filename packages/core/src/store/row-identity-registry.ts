/**
 * Declared row identity (T12341): which syncing tables carry a uid and how it
 * is made. Data only, with type-only imports, so the Gate B scripts
 * (`scripts/fingerprint-store.mjs`) load it straight from source, like the
 * Gate A registry. The uid recipes and the fill live in `row-identity.ts`.
 * Spec: `cleo docs fetch t12341-uid-scheme`.
 *
 * @module
 * @task T12341
 * @task T12897
 * @epic T12323
 */

import { createHash } from 'node:crypto';
import type { RowIdentityRef, RowIdentitySpec, TableScope } from '@cleocode/contracts';

/** Physical name of every uid column. */
export const UID_COLUMN = 'uid';

/** Physical name of the birth fingerprint column of every minted table. */
export const BIRTH_FP_COLUMN = 'birth_fp';

const TASKS: RowIdentityRef['table'] = 'tasks_tasks';
const SESSIONS: RowIdentityRef['table'] = 'tasks_sessions';
const ACS: RowIdentityRef['table'] = 'tasks_task_acceptance_criteria';
const BRAIN_DECISIONS: RowIdentityRef['table'] = 'brain_decisions';

/**
 * Brain text-keyed tables (T12894), the same in both scopes: minted from their
 * TEXT id and birth column, with creation facts no edit changes. Brain ids are
 * random (`O-`, `L-`, `P-` hex) or counter-allocated (`D####`, `SN-###`); a
 * counter id another device also allocated is held as a key collision on
 * receive, never merged (no display-id re-mint for brain ids yet).
 * `brain_attention.created_at` is INTEGER epoch ms (read as the birth as is).
 * `brain_session_narrative` is one row per session: natural on its session id.
 *
 * `birthFacts` are FROZEN for recipe v2 like every other entry.
 */
function brainTextKeyed(): RowIdentitySpec[] {
  return [
    {
      table: BRAIN_DECISIONS,
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      birthFacts: ['type', 'decision'],
      refs: [
        { column: 'supersedes', table: BRAIN_DECISIONS },
        { column: 'superseded_by', table: BRAIN_DECISIONS },
      ],
      task: 'T12894',
    },
    {
      table: 'brain_patterns',
      kind: 'minted',
      key: ['id'],
      birth: 'extracted_at',
      birthFacts: ['type', 'pattern'],
      task: 'T12894',
    },
    {
      table: 'brain_learnings',
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      birthFacts: ['insight', 'source'],
      task: 'T12894',
    },
    {
      table: 'brain_observations',
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      birthFacts: ['type', 'title'],
      task: 'T12894',
    },
    {
      table: 'brain_page_nodes',
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      birthFacts: ['node_type', 'label'],
      task: 'T12894',
    },
    {
      table: 'brain_attention',
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      birthFacts: ['scope_kind', 'scope_id', 'content'],
      task: 'T12894',
    },
    {
      table: 'brain_backfill_runs',
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      birthFacts: ['kind', 'source', 'target_table'],
      task: 'T12894',
    },
    {
      table: 'brain_observations_staging',
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      birthFacts: ['source_table', 'source_id', 'sweep_run_id', 'action'],
      task: 'T12894',
    },
    {
      table: 'brain_promotion_log',
      kind: 'minted',
      key: ['id'],
      birth: 'decided_at',
      birthFacts: ['observation_id', 'from_tier', 'to_tier'],
      task: 'T12894',
    },
    {
      table: 'brain_transcript_events',
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      birthFacts: ['session_id', 'seq', 'role', 'block_type'],
      task: 'T12894',
    },
    {
      table: 'brain_session_narrative',
      kind: 'natural',
      key: ['session_id'],
      task: 'T12894',
    },
  ];
}

/**
 * Brain natural-composite-key tables (T12895): a UUIDv8 over the primary key,
 * so every device derives the same uid for the same edge or link.
 *
 * - `brain_page_edges` keys on its RAW node ids, not on `brain_page_nodes`
 *   uids: about 93% of edges point at ids with no page-node row (code symbols,
 *   tasks), so a node reference would hash `dangling:<id>` until the node
 *   appears, and an edge filled before the node versus after it would get two
 *   uids for one edge. Node ids are themselves natural (`<type>:<source-id>`),
 *   so the raw key is stable across devices. Edges are directed, and so are
 *   the two rows of a `co_retrieved`/`contradicts` pair stored both ways: no
 *   symmetric rule, both rows keep their own uid and a merge unions them.
 * - `brain_memory_links.memory_id` is polymorphic (by `memory_type`), so it
 *   stays raw; `task_id` follows the task's uid where the store has tasks
 *   (project scope). The global store has no tasks table: raw there.
 * - `brain_sticky_tags` (global only; the project table waits on T12535)
 *   follows its note's uid.
 * - `tasks_brain_release_links` (project only): both ids are soft and
 *   polymorphic or exempt (`tasks_releases` waits on T12535), so raw.
 */
function brainNaturalKeyed(scope: TableScope): RowIdentitySpec[] {
  return [
    {
      table: 'brain_page_edges',
      kind: 'natural',
      key: ['from_id', 'to_id', 'edge_type'],
      task: 'T12895',
    },
    {
      table: 'brain_memory_links',
      kind: 'natural',
      key: ['memory_type', 'memory_id', 'task_id', 'link_type'],
      ...(scope === 'project' ? { keyRefs: [{ column: 'task_id', table: TASKS }] } : {}),
      task: 'T12895',
    },
  ];
}

const RETRIEVAL_LOG: RowIdentityRef['table'] = 'brain_retrieval_log';
const PLASTICITY_EVENTS: RowIdentityRef['table'] = 'brain_plasticity_events';

/**
 * Brain tables keyed by an INTEGER AUTOINCREMENT id (T12896), the same in both
 * scopes. The id numbers from 1 on every device, so it is a LOCAL key: it never
 * travels (`captureTableDef` keeps an INTEGER PRIMARY KEY off the wire) and a
 * received row gets the next local id; integer references between these
 * tables travel as uids (`refs`). Spec §4: minted, append-only, with a frozen
 * content list per table.
 *
 * - Append-only (insert, plus the retention prune's deletes; never updated):
 *   plasticity events, weight history, modulators, consolidation events and
 *   usage log. Their uid hashes the frozen `content`, and `birthFacts` repeat
 *   it, as AC history does.
 * - `brain_retrieval_log` is minted but NOT append-only: the session reward
 *   pass labels `reward_signal` after the insert (`brain-stdp.ts`), and an
 *   append-only row keeps no undo image for an update.
 * - `brain_memory_trees` stays exempt: the surprisal pass deletes and rebuilds
 *   the whole tree every cycle, so its class (synced or derived) is decided
 *   apart from its identity.
 *
 * `content` and `birthFacts` are FROZEN for recipe v2 like every other entry.
 */
function brainIntegerKeyed(): RowIdentitySpec[] {
  return [
    {
      table: RETRIEVAL_LOG,
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      birthFacts: ['query', 'source', 'session_id', 'retrieval_order'],
      task: 'T12896',
    },
    {
      table: PLASTICITY_EVENTS,
      kind: 'minted',
      key: ['id'],
      birth: 'timestamp',
      content: ['source_node', 'target_node', 'kind', 'delta_w', 'session_id'],
      birthFacts: ['source_node', 'target_node', 'kind', 'delta_w', 'session_id'],
      refs: [{ column: 'retrieval_log_id', table: RETRIEVAL_LOG }],
      task: 'T12896',
    },
    {
      table: 'brain_weight_history',
      kind: 'minted',
      key: ['id'],
      birth: 'changed_at',
      content: ['edge_from_id', 'edge_to_id', 'edge_type', 'event_kind', 'delta_weight'],
      birthFacts: ['edge_from_id', 'edge_to_id', 'edge_type', 'event_kind', 'delta_weight'],
      refs: [
        { column: 'source_plasticity_event_id', table: PLASTICITY_EVENTS },
        { column: 'retrieval_log_id', table: RETRIEVAL_LOG },
      ],
      task: 'T12896',
    },
    {
      table: 'brain_modulators',
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      content: ['modulator_type', 'valence', 'source_event_id', 'session_id'],
      birthFacts: ['modulator_type', 'valence', 'source_event_id', 'session_id'],
      task: 'T12896',
    },
    {
      table: 'brain_consolidation_events',
      kind: 'minted',
      key: ['id'],
      birth: 'started_at',
      content: ['trigger', 'session_id', 'step_results_json'],
      birthFacts: ['trigger', 'session_id', 'step_results_json'],
      task: 'T12896',
    },
    {
      table: 'brain_usage_log',
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      content: ['entry_id', 'task_id', 'used', 'outcome'],
      birthFacts: ['entry_id', 'task_id', 'used', 'outcome'],
      task: 'T12896',
    },
  ];
}

/**
 * Declared row identity, per scope. Every syncing table is either declared
 * here or exempt with a reason in {@link ROW_IDENTITY_EXEMPT} (T12897); the
 * row-identity coverage gate fails on a table in neither.
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
      // v2 (T12802): no @refFp: the criterion's fingerprint is unknowable when
      // it was gone before this row got its identity, so it made the value
      // depend on fill timing. ac_id is always known.
      birthFacts: ['ac_id', 'previous_text', 'reason'],
      storedRefUids: [{ column: 'ac_uid', from: 'ac_id', table: ACS }],
      task: 'T12341',
    },
    {
      table: 'tasks_evidence_ac_bindings',
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      // v2 (T12802): ac_id in place of @refFp:ac_uid and ac_text_hash. Both
      // were filled from the criterion, so a backfilled binding whose
      // criterion was already gone got a different value (see AC history).
      birthFacts: ['evidence_atom_id', 'binding_type', 'ac_id'],
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
      // T12800: the reason is part of the key (collision-remint and
      // remint-assigned of one id and row are distinct facts).
      key: ['entity_table', 'display_id', 'entity_uid', 'reason'],
      task: 'T12341',
    },
    {
      // The uid IS the primary key: display-id-alias.ts computes it on write.
      table: 'tasks_uid_aliases',
      kind: 'natural',
      key: ['entity_table', 'old_uid', 'old_birth_fp'],
      task: 'T12341',
    },
    ...brainTextKeyed(),
    ...brainNaturalKeyed('project'),
    ...brainIntegerKeyed(),
    {
      table: 'tasks_brain_release_links',
      kind: 'natural',
      key: ['brain_entry_id', 'release_id', 'link_type'],
      task: 'T12895',
    },
  ],
  global: [
    ...brainTextKeyed(),
    ...brainNaturalKeyed('global'),
    ...brainIntegerKeyed(),
    {
      // The global store has no bare sticky twin (the project table waits on
      // the T12535 collapse). `SN-###` ids are counter-allocated.
      table: 'brain_sticky_notes',
      kind: 'minted',
      key: ['id'],
      birth: 'created_at',
      birthFacts: ['content'],
      task: 'T12894',
    },
    {
      table: 'brain_sticky_tags',
      kind: 'natural',
      key: ['sticky_id', 'tag'],
      keyRefs: [{ column: 'sticky_id', table: 'brain_sticky_notes' }],
      task: 'T12895',
    },
    {
      // T12915: one agent per slug (`agent_id`, UNIQUE), and seed-install creates
      // the same slug on every machine, so the slug is the natural key. The
      // random text `id` is minted per device: a local key that never travels.
      table: 'agent_registry_agents',
      kind: 'natural',
      key: ['agent_id'],
      localKey: 'id',
      task: 'T12915',
    },
  ],
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
    'tasks_identity_quarantine',
  ],
  global: [],
};

/**
 * Why a syncing table syncs without declared row identity (T12897).
 *
 * - `planned` — a filed task gives the table its uid; it syncs without one
 *   until then.
 * - `twin-collapse` — one of a live exodus twin pair that both sync, or a
 *   table the collapse must change first; the uid goes on the survivor once
 *   T12535 collapses the pair (spec §10).
 * - `not-row-replicated` — the table does not travel as rows at all.
 *
 * @task T12897
 */
export type RowIdentityExemptionCategory = 'planned' | 'twin-collapse' | 'not-row-replicated';

/**
 * A syncing table's declared reason for having no {@link ROW_IDENTITY} entry.
 *
 * @task T12897
 */
export interface RowIdentityExemption {
  /** Kind of reason. */
  readonly category: RowIdentityExemptionCategory;
  /** Why the table syncs without row identity, and what ends the exemption. */
  readonly reason: string;
  /** The task that ends the exemption; it must exist and be open. */
  readonly task: string;
}

const BRAIN_TASK_OBSERVATIONS: RowIdentityExemption = {
  category: 'planned',
  reason:
    'not in the consolidated schema: the drizzle-brain reconcile creates it after the open-time identity heal (a runtime cache exodus never copies), so a store without it would break every declared-table walk; it joins the consolidated project schema, then is declared natural on (observation_id, task uid) with its INTEGER id local',
  task: 'T12896',
};

const BRAIN_MEMORY_TREES: RowIdentityExemption = {
  category: 'planned',
  reason:
    'the surprisal pass deletes and rebuilds every tree row each cycle (surprisal-tree.ts), so whether the table syncs at all or is derived (recomputed per device, like brain_observations.tree_id, which ops already strip) is decided before it gets a uid',
  task: 'T12896',
};

/** Kept from the T12341 pending reasons: the sticky tables go together. */
const STICKY_REASON =
  'the degraded-mode TEMP shadow tables in store/twin-collapse.ts declare its columns and must carry uid first; that file is being edited by twin-collapse slice 2 (T12535)';

/** The project sticky tables wait on the twin collapse itself (#1764 review L5). */
const STICKY_TWIN: RowIdentityExemption = {
  category: 'twin-collapse',
  reason: STICKY_REASON,
  task: 'T12535',
};

const TWIN: RowIdentityExemption = {
  category: 'twin-collapse',
  reason:
    'one of a live exodus twin pair (store/exodus/table-name-map.ts) whose twins both sync; row identity is declared on the survivor when the pair collapses (spec §10)',
  task: 'T12535',
};

/** A cluster of tables whose row identity one filed task plans (#1764 review M2). */
function cluster(task: string): RowIdentityExemption {
  return {
    category: 'planned',
    reason: `uid scheme not designed yet; rows merge on their local primary key until ${task} lands`,
    task,
  };
}

const CONDUIT = cluster('T12913');
const LIFECYCLE_RELEASE_GIT = cluster('T12914');
const AGENT_ACCOUNTS_SERVICE = cluster('T12915');
const NEXUS_REGISTRY = cluster('T12916');
const SKILLS = cluster('T12917');
const DOCS = cluster('T12919');
const PROJECT_MISC = cluster('T12920');

function exempt(
  tables: readonly string[],
  exemption: RowIdentityExemption,
): Record<string, RowIdentityExemption> {
  return Object.fromEntries(tables.map((table) => [table, exemption]));
}

/** Brain tables of both scopes, by the task that gives them a uid. */
const BRAIN_EXEMPT: Readonly<Record<string, RowIdentityExemption>> = {
  brain_memory_trees: BRAIN_MEMORY_TREES,
  brain_embeddings: {
    category: 'not-row-replicated',
    reason:
      'vec0 virtual table: the session extension cannot capture it, so it ships as a content-addressed cache blob, never as rows (classification registry note)',
    task: 'T12918',
  },
};

/**
 * Every syncing table WITHOUT a {@link ROW_IDENTITY} entry, with the reason it
 * syncs without one. A syncing table in neither place fails the row-identity
 * coverage gate (`scripts/lint-row-identity-coverage.mjs` against the
 * classification registry, `__tests__/row-identity-gate.test.ts` against
 * fresh stores), and so does an exemption whose table is declared, no longer
 * exists or no longer syncs. Declaring a table drops its exemption in the
 * same change.
 *
 * @task T12897
 */
export const ROW_IDENTITY_EXEMPT: Readonly<
  Record<TableScope, Readonly<Record<string, RowIdentityExemption>>>
> = {
  project: {
    ...BRAIN_EXEMPT,
    brain_task_observations: BRAIN_TASK_OBSERVATIONS,
    // Both twins of each pair. brain_session_narrative (twin of
    // session_narrative) and brain_observations_staging already have a uid
    // plan (T12894), so only their bare sides wait on the collapse.
    ...exempt(
      [
        'adr_relations',
        'tasks_adr_relations',
        'adr_task_links',
        'tasks_adr_task_links',
        'agent_error_log',
        'tasks_agent_error_log',
        'architecture_decisions',
        'tasks_architecture_decisions',
        'audit_log',
        'tasks_audit_log',
        'experiments',
        'tasks_experiments',
        'manifest_entries',
        'docs_manifest_entries',
        'pipeline_manifest',
        'docs_pipeline_manifest',
        'playbook_approvals',
        'tasks_playbook_approvals',
        'playbook_runs',
        'tasks_playbook_runs',
        'token_usage',
        'tasks_token_usage',
        'warp_chains',
        'tasks_warp_chains',
        'warp_chain_instances',
        'tasks_warp_chain_instances',
        'session_narrative',
      ],
      TWIN,
    ),
    brain_sticky_notes: STICKY_TWIN,
    brain_sticky_tags: STICKY_TWIN,
    brain_v2_candidate: {
      category: 'twin-collapse',
      reason:
        'pre-T1402 name of brain_observations_staging; dropped by the twin collapse, never given a uid',
      task: 'T12535',
    },
    ...exempt(
      [
        'conduit_attachment_approvals',
        'conduit_attachment_contributors',
        'conduit_attachment_versions',
        'conduit_attachments',
        'conduit_conversations',
        'conduit_message_pins',
        'conduit_messages',
        'conduit_project_agent_refs',
        'conduit_topic_message_acks',
        'conduit_topic_messages',
        'conduit_topic_subscriptions',
        'conduit_topics',
      ],
      CONDUIT,
    ),
    ...exempt(
      [
        'tasks_commit_files',
        'tasks_commits',
        'tasks_lifecycle_evidence',
        'tasks_lifecycle_gate_results',
        'tasks_lifecycle_pipelines',
        'tasks_lifecycle_stages',
        'tasks_lifecycle_transitions',
        'tasks_pr_commits',
        'tasks_pr_tasks',
        'tasks_pull_requests',
        'tasks_release_artifacts',
        'tasks_release_changes',
        'tasks_release_changesets',
        'tasks_release_commits',
        'tasks_releases',
        'tasks_task_commits',
      ],
      LIFECYCLE_RELEASE_GIT,
    ),
    ...exempt(['docs_attachment_refs', 'docs_attachments', 'docs_wikilinks'], DOCS),
    ...exempt(
      [
        'nexus_relation_weights',
        'pi_session_entries',
        'pi_session_leaf',
        'schedules',
        'selfimprove_dhq',
        'tasks_acceptance_projection_dirty',
        'tasks_acceptance_projection_state',
        'tasks_agent_credentials',
        'tasks_external_task_links',
        'tasks_goal',
        'tasks_session_handoff_entries',
        'tasks_task_work_history',
      ],
      PROJECT_MISC,
    ),
  },
  global: {
    ...BRAIN_EXEMPT,
    ...exempt(
      ['accounts', 'agent_service_grants', 'service_configs', 'service_connections'],
      AGENT_ACCOUNTS_SERVICE,
    ),
    ...exempt(
      [
        'nexus_audit_log',
        'nexus_devices',
        'nexus_project_git_state',
        'nexus_project_id_aliases',
        'nexus_project_locations',
        'nexus_project_registry',
        'nexus_sigils',
        'nexus_user_profile',
      ],
      NEXUS_REGISTRY,
    ),
    ...exempt(
      ['skills_skill_patches', 'skills_skill_reviews', 'skills_skill_usage', 'skills_skills'],
      SKILLS,
    ),
  },
};

/**
 * The exemption count per scope. Only ever lowered: a change that declares
 * tables lowers it in the same change, so the allowance cannot be spent again,
 * and a new syncing table is declared rather than exempted unless the change
 * raises this on purpose.
 *
 * Since T12894 declared the brain text-keyed tables (11 project, 12 global),
 * T12895 the brain natural-key tables (3 project, 3 global) and T12896 the
 * brain integer-keyed tables (6 project, 6 global), and T12915 declared the
 * agent registry (1 global; 6 more reclassified derived or local-only)
 * ({@link rowIdentityExemptionSummary} prints the live numbers):
 *
 * | category             | task   | project | global |
 * |----------------------|--------|---------|--------|
 * | planned              | T12894 | 0       | 0      |
 * | planned              | T12895 | 0       | 0      |
 * | planned              | T12896 | 2       | 1      |
 * | planned (conduit)    | T12913 | 12      | 0      |
 * | planned (lifecycle…) | T12914 | 16      | 0      |
 * | planned (agents…)    | T12915 | 0       | 4      |
 * | planned (nexus)      | T12916 | 0       | 8      |
 * | planned (skills)     | T12917 | 0       | 4      |
 * | planned (docs)       | T12919 | 3       | 0      |
 * | planned (misc)       | T12920 | 12      | 0      |
 * | twin-collapse        | T12535 | 30      | 0      |
 * | not-row-replicated   | T12918 | 1       | 1      |
 * | total                |        | 76      | 18     |
 *
 * @task T12897
 */
export const ROW_IDENTITY_EXEMPT_PINNED: Readonly<Record<TableScope, number>> = {
  project: 76,
  global: 18,
};

/**
 * sha256 of each scope's sorted exempt table names
 * ({@link rowIdentityExemptDigest}), pinned with the count so swapping one
 * exempt table for another fails too (#1764 review L4). Update it in the same
 * change that drops an exemption; the gate prints the new value.
 *
 * @task T12897
 */
export const ROW_IDENTITY_EXEMPT_NAMES_SHA256: Readonly<Record<TableScope, string>> = {
  project: '356d44564d00f5406b0b6abcee631ce20e7363e6420d7bb97d09b8cc8c875d52',
  global: '6b0e65a89750a84a7b2e0b905d37864ff99a8a7d31e3392c06786c0b843ec925',
};

/**
 * sha256 (hex) of a set of table names, sorted and newline-joined.
 *
 * @param names - Table names.
 * @returns The hex digest.
 * @task T12897
 */
export function rowIdentityExemptDigest(names: Iterable<string>): string {
  return createHash('sha256')
    .update([...names].sort().join('\n'))
    .digest('hex');
}

/**
 * Exemption counts of one scope, by category and by `category task`.
 *
 * @param scope - Store scope.
 * @returns `total`, `byCategory` and `byTask` (key `<category> <task>`),
 *   keys sorted.
 * @task T12897
 */
export function rowIdentityExemptionSummary(scope: TableScope): {
  total: number;
  byCategory: Record<string, number>;
  byTask: Record<string, number>;
} {
  const byCategory: Record<string, number> = {};
  const byTask: Record<string, number> = {};
  const exemptions = Object.values(ROW_IDENTITY_EXEMPT[scope]);
  for (const { category, task } of exemptions) {
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    byTask[`${category} ${task}`] = (byTask[`${category} ${task}`] ?? 0) + 1;
  }
  const sorted = (o: Record<string, number>) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  return { total: exemptions.length, byCategory: sorted(byCategory), byTask: sorted(byTask) };
}

/**
 * One problem the row-identity coverage gate reports.
 *
 * - `missing` — a syncing table with neither a declared uid nor an exemption.
 * - `stale` — an exemption whose table is not a syncing table (gone, or
 *   reclassified to a class that does not sync).
 * - `declared` — an exemption whose table is also declared.
 * - `invalid` — an exemption without a reason or a `T<digits>` task.
 * - `pinned` — the exemption count or the digest of the exempt names differs
 *   from its pin.
 *
 * @task T12897
 */
export interface RowIdentityCoverageProblem {
  readonly kind: 'missing' | 'stale' | 'declared' | 'invalid' | 'pinned';
  readonly table?: string;
  readonly message: string;
}

/**
 * Check that every syncing table is declared or exempt, and that every
 * exemption still names an undeclared syncing table. Pure: the caller supplies
 * the syncing set (from the classification registry or a physical store).
 *
 * @param input - `syncing`: the scope's syncing tables; `declared`: tables
 *   with a {@link ROW_IDENTITY} entry; `exempt`: the scope's exemptions;
 *   `pinned`: the expected exemption count (omit to skip); `pinnedDigest`:
 *   the expected {@link rowIdentityExemptDigest} of the exempt names (omit to
 *   skip); `mayBeAbsent`:
 *   exempt tables allowed to be missing from `syncing` (a fresh store leaves
 *   out optional-transient tables).
 * @returns The problems; empty when every syncing table is covered.
 * @task T12897
 */
export function checkRowIdentityCoverage(input: {
  readonly syncing: Iterable<string>;
  readonly declared: Iterable<string>;
  readonly exempt: Readonly<Record<string, RowIdentityExemption>>;
  readonly pinned?: number;
  readonly pinnedDigest?: string;
  readonly mayBeAbsent?: Iterable<string>;
}): RowIdentityCoverageProblem[] {
  const syncing = new Set(input.syncing);
  const declared = new Set(input.declared);
  const mayBeAbsent = new Set(input.mayBeAbsent ?? []);
  const problems: RowIdentityCoverageProblem[] = [];
  for (const table of [...syncing].sort()) {
    if (!declared.has(table) && !Object.hasOwn(input.exempt, table)) {
      problems.push({
        kind: 'missing',
        table,
        message: `${table} syncs with neither a ROW_IDENTITY entry nor a ROW_IDENTITY_EXEMPT reason`,
      });
    }
  }
  const exemptTables = Object.keys(input.exempt).sort();
  for (const table of exemptTables) {
    const exemption = input.exempt[table];
    if (declared.has(table)) {
      problems.push({
        kind: 'declared',
        table,
        message: `${table} is declared in ROW_IDENTITY; drop its exemption`,
      });
    } else if (!syncing.has(table) && !mayBeAbsent.has(table)) {
      problems.push({
        kind: 'stale',
        table,
        message: `${table} is exempt but is not a syncing table (gone or reclassified); drop its exemption`,
      });
    }
    if (!exemption?.reason.trim() || !/^T\d+$/.test(exemption.task)) {
      problems.push({
        kind: 'invalid',
        table,
        message: `${table}: an exemption needs a reason and a T<digits> task`,
      });
    }
  }
  if (input.pinned !== undefined && exemptTables.length !== input.pinned) {
    problems.push({
      kind: 'pinned',
      message:
        exemptTables.length > input.pinned
          ? `${exemptTables.length} exemptions, pinned at ${input.pinned}: declare the new table's row identity instead of exempting it`
          : `${exemptTables.length} exemptions, pinned at ${input.pinned}: lower ROW_IDENTITY_EXEMPT_PINNED to ${exemptTables.length}`,
    });
  }
  if (input.pinnedDigest !== undefined && exemptTables.length === input.pinned) {
    const digest = rowIdentityExemptDigest(exemptTables);
    if (digest !== input.pinnedDigest) {
      problems.push({
        kind: 'pinned',
        message: `the exempt table names changed at the same count (a swap): their digest is ${digest}, pinned ${input.pinnedDigest}. Declare the new table instead; if the change is a reviewed reclassification, update ROW_IDENTITY_EXEMPT_NAMES_SHA256`,
      });
    }
  }
  return problems;
}

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
