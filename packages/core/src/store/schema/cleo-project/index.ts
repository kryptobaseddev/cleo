/**
 * Consolidated **PROJECT-scope `cleo.db`** target schema — barrel.
 *
 * SG-DB-SUBSTRATE-V2 · saga T11242 · epic T11245 (E2) · task T11360.
 *
 * ## What this directory is
 *
 * The owner-ratified D1″ lifecycle split (2026-05-30) collapses the CLEO SQLite
 * fleet into exactly two `cleo.db` files: a PROJECT-scope DB
 * (`<projectRoot>/.cleo/cleo.db`) and a GLOBAL-scope DB
 * (`$XDG_DATA_HOME/cleo/cleo.db`). The PROJECT-scope DB holds every project-tier
 * domain — `tasks_*` / `brain_*` (this project's memory) / `conduit_*` /
 * `docs_*` / `telemetry_*` — as domain-prefixed Pattern-A tables (87 tables /
 * 903 columns per the canonical typing report §1).
 *
 * Modules under this directory author that **target shape**: domain-prefixed
 * `sqliteTable` definitions with the E10 strict typing applied per
 * `docs/migration/sqlite-schema-canonical.md`. They are NOT yet the runtime
 * schema — the live runtime modules one level up
 * (`packages/core/src/store/schema/*.ts`) keep their UNPREFIXED physical names
 * (`tasks`, `commits`, `attachments`, …) because they back the live runtime
 * queries and the journaled drizzle migrations (the migration-baseline test
 * asserts the existence table `tasks`, not `tasks_tasks`). The **exodus
 * migration (T11248)** swaps the substrate to this shape and renames the
 * physical tables; pointing a runtime accessor at this module before exodus
 * would read an empty / nonexistent table.
 *
 * ## Idempotent prefixer (AC1)
 *
 * Each table's physical name is its `targetTable` from
 * `docs/migration/sqlite-schema-columns.json`. A table already carrying a
 * recognized domain prefix (`telemetry_events`, `conduit_*`, `brain_*`, …) is
 * NOT double-prefixed; bare tables (`tasks` → `tasks_tasks`, `attachments` →
 * `docs_attachments`) gain their domain prefix.
 *
 * ## Coverage status (T11360 — COMPLETE · 89 project-tier tables · 87 canonical)
 *
 * **Batch 1 (PR #849 — merged · 9 tables):** docs (D11 collapse, AC3:
 * docs_attachments · docs_attachment_refs · docs_manifest_entries ·
 * docs_pipeline_manifest) · telemetry (telemetry_events · telemetry_schema_meta) ·
 * provenance/commits (tasks_commits · tasks_task_commits · tasks_commit_files).
 *
 * **Batch 2 (PR #851 — merged · 18 tables):** conduit (14 tables · ALL §4
 * epoch→ISO8601 resolved to seconds per §8.1 + §7 idempotency keys + §3b
 * `enabled` boolean; the two `_conduit_*` legacy meta tables OMITTED per §6b) ·
 * tasks-core batch 2 (tasks_background_jobs [§4 ms-epoch + §7 idempotency] ·
 * tasks_experiments · tasks_evidence_ac_bindings · tasks_task_labels [AC4]).
 *
 * **Batch 3 (this increment — 38 tables, completing the project-tier non-brain set):**
 *   - **tasks-core** (11 tables · `tasks` → `tasks_tasks` AC1 example + §8.2
 *     `sessions.grade_mode` boolean RESOLVED as genuine 0/1; T11362 adds the §7
 *     `tasks_tasks.idempotency_key` + UNIQUE for sentient re-tick dedup): tasks_tasks ·
 *     tasks_task_acceptance_criteria · tasks_acceptance_projection_state ·
 *     tasks_acceptance_projection_dirty · tasks_task_dependencies ·
 *     tasks_task_relations · tasks_sessions · tasks_session_handoff_entries ·
 *     tasks_task_work_history · tasks_task_acceptance_criteria_history ·
 *     tasks_external_task_links.
 *   - **lifecycle** (5 tables): tasks_lifecycle_{pipelines,stages,gate_results,
 *     evidence,transitions}.
 *   - **audit/governance** (7 tables · §7 audit_log idempotency model preserved —
 *     its `(project_hash, domain, operation, idempotency_key)` lookup promoted to
 *     a UNIQUE constraint by T11362 so the canonical retry-dedup is enforced):
 *     tasks_schema_meta · tasks_audit_log · tasks_token_usage ·
 *     tasks_architecture_decisions · tasks_adr_task_links · tasks_adr_relations ·
 *     tasks_status_registry.
 *   - **provenance (PRs + releases)** (8 tables · §3b booleans on PR
 *     is_release_pr/is_bump_only + release_commits is_first/is_last/
 *     is_release_chore + §5b enums): tasks_pull_requests · tasks_pr_commits ·
 *     tasks_pr_tasks · tasks_releases · tasks_release_commits ·
 *     tasks_release_changes · tasks_release_changesets · tasks_release_artifacts.
 *   - **runtime** (chain · agents · playbooks · 6 tables · §3b
 *     playbook_approvals.auto_passed + §5b status enums minted compiler-checked
 *     from contracts unions): tasks_warp_chains · tasks_warp_chain_instances ·
 *     tasks_agent_instances · tasks_agent_error_log · tasks_playbook_runs ·
 *     tasks_playbook_approvals.
 *
 * **Final batch (this increment · brain_* MIRRORED family · 24 tables):** the
 * `brain_*` memory family — the ONE domain that lives in BOTH the project and
 * global `cleo.db` (project-local vs cross-project memory). To avoid
 * duplication it is authored ONCE under `../cleo-shared/brain.ts` and
 * re-exported here; the future `cleo-global/index.ts` (T11361) re-exports the
 * SAME shared module. §5b enums fixed (transcript_events.role,
 * backfill_runs.{kind,status}); §4 ms-epoch → ISO8601 (decisions.validator_run_at,
 * attention.{created_at,expires_at}, session_narrative.last_updated_at); §6b
 * sticky tags → `brain_sticky_tags` junction; `brain_attention.tags` keeps the
 * E4 jsonb BLOB.
 *
 * **PROJECT SCHEMA NOW COMPLETE.** Every project-tier table is authored: the
 * canonical 87 (tasks-core 45 + conduit 14 + docs 4 + telemetry 2 + brain 22)
 * plus the 2 E4 junctions added on main since the audit (`tasks_task_labels`,
 * `brain_sticky_tags`) = 89 prefixed `sqliteTable`s across `cleo-project/` +
 * `cleo-shared/`. The two `_conduit_*` legacy meta tables are dropped at exodus
 * per §6b. **T11549 (zero-loss final mile)**: `tasks_agent_credentials` and
 * `tasks_brain_release_links` added in `provenance-orphans.ts` (2 tables, 11
 * rows recovered from legacy brain.db). Total = 91 prefixed tables.
 * What remains for the saga is the GLOBAL scope (T11361: nexus_* / skills_* /
 * signaldock_* + this same mirrored brain_*) and the exodus cutover (T11248).
 *
 * ## Nexus code-graph residency move (ADR-090 · T11538 — additive)
 *
 * `./nexus-graph.ts` adds the four per-project code/knowledge-graph tables
 * (`nexus_nodes`, `nexus_relations`, `nexus_contracts`, `nexus_code_index`) to
 * the PROJECT scope (each with `project_id` DROPPED — scope is implicit). They
 * wrongly lived in GLOBAL scope (`../cleo-global/nexus.ts`); moving them makes
 * `.cleo/cleo.db` the complete portable living brain. This is STEP 1 (schema
 * definition only); T11539 removes the global copies + moves the data, and
 * T11545 partitions `nexus_relation_weights` into this module.
 *
 * @task T11360 · T11538 (nexus code-graph)
 * @epic T11245 · T11535 (nexus residency)
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §1 (per-scope counts) · §3–§8 (typing rules)
 * @see ../cleo-shared/brain.ts (the mirrored brain_* family — also imported by cleo-global, T11361)
 * @see ../cleo-global/nexus.ts (the GLOBAL source the four graph tables move OUT of)
 * @see drizzle/cleo-project.config.ts (per-scope domain membership)
 */

export * from '../cleo-shared/index.js';
export * from './audit.js';
export * from './conduit.js';
export * from './docs.js';
export * from './lifecycle.js';
export * from './nexus-graph.js';
export * from './provenance-commits.js';
export * from './provenance-orphans.js';
export * from './provenance-rest.js';
export * from './runtime.js';
export * from './tasks-core.js';
export * from './tasks-core-batch2.js';
export * from './telemetry.js';
