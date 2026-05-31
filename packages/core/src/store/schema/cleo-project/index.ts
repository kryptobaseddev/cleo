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
 * ## Coverage status (T11360 — 65 project-tier tables authored · only brain_* remains)
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
 *     `sessions.grade_mode` boolean RESOLVED as genuine 0/1): tasks_tasks ·
 *     tasks_task_acceptance_criteria · tasks_acceptance_projection_state ·
 *     tasks_acceptance_projection_dirty · tasks_task_dependencies ·
 *     tasks_task_relations · tasks_sessions · tasks_session_handoff_entries ·
 *     tasks_task_work_history · tasks_task_acceptance_criteria_history ·
 *     tasks_external_task_links.
 *   - **lifecycle** (5 tables): tasks_lifecycle_{pipelines,stages,gate_results,
 *     evidence,transitions}.
 *   - **audit/governance** (7 tables · §7 audit_log idempotency model preserved):
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
 * **Remaining (the coordinated FINAL step):** ONLY the `brain_*` memory family
 * (22 tables) — mirrored across the project AND global scopes, so it is authored
 * once and shared by both `cleo-project` and `cleo-global` configs. Every
 * project-tier non-brain table is now authored.
 *
 * @task T11360
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §1 (per-scope counts) · §3–§8 (typing rules)
 * @see drizzle/cleo-project.config.ts (per-scope domain membership)
 */

export * from './audit.js';
export * from './conduit.js';
export * from './docs.js';
export * from './lifecycle.js';
export * from './provenance-commits.js';
export * from './provenance-rest.js';
export * from './runtime.js';
export * from './tasks-core.js';
export * from './tasks-core-batch2.js';
export * from './telemetry.js';
