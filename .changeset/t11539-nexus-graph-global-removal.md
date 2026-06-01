---
id: t11539-nexus-graph-global-removal
tasks: [T11539]
prs: [917]
kind: feat
summary: Remove the four nexus code-graph tables from GLOBAL scope (10 → 6) and route them to PROJECT scope in exodus — nexus residency move step 2 (ADR-090)
---

Removes `nexus_nodes`, `nexus_relations`, `nexus_contracts`, and `nexus_code_index` (plus their in-module enum const arrays `NEXUS_NODE_KINDS`/`NEXUS_RELATION_TYPES`/`NEXUS_CONTRACT_TYPES`/`CODE_INDEX_KINDS` and the eight row-type exports) from `packages/core/src/store/schema/cleo-global/nexus.ts`, dropping the nexus GLOBAL table count from 10 to 6. The six registry/identity tables (`nexus_project_registry`, `nexus_project_id_aliases`, `nexus_audit_log`, `nexus_schema_meta`, `nexus_user_profile`, `nexus_sigils`) stay GLOBAL per ADR-090 Category B. No external module imported the removed symbols — the live runtime uses `schema/nexus-schema.ts` (untouched).

The exodus `table-name-map.ts` gains `NEXUS_GRAPH_PROJECT_TABLES` + `resolveTableTargetScope()` — the single SSoT consumed by BOTH the migrate runner (`migrate.ts`, insert target) and the verifier (`verify-migration.ts`, verify target) so they never disagree — routing the four graph tables, still extracted from the legacy GLOBAL `nexus.db` source, into the PROJECT consolidated `cleo.db`. `copyTableFromAttached()` + `detectIsoGlobColumns()` gained a `targetSchema` parameter (default `main`); the global `migrateScope` pass cross-attaches the project DB and schema-qualifies the INSERT + introspection for those four tables. WAL-safe (the project pass already committed; the project handle is idle).

This is step 2 of the residency move (T11538 #913 authored the project-scope schema). The live runtime is unaffected — graph tables are still created in the global `cleo.db` by the legacy `drizzle-nexus` migrations, and `getNexusDb` → `openDualScopeDb('global')` + the ADR-036 assert are untouched. The Studio `scope=all` fan-out is deferred to T11570 (depends on the larger E6 runtime cutover, not just this schema+exodus change). The Hebbian plasticity partition `nexus_relation_weights` (T11545) must land WITH the move.
