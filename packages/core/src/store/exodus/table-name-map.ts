/**
 * Deterministic legacy-to-consolidated table-name resolver for exodus migration.
 *
 * ## Problem (ROOT CAUSE 1 — T11532)
 *
 * Legacy source DBs use UNPREFIXED table names (`tasks`, `messages`, `skills`, …)
 * while the consolidated dual-scope `cleo.db` uses DOMAIN-PREFIXED names
 * (`tasks_tasks`, `conduit_messages`, `skills_skills`, …). Without a mapping,
 * every `INSERT OR IGNORE INTO main."<name>"` silently copies 0 rows because the
 * target table is absent under the legacy name.
 *
 * ## Design
 *
 * The mapping is a static lookup table derived from reading every
 * `cleo-project/` and `cleo-global/` schema file and matching the physical
 * `sqliteTable('<consolidated-name>', …)` names against each legacy DB's schema.
 *
 * Rules:
 *  - If a legacy table is already domain-prefixed in the consolidated schema
 *    (e.g. `brain_observations`, `nexus_audit_log`, `tasks_goal`), map identity.
 *  - If a legacy table has NO consolidated counterpart (virtual tables, orphan
 *    telemetry tables, …), return `null` so the caller can log + skip explicitly
 *    rather than silently discarding rows.
 *
 * ## Source-DB scope
 *
 * The resolver takes a `sourceName` (the `LegacyDbDescriptor.name` value, e.g.
 * `"tasks"`, `"brain (project)"`, `"conduit"`) to disambiguate tables that
 * share the same legacy name across multiple DBs (e.g. `"attachments"` lives in
 * both conduit.db and attachments.ts/tasks.db; `"sessions"` lives in both
 * tasks.db and signaldock.db).
 *
 * ## Nexus code-graph residency move (ADR-090 · T11539)
 *
 * The four nexus code-graph tables — `nexus_nodes`, `nexus_relations`,
 * `nexus_contracts`, `nexus_code_index` (ADR-090 "Category A") — were removed
 * from the GLOBAL schema (`../schema/cleo-global/nexus.ts`) and now reside in
 * PROJECT scope (`../schema/cleo-project/nexus-graph.ts`). They are still
 * extracted from the legacy GLOBAL `nexus.db` source, but exodus MUST route them
 * into the PROJECT-scope consolidated `cleo.db`, not the global one. The source
 * descriptor `nexus` carries `targetScope: 'global'`, so a per-table scope
 * override is required for these four tables — see
 * {@link NEXUS_GRAPH_PROJECT_TABLES} and {@link resolveTableTargetScope}. The
 * six registry/identity tables (`nexus_project_registry`,
 * `nexus_project_id_aliases`, `nexus_audit_log`, `nexus_schema_meta`,
 * `nexus_user_profile`, `nexus_sigils`) stay GLOBAL.
 *
 * @task T11532 (ROOT CAUSE 1 — name-mapping gap)
 * @task T11533 (ROOT CAUSE 3 — signaldock skills mapping + brain_release_links skip +
 *               brain_session_narrative mapping)
 * @task T11546 (no-home-table fixes — schema_meta→tasks_schema_meta, brain_usage_log mapping,
 *               brain_schema_meta mapping)
 * @task T11539 (nexus code-graph residency — route the 4 graph tables to PROJECT scope)
 * @epic T11248
 * @saga T11242
 */

import type { ExodusScope } from './types.js';

// ---------------------------------------------------------------------------
// Per-source legacy→consolidated mapping tables
// ---------------------------------------------------------------------------

/**
 * tasks.db — tables from tasks-schema.ts (tasks.ts, audit.ts, background-jobs.ts,
 * chain-schema.ts, agent-schema.ts, lifecycle.ts, evidence-bindings.ts,
 * experiments.ts, attachments.ts, manifest.ts, code-index.ts, playbooks.ts,
 * provenance/releases.ts, provenance/commits.ts, provenance/pull-requests.ts,
 * goal.ts) all prefixed with `tasks_` in the consolidated schema, except the
 * docs tables which become `docs_*`.
 */
const TASKS_DB_MAP: ReadonlyMap<string, string> = new Map([
  // tasks.ts
  ['tasks', 'tasks_tasks'],
  ['task_acceptance_criteria', 'tasks_task_acceptance_criteria'],
  ['acceptance_projection_state', 'tasks_acceptance_projection_state'],
  ['acceptance_projection_dirty', 'tasks_acceptance_projection_dirty'],
  ['task_dependencies', 'tasks_task_dependencies'],
  ['task_labels', 'tasks_task_labels'],
  ['task_relations', 'tasks_task_relations'],
  ['sessions', 'tasks_sessions'],
  ['session_handoff_entries', 'tasks_session_handoff_entries'],
  ['task_work_history', 'tasks_task_work_history'],
  ['task_acceptance_criteria_history', 'tasks_task_acceptance_criteria_history'],
  ['external_task_links', 'tasks_external_task_links'],
  // audit.ts
  ['audit_log', 'tasks_audit_log'],
  ['token_usage', 'tasks_token_usage'],
  ['architecture_decisions', 'tasks_architecture_decisions'],
  ['adr_task_links', 'tasks_adr_task_links'],
  ['adr_relations', 'tasks_adr_relations'],
  ['status_registry', 'tasks_status_registry'],
  // background-jobs.ts
  ['background_jobs', 'tasks_background_jobs'],
  // chain-schema.ts
  ['warp_chains', 'tasks_warp_chains'],
  ['warp_chain_instances', 'tasks_warp_chain_instances'],
  // agent-schema.ts
  ['agent_instances', 'tasks_agent_instances'],
  ['agent_error_log', 'tasks_agent_error_log'],
  // lifecycle.ts
  ['lifecycle_pipelines', 'tasks_lifecycle_pipelines'],
  ['lifecycle_stages', 'tasks_lifecycle_stages'],
  ['lifecycle_gate_results', 'tasks_lifecycle_gate_results'],
  ['lifecycle_evidence', 'tasks_lifecycle_evidence'],
  ['lifecycle_transitions', 'tasks_lifecycle_transitions'],
  // evidence-bindings.ts
  ['evidence_ac_bindings', 'tasks_evidence_ac_bindings'],
  // experiments.ts
  ['experiments', 'tasks_experiments'],
  // attachments.ts (docs-domain in consolidated)
  ['attachments', 'docs_attachments'],
  ['attachment_refs', 'docs_attachment_refs'],
  // manifest.ts (docs-domain in consolidated)
  ['manifest_entries', 'docs_manifest_entries'],
  ['pipeline_manifest', 'docs_pipeline_manifest'],
  // provenance/commits.ts
  ['commits', 'tasks_commits'],
  ['task_commits', 'tasks_task_commits'],
  ['commit_files', 'tasks_commit_files'],
  // provenance/pull-requests.ts
  ['pull_requests', 'tasks_pull_requests'],
  ['pr_commits', 'tasks_pr_commits'],
  ['pr_tasks', 'tasks_pr_tasks'],
  // provenance/releases.ts
  ['releases', 'tasks_releases'],
  ['release_commits', 'tasks_release_commits'],
  ['release_changes', 'tasks_release_changes'],
  ['release_changesets', 'tasks_release_changesets'],
  ['release_artifacts', 'tasks_release_artifacts'],
  // playbooks.ts (tasks.db stores playbook_runs/playbook_approvals)
  ['playbook_runs', 'tasks_playbook_runs'],
  ['playbook_approvals', 'tasks_playbook_approvals'],
  // goal.ts — already prefixed in legacy
  ['tasks_goal', 'tasks_goal'],
  // audit.ts — schema_meta is unprefixed in legacy tasks.db; gains tasks_ prefix in consolidated.
  // (T11546 no-home-table fix — was missing from map, falling through to identity lookup for
  //  'schema_meta' which is absent in consolidated; now correctly mapped to tasks_schema_meta.)
  ['schema_meta', 'tasks_schema_meta'],
  // T11550 P0 fix: agent_credentials and brain_release_links physically live in tasks.db
  // (verified via sqlite_master introspection). T11549 erroneously placed these in BRAIN_DB_MAP
  // because the legacy origin comment said "brain.db due to historical locality" — but the real
  // project DB has them in tasks.db. The exodus source descriptor for tasks.db is 'tasks', so
  // only TASKS_DB_MAP is consulted when copying from tasks.db. These entries must be here for
  // the 3 agent_credentials rows and 8 brain_release_links rows to survive migration.
  ['agent_credentials', 'tasks_agent_credentials'],
  ['brain_release_links', 'tasks_brain_release_links'],
]);

/**
 * brain.db (project) and global brain.db — tables from memory-schema.ts /
 * cleo-shared/brain.ts.
 *
 * Most tables are already `brain_*` prefixed in the legacy schema and keep the
 * same name in the consolidated schema. Three exceptions:
 *   - `sticky_tags`        → `brain_sticky_tags` (lost prefix in legacy)
 *   - `deriver_queue`      → `brain_deriver_queue` (lost prefix in legacy)
 *   - `session_narrative`  → `brain_session_narrative` (lost prefix in legacy)
 *
 * Tables present in the live DB but NOT in the consolidated target schema
 * (virtual tables, orphan telemetry, etc.) map to `null` — they will be
 * logged as explicit skips rather than silently discarded.
 *
 * ## brain_release_links (T11533 → T11549 → T11550 fix)
 *
 * T11533 incorrectly marked `brain_release_links` as `null` (skip). T11549 added
 * the target table `tasks_brain_release_links` to `cleo-project/provenance-orphans.ts`
 * and mapped the table here in BRAIN_DB_MAP — but T11550 discovered that the 8 rows
 * physically live in **tasks.db**, not brain.db (verified via sqlite_master). The
 * correct mapping belongs in TASKS_DB_MAP (added there in T11550). The BRAIN_DB_MAP
 * entry is now `null` (skip) to guard against double-migration if brain.db ever
 * contains a phantom table by this name.
 *
 * ## agent_credentials (T11549 → T11550 fix)
 *
 * Same situation as brain_release_links: the 3 rows physically live in **tasks.db**,
 * not brain.db. T11549 added the target table and mapped it here in BRAIN_DB_MAP,
 * but the source is tasks.db. T11550 moves the mapping to TASKS_DB_MAP and sets
 * this entry to `null` (skip) to prevent double-migration.
 */
const BRAIN_DB_MAP: ReadonlyMap<string, string | null> = new Map([
  // Already-prefixed brain_* tables (identity mapping)
  ['brain_decisions', 'brain_decisions'],
  ['brain_patterns', 'brain_patterns'],
  ['brain_learnings', 'brain_learnings'],
  ['brain_observations', 'brain_observations'],
  ['brain_sticky_notes', 'brain_sticky_notes'],
  ['brain_attention', 'brain_attention'],
  ['brain_memory_links', 'brain_memory_links'],
  ['brain_page_nodes', 'brain_page_nodes'],
  ['brain_page_edges', 'brain_page_edges'],
  ['brain_retrieval_log', 'brain_retrieval_log'],
  ['brain_plasticity_events', 'brain_plasticity_events'],
  ['brain_weight_history', 'brain_weight_history'],
  ['brain_modulators', 'brain_modulators'],
  ['brain_consolidation_events', 'brain_consolidation_events'],
  ['brain_transcript_events', 'brain_transcript_events'],
  ['brain_promotion_log', 'brain_promotion_log'],
  ['brain_backfill_runs', 'brain_backfill_runs'],
  ['brain_memory_trees', 'brain_memory_trees'],
  ['brain_observations_staging', 'brain_observations_staging'],
  // brain_release_links: T11550 P0 fix — table physically lives in tasks.db (not brain.db).
  // The TASKS_DB_MAP entry (added in T11550) handles the real migration path.
  // If a legacy brain.db ever contains this table, skip it to avoid double-migration.
  ['brain_release_links', null],
  // brain_schema_meta: key-value schema-version store (T11546 no-home-table fix —
  //   was missing from map, falling through to identity lookup; now correctly mapped).
  ['brain_schema_meta', 'brain_schema_meta'],
  // Unprefixed legacy names (gain brain_ prefix in consolidated)
  ['sticky_tags', 'brain_sticky_tags'],
  ['deriver_queue', 'brain_deriver_queue'],
  // session_narrative → brain_session_narrative (T11533 fix — was missing from map,
  // causing identity fallback to 'session_narrative' which doesn't exist in consolidated).
  ['session_narrative', 'brain_session_narrative'],
  // brain_usage_log: quality-feedback telemetry (8471 rows). Added to the consolidated
  //   Drizzle schema in T11546 migration 20260531000002 so exodus can copy these rows.
  //   Identity mapping (already has brain_ prefix).
  ['brain_usage_log', 'brain_usage_log'],
  // brain_task_observations: runtime-only observation cache. Not in Drizzle schema.
  ['brain_task_observations', null],
  // brain_embeddings: vec0 VIRTUAL TABLE — cannot be migrated via INSERT/SELECT.
  //   Requires the sqlite-vec extension (vec0) to be loaded. Skip — will be
  //   recreated lazily by memory-sqlite.ts after the exodus cutover.
  ['brain_embeddings', null],
  // brain_embeddings_info: metadata companion to brain_embeddings vec0 virtual table.
  ['brain_embeddings_info', null],
  // agent_credentials: T11550 P0 fix — table physically lives in tasks.db (not brain.db).
  // The TASKS_DB_MAP entry (added in T11550) handles the real migration path.
  // If a legacy brain.db ever contains this table, skip it to avoid double-migration.
  ['agent_credentials', null],
]);

/**
 * conduit.db — tables from conduit-schema.ts, all prefixed `conduit_*`.
 *
 * Note: conduit.db also has an `attachments` table (conduit attachment tracking),
 * which maps to `conduit_attachments` — NOT `docs_attachments` (that is from
 * tasks.db/attachments.ts).
 */
const CONDUIT_DB_MAP: ReadonlyMap<string, string> = new Map([
  ['messages', 'conduit_messages'],
  ['delivery_jobs', 'conduit_delivery_jobs'],
  ['dead_letters', 'conduit_dead_letters'],
  ['message_pins', 'conduit_message_pins'],
  ['attachments', 'conduit_attachments'],
  ['attachment_versions', 'conduit_attachment_versions'],
  ['attachment_approvals', 'conduit_attachment_approvals'],
  ['attachment_contributors', 'conduit_attachment_contributors'],
  ['topics', 'conduit_topics'],
  ['topic_subscriptions', 'conduit_topic_subscriptions'],
  ['topic_messages', 'conduit_topic_messages'],
  ['topic_message_acks', 'conduit_topic_message_acks'],
  // conduit.db may also contain conversation/agent-ref tables
  ['conversations', 'conduit_conversations'],
  ['project_agent_refs', 'conduit_project_agent_refs'],
]);

/**
 * nexus.db — tables from nexus-schema.ts.
 *
 * Some tables are ALREADY prefixed (`nexus_audit_log`, `nexus_nodes`, etc.) and
 * map identity. Others lack the prefix and gain `nexus_` in consolidated.
 *
 * ## Scope split (ADR-090 · T11539)
 *
 * The legacy `nexus.db` source descriptor carries `targetScope: 'global'`, but
 * the four code-graph tables (`code_index`/`nexus_code_index`, `nexus_nodes`,
 * `nexus_relations`, `nexus_contracts`) now live in PROJECT scope. Their
 * consolidated NAME is unchanged (identity / `nexus_code_index`), but their
 * destination DB is the PROJECT `cleo.db` — see {@link NEXUS_GRAPH_PROJECT_TABLES}
 * and {@link resolveTableTargetScope}. The remaining six registry/identity
 * tables stay GLOBAL.
 */
const NEXUS_DB_MAP: ReadonlyMap<string, string> = new Map([
  // Unprefixed legacy names
  ['project_registry', 'nexus_project_registry'],
  ['project_id_aliases', 'nexus_project_id_aliases'],
  ['user_profile', 'nexus_user_profile'],
  ['sigils', 'nexus_sigils'],
  // code_index → nexus_code_index: routed to PROJECT scope (ADR-090 §2.1).
  ['code_index', 'nexus_code_index'],
  // Already-prefixed names (identity)
  ['nexus_audit_log', 'nexus_audit_log'],
  // The 3 graph tables below keep identity names but route to PROJECT scope (ADR-090).
  ['nexus_nodes', 'nexus_nodes'],
  ['nexus_relations', 'nexus_relations'],
  // T11545: partitioned Hebbian plasticity weights (1:1 with nexus_relations).
  ['nexus_relation_weights', 'nexus_relation_weights'],
  ['nexus_contracts', 'nexus_contracts'],
  // schema_meta tables created by consolidated schema bootstrap
  ['nexus_schema_meta', 'nexus_schema_meta'],
]);

/**
 * Legacy table names of the four nexus code-graph tables that moved from GLOBAL
 * to PROJECT scope (ADR-090 · T11538/T11539).
 *
 * Keyed by the LEGACY physical name as it appears in `nexus.db`:
 *   - `nexus_nodes`, `nexus_relations`, `nexus_contracts` — already prefixed.
 *   - `code_index` — bare in legacy `nexus.db`; → `nexus_code_index` consolidated.
 *
 * Membership drives {@link resolveTableTargetScope}: exodus copies/verifies
 * these against the PROJECT consolidated `cleo.db`, NOT the GLOBAL one, even
 * though the `nexus` source descriptor's `targetScope` is `'global'`.
 *
 * @task T11539
 * @epic T11248
 * @saga T11242
 * @see cleo docs fetch adr-090-nexus-graph-residency-split
 */
export const NEXUS_GRAPH_PROJECT_TABLES: ReadonlySet<string> = new Set([
  'nexus_nodes',
  'nexus_relations',
  'nexus_contracts',
  'code_index',
]);

/**
 * Resolve the consolidated TARGET SCOPE for a legacy source table.
 *
 * Most tables share the scope of their source DB descriptor (`sourceScope`).
 * The exception is the four nexus code-graph tables — they are extracted from
 * the GLOBAL legacy `nexus.db` but land in PROJECT scope per ADR-090 (T11539).
 *
 * This is the SSoT consumed by BOTH the exodus migrate runner (insert target DB)
 * and the exodus verifier (verify target DB) so the two never disagree.
 *
 * @param sourceName  - `LegacyDbDescriptor.name` (e.g. `"nexus"`, `"tasks"`).
 * @param legacyTable - Physical table name in the legacy source DB.
 * @param sourceScope - The source descriptor's `targetScope`.
 * @returns The scope of the consolidated `cleo.db` this table copies into.
 *
 * @task T11539
 * @epic T11248
 * @saga T11242
 */
export function resolveTableTargetScope(
  sourceName: string,
  legacyTable: string,
  sourceScope: ExodusScope,
): ExodusScope {
  if (inferSourceKind(sourceName) === 'nexus' && NEXUS_GRAPH_PROJECT_TABLES.has(legacyTable)) {
    return 'project';
  }
  return sourceScope;
}

/**
 * agent-registry (global) — the legacy on-disk source file is `signaldock.db`
 * (the source-descriptor `name` stays `"signaldock"` — see {@link inferSourceKind} —
 * because that is the genuine artifact name on disk). Its bare tables map to the
 * consolidated PREFIXED `agent_registry_*` tables (renamed from `signaldock_*`
 * under T11622 / SG-AGENT-IDENTITY E4).
 *
 * KEYS are the bare legacy names (the source DB still has the old shape); VALUES
 * are the consolidated `agent_registry_*` target names — these MUST equal the
 * `sqliteTable` names declared in `cleo-global/agent-registry.ts` (asserted by
 * the exodus-map invariant test, the DHQ-046 N→0 deficit catcher).
 *
 * Note: the legacy `signaldock.db` has a `sessions` table (identity session
 * management), which maps to `agent_registry_sessions` — NOT `tasks_sessions`.
 *
 * ## `skills` mapping (T11533 ROOT CAUSE 3 fix)
 *
 * The legacy `signaldock.db` contains a `skills` table (36 rows — pre-seeded skill
 * slug catalog). In the consolidated global schema this becomes
 * `agent_registry_skills`. Without this entry the legacy `skills` table fell
 * through to an identity mapping, looked for a `skills` table in the global
 * cleo.db (absent), and was silently skipped — resulting in
 * agent_registry_skills=0 despite 36 source rows.
 *
 * @task T11622 (signaldock_* → agent_registry_* target rename; folds T11578 AC2)
 */
const AGENT_REGISTRY_DB_MAP: ReadonlyMap<string, string> = new Map([
  ['users', 'agent_registry_users'],
  ['organization', 'agent_registry_organization'],
  ['agents', 'agent_registry_agents'],
  ['claim_codes', 'agent_registry_claim_codes'],
  ['agent_capabilities', 'agent_registry_agent_capabilities'],
  // agent_skills junction: agent <-> skill slug catalog bindings
  ['agent_skills', 'agent_registry_agent_skills'],
  ['agent_connections', 'agent_registry_agent_connections'],
  ['accounts', 'agent_registry_accounts'],
  ['sessions', 'agent_registry_sessions'],
  ['verifications', 'agent_registry_verifications'],
  ['org_agent_keys', 'agent_registry_org_agent_keys'],
  // Capability catalog (pre-seeded, 19 entries)
  ['capabilities', 'agent_registry_capabilities'],
  // Skill catalog (pre-seeded, 36 entries) — T11533 ROOT CAUSE 3 fix:
  // was missing → identity fallback → 'skills' absent in global → 0 rows copied.
  ['skills', 'agent_registry_skills'],
]);

/**
 * skills.db (global) — tables from skills-schema.ts, all prefixed `skills_*`.
 */
const SKILLS_DB_MAP: ReadonlyMap<string, string> = new Map([
  ['skills', 'skills_skills'],
  ['skill_usage', 'skills_skill_usage'],
  ['skill_reviews', 'skills_skill_reviews'],
  ['skill_patches', 'skills_skill_patches'],
]);

// ---------------------------------------------------------------------------
// Source-name pattern matchers
// ---------------------------------------------------------------------------

/** Known source DB name patterns (from `LegacyDbDescriptor.name`). */
type SourceKind = 'tasks' | 'brain' | 'conduit' | 'nexus' | 'signaldock' | 'skills';

/**
 * Infer the source DB kind from `LegacyDbDescriptor.name`.
 *
 * The descriptor names used in `buildSourceDescriptors()` are:
 *   `"tasks"`, `"brain (project)"`, `"conduit"`, `"nexus"`, `"signaldock"`, `"skills"`
 */
function inferSourceKind(sourceName: string): SourceKind | null {
  const n = sourceName.toLowerCase();
  if (n.startsWith('tasks')) return 'tasks';
  if (n.startsWith('brain')) return 'brain';
  if (n.startsWith('conduit')) return 'conduit';
  if (n.startsWith('nexus')) return 'nexus';
  if (n.startsWith('signaldock')) return 'signaldock';
  if (n.startsWith('skills')) return 'skills';
  return null;
}

// ---------------------------------------------------------------------------
// Derived / internal table classification (T11572)
// ---------------------------------------------------------------------------

/**
 * Internal bookkeeping tables that exist in a legacy source DB but have NO
 * consolidated counterpart and carry no user data — they are recreated by the
 * runtime, not migrated. Matched by EXACT name.
 *
 * Each legacy per-domain SQLite file (`conduit.db`, `signaldock.db`,
 * `skills.db`, …) carries its OWN private schema-version / migration-ledger
 * table that records HOW that file was built — NOT user-payload data:
 *
 * - `_conduit_meta` / `_conduit_migrations` — conduit-sqlite's own
 *   schema-version + migration-ledger tables (see `conduit-sqlite.ts`).
 * - `_signaldock_meta` / `_signaldock_migrations` — agent-registry-store's own
 *   ledger tables (same class — T11577 global-scope cutover blocker).
 * - `_skills_meta` — skills.db's own schema-version row (same class — T11577).
 *
 * The consolidated `cleo.db` has its own Drizzle journal (`__drizzle_*`) for the
 * same purpose, so these legacy ledgers have no consolidated home. Row-comparing
 * them would count internal ledger rows as a user-data deficit and abort the
 * cutover. The {@link INTERNAL_LEDGER_PATTERN} below generalises the same skip
 * to ANY future `_<domain>_meta` / `_<domain>_migrations` ledger so a new source
 * DB never re-introduces this false-positive; these exact entries remain for
 * documentation + as a fast path.
 *
 * @task T11572 (parity gate over-abort — internal/meta exclusion)
 * @task T11577 (generalise to signaldock/skills + any per-source ledger)
 */
const INTERNAL_BOOKKEEPING_TABLES: ReadonlySet<string> = new Set([
  '_conduit_meta',
  '_conduit_migrations',
  '_signaldock_meta',
  '_signaldock_migrations',
  '_skills_meta',
]);

/**
 * Pattern matching a per-source SQLite **internal ledger** table: an underscore-
 * prefixed `_<domain>_meta` or `_<domain>_migrations` name where `<domain>` is a
 * lowercase identifier (e.g. `_conduit_meta`, `_signaldock_migrations`,
 * `_skills_meta`).
 *
 * Every legacy domain DB (conduit/signaldock/skills/…) materialises one of these
 * to track its own schema version / applied-migration history. They are private
 * bookkeeping — NOT migratable base data — and have no consolidated home (the
 * consolidated `cleo.db` keeps its own `__drizzle_*` journal). Generalising the
 * skip to this shape is future-proof: a NEW source DB that follows the same
 * `_<domain>_(meta|migrations)` convention is excluded automatically, so this
 * exact false-positive class can never abort the cutover again.
 *
 * The pattern is intentionally conservative — it requires the leading underscore
 * and the exact `_meta` / `_migrations` suffix so it can never match a real
 * data table (those are never underscore-prefixed in any legacy source schema).
 *
 * @task T11577 (parity gate over-abort — generalise per-source ledger skip)
 */
const INTERNAL_LEDGER_PATTERN: RegExp = /^_[a-z][a-z0-9]*_(?:meta|migrations)$/;

/**
 * FTS5 shadow-table suffixes. A full-text index `<base>_fts` (an `fts5` VIRTUAL
 * TABLE — e.g. `brain_decisions_fts`, `messages_fts`) materialises a family of
 * backing tables `<base>_fts_data`, `<base>_fts_idx`, `<base>_fts_docsize`,
 * `<base>_fts_config`, and (for `content=`-less indexes) `<base>_fts_content`.
 *
 * These are DERIVED from their content table and are REBUILT post-migration
 * (`brain-search.ts` issues `INSERT INTO <base>_fts(<base>_fts) VALUES('rebuild')`).
 * Their row counts do NOT correspond 1:1 to user rows, so comparing them against
 * an absent consolidated target produces a spurious N→0 deficit. They must be
 * excluded from the row-count-parity gate, not migrated.
 *
 * @task T11572 (parity gate over-abort — FTS5 shadow-table exclusion)
 */
const FTS5_SHADOW_SUFFIXES: readonly string[] = [
  '_fts_data',
  '_fts_idx',
  '_fts_docsize',
  '_fts_config',
  '_fts_content',
] as const;

/**
 * Return `true` if `tableName` is a DERIVED or INTERNAL table that must be
 * EXCLUDED from the exodus row-count-parity gate (and from the copy path).
 *
 * This is the single, named, documented classification consumed by BOTH the
 * migrate copy loop and the `verifyMigration` parity check, so the two never
 * disagree about which tables carry migratable user data. It recognises:
 *
 *   1. **FTS5 virtual tables** — a bare `*_fts` name (e.g. `brain_decisions_fts`,
 *      `messages_fts`). The virtual table itself cannot be `INSERT … SELECT`-ed
 *      and is rebuilt from its content table after migration.
 *   2. **FTS5 shadow/backing tables** — `*_fts_data`, `*_fts_idx`,
 *      `*_fts_docsize`, `*_fts_config`, `*_fts_content` (see
 *      {@link FTS5_SHADOW_SUFFIXES}). Derived; rebuilt post-migration.
 *   3. **Internal bookkeeping** — any per-source schema-version / migration
 *      ledger: `_conduit_meta`, `_conduit_migrations`, `_signaldock_meta`,
 *      `_signaldock_migrations`, `_skills_meta`, and — generalised via
 *      {@link INTERNAL_LEDGER_PATTERN} — ANY `_<domain>_meta` /
 *      `_<domain>_migrations` ledger from a future source DB (see
 *      {@link INTERNAL_BOOKKEEPING_TABLES}). Schema-version ledgers with no
 *      consolidated home.
 *
 * A migration is "safe" iff every BASE-DATA row survives; these derived/internal
 * tables are NOT base data, so a 0-row consolidated counterpart for them is
 * expected and correct — not data loss.
 *
 * @param tableName - Physical table name from a legacy source DB.
 * @returns `true` when the table is derived/internal and must be skipped.
 *
 * @task T11572 (exodus parity gate: exclude FTS5 + internal/meta shadow tables)
 * @task T11577 (generalise internal-ledger skip to signaldock/skills + any per-source ledger)
 * @epic T11249 (E6)
 * @saga T11242
 */
export function isDerivedOrInternalTable(tableName: string): boolean {
  // Exact-name fast path (documented known ledgers).
  if (INTERNAL_BOOKKEEPING_TABLES.has(tableName)) return true;
  // Generalised per-source ledger: `_<domain>_meta` / `_<domain>_migrations`.
  // Future-proofs against a new source DB re-introducing the same false-positive.
  if (INTERNAL_LEDGER_PATTERN.test(tableName)) return true;
  // Bare FTS5 virtual table (e.g. `brain_decisions_fts`, `messages_fts`).
  if (tableName.endsWith('_fts')) return true;
  // FTS5 backing/shadow tables (`*_fts_data`, `*_fts_idx`, …).
  return FTS5_SHADOW_SUFFIXES.some((suffix) => tableName.endsWith(suffix));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Result of resolving a legacy table name to its consolidated target.
 *
 * `kind === 'mapped'`  — `targetName` holds the consolidated physical name.
 * `kind === 'skip'`    — table is intentionally excluded (virtual, orphan, etc.);
 *                        `reason` holds a human-readable explanation.
 * `kind === 'unknown'` — source DB is unrecognized; falls back to identity copy
 *                        (best-effort for forward-compatibility with future DBs).
 */
export type TableNameResolution =
  | { readonly kind: 'mapped'; readonly targetName: string }
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'unknown'; readonly targetName: string };

/**
 * Resolve the consolidated target table name for a legacy source table.
 *
 * @param sourceName  - `LegacyDbDescriptor.name` (e.g. `"tasks"`, `"brain (project)"`).
 * @param legacyTable - Physical table name from the legacy source DB.
 * @returns A `TableNameResolution` describing how to copy (or skip) the table.
 */
export function resolveConsolidatedTableName(
  sourceName: string,
  legacyTable: string,
): TableNameResolution {
  // T11572/T11577: derived (FTS5 shadow) + internal per-source ledger tables
  // (`_<domain>_meta` / `_<domain>_migrations` — conduit/signaldock/skills/…)
  // are excluded BEFORE any per-source map lookup. They carry no migratable base
  // data — comparing them against an absent consolidated target would count an
  // N→0 "deficit" and abort the cutover. This guard is source-kind-agnostic so
  // it covers FTS shadow + ledger tables in any DB (brain/conduit/signaldock/…).
  if (isDerivedOrInternalTable(legacyTable)) {
    return {
      kind: 'skip',
      reason: legacyTable.includes('_fts')
        ? `derived FTS5 table — rebuilt post-migration from its content table, not row-compared`
        : `internal bookkeeping table — no consolidated home (recreated by runtime)`,
    };
  }

  const kind = inferSourceKind(sourceName);

  if (kind === null) {
    // Unrecognized source — identity fallback (forward-compatible).
    return { kind: 'unknown', targetName: legacyTable };
  }

  let map: ReadonlyMap<string, string | null>;
  switch (kind) {
    case 'tasks':
      map = TASKS_DB_MAP;
      break;
    case 'brain':
      map = BRAIN_DB_MAP;
      break;
    case 'conduit':
      map = CONDUIT_DB_MAP;
      break;
    case 'nexus':
      map = NEXUS_DB_MAP;
      break;
    case 'signaldock':
      map = AGENT_REGISTRY_DB_MAP;
      break;
    case 'skills':
      map = SKILLS_DB_MAP;
      break;
  }

  if (!map.has(legacyTable)) {
    // Not in the explicit map — try identity (e.g. already-prefixed tables not
    // enumerated, or schema-meta tables created by the consolidated bootstrap).
    return { kind: 'mapped', targetName: legacyTable };
  }

  const consolidated = map.get(legacyTable);
  // `undefined` should not occur since we checked `has()`, but guard for type safety.
  if (consolidated === null || consolidated === undefined) {
    return {
      kind: 'skip',
      reason: getSkipReason(kind, legacyTable),
    };
  }

  return { kind: 'mapped', targetName: consolidated };
}

/**
 * Return a human-readable explanation for why a table is intentionally excluded
 * from the consolidated schema.
 */
function getSkipReason(sourceKind: SourceKind, legacyTable: string): string {
  const reasons: Partial<Record<string, string>> = {
    brain_task_observations:
      'runtime-only observation cache (not Drizzle-managed); ' +
      'recreated lazily after exodus cutover',
    brain_embeddings:
      'vec0 VIRTUAL TABLE — cannot be migrated via INSERT/SELECT; ' +
      'requires sqlite-vec extension; recreated lazily after exodus cutover',
    brain_embeddings_info:
      'metadata companion to brain_embeddings vec0 virtual table; ' +
      'excluded from consolidated schema (derived/recreatable)',
    // brain_release_links and agent_credentials are no longer skipped (T11549):
    // they now map to tasks_brain_release_links and tasks_agent_credentials respectively.
  };
  return (
    reasons[legacyTable] ?? `table '${legacyTable}' from ${sourceKind} has no consolidated target`
  );
}

/**
 * Reverse-lookup: given a consolidated target table name, return the set of
 * legacy (sourceName, legacyTableName) pairs that map to it.
 *
 * Used by `runExodusVerify()` to compare legacy source counts against the
 * correct consolidated target table rather than the legacy table name.
 *
 * Returns an empty array if no legacy table maps to the given consolidated name.
 */
export function reverseLookup(
  consolidatedTable: string,
  sources: ReadonlyArray<{ readonly name: string }>,
): Array<{ sourceName: string; legacyTable: string }> {
  const result: Array<{ sourceName: string; legacyTable: string }> = [];
  for (const src of sources) {
    const kind = inferSourceKind(src.name);
    if (kind === null) continue;

    let map: ReadonlyMap<string, string | null>;
    switch (kind) {
      case 'tasks':
        map = TASKS_DB_MAP;
        break;
      case 'brain':
        map = BRAIN_DB_MAP;
        break;
      case 'conduit':
        map = CONDUIT_DB_MAP;
        break;
      case 'nexus':
        map = NEXUS_DB_MAP;
        break;
      case 'signaldock':
        map = AGENT_REGISTRY_DB_MAP;
        break;
      case 'skills':
        map = SKILLS_DB_MAP;
        break;
    }
    for (const [legacy, consolidated] of map) {
      if (consolidated === consolidatedTable) {
        result.push({ sourceName: src.name, legacyTable: legacy });
      }
    }
  }
  return result;
}
