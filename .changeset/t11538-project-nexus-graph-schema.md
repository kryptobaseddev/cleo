---
id: t11538-project-nexus-graph-schema
tasks: [T11538]
kind: feat
summary: Define the PROJECT-scope nexus code-graph schema (nexus_nodes/relations/contracts/code_index, project_id dropped) — nexus residency move step 1 (ADR-090)
---

Adds `packages/core/src/store/schema/cleo-project/nexus-graph.ts` defining the four per-project code/knowledge-graph tables (`nexus_nodes`, `nexus_relations`, `nexus_contracts`, `nexus_code_index`) in the consolidated PROJECT-scope `cleo.db` target shape, and exports the module from the project-scope schema barrel. Per ADR-090 §2.1 the redundant `project_id` column is DROPPED from all four tables (scope is implicit in which project's `.cleo/cleo.db` is open), and every `project_id`-leading index is dropped or collapsed onto its already-present non-leading sibling. All other columns, intra-graph soft FKs, E10 enums (`NEXUS_NODE_KINDS`/`NEXUS_RELATION_TYPES`/`NEXUS_CONTRACT_TYPES`/`CODE_INDEX_KINDS`), and typed booleans are preserved byte-for-byte from the GLOBAL source (`cleo-global/nexus.ts`). This is purely additive STEP 1 of the residency move — it does not remove the global copies, move data, or rewire the live accessor (T11539), nor partition `nexus_relation_weights` (T11545). The Hebbian plasticity columns stay inline on `nexus_relations` until T11545.
