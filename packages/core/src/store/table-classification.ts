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
 * ## Two tiers: every table is backed up, portable tables also sync
 *
 * - **Tier 1, backup (the invariant).** Every table in both stores, with every
 *   row, whatever its class (including `local-only`, `derived`, pending and
 *   even unclassified tables), is backed up: encrypted client-side and
 *   versioned per device, so any machine can be restored bit-for-bit. A class
 *   NEVER exempts a table from backup. {@link TABLE_CLASS_POLICY} encodes this
 *   as `backup: true` for every class, and the Gate A test asserts it.
 * - **Tier 2, sync/merge across the owner's devices.** Only the portable
 *   classes. `portable-personal` merges across the owner's own devices;
 *   `portable-project` also merges into the project's shared space for
 *   collaborators; `portable-secret` travels sealed end-to-end. `peer_scope`
 *   governs sharing with OTHER people, never the owner's own machines.
 *
 * The test for a table: if this device died and the owner opened a new one,
 * would an agent have to redo work or lose knowledge? If yes, it is portable.
 *
 * `derived` is deliberately NARROW: only what is rebuilt deterministically,
 * cheaply and without an LLM. That is the FTS5/sqlite-vec shadow tables and
 * the nexus code graph (rebuilt from source by `cleo nexus analyze`).
 * Embeddings, sleep-cycle output and anything an LLM produced are NOT
 * derived: regenerating them costs money or time. `local-only` is for state
 * that is meaningless off-device: leases, queues, pids, paths, locations and
 * fs-keyed caches.
 *
 * ## Follow-up: current learned weights (does not block Gate A)
 *
 * `brain_plasticity_events` and `brain_weight_history` are local-only for row
 * sync (they are STDP event history, 14M+ inserts). A new device still needs
 * the CURRENT learned weights. Deliver them either as a compacted
 * "current weights" projection that syncs as `portable-personal`, or as a
 * periodic compacted snapshot blob. Until then a new device restores them
 * only from the tier-1 backup.
 *
 * ## Sources
 *
 * The classes come from the classification draft
 * (`docs/research/table-classification-draft.md` in the cleo-nexus repo), the
 * core owner's rulings in its §F, and the core owner's two-tier ruling of
 * 2026-09-28 plus its follow-up ruling on the STDP tables. Table
 * classification was delegated to agents by the owner, so these are cleo-dev
 * rulings; the ruling supersedes earlier ones where they conflict (each such
 * entry carries the old reasoning in its `note`). Rows marked
 * `needs-owner-call` are provisional. Tables on the `pending` list have no
 * class and never sync (they are still backed up), and the Gate A test fails
 * while the list is non-empty: pending is a working state, never a merged
 * one.
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
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28 (round 2)',
    note: 'bare twin of tasks_agent_error_log (exodus map); same ruling',
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
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'named in the ruling',
  },
  brain_backfill_runs: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'operator workflow history',
  },
  brain_consolidation_events: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'sleep-cycle run history',
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
  brain_embeddings: {
    class: 'portable-personal',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'embeddings are NOT derived under the ruling (they cost money to regenerate). vec0 is a virtual table the session extension cannot capture, so it must ship as a content-addressed cache blob; its _rowids/_chunks/_vector_chunks/_info shadows stay derived by pattern',
  },
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
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'named in the ruling',
  },
  brain_memory_trees: {
    class: 'portable-personal',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'surprisal clustering output, so not derived under the ruling. Its id is an INTEGER autoincrement, so rows need a uid before they can merge; brain_observations.tree_id keeps its strip override until then',
  },
  brain_modulators: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'cleo-dev ruling (final, 2026-09-28): learned modulator state syncs',
  },
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
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'sweep staging; same family as brain_v2_candidate, which the ruling names',
  },
  brain_page_edges: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'brain graph written by consolidation (163,969 rows live); weight/reinforcement_count are in-place counters',
  },
  brain_page_nodes: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'brain graph written by consolidation and graph-auto-populate, not by nexus analyze; carries reinforcement counters',
  },
  brain_patterns: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'writer verified: memory/specialists.ts (LLM Induction/CodePattern specialists) and sleep-consolidation.ts',
  },
  brain_patterns_fts: {
    class: 'derived',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  brain_plasticity_events: {
    class: 'local-only',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'cleo-dev ruling (final, 2026-09-28): local-only for row sync (14M+ inserts ever, draft §D); still tier-1 backed up. A new device gets the CURRENT learned weights through a follow-up projection or snapshot blob (see the module doc), not this event history',
  },
  brain_promotion_log: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'named in the ruling',
  },
  brain_release_links: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'draft §2.2',
    dropTask: 'T12535',
    liveTwin: 'tasks_brain_release_links',
  },
  brain_retrieval_log: {
    class: 'portable-personal',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: '"all brain_*" per the ruling, but it is retrieval telemetry (2,030 rows); confirm it carries knowledge',
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
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'named in the ruling; INTEGER autoincrement PK needs a uid before merge',
  },
  brain_transcript_events: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'named in the ruling; raw transcripts are PII-heavy',
  },
  brain_usage_log: {
    class: 'portable-personal',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: '"all brain_*" per the ruling, but it is feedback telemetry (10,152 rows) that drives quality scores; confirm',
  },
  brain_v2_candidate: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'named in the ruling; pre-T1402 name of brain_observations_staging, dropped by T12535',
  },
  brain_weight_history: {
    class: 'local-only',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'cleo-dev ruling (final, 2026-09-28): local-only for row sync (14M+ inserts ever, draft §D); still tier-1 backed up. A new device gets the CURRENT learned weights through a follow-up projection or snapshot blob (see the module doc), not this event history',
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
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: conduit_* sync (agents need handoff history across devices). No secret column found. Merge scope project (not personal) is my proposal',
  },
  conduit_attachment_contributors: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: conduit_* sync (agents need handoff history across devices). No secret column found. Merge scope project (not personal) is my proposal',
  },
  conduit_attachment_versions: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: conduit_* sync (agents need handoff history across devices). No secret column found. Merge scope project (not personal) is my proposal',
  },
  conduit_attachments: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: conduit_* sync (agents need handoff history across devices). No secret column found. Merge scope project (not personal) is my proposal',
  },
  conduit_conversations: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: conduit_* sync (agents need handoff history across devices). No secret column found. Merge scope project (not personal) is my proposal',
  },
  conduit_dead_letters: {
    class: 'local-only',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling keeps queues/delivery state device-local',
  },
  conduit_delivery_jobs: {
    class: 'local-only',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling keeps queues/delivery state device-local',
  },
  conduit_message_pins: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: conduit_* sync (agents need handoff history across devices). No secret column found. Merge scope project (not personal) is my proposal',
  },
  conduit_messages: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: conduit_* sync (agents need handoff history across devices). No secret column found. Merge scope project (not personal) is my proposal',
  },
  conduit_messages_fts: {
    class: 'derived',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  conduit_project_agent_refs: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: conduit_* sync (agents need handoff history across devices). No secret column found. Merge scope project (not personal) is my proposal',
  },
  conduit_topic_message_acks: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28 (round 2)',
    note: "supersedes the first ruling (queues device-local): an ack is the owner's read state, and a message acked on one device must not re-deliver on another",
  },
  conduit_topic_messages: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: conduit_* sync (agents need handoff history across devices). No secret column found. Merge scope project (not personal) is my proposal',
  },
  conduit_topic_subscriptions: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: conduit_* sync (agents need handoff history across devices). No secret column found. Merge scope project (not personal) is my proposal',
  },
  conduit_topics: {
    class: 'portable-project',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: conduit_* sync (agents need handoff history across devices). No secret column found. Merge scope project (not personal) is my proposal',
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
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: manifests. output_file was not verified to be repo-relative, so it is held device-local until confirmed',
    columns: [
      {
        column: 'output_file',
        class: 'local-only',
        reason: 'may hold an absolute path; unverified',
      },
    ],
  },
  docs_pipeline_manifest: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: manifests; source_file is written repo-relative (memory/manifest-ingestion.ts)',
  },
  docs_wikilinks: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: docs_*; parsed links are not in the narrow derived set',
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
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: experiments (both twins)',
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
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: manifests. output_file was not verified to be repo-relative, so it is held device-local until confirmed',
    columns: [
      {
        column: 'output_file',
        class: 'local-only',
        reason: 'may hold an absolute path; unverified',
      },
    ],
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
    class: 'portable-personal',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'co-access weights come from usage, not from `nexus analyze`, so they are outside the narrow derived set; confirm whether they carry knowledge',
  },
  nexus_relations: {
    class: 'derived',
    status: 'draft',
    source: 'draft §1.9 (rebuilt by cleo nexus analyze)',
  },
  nexus_symbols_fts: { class: 'derived', status: 'draft', source: 'table-classification-draft.md' },
  pi_session_entries: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: agent session history; personal like sessions',
  },
  pi_session_leaf: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: agent session history; personal like sessions',
  },
  pipeline_manifest: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'live bare twin; ruling: pipeline_manifest',
  },
  playbook_approvals: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28 (round 2)',
    note: 'both twins carry the ruling (the exodus map pairs playbook_approvals with tasks_playbook_approvals)',
    columns: [
      {
        column: 'token',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
    ],
  },
  playbook_runs: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28 (round 2)',
    note: 'both twins carry the ruling (exodus map: playbook_runs ↔ tasks_playbook_runs)',
  },
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
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: definitions sync. The table has no lease/claim column (schedule_id, cron_expr, title, description, enabled, timestamps); execution claims live elsewhere',
  },
  schema_meta: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'T12535 PR 1 (atomic twin collapse)',
    dropTask: 'T12535',
    liveTwin: 'tasks_schema_meta',
    note: 'physically identical to its live twin; store/twin-collapse.ts carries its rows there at every open (initial collapse, then incremental re-merge while an older build still writes it). One sanctioned write-through reaches this table: mirrorCounterToBare raises only the counter field of a counter key (task_id_sequence, sqlite_snapshot_gate, file_meta) to the twin value, in the same transaction as the twin write, so the 2026.9.20 build, which still allocates from this bare counter, cannot reissue an id; nothing else writes it (T12724)',
  },
  selfimprove_dhq: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: selfimprove_dhq; INTEGER id, key the uid on dhq_id',
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
  session_terminal_bindings: {
    class: 'local-only',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'terminal identity keys (env/ppid) are meaningless off-device',
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
  status_registry: {
    class: 'local-only',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'static seed recreated by migrations; not in the narrow derived set',
  },
  sticky_tags: {
    class: 'local-only',
    status: 'frozen-legacy',
    source: 'T12535 PR 1 (atomic twin collapse)',
    dropTask: 'T12535',
    liveTwin: 'brain_sticky_tags',
    note: 'physically identical to its live twin (was portable-personal while live); store/twin-collapse.ts carries its rows there at every open (initial collapse, then incremental re-merge while an older build still writes it) and never writes this table',
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
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28 (round 2)',
    note: 'derived only if a deterministic rebuild path exists, and none does: the only writer is the seed INSERT in migrations/drizzle-tasks/20260525000070_t10570-acceptance-projection-state/migration.sql:27; tasks/ac-table.ts:531 rebuildChildProjectionAc rebuilds child_task criterion rows, never this table, and doctor/acceptance-drift.ts:46 documents it as unmaintained since 2026-05-26',
  },
  tasks_acceptance_projection_state: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28 (round 2)',
    note: 'derived only if a deterministic rebuild path exists, and none does: the only writer is the seed INSERT in migrations/drizzle-tasks/20260525000070_t10570-acceptance-projection-state/migration.sql:27; tasks/ac-table.ts:531 rebuildChildProjectionAc rebuilds child_task criterion rows, never this table, and doctor/acceptance-drift.ts:46 documents it as unmaintained since 2026-05-26',
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
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28 (round 2)',
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
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: PR/commit/release links replicate, ALL rows (history is cheap)',
  },
  tasks_commits: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: PR/commit/release links replicate, ALL rows (history is cheap)',
    columns: [
      {
        column: 'project_hash',
        class: 'local-only',
        reason: 'path-derived hash of the project root on this device (ADR-094)',
      },
    ],
  },
  tasks_evidence_ac_bindings: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_experiments: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: experiments (both twins)',
  },
  tasks_external_task_links: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  tasks_goal: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28 (round 2)',
    note: 'per-agent goal state (turn budget, verdict); an agent resuming on another device needs it. No bare `goal` twin exists',
  },
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
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28 (round 2)',
    columns: [
      {
        column: 'token',
        class: 'portable-secret',
        reason: 'credential column (CREDENTIAL_COLUMNS, store/portable-bundle-scan.ts)',
      },
    ],
  },
  tasks_playbook_runs: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28 (round 2)',
  },
  tasks_pr_commits: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: PR/commit/release links replicate, ALL rows (history is cheap)',
  },
  tasks_pr_tasks: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: PR/commit/release links replicate, ALL rows (history is cheap)',
  },
  tasks_pull_requests: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: PR/commit/release links replicate, ALL rows (history is cheap)',
    columns: [
      {
        column: 'project_hash',
        class: 'local-only',
        reason: 'path-derived hash of the project root on this device (ADR-094)',
      },
    ],
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
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: PR/commit/release links replicate, ALL rows (history is cheap)',
  },
  tasks_release_commits: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: PR/commit/release links replicate, ALL rows (history is cheap)',
  },
  tasks_releases: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev §F.11',
    columns: [
      {
        column: 'project_hash',
        class: 'local-only',
        reason: 'path-derived hash of the project root on this device (ADR-094)',
      },
    ],
  },
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
    class: 'local-only',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'static seed recreated by migrations; not in the narrow derived set',
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
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: PR/commit/release links replicate, ALL rows (history is cheap)',
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
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: work history syncs; personal per §F.7 (sessions are personal)',
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
    class: 'portable-personal',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'ruling: token_usage is portable (cost history). Merge scope personal is my proposal (keyed by session, and sessions are personal)',
  },
  tasks_warp_chain_instances: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28 (round 2)',
  },
  tasks_warp_chains: {
    class: 'portable-project',
    status: 'draft',
    source: 'table-classification-draft.md',
  },
  token_usage: {
    class: 'portable-personal',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'live bare twin of tasks_token_usage; same ruling',
  },
  warp_chain_instances: {
    class: 'portable-project',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28 (round 2)',
    note: 'supersedes draft §2.1 (P / L): running chain instances resume on another device. Both twins carry the ruling',
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
      {
        column: 'refresh_enc',
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
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'named in the ruling',
  },
  brain_backfill_runs: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'operator workflow history',
  },
  brain_consolidation_events: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'sleep-cycle run history',
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
  brain_embeddings: {
    class: 'portable-personal',
    status: 'optional-transient',
    source: 'cleo-dev ruling 2026-09-28 (round 2)',
    note: 'no global binder creates the vec0 table today (store/memory-sqlite.ts initializeBrainVec runs for the project brain only), so this entry is pinned optional-transient by the Gate A test. It exists so a future global vec0 table is portable-personal like its project twin, never derived by a name pattern: embeddings cost money to regenerate',
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
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'named in the ruling',
  },
  brain_memory_trees: {
    class: 'portable-personal',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'surprisal clustering output, so not derived under the ruling. Its id is an INTEGER autoincrement, so rows need a uid before they can merge; brain_observations.tree_id keeps its strip override until then',
  },
  brain_modulators: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'cleo-dev ruling (final, 2026-09-28): learned modulator state syncs',
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
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'sweep staging; same family as brain_v2_candidate, which the ruling names',
  },
  brain_page_edges: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'brain graph written by consolidation (163,969 rows live); weight/reinforcement_count are in-place counters',
  },
  brain_page_nodes: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'brain graph written by consolidation and graph-auto-populate, not by nexus analyze; carries reinforcement counters',
  },
  brain_patterns: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'writer verified: memory/specialists.ts (LLM Induction/CodePattern specialists) and sleep-consolidation.ts',
  },
  brain_plasticity_events: {
    class: 'local-only',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'cleo-dev ruling (final, 2026-09-28): local-only for row sync (14M+ inserts ever, draft §D); still tier-1 backed up. A new device gets the CURRENT learned weights through a follow-up projection or snapshot blob (see the module doc), not this event history',
  },
  brain_promotion_log: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'named in the ruling',
  },
  brain_retrieval_log: {
    class: 'portable-personal',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: '"all brain_*" per the ruling, but it is retrieval telemetry (2,030 rows); confirm it carries knowledge',
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
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'named in the ruling; raw transcripts are PII-heavy',
  },
  brain_usage_log: {
    class: 'portable-personal',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: '"all brain_*" per the ruling, but it is feedback telemetry (10,152 rows) that drives quality scores; confirm',
  },
  brain_weight_history: {
    class: 'local-only',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'cleo-dev ruling (final, 2026-09-28): local-only for row sync (14M+ inserts ever, draft §D); still tier-1 backed up. A new device gets the CURRENT learned weights through a follow-up projection or snapshot blob (see the module doc), not this event history',
  },
  models_catalog: {
    class: 'local-only',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'seeded from models.dev by llm/catalog-seeder.ts; not in the narrow derived set',
  },
  nexus_audit_log: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28 (round 2)',
    note: "the owner's nexus audit history; supersedes draft §3 (local-only)",
  },
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
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28 (round 2)',
    note: 'old project ids resolve on every device the owner uses; supersedes draft §3 (local-only)',
  },
  nexus_devices: {
    class: 'portable-personal',
    status: 'resolved',
    source:
      'cleo-dev ruling 2026-09-28 (round 2); drizzle-cleo-global t12510 (T12510, epic T12496)',
    note: "the owner's device list: one row per machine, so each device sees the others",
  },
  nexus_project_git_state: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'drizzle-cleo-global t12511 (T12511)',
    note: 'per-device probe rows; other-device view requires sync',
    columns: [
      {
        column: 'remote_url',
        class: 'strip',
        reason:
          'cleo-dev ruling 2026-09-28 (round 2): a remote URL can embed credentials (https://user:token@host); stripped from outgoing ops and re-probed on the receiver',
      },
    ],
  },
  nexus_project_locations: {
    class: 'portable-personal',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28 (round 2); drizzle-cleo-global t12469 / t12470 (T12469)',
    note: "per-device rows keyed (project_id, device_id, path): each device syncs its own rows so the owner can see where a project lives elsewhere; a peer never overwrites this device's path",
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
    class: 'local-only',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'seeded from models.dev and recreated locally; not in the narrow derived set. User-added rows (source column) would need portable-personal',
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
  session_manifest: {
    class: 'local-only',
    status: 'resolved',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'mirror of project sessions (which sync via the project store); carries project_path',
  },
  skills_skill_patches: { class: 'portable-personal', status: 'draft', source: 'draft §3' },
  skills_skill_reviews: {
    class: 'portable-personal',
    status: 'needs-owner-call',
    source: 'draft §3',
  },
  skills_skill_usage: {
    class: 'portable-personal',
    status: 'needs-owner-call',
    source: 'cleo-dev ruling 2026-09-28',
    note: 'usage history, by analogy with token_usage (cost history is portable); confirm',
  },
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

/**
 * FTS5 tables by their explicit base names. A pattern never classifies by a
 * bare `_fts` suffix: a future table that merely ends in `_fts` must fail
 * Gate A until someone decides it is really an index. Each base covers the
 * FTS5 virtual table itself plus its five known shadow tables.
 */
const FTS5_BASES = [
  'brain_decisions_fts',
  'brain_learnings_fts',
  'brain_observations_fts',
  'brain_patterns_fts',
  'conduit_messages_fts',
  'nexus_symbols_fts',
] as const;

/** The FTS5 virtual tables above and their `_config/_content/_data/_docsize/_idx` shadows. */
const FTS5_RULE: TablePatternRule = {
  match: `^(${FTS5_BASES.join('|')})(_(config|content|data|docsize|idx))?$`,
  class: 'derived',
  reason: 'FTS5 virtual table or shadow; rebuilt by triggers on the replica',
};

/**
 * The sqlite-vec (vec0) shadow tables of `brain_embeddings`, by their known
 * names. The `brain_embeddings` virtual table itself is an explicit
 * portable-personal entry in both scopes: embeddings are not derived.
 */
const VEC0_SHADOW_RULE: TablePatternRule = {
  match: '^brain_embeddings_(chunks|info|rowids|vector_chunks[0-9]{2})$',
  class: 'derived',
  reason: 'sqlite-vec shadow table of brain_embeddings; rebuilt from the virtual table',
};

/** FTS5 and sqlite-vec shadow families plus exodus recovery scratch (project). */
const PROJECT_PATTERNS: readonly TablePatternRule[] = [
  FTS5_RULE,
  VEC0_SHADOW_RULE,
  {
    match: '^_exodus_recovery_.+$',
    class: 'local-only',
    reason: 'exodus recovery scratch (draft §2.3)',
  },
];

/** FTS5 and sqlite-vec shadow families (global). */
const GLOBAL_PATTERNS: readonly TablePatternRule[] = [FTS5_RULE, VEC0_SHADOW_RULE];

/** Project tables that exist but await an owner ruling; they have no class. */
const PROJECT_PENDING: readonly PendingTableClassification[] = [];

/** Global tables that exist but await an owner ruling; they have no class. */
const GLOBAL_PENDING: readonly PendingTableClassification[] = [];

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
 * What each class means for the two tiers.
 *
 * `backup` is `true` for EVERY class: that is the tier-1 invariant, and it is
 * typed as the literal `true` so a class can never opt out. `sync` is tier 2.
 *
 * @task T12332
 */
export const TABLE_CLASS_POLICY: Readonly<Record<TableClass, { backup: true; sync: boolean }>> = {
  'portable-project': { backup: true, sync: true },
  'portable-personal': { backup: true, sync: true },
  'portable-secret': { backup: true, sync: true },
  'local-only': { backup: true, sync: false },
  derived: { backup: true, sync: false },
};

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
 * Whether a class syncs across devices (tier 2; sealed for secrets).
 *
 * A sync journal includes a table only when this is true for its class.
 * Pending and unclassified tables have no class and never sync. Backup
 * (tier 1) is not gated by this: every table is backed up.
 *
 * @param tableClass - The class to test.
 * @returns `true` for the three portable classes.
 * @task T12332
 */
export function isPortableTableClass(tableClass: TableClass): boolean {
  return TABLE_CLASS_POLICY[tableClass].sync;
}
