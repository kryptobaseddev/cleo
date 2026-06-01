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
 * @task T11532 (ROOT CAUSE 1 — name-mapping gap)
 * @task T11533 (ROOT CAUSE 3 — signaldock skills mapping + brain_release_links skip +
 *               brain_session_narrative mapping)
 * @task T11546 (no-home-table fixes — schema_meta→tasks_schema_meta, brain_usage_log mapping,
 *               brain_schema_meta mapping)
 * @epic T11248
 * @saga T11242
 */

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
 * ## brain_release_links (T11533 → T11549 fix)
 *
 * The legacy brain.db contains a `brain_release_links` table (8 rows) used by
 * `cleo release reconcile` to track release provenance. T11533 incorrectly marked
 * this as `null` (skip) because the consolidated cleo-project schema did not yet
 * include the table. T11549 adds `tasks_brain_release_links` to the consolidated
 * project schema (`cleo-project/provenance-orphans.ts`) so all 8 rows can be
 * migrated. The table is now mapped to `'tasks_brain_release_links'`.
 *
 * ## agent_credentials (T11549 fix)
 *
 * The legacy brain.db contains an `agent_credentials` table (3 rows) with
 * encrypted API keys. T11533 marked this as `null` (skip) because it was not in
 * the consolidated schema. T11549 adds `tasks_agent_credentials` to the project
 * schema so all 3 rows (including `api_key_encrypted`) are preserved through
 * exodus. The table is now mapped to `'tasks_agent_credentials'`.
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
  // brain_release_links: T11549 fix — consolidated target added in cleo-project/provenance-orphans.ts.
  // Was `null` (skip) in T11533; now maps to tasks_brain_release_links (8 rows preserved).
  ['brain_release_links', 'tasks_brain_release_links'],
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
  // agent_credentials: T11549 fix — consolidated target added in cleo-project/provenance-orphans.ts.
  // Was `null` (skip); now maps to tasks_agent_credentials (3 rows incl. api_key_encrypted).
  ['agent_credentials', 'tasks_agent_credentials'],
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
 */
const NEXUS_DB_MAP: ReadonlyMap<string, string> = new Map([
  // Unprefixed legacy names
  ['project_registry', 'nexus_project_registry'],
  ['project_id_aliases', 'nexus_project_id_aliases'],
  ['user_profile', 'nexus_user_profile'],
  ['sigils', 'nexus_sigils'],
  ['code_index', 'nexus_code_index'],
  // Already-prefixed names (identity)
  ['nexus_audit_log', 'nexus_audit_log'],
  ['nexus_nodes', 'nexus_nodes'],
  ['nexus_relations', 'nexus_relations'],
  ['nexus_contracts', 'nexus_contracts'],
  // schema_meta tables created by consolidated schema bootstrap
  ['nexus_schema_meta', 'nexus_schema_meta'],
]);

/**
 * signaldock.db (global) — tables from signaldock-schema.ts, all prefixed `signaldock_*`.
 *
 * Note: signaldock.db has a `sessions` table (identity session management),
 * which maps to `signaldock_sessions` — NOT `tasks_sessions`.
 *
 * ## `skills` mapping (T11533 ROOT CAUSE 3 fix)
 *
 * signaldock.db contains a `skills` table (36 rows — pre-seeded skill slug catalog,
 * `export const skills = sqliteTable('skills', …)` in `signaldock-schema.ts`).
 * In the consolidated global schema this becomes `signaldock_skills`. Without
 * this entry the legacy `skills` table fell through to an identity mapping,
 * looked for a `skills` table in the global cleo.db (absent), and was silently
 * skipped — resulting in signaldock_skills=0 despite 36 source rows.
 */
const SIGNALDOCK_DB_MAP: ReadonlyMap<string, string> = new Map([
  ['users', 'signaldock_users'],
  ['organization', 'signaldock_organization'],
  ['agents', 'signaldock_agents'],
  ['claim_codes', 'signaldock_claim_codes'],
  ['agent_capabilities', 'signaldock_agent_capabilities'],
  // agent_skills junction: agent <-> skill slug catalog bindings
  ['agent_skills', 'signaldock_agent_skills'],
  ['agent_connections', 'signaldock_agent_connections'],
  ['accounts', 'signaldock_accounts'],
  ['sessions', 'signaldock_sessions'],
  ['verifications', 'signaldock_verifications'],
  ['org_agent_keys', 'signaldock_org_agent_keys'],
  // Capability catalog (pre-seeded, 19 entries)
  ['capabilities', 'signaldock_capabilities'],
  // Skill catalog (pre-seeded, 36 entries) — T11533 ROOT CAUSE 3 fix:
  // was missing → identity fallback → 'skills' absent in global → 0 rows copied.
  ['skills', 'signaldock_skills'],
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
      map = SIGNALDOCK_DB_MAP;
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
        map = SIGNALDOCK_DB_MAP;
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
