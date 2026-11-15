# CLEO Database Architecture

> **Status**: CANONICAL
> **Scope**: Every SQLite store CLEO opens on a machine: the project store, the global store, and the files around them

---

## 1. Overview

CLEO keeps its data in **two `cleo.db` files**, one per scope:

| Scope | File | Holds |
|---|---|---|
| Project | `<projectRoot>/.cleo/cleo.db` | Everything that belongs to one project: tasks, sessions, lifecycle, provenance, project memory, docs, the NEXUS code graph, conduit (legacy messaging) state |
| Global | `<cleoHome>/cleo.db` | Everything that spans projects on this machine: the NEXUS project registry, skills, agent identity, global memory, telemetry, providers and services |

`<cleoHome>` is the CLEO data directory resolved by `getCleoHome()` (`packages/core/src/paths.ts`, from `@cleocode/paths`):

- Linux: `~/.local/share/cleo`
- macOS: `~/Library/Application Support/cleo`
- `CLEO_HOME` overrides it.

Both files use `node:sqlite` (`DatabaseSync`) with Drizzle ORM (`drizzle-orm` `1.0.0-rc.4`, `packages/core/package.json`). Tables carry a domain prefix (`tasks_`, `brain_`, `conduit_`, `docs_`, `nexus_`, `skills_`, `agent_registry_`, `telemetry_`) so one file can hold many domains.

The older per-domain files (`tasks.db`, `brain.db`, `conduit.db`, `nexus.db`, `signaldock.db`, `skills.db`, `telemetry.db`) are legacy. Their data was moved into the two `cleo.db` files; see §5.

---

## 2. Opening a store

Every open of either `cleo.db` goes through `openDualScopeDb(scope, cwd)` in `packages/core/src/store/dual-scope-db.ts`. It:

1. Resolves the path: `resolveCleoDir(cwd)` + `cleo.db` for the project scope, `getCleoHome()` + `cleo.db` for the global scope (`resolveDualScopeDbPath`).
2. Opens a `node:sqlite` `DatabaseSync` handle.
3. Applies the pragma set from `specs/sqlite-pragmas.json` (`applyPerfPragmas`, `packages/core/src/store/sqlite-pragmas.ts`).
4. Runs pending migrations for that scope.
5. Caches the handle per (scope, path).

`openCleoDb(scope, cwd)` in `packages/core/src/store/open-cleo-db.ts` accepts only `'project'` or `'global'` and delegates to `openDualScopeDb`. The older role-based API (`tasks`, `brain`, `conduit`, `nexus`, `signaldock`, …) was removed. Domain accessors such as `getDb`, `getBrainDb`, `ensureConduitDb` and `getNexusDb` bind the same consolidated handles.

**Raw opens are forbidden.** `new DatabaseSync(` outside the allowlist fails arch gate 3 (`scripts/lint-no-direct-db-open.mjs --strict`). The allowlist is `packages/core/src/store/**`, `packages/core/src/migration/**` and `packages/studio/src/lib/server/db/connections.ts`; tests may open raw for seeding, and any other legitimate open carries `// db-open-allowed: <reason>`. Agents never read `.cleo/*.db` directly; they ask the CLI.

### 2.1 Migrations

Each scope has its own migrations folder:

- `packages/core/migrations/drizzle-cleo-project/`
- `packages/core/migrations/drizzle-cleo-global/`

The legacy per-domain migration folders (`drizzle-tasks`, `drizzle-brain`, `drizzle-nexus`, `drizzle-conduit`, `drizzle-agent-registry`, `drizzle-skills`, `drizzle-telemetry`) still apply to the consolidated files and share one journal with the two scope folders. The full list is `CONSOLIDATED_JOURNAL_LINEAGES` in `packages/core/src/store/resolve-migrations-folder.ts`. `cleo doctor migrations` reports the journal of both stores per lineage (read-only).

---

## 3. What each scope holds

Schemas live in `packages/core/src/store/schema/`:

- `cleo-project/` — project-only tables (barrel: `cleo-project/index.ts`)
- `cleo-global/` — global-only tables (barrel: `cleo-global/index.ts`)
- `cleo-shared/` — the `brain_*` memory family, re-exported by **both** barrels, so the same tables exist in both files with data split by scope (project memory vs cross-project memory)

### 3.1 Project scope (`<projectRoot>/.cleo/cleo.db`)

| Module | Tables |
|---|---|
| `tasks-core.ts`, `tasks-core-batch2.ts` | `tasks_tasks`, acceptance criteria and their history, dependencies, relations, sessions, session handoff entries, work history, external task links, background jobs, experiments, evidence AC bindings, `tasks_task_labels` |
| `audit.ts` | `tasks_schema_meta`, `tasks_audit_log`, `tasks_token_usage`, `tasks_architecture_decisions`, `tasks_adr_task_links`, `tasks_adr_relations`, `tasks_status_registry` |
| `lifecycle.ts` | `tasks_lifecycle_pipelines`, `_stages`, `_gate_results`, `_evidence`, `_transitions` |
| `provenance-commits.ts`, `provenance-rest.ts`, `provenance-orphans.ts` | commits, pull requests, releases and their link tables; `tasks_agent_credentials`; `tasks_brain_release_links`; `brain_task_observations` |
| `runtime.ts` | `tasks_warp_chains`, `tasks_warp_chain_instances`, `tasks_agent_instances`, `tasks_agent_error_log`, `tasks_playbook_runs`, `tasks_playbook_approvals` |
| `docs.ts` | `docs_attachments`, `docs_attachment_refs`, `docs_manifest_entries`, `docs_pipeline_manifest`, `docs_publications`, `decision_adr_links`, `conduit_doc_migration_ledger` |
| `conduit.ts` | `conduit_conversations`, `conduit_messages`, delivery jobs, dead letters, pins, attachments and their versions/approvals/contributors, doc heads and slug aliases, `section_crdt_states`, topics and subscriptions, `conduit_project_agent_refs` |
| `nexus-graph.ts` | `nexus_nodes`, `nexus_relations`, `nexus_relation_weights`, `nexus_contracts`, `nexus_code_index` |

### 3.2 Global scope (`<cleoHome>/cleo.db`)

| Module | Tables |
|---|---|
| `nexus.ts` | `nexus_project_registry`, `nexus_project_id_aliases`, `nexus_project_paths`, `nexus_project_locations`, `nexus_devices`, `nexus_project_git_state`, `nexus_audit_log`, `nexus_schema_meta`, `nexus_user_profile`, `nexus_sigils` |
| `skills.ts` | `skills_skills`, `skills_skill_usage`, `skills_skill_reviews`, `skills_skill_patches` |
| `agent-registry.ts` | `agent_registry_agents`, `_users`, `_organization`, `_claim_codes`, `_capabilities`, `_skills`, `_agent_capabilities`, `_agent_skills`, `_agent_connections`, `_accounts`, `_sessions`, `_verifications`, `_org_agent_keys` |
| `telemetry.ts` | `telemetry_events`, `telemetry_schema_meta` |
| `accounts.ts`, `providers.ts`, `models-catalog.ts`, `services.ts`, `session-manifest.ts` | `accounts`, `providers`, `models_catalog`, `service_connections`, `service_configs`, `agent_service_grants`, `session_manifest` |

### 3.3 Both scopes (`cleo-shared/brain.ts`)

`brain_decisions`, `brain_patterns`, `brain_learnings`, `brain_observations`, `brain_observations_staging`, `brain_sticky_notes`, `brain_sticky_tags`, `brain_attention`, `brain_memory_links`, `brain_memory_trees`, `brain_page_nodes`, `brain_page_edges`, `brain_retrieval_log`, `brain_usage_log`, `brain_plasticity_events`, `brain_weight_history`, `brain_modulators`, `brain_consolidation_events`, `brain_transcript_events`, `brain_promotion_log`, `brain_backfill_runs`, `brain_session_narrative`, `brain_deriver_queue`, `brain_schema_meta`.

### 3.4 Table counts

Counted by collecting the distinct names passed to `sqliteTable('…')` or `makeSchemaMetaTable('…')` in each folder's `.ts` files, with comments stripped:

| Folder | Tables |
|---|---|
| `cleo-project/` | 76 |
| `cleo-global/` | 36 |
| `cleo-shared/` | 24 (present in both files) |

These counts cover only the scope modules. They leave out tables a legacy lineage still creates in the consolidated file (for example `tasks_goal`, declared in `schema/goal.ts` and created by a `drizzle-tasks` migration), FTS5 virtual tables (for example `nexus_symbols_fts`), and sync-journal tables.

### 3.5 Other SQLite files

- `<projectRoot>/.cleo/blobs/manifest.db` — the content-addressed doc blob manifest. Its inventory entry marks it `derived` and rebuildable from the blob store, so snapshots skip it.
- `.cleo/attachments/index.db` is a legacy attachments store; `cleo docs doctor` reports it as `legacy-store-present` (`packages/core/src/docs/doctor.ts`).

Agents reach docs storage only through `cleo docs …`, never by opening these files.

---

## 4. Cross-scope references

SQLite cannot enforce a foreign key across two files, so references between the project and global stores are **soft**: plain text ids, checked by application code. Examples: `conduit_project_agent_refs` (project) → `agent_registry_agents` (global), `nexus_audit_log.session_id` (global) → `tasks_sessions` (project). References inside one file keep native `.references()` where the source declared them.

Two accessors join across the scopes:

- **Agents** — `packages/core/src/store/agent-registry-accessor.ts` reads both handles and joins in Node.
- **NEXUS** — `getNexusDb()` (`packages/core/src/store/nexus-sqlite.ts`) opens the project store as `main` and `ATTACH`es the global store as `nexus_global`. Graph tables resolve in the project file; registry tables fall through to the global file.

`reconcileOrphanedRefs()` (`packages/core/src/store/cross-db-cleanup.ts`) removes stale brain references to deleted tasks.

---

## 5. Legacy per-domain files

Before consolidation each domain had its own file. The data was moved into `cleo.db` by the exodus migration, which runs on open.

| Legacy file | Now in |
|---|---|
| `.cleo/tasks.db`, `.cleo/brain.db`, `.cleo/conduit.db` | project `cleo.db` |
| `<cleoHome>/nexus.db`, `<cleoHome>/signaldock.db`, `<cleoHome>/skills.db`, `<cleoHome>/telemetry.db` | global `cleo.db` (NEXUS graph tables: project `cleo.db`) |
| `.cleo/signaldock.db` (project) | historical; folded into conduit before consolidation |

Rules:

- The live store is `.cleo/cleo.db`. A small `.cleo/tasks.db`, `tasks-*.db` snapshots under `.cleo/backups/sqlite/`, and an empty bare `tasks` table are normal decoys.
- `cleo doctor superseded-store` reports legacy store files still on disk under their old live names and proves which file holds the data by row counts. It is read-only.
- `cleo doctor exodus-health` reports per-scope migration state; `cleo doctor exodus-residue` finds legacy source files left after a cutover and `--fix` archives them (a move, never a delete).
- `cleo doctor nexus-residency` reports NEXUS tables stored in the wrong scope.

The inventory of these roles, with legacy paths, is `packages/contracts/src/db-inventory.json` (exported as `DB_INVENTORY`). Some of its global rows still name the legacy file paths.

---

## 6. Agent identity and messaging

Agent identity is global. It lives in `agent_registry_agents` and the other `agent_registry_*` tables in the global `cleo.db` (renamed from `signaldock_*`; header of `agent-registry-accessor.ts`). A project sees an agent only through a `conduit_project_agent_refs` row in its project store.

| Command | Effect |
|---|---|
| `cleo agent attach <id>` | Attach a global agent to the current project |
| `cleo agent detach <id>` | Detach it from the project; the global identity stays |
| `cleo agent list` | Agents attached to the current project |
| `cleo agent list --global` | Every global agent, attached or not |
| `cleo agent remove <id>` | Detach from the current project (default) |
| `cleo agent remove <id> --global` | Remove the global identity |

Agent-to-agent messaging is AgentMBX (D11176). The `conduit_*` tables are legacy messaging state, and SignalDock is retired.

### 6.1 Credential keys

Credential encryption keys derive from two machine-local files in `<cleoHome>`:

- `machine-key` — 32 bytes; every credential key derives from it (`packages/core/src/crypto/credentials.ts`).
- `global-salt` — 32 bytes, mode `0600` (`packages/core/src/store/global-salt.ts`).

Global credentials (agent API keys in `agent_registry_agents.api_key_encrypted`) use `HMAC-SHA256(machine-key ‖ global-salt, id)` as the encryption key, and the stored value is the encrypted real key (`packages/core/src/store/agent-api-key.ts`). Credentials move to another device through passphrase-sealed credential transfer (`packages/core/src/store/credential-transfer.ts`), never by copying `machine-key`. `cleo doctor credentials` reports keys that cannot be recovered.

---

## 7. JSON columns: TEXT, JSONB or a junction table

A JSON-bearing column is stored one of three ways, by how it is read:

| Class | Storage | When |
|---|---|---|
| TEXT | `text` column, `JSON.parse` on read | read whole, never queried in SQL (the default) |
| JSONB | `blob` through the `jsonb<T>()` custom type | queried, mutated or appended inside SQL |
| Junction | a two-column table | membership is filtered or joined in SQL |

In the schema today, JSONB holds `tasks_goal.goal_kind`, `tasks_goal.criteria`, `tasks_goal.last_verdict` (`schema/goal.ts`) and `brain_attention.tags` (`cleo-shared/brain.ts`). The junction tables are `tasks_task_labels` (task labels) and the sticky-note tag tables (`brain_sticky_tags`, plus its bare legacy twin `sticky_tags`, which `cleo doctor twin-collapse` keeps in step). Columns such as `tasks_tasks.notes_json`, `brain_page_nodes.metadata_json`, `brain_retrieval_log.entry_ids` and the attachment `related_tasks`/`topics`/`keywords` columns are TEXT.

The helper is `packages/core/src/store/schema/jsonb.ts`. Its rules hold for every JSONB column, because the binary encoding is opaque and not portable across SQLite versions:

- Read a whole value through `json(col)` (the `jsonbText` select helper), never by parsing the raw BLOB; the custom type's `fromDriver` throws on a raw BLOB.
- Query inside SQL with `jsonb_extract`, `json_each` or `jsonb_insert`.
- Every logical export or backup converts the value back with `json(col)`. `VACUUM INTO` copies bytes verbatim and is safe on the same engine.

---

## 8. Data integrity

### 8.1 What git may track

The project `cleo.db` and its `-wal`/`-shm` sidecars MUST NOT be committed to any git repository: git overwriting a live SQLite file while its WAL sidecars stay behind loses data (ADR-013 §9). The same holds for `.cleo/config.json` and `.cleo/project-info.json`.

`.cleo/.gitignore` (template: `packages/core/templates/cleo-gitignore`) ignores everything in `.cleo/`, allows a short list back in, and then denies `*.db`, `*.db-shm`, `*.db-wal` and `*.db-journal` again as a safety net. The allowed files include:

- `.cleo/project.json` — `{schemaVersion, id, name}`; the id is written once and never changed (ADR-096).
- `.cleo/project-id` — the legacy id-only mirror (ADR-094).
- `.cleo/project-context.json`, `.cleo/owner-settings.json`, `adrs/**`, `agent-outputs/**`.

Commit both identity files; never edit or regenerate an id. `cleo doctor project-identity` checks them.

### 8.2 Checkpoint repository

CLEO keeps an isolated git repository for checkpoints at `.cleo/checkpoint.git` (`CHECKPOINT_GIT_DIRNAME`, `packages/core/src/store/checkpoint-git-dir.ts`). It is deliberately not named `.git`, because git refuses to index an untracked nested repository with no commits, which broke `git add -A` in fresh projects.

- Every checkpoint command runs with `GIT_DIR=<cleoDir>/checkpoint.git` and `GIT_WORK_TREE=<cleoDir>` (`makeCleoGitEnv`, `packages/core/src/store/git-checkpoint.ts`); it never uses the project's `.git` index.
- Checkpoints track only human-editable JSON and doc directories: `config.json`, `project-info.json`, `project-context.json`, `adrs/`, `agent-outputs/` (`STATE_FILES`), plus entries in `config.json` `checkpoint.stateFileAllowlist`. No `.db` file is ever a checkpoint state file.
- `isCleoGitInitialized()` checks for `checkpoint.git/HEAD`.
- `cleo doctor` reports check `cleo_git_repo` with status `warning` when that `HEAD` is missing (`packages/core/src/system/health.ts`).

### 8.3 Snapshots and backups

SQLite stores are backed up with `VACUUM INTO`, which writes a WAL-free copy (`packages/core/src/store/sqlite-backup.ts`):

- Project-tier snapshots go to `.cleo/backups/sqlite/`, global-tier snapshots to `<cleoHome>/backups/sqlite/`.
- Snapshot names match `<prefix>-YYYYMMDD-HHmmss.db`.
- Project-tier retention is time-spread: the latest, quarter-hourly, hourly and daily slots are kept (`selectSnapshotsToKeep`, `packages/core/src/store/snapshot-gate.ts`). Global-tier snapshots keep the newest 10.
- Snapshot failures never interrupt the operation. Before a destructive step, the data-safety layer takes a `mode: 'required'` snapshot and waits for it to finish; a failure is logged at error level, not thrown.
- The data-safety layer (`packages/core/src/store/data-safety-central.ts`) calls `vacuumIntoBackup` alongside `gitCheckpoint`. `cleo session end` runs `vacuumIntoBackupAll` (`packages/core/src/sessions/session-end-snapshot.ts`).

Commands:

| Command | Effect |
|---|---|
| `cleo backup add` | Back up all CLEO data files |
| `cleo backup list` | List available backups |
| `cleo backup verify` | Report freshness and integrity of each snapshot |
| `cleo backup export` / `import` | Portable `.cleobundle.tar.gz` (scopes `project`, `global`, `all`, `machine`) |
| `cleo restore backup --id <backupId>` or `--snapshot <file>` | Restore the project store after verifying the snapshot; live writers refuse it and the replaced store is kept as a pre-restore backup |
| `cleo doctor repair-store` | Repair a damaged `cleo.db` losslessly, keeping the originals and a recovery receipt |
| `cleo doctor fk-check` | `PRAGMA foreign_key_check` on both stores (read-only) |

---

## 9. Schema authority

The current shape of the stores is defined by:

1. The scope schema modules: `packages/core/src/store/schema/cleo-project/`, `cleo-global/` and `cleo-shared/`.
2. The latest effective migration state of every lineage in §2.1. A historical migration file may contain superseded intermediate constraints; never read one alone as the current schema.
3. `packages/contracts/src/status-registry.ts` for status enums (ADR-018). Do not duplicate status constants in schema files.
4. `LIFECYCLE_STAGE_NAMES` in `packages/core/src/store/schema/lifecycle.ts` for lifecycle stage names.

`packages/core/src/store/tasks-schema.ts` is a barrel over the per-domain modules directly under `packages/core/src/store/schema/` (for example `goal.ts`, `memory-schema.ts`, `nexus-schema.ts`), which the legacy lineages and some accessors still use.

### 9.1 Contributor checklist

1. Change the table in the scope module that owns it (§3).
2. Add a migration under the matching scope folder (`drizzle-cleo-project/` or `drizzle-cleo-global/`). Never edit or delete a migration that has been released (arch gate 36).
3. Run the schema parity tests that cover the change, for example `packages/core/src/store/__tests__/lifecycle-schema-parity.test.ts` and `consolidated-schema-parity-fk.test.ts`, one file at a time through `cleo run --wait --class test -- …`.
4. Run `pnpm biome check --write .` and the build.
5. Run `cleo check arch`: gates 3 (DB open guard), 21 (dual-scope unqualified reads), 28 (raw table writes), 36 (change-journal schema rules) and 37 (row-identity coverage) all apply to store changes.
6. Commit schema, migration and tests together.

---

## Related ADRs

- [ADR-013 — Data integrity checkpoint architecture](../adr/adr-013-data-integrity-checkpoint-architecture.md)
- [ADR-008 — CLEO canonical architecture](../adr/adr-008-cleo-canonical-architecture.md)
- [ADR-068 — CLEO database charter](../adr/adr-068-cleo-database-charter.md) (superseded; historical 12-database charter)
- [ADR-037 — Conduit/SignalDock separation](../adr/adr-037-conduit-signaldock-separation.md) (superseded)
- [ADR-012 — Drizzle Kit migration system](../adr/adr-012-drizzle-kit-migration-system.md) (superseded)
- [ADR-006 — Canonical SQLite storage](../adr/adr-006-canonical-sqlite-storage.md) (superseded)
- ADR-090 — NEXUS graph residency split: `cleo docs fetch adr-090-nexus-graph-residency-split`
- ADR-094 / ADR-096 — tracked project identity
