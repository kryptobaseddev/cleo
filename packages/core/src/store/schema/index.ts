/**
 * Schema barrel — re-exports all domain modules.
 *
 * Domain breakdown:
 *   tasks         — tasks, sessions, task_dependencies, task_relations,
 *                   session_handoff_entries, task_work_history, external_task_links
 *   lifecycle     — lifecycle_pipelines, lifecycle_stages, lifecycle_gate_results,
 *                   lifecycle_evidence, lifecycle_transitions
 *   manifest      — manifest_entries, pipeline_manifest
 *   audit         — schema_meta, audit_log, token_usage,
 *                   architecture_decisions, adr_task_links, adr_relations,
 *                   status_registry
 *   background-jobs — background_jobs
 *   attachments   — attachments, attachment_refs
 *   experiments   — experiments
 *   evidence-bindings — evidence_ac_bindings (M:N join: evidence atom ↔ AC)
 *   provenance/   — commits, task_commits, commit_files,
 *                   pull_requests, pr_commits, pr_tasks,
 *                   releases, release_commits, release_changes,
 *                   release_changesets, release_artifacts, brain_release_links
 */

export * from './attachments.js';
export * from './audit.js';
export * from './background-jobs.js';
export * from './evidence-bindings.js';
export * from './experiments.js';
export * from './lifecycle.js';
export * from './manifest.js';
export * from './provenance/index.js';
export * from './tasks.js';
