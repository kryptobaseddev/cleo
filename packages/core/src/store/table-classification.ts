/**
 * Table classification registry — the replication class of every physical
 * table in the project and global `cleo.db` (Gate A).
 *
 * Every table a store can hold is either classified here (by an explicit
 * entry or a pattern rule) or listed as pending an owner ruling. A table in
 * neither place is UNCLASSIFIED, and the Gate A test
 * (`__tests__/table-classification-gate.test.ts`) fails on it. That test
 * enumerates `sqlite_master` of freshly migrated stores and of the committed
 * live-store shape, so a table born in a migration, in runtime DDL, or in a
 * legacy lineage cannot slip through.
 *
 * ## Keyed on physical names, not the Drizzle schema
 *
 * The runtime often writes the BARE legacy twin (`attachments`,
 * `architecture_decisions`, `session_narrative`, …) rather than the prefixed
 * table, while other bare twins are frozen copies nobody reads. A registry
 * keyed on the Drizzle schema would classify the frozen copy and miss the
 * live one, so both twins are listed here and the frozen ones carry
 * `status: 'frozen-legacy'`, `liveTwin` and `dropTask` (T12535 collapses them).
 *
 * ## Sources
 *
 * The classes come from the classification draft
 * (`docs/research/table-classification-draft.md` in the cleo-nexus repo) plus
 * the core owner's rulings in its §F. Rows marked `needs-owner-call` are
 * provisional. Rows in `pending` have no class at all and must never be
 * treated as portable.
 *
 * @task T12332
 * @epic T12322
 * @module store/table-classification
 */

import type {
  PendingTableClassification,
  TableClass,
  TableClassification,
  TablePatternRule,
  TableRegistryEntry,
  TableScope,
  TableScopeRegistry,
} from '@cleocode/contracts';

const PROJECT_TABLES: Readonly<Record<string, TableRegistryEntry>> = {
  __drizzle_migrations: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  _conduit_meta: { class: 'local-only', status: 'draft', source: 'table-classification-draft.md' },
  _conduit_migrations: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  _exodus_database_identity: {
    class: 'local-only',
    status: 'optional-transient',
    source: 'table-classification-draft.md',
  },
  _fts5_check: {
    class: 'local-only',
    status: 'optional-transient',
    source: 'table-classification-draft.md',
  },
  _nexus_meta: { class: 'local-only', status: 'draft', source: 'table-classification-draft.md' },
  _nexus_parse_cache: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  _writer_leases: { class: 'local-only', status: 'draft', source: 'table-classification-draft.md' },
  _writer_queue: { class: 'local-only', status: 'draft', source: 'table-classification-draft.md' },
  acceptance_projection_dirty: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_acceptance_projection_dirty',
  },
  acceptance_projection_state: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_acceptance_projection_state',
  },
  adr_relations: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  adr_task_links: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  agent_credentials: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_agent_credentials',
    columns: [
      {
        column: 'api_key_encrypted',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
    ],
  },
  agent_error_log: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  agent_instances: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  architecture_decisions: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  attachment_refs: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  attachments: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  audit_log: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev §F.8 (union into tasks_audit_log by T12535)',
  },
  background_jobs: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_attention: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  brain_backfill_runs: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_consolidation_events: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_decisions: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev §F.9 (brain_decisions defaults to project)',
    rowRouting: {
      column: 'peer_scope',
      routes: {},
      reason:
        "draft §0.3 / §F.9: peer_scope is the per-row personal/project switch. The value→class map is pending: the column defaults to 'project' on every row today, so a value route would promote every memory",
    },
  },
  brain_decisions_fts: {
    class: 'derived',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_deriver_queue: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_embeddings: { class: 'derived', status: 'draft', source: 'table-classification-draft.md' },
  brain_learnings: {
    class: 'portable-personal',
    status: 'draft',
    source: 'table-classification-draft.md',
    rowRouting: {
      column: 'peer_scope',
      routes: {},
      reason:
        "draft §0.3 / §F.9: peer_scope is the per-row personal/project switch. The value→class map is pending: the column defaults to 'project' on every row today, so a value route would promote every memory",
    },
  },
  brain_learnings_fts: {
    class: 'derived',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_memory_links: {
    class: 'portable-personal',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  brain_memory_trees: {
    class: 'derived',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_modulators: { class: 'derived', status: 'draft', source: 'table-classification-draft.md' },
  brain_observations: {
    class: 'portable-personal',
    status: 'draft',
    source: 'table-classification-draft.md',
    rowRouting: {
      column: 'peer_scope',
      routes: {},
      reason:
        "draft §0.3 / §F.9: peer_scope is the per-row personal/project switch. The value→class map is pending: the column defaults to 'project' on every row today, so a value route would promote every memory",
    },
    columns: [
      {
        column: 'tree_id',
        class: 'strip',
        reason: '§F.10: points at derived brain_memory_trees (AI id); null it in ops and recompute',
      },
    ],
  },
  brain_observations_fts: {
    class: 'derived',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_observations_staging: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_page_edges: { class: 'derived', status: 'draft', source: 'table-classification-draft.md' },
  brain_page_nodes: { class: 'derived', status: 'draft', source: 'table-classification-draft.md' },
  brain_patterns: { class: 'derived', status: 'draft', source: 'table-classification-draft.md' },
  brain_patterns_fts: {
    class: 'derived',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_plasticity_events: {
    class: 'derived',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_promotion_log: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  brain_release_links: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_brain_release_links',
  },
  brain_retrieval_log: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_schema_meta: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_session_narrative: {
    class: 'portable-personal',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_sticky_notes: {
    class: 'portable-personal',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_sticky_tags: {
    class: 'portable-personal',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_task_observations: {
    class: 'portable-personal',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  brain_transcript_events: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  brain_usage_log: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_weight_history: {
    class: 'derived',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  commit_files: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_commit_files',
  },
  commits: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_commits',
  },
  conduit_attachment_approvals: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  conduit_attachment_contributors: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  conduit_attachment_versions: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  conduit_attachments: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  conduit_conversations: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  conduit_dead_letters: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  conduit_delivery_jobs: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  conduit_message_pins: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  conduit_messages: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  conduit_messages_fts: {
    class: 'derived',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  conduit_project_agent_refs: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  conduit_topic_message_acks: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  conduit_topic_messages: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  conduit_topic_subscriptions: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  conduit_topics: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  deriver_queue: { class: 'local-only', status: 'draft', source: 'table-classification-draft.md' },
  docs_attachment_refs: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  docs_attachments: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  docs_manifest_entries: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  docs_pipeline_manifest: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  docs_wikilinks: {
    class: 'derived',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  evidence_ac_bindings: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_evidence_ac_bindings',
  },
  experiments: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  external_task_links: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_external_task_links',
  },
  lifecycle_evidence: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_lifecycle_evidence',
  },
  lifecycle_gate_results: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_lifecycle_gate_results',
  },
  lifecycle_pipelines: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_lifecycle_pipelines',
  },
  lifecycle_stages: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_lifecycle_stages',
  },
  lifecycle_transitions: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_lifecycle_transitions',
  },
  manifest_entries: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  nexus_code_index: {
    class: 'derived',
    status: 'draft',
    source: 'draft §1.9 (rebuilt by cleo nexus analyze)',
  },
  nexus_contracts: {
    class: 'derived',
    status: 'draft',
    source: 'draft §1.9 (rebuilt by cleo nexus analyze)',
  },
  nexus_nodes: {
    class: 'derived',
    status: 'draft',
    source: 'draft §1.9 (rebuilt by cleo nexus analyze)',
  },
  nexus_relation_weights: {
    class: 'derived',
    status: 'draft',
    source: 'draft §1.9 (rebuilt by cleo nexus analyze)',
  },
  nexus_relations: {
    class: 'derived',
    status: 'draft',
    source: 'draft §1.9 (rebuilt by cleo nexus analyze)',
  },
  nexus_symbols_fts: { class: 'derived', status: 'draft', source: 'table-classification-draft.md' },
  pi_session_entries: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  pi_session_leaf: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  pipeline_manifest: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  playbook_approvals: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
    columns: [
      {
        column: 'token',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
    ],
  },
  playbook_runs: { class: 'local-only', status: 'draft', source: 'table-classification-draft.md' },
  pr_commits: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_pr_commits',
  },
  pr_tasks: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_pr_tasks',
  },
  pull_requests: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_pull_requests',
  },
  release_artifacts: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_release_artifacts',
    note: 'The JSON seed applied §F.11 to this bare twin; §F.11 rules on the live prefixed tasks_release_artifacts, and §2.2 lists the bare table as frozen',
  },
  release_changes: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_release_changes',
    note: 'The JSON seed applied §F.11 to this bare twin; §F.11 rules on the live prefixed tasks_release_changes, and §2.2 lists the bare table as frozen',
  },
  release_changesets: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_release_changesets',
  },
  release_commits: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_release_commits',
  },
  releases: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_releases',
  },
  schedules: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  schema_meta: { class: 'local-only', status: 'draft', source: 'table-classification-draft.md' },
  selfimprove_dhq: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  session_handoff_entries: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_session_handoff_entries',
  },
  session_narrative: {
    class: 'portable-personal',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  sessions: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_sessions',
    columns: [
      {
        column: 'owner_auth_token',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
    ],
  },
  sqlite_sequence: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  status_registry: { class: 'derived', status: 'draft', source: 'table-classification-draft.md' },
  sticky_tags: {
    class: 'portable-personal',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  task_acceptance_criteria: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_task_acceptance_criteria',
  },
  task_acceptance_criteria_history: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_task_acceptance_criteria_history',
  },
  task_commits: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_task_commits',
  },
  task_dependencies: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_task_dependencies',
  },
  task_labels: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_task_labels',
  },
  task_relations: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_task_relations',
  },
  task_work_history: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_task_work_history',
  },
  tasks: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_tasks',
  },
  tasks_acceptance_projection_dirty: {
    class: 'derived',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_acceptance_projection_state: {
    class: 'derived',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_adr_relations: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_adr_task_links: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_agent_credentials: {
    class: 'portable-secret',
    status: 'draft',
    source: 'table-classification-draft.md',
    columns: [
      {
        column: 'api_key_encrypted',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
    ],
  },
  tasks_agent_error_log: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_agent_instances: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_architecture_decisions: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_audit_log: { class: 'portable-project', status: 'resolved', source: 'cleo-dev §F.8' },
  tasks_background_jobs: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_brain_release_links: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_commit_files: {
    class: 'derived',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_commits: { class: 'derived', status: 'draft', source: 'table-classification-draft.md' },
  tasks_evidence_ac_bindings: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_experiments: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  tasks_external_task_links: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_goal: { class: 'local-only', status: 'draft', source: 'table-classification-draft.md' },
  tasks_lifecycle_evidence: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_lifecycle_gate_results: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_lifecycle_pipelines: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_lifecycle_stages: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_lifecycle_transitions: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_playbook_approvals: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
    columns: [
      {
        column: 'token',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
    ],
  },
  tasks_playbook_runs: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_pr_commits: { class: 'derived', status: 'draft', source: 'table-classification-draft.md' },
  tasks_pr_tasks: {
    class: 'derived',
    status: 'resolved',
    source: 'cleo-dev §F.11',
    rowRouting: {
      column: 'link_kind',
      routes: { manual: 'portable-project' },
      reason:
        "§F.11: derived from git/PR bodies except rows with link_kind = 'manual', which replicate",
    },
  },
  tasks_pull_requests: {
    class: 'derived',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  tasks_release_artifacts: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev §F.11',
  },
  tasks_release_changes: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev §F.11',
  },
  tasks_release_changesets: {
    class: 'derived',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  tasks_release_commits: {
    class: 'derived',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_releases: { class: 'portable-project', status: 'resolved', source: 'cleo-dev §F.11' },
  tasks_schema_meta: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_session_handoff_entries: {
    class: 'portable-personal',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_sessions: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev §F.7',
    columns: [
      {
        column: 'owner_auth_token',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
    ],
  },
  tasks_status_registry: {
    class: 'derived',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_task_acceptance_criteria: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_task_acceptance_criteria_history: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_task_commits: {
    class: 'derived',
    status: 'resolved',
    source: 'cleo-dev §F.11',
    rowRouting: {
      column: 'link_kind',
      routes: { manual: 'portable-project' },
      reason:
        "§F.11: derived from git/PR bodies except rows with link_kind = 'manual', which replicate",
    },
  },
  tasks_task_dependencies: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_task_labels: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_task_relations: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_task_work_history: {
    class: 'portable-personal',
    status: 'needs-owner-call',
    source: 'table-classification-draft.md',
  },
  tasks_tasks: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
    columns: [
      {
        column: 'verification_json',
        class: 'strip',
        jsonPath: '$.evidence.*.atoms[*].resolvedPath',
        reason:
          '§F.14 / PR #1570: evidence resolvedPath is an absolute path on the verifying device (ADR-094)',
      },
    ],
  },
  tasks_token_usage: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_warp_chain_instances: {
    class: 'local-only',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_warp_chains: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  token_usage: { class: 'local-only', status: 'draft', source: 'table-classification-draft.md' },
  warp_chain_instances: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §2.1 (warp_chains / warp_chain_instances = P / L)',
    note: 'The JSON seed said portable-project; the draft and its prefixed twin tasks_warp_chain_instances say local-only (running instance state)',
  },
  warp_chains: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
};

const GLOBAL_TABLES: Readonly<Record<string, TableRegistryEntry>> = {
  __catalog_meta: {
    class: 'local-only',
    status: 'optional-transient',
    source: 'draft §3',
    note: 'created lazily by llm/catalog-seeder.ts',
  },
  __drizzle_migrations: { class: 'local-only', status: 'draft', source: 'draft §3' },
  _agent_registry_meta: { class: 'local-only', status: 'draft', source: 'draft §3' },
  _agent_registry_migrations: { class: 'local-only', status: 'draft', source: 'draft §3' },
  _writer_leases: { class: 'local-only', status: 'draft', source: 'draft §3' },
  _writer_queue: { class: 'local-only', status: 'draft', source: 'draft §3' },
  accounts: {
    class: 'portable-secret',
    status: 'draft',
    source: 'draft §3',
    columns: [
      {
        column: 'secret_enc',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
    ],
  },
  agent_registry_accounts: {
    class: 'portable-secret',
    status: 'draft',
    source: 'draft §3',
    columns: [
      {
        column: 'access_token',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
      {
        column: 'refresh_token',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
      {
        column: 'id_token',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
      {
        column: 'password',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
    ],
  },
  agent_registry_agent_capabilities: {
    class: 'portable-personal',
    status: 'draft',
    source: 'draft §3',
  },
  agent_registry_agent_connections: { class: 'local-only', status: 'draft', source: 'draft §3' },
  agent_registry_agent_skills: { class: 'portable-personal', status: 'draft', source: 'draft §3' },
  agent_registry_agents: {
    class: 'portable-personal',
    status: 'draft',
    source: 'draft §3',
    columns: [
      {
        column: 'cant_path',
        class: 'local-only',
        reason: 'draft §3: device path or per-device counter',
      },
      {
        column: 'messages_sent',
        class: 'local-only',
        reason: 'draft §3: device path or per-device counter',
      },
      {
        column: 'messages_received',
        class: 'local-only',
        reason: 'draft §3: device path or per-device counter',
      },
      {
        column: 'conversation_count',
        class: 'local-only',
        reason: 'draft §3: device path or per-device counter',
      },
      {
        column: 'friend_count',
        class: 'local-only',
        reason: 'draft §3: device path or per-device counter',
      },
      {
        column: 'last_seen',
        class: 'local-only',
        reason: 'draft §3: device path or per-device counter',
      },
      {
        column: 'last_used_at',
        class: 'local-only',
        reason: 'draft §3: device path or per-device counter',
      },
      {
        column: 'webhook_secret',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
      {
        column: 'api_key_hash',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
      {
        column: 'api_key_encrypted',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
    ],
  },
  agent_registry_capabilities: { class: 'portable-personal', status: 'draft', source: 'draft §3' },
  agent_registry_claim_codes: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §3',
    note: 'dormant better-auth mirror; server-authoritative if ever used',
  },
  agent_registry_org_agent_keys: { class: 'portable-secret', status: 'draft', source: 'draft §3' },
  agent_registry_organization: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §3',
    note: 'dormant better-auth mirror; server-authoritative if ever used',
  },
  agent_registry_sessions: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §3',
    note: 'dormant better-auth mirror; server-authoritative if ever used',
    columns: [
      {
        column: 'token',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
    ],
  },
  agent_registry_skills: { class: 'portable-personal', status: 'draft', source: 'draft §3' },
  agent_registry_users: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §3',
    note: 'dormant better-auth mirror; server-authoritative if ever used',
    columns: [
      {
        column: 'password_hash',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
    ],
  },
  agent_registry_verifications: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §3',
    note: 'dormant better-auth mirror; server-authoritative if ever used',
  },
  agent_service_grants: { class: 'portable-secret', status: 'draft', source: 'draft §3' },
  brain_attention: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'draft §3 (same split as project §1.8)',
  },
  brain_backfill_runs: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §3 (same split as project §1.8)',
  },
  brain_consolidation_events: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §3 (same split as project §1.8)',
  },
  brain_decisions: {
    class: 'portable-personal',
    status: 'draft',
    source: "draft §3 (the global brain is the user's)",
    rowRouting: {
      column: 'peer_scope',
      routes: {},
      reason:
        "draft §0.3 / §F.9: peer_scope is the per-row personal/project switch. The value→class map is pending: the column defaults to 'project' on every row today, so a value route would promote every memory",
    },
  },
  brain_deriver_queue: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §3 (same split as project §1.8)',
  },
  brain_learnings: {
    class: 'portable-personal',
    status: 'draft',
    source: "draft §3 (the global brain is the user's)",
    rowRouting: {
      column: 'peer_scope',
      routes: {},
      reason:
        "draft §0.3 / §F.9: peer_scope is the per-row personal/project switch. The value→class map is pending: the column defaults to 'project' on every row today, so a value route would promote every memory",
    },
  },
  brain_memory_links: {
    class: 'portable-personal',
    status: 'draft',
    source: "draft §3 (the global brain is the user's)",
  },
  brain_memory_trees: {
    class: 'derived',
    status: 'draft',
    source: 'draft §3 (same split as project §1.8)',
  },
  brain_modulators: {
    class: 'derived',
    status: 'draft',
    source: 'draft §3 (same split as project §1.8)',
  },
  brain_observations: {
    class: 'portable-personal',
    status: 'draft',
    source: "draft §3 (the global brain is the user's)",
    rowRouting: {
      column: 'peer_scope',
      routes: {},
      reason:
        "draft §0.3 / §F.9: peer_scope is the per-row personal/project switch. The value→class map is pending: the column defaults to 'project' on every row today, so a value route would promote every memory",
    },
    columns: [
      {
        column: 'tree_id',
        class: 'strip',
        reason: '§F.10: points at derived brain_memory_trees (AI id); null it in ops and recompute',
      },
    ],
  },
  brain_observations_staging: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §3 (same split as project §1.8)',
  },
  brain_page_edges: {
    class: 'derived',
    status: 'draft',
    source: 'draft §3 (same split as project §1.8)',
  },
  brain_page_nodes: {
    class: 'derived',
    status: 'draft',
    source: 'draft §3 (same split as project §1.8)',
  },
  brain_patterns: {
    class: 'derived',
    status: 'draft',
    source: 'draft §3 (same split as project §1.8)',
  },
  brain_plasticity_events: {
    class: 'derived',
    status: 'draft',
    source: 'draft §3 (same split as project §1.8)',
  },
  brain_promotion_log: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'draft §3 (same split as project §1.8)',
  },
  brain_retrieval_log: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §3 (same split as project §1.8)',
  },
  brain_schema_meta: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §3 (same split as project §1.8)',
  },
  brain_session_narrative: {
    class: 'portable-personal',
    status: 'draft',
    source: "draft §3 (the global brain is the user's)",
  },
  brain_sticky_notes: {
    class: 'portable-personal',
    status: 'draft',
    source: "draft §3 (the global brain is the user's)",
  },
  brain_sticky_tags: {
    class: 'portable-personal',
    status: 'draft',
    source: "draft §3 (the global brain is the user's)",
  },
  brain_transcript_events: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'draft §3 (same split as project §1.8)',
  },
  brain_usage_log: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §3 (same split as project §1.8)',
  },
  brain_weight_history: {
    class: 'derived',
    status: 'draft',
    source: 'draft §3 (same split as project §1.8)',
  },
  models_catalog: { class: 'derived', status: 'draft', source: 'draft §3' },
  nexus_audit_log: { class: 'local-only', status: 'draft', source: 'draft §3' },
  nexus_code_index: {
    class: 'derived',
    status: 'draft',
    source: 'draft §3',
    note: 'orphaned global copy (ADR-090); the graph lives in project scope',
  },
  nexus_contracts: {
    class: 'derived',
    status: 'draft',
    source: 'draft §3',
    note: 'orphaned global copy (ADR-090); the graph lives in project scope',
  },
  nexus_nodes: {
    class: 'derived',
    status: 'draft',
    source: 'draft §3',
    note: 'orphaned global copy (ADR-090); the graph lives in project scope',
  },
  nexus_project_id_aliases: {
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'draft §3',
    note: 'legacy ids are path-derived; is any row user-authored?',
  },
  nexus_project_paths: { class: 'local-only', status: 'draft', source: 'draft §3' },
  nexus_project_registry: {
    class: 'portable-personal',
    status: 'draft',
    source: 'draft §3',
    columns: [
      {
        column: 'project_path',
        class: 'local-only',
        reason: 'draft §3: path, host or per-device health/counter value',
      },
      {
        column: 'brain_db_path',
        class: 'local-only',
        reason: 'draft §3: path, host or per-device health/counter value',
      },
      {
        column: 'tasks_db_path',
        class: 'local-only',
        reason: 'draft §3: path, host or per-device health/counter value',
      },
      {
        column: 'project_hash',
        class: 'local-only',
        reason: 'draft §3: path, host or per-device health/counter value',
      },
      {
        column: 'stats_json',
        class: 'local-only',
        reason: 'draft §3: path, host or per-device health/counter value',
      },
      {
        column: 'last_indexed',
        class: 'local-only',
        reason: 'draft §3: path, host or per-device health/counter value',
      },
      {
        column: 'last_seen',
        class: 'local-only',
        reason: 'draft §3: path, host or per-device health/counter value',
      },
      {
        column: 'last_sync',
        class: 'local-only',
        reason: 'draft §3: path, host or per-device health/counter value',
      },
      {
        column: 'task_count',
        class: 'local-only',
        reason: 'draft §3: path, host or per-device health/counter value',
      },
    ],
  },
  nexus_relations: {
    class: 'derived',
    status: 'draft',
    source: 'draft §3',
    note: 'orphaned global copy (ADR-090); the graph lives in project scope',
  },
  nexus_schema_meta: { class: 'local-only', status: 'draft', source: 'draft §3' },
  nexus_sigils: { class: 'portable-personal', status: 'draft', source: 'draft §3' },
  nexus_user_profile: { class: 'portable-personal', status: 'draft', source: 'draft §3' },
  pi_session_entries: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §3',
    note: 'global copy exists only for DDL convergence; the store opens project scope',
  },
  pi_session_leaf: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §3',
    note: 'global copy exists only for DDL convergence; the store opens project scope',
  },
  providers: {
    class: 'derived',
    status: 'needs-owner-call',
    source: 'draft §3',
    note: 'seeded; the source column may mark user-added rows',
  },
  schedules: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §3',
    note: 'global copy exists only for DDL convergence; the store opens project scope',
  },
  selfimprove_dhq: {
    class: 'local-only',
    status: 'draft',
    source: 'draft §3',
    note: 'global copy exists only for DDL convergence; the store opens project scope',
  },
  service_configs: {
    class: 'portable-secret',
    status: 'draft',
    source: 'draft §3',
    columns: [
      {
        column: 'client_secret_enc',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
    ],
  },
  service_connections: {
    class: 'portable-secret',
    status: 'draft',
    source: 'draft §3',
    columns: [
      {
        column: 'credentials_enc',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
    ],
  },
  session_manifest: { class: 'derived', status: 'draft', source: 'draft §3' },
  skills_skill_patches: { class: 'portable-personal', status: 'draft', source: 'draft §3' },
  skills_skill_reviews: {
    class: 'portable-personal',
    status: 'needs-owner-call',
    source: 'draft §3',
  },
  skills_skill_usage: { class: 'local-only', status: 'draft', source: 'draft §3' },
  skills_skills: {
    class: 'portable-personal',
    status: 'draft',
    source: 'draft §3',
    columns: [
      {
        column: 'install_path',
        class: 'local-only',
        reason: 'draft §3: install path on this device',
      },
      {
        column: 'canonical_path',
        class: 'local-only',
        reason: 'draft §3: install path on this device',
      },
      {
        column: 'archived_from_path',
        class: 'local-only',
        reason: 'draft §3: install path on this device',
      },
    ],
  },
  sqlite_sequence: { class: 'local-only', status: 'draft', source: 'draft §3' },
  telemetry_events: { class: 'local-only', status: 'draft', source: 'draft §3' },
  telemetry_schema_meta: { class: 'local-only', status: 'draft', source: 'draft §3' },
};

/** FTS5 and sqlite-vec shadow families plus exodus recovery scratch (project). */
const PROJECT_PATTERNS: readonly TablePatternRule[] = [
  {
    match: '^[a-z_]+_fts(_(config|data|docsize|idx|content))?$',
    class: 'derived',
    reason: 'FTS5 virtual table or shadow; rebuilt by triggers on the replica',
  },
  {
    match: '^brain_embeddings(_.+)?$',
    class: 'derived',
    reason: 'sqlite-vec index; recomputed locally',
  },
  {
    match: '^_exodus_recovery_.+$',
    class: 'local-only',
    reason: 'exodus recovery scratch (draft §2.3)',
  },
];

/** FTS5 and sqlite-vec shadow families (global). */
const GLOBAL_PATTERNS: readonly TablePatternRule[] = [
  {
    match: '^[a-z_]+_fts(_(config|data|docsize|idx|content))?$',
    class: 'derived',
    reason: 'FTS5 virtual table or shadow; rebuilt by triggers on the replica',
  },
  {
    match: '^brain_embeddings(_.+)?$',
    class: 'derived',
    reason: 'sqlite-vec index; recomputed locally',
  },
];

/** Project tables that exist but await an owner ruling; they have no class. */
const PROJECT_PENDING: readonly PendingTableClassification[] = [
  {
    table: 'brain_v2_candidate',
    source:
      'drizzle-brain 20260424000005_t1147 (renamed to brain_observations_staging by t1402, but a fresh store still carries it)',
    question:
      'Pre-T1402 name of brain_observations_staging. Classify like the staging table (local-only), or drop it in T12535?',
  },
  {
    table: 'session_terminal_bindings',
    source: 'drizzle-cleo-project t12499 (session-binding-schema.ts)',
    question:
      'Terminal identity key → session id. Keys are env/ppid based, so the table looks device-local; confirm local-only.',
  },
];

/** Global tables that exist but await an owner ruling; they have no class. */
const GLOBAL_PENDING: readonly PendingTableClassification[] = [
  {
    table: 'nexus_devices',
    source: 'drizzle-cleo-global t12510 (T12510, epic T12496)',
    question:
      "One row per machine (hostname, os, arch, heartbeat). Newer than the draft. Portable-personal (the owner's device list) or local-only?",
  },
  {
    table: 'nexus_project_locations',
    source: 'drizzle-cleo-global t12469 / t12470 (T12469)',
    question:
      'Per-device project locations keyed (project_id, device_id, path). Newer than the draft. Portable-personal with per-device rows, or local-only like nexus_project_paths?',
  },
];

/**
 * The classification registry for the project `cleo.db`.
 *
 * @task T12332
 */
export const PROJECT_TABLE_REGISTRY: TableScopeRegistry = {
  scope: 'project',
  tables: PROJECT_TABLES,
  patterns: PROJECT_PATTERNS,
  pending: PROJECT_PENDING,
};

/**
 * The classification registry for the global `cleo.db`.
 *
 * @task T12332
 */
export const GLOBAL_TABLE_REGISTRY: TableScopeRegistry = {
  scope: 'global',
  tables: GLOBAL_TABLES,
  patterns: GLOBAL_PATTERNS,
  pending: GLOBAL_PENDING,
};

/**
 * Every class a table can carry, in a stable order for reports.
 *
 * @task T12332
 */
export const TABLE_CLASSES: readonly TableClass[] = [
  'portable-project',
  'portable-personal',
  'portable-secret',
  'local-only',
  'derived',
];

/**
 * Return the registry for a scope.
 *
 * @param scope - Which `cleo.db` the table lives in.
 * @returns That scope's registry.
 * @task T12332
 */
export function getTableRegistry(scope: TableScope): TableScopeRegistry {
  return scope === 'project' ? PROJECT_TABLE_REGISTRY : GLOBAL_TABLE_REGISTRY;
}

/** Compiled pattern rules, built once per scope. */
const compiledPatterns = new Map<TableScope, ReadonlyArray<[RegExp, TablePatternRule]>>();

function patternsFor(scope: TableScope): ReadonlyArray<[RegExp, TablePatternRule]> {
  let compiled = compiledPatterns.get(scope);
  if (!compiled) {
    compiled = getTableRegistry(scope).patterns.map((rule) => [new RegExp(rule.match), rule]);
    compiledPatterns.set(scope, compiled);
  }
  return compiled;
}

/**
 * Classify one physical table name.
 *
 * Lookup order: explicit entry, then pattern rule, then the pending list.
 * Pure: no database is opened.
 *
 * @param scope - Which `cleo.db` the table lives in.
 * @param name - The physical name as `sqlite_master` reports it.
 * @returns The classification; `kind: 'unclassified'` fails Gate A.
 *
 * @example
 * ```ts
 * classifyTable('project', 'tasks_tasks'); // { kind: 'entry', class: 'portable-project', … }
 * classifyTable('project', 'brain_observations_fts_idx'); // { kind: 'pattern', class: 'derived', … }
 * ```
 * @task T12332
 */
export function classifyTable(scope: TableScope, name: string): TableClassification {
  const registry = getTableRegistry(scope);
  const entry: TableRegistryEntry | undefined = Object.hasOwn(registry.tables, name)
    ? registry.tables[name]
    : undefined;
  if (entry) return { kind: 'entry', scope, table: name, class: entry.class, entry };
  for (const [re, rule] of patternsFor(scope)) {
    if (re.test(name)) return { kind: 'pattern', scope, table: name, class: rule.class, rule };
  }
  const pending = registry.pending.find((p) => p.table === name);
  if (pending) return { kind: 'pending', scope, table: name, pending };
  return { kind: 'unclassified', scope, table: name };
}

/**
 * Whether a class travels off the device (sync or sealed).
 *
 * A snapshot or journal writer includes a table only when this is true for
 * its class. Pending and unclassified tables have no class and never travel.
 *
 * @param tableClass - The class to test.
 * @returns `true` for the three portable classes.
 * @task T12332
 */
export function isPortableTableClass(tableClass: TableClass): boolean {
  return (
    tableClass === 'portable-project' ||
    tableClass === 'portable-personal' ||
    tableClass === 'portable-secret'
  );
}
