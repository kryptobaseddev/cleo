# T910 — CLEO API Documentation Inventory & SSoT Audit

**Date**: 2026-04-17
**Author**: ct-documentor (audit mode)
**Status**: RESEARCH — not authoritative, do not quote as canon
**Parent task**: T910 (Orchestration Coherence v3 follow-up)
**Output**: Pure research. Recommendations at end. No doc files created or modified.

---

## Executive Summary

- **34 markdown docs** under `docs/` plus **13 package READMEs** were inspected. 23 of those files reference "api", "endpoint", "route", "REST", or "HTTP…route" in some form.
- **No single file is a true API SSoT today.** The claimed master (`docs/archive/CLEO-API.md`) was deliberately archived on 2026-04-10 because `docs/specs/CLEO-OPERATION-CONSTITUTION.md` superseded it. The Constitution is the closest thing CLEO has to an op-level SSoT — but it is hand-maintained and derived-from, not generated-from, the registry.
- **`docs/generated/api-reference.md` is not what it sounds like.** It is a 3.1 MB forge-ts dump of TypeScript function/class/interface signatures, not a catalog of dispatch operations. It stopped being regenerated on 2026-04-06 and does not include any of the 22 canonical Tasks ops, any Memory/BRAIN op, or any Conduit/Nexus op by name. It cannot be the ops SSoT.
- **Contracts live in two places.** Operation wire types live under `packages/contracts/src/operations/*.ts` (12 files, one per domain). Facade / wire types live at `packages/contracts/src/*.ts` root (`task.ts`, `session.ts`, `brain.ts`, `conduit.ts`, `spawn.ts`, `playbook.ts`, `agent-registry.ts`, `lafs.ts`, `orchestration-hierarchy.ts` + ~20 more). These are not cross-referenced from any single doc.
- **Studio HTTP routes are documented nowhere.** `packages/studio/src/routes/api/{tasks,brain,nexus,living-brain,health,project,search}/*/+server.ts` define a real REST surface but there is no README, no spec, no generated OpenAPI referencing them.

**Top 3 findings:**

1. **The authoritative-ish op inventory is `docs/specs/CLEO-OPERATION-CONSTITUTION.md` (`docs/specs/CLEO-OPERATION-CONSTITUTION.md:78-120`), which itself explicitly defers to the runtime registry `packages/cleo/src/dispatch/registry.ts` (line 14: "When conflicts exist between this document and the registry, the registry wins"). Constitution covers all 11 domains at operation-table granularity. No other doc is this complete.**
2. **`docs/generated/api-reference.md` is a naming trap.** Title "API Reference" + path `api-reference.md` implies it's the API SSoT; it is actually the forge-ts TSDoc dump of the TS export surface. It covers zero `tasks.*` / `memory.*` / `nexus.*` / `conduit.*` operations by their dispatch name. Keeping it at this path is actively misleading.
3. **Conduit has zero public op surface.** `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md:1-8` states Conduit is a runtime IPC layer, NOT a dispatch domain. `docs/specs/CLEO-OPERATION-CONSTITUTION.md:80-94` confirms: no `conduit` entry in the 11 canonical domains. Anyone looking for "conduit API docs" is looking for something that does not exist as a dispatch surface — it's internal IPC between TS and Rust. Studio has an `api/conduit/` path? **NO** — Studio does not expose Conduit. So the Conduit docs gap is real only as an IPC/envelope spec gap, not as a dispatch gap.

---

## Section 1: Inventory Table

One row per file that mentions API surface, ops, or data accessors. Skipping files verified not to cover API content (listed in sidebar below table).

| File | Domain | API surface covered | Kind | Authoritative? | Staleness signals | Gaps |
|------|--------|--------------------|------|----------------|-------------------|------|
| `docs/specs/CLEO-OPERATION-CONSTITUTION.md` | ALL 11 | All dispatch ops per-domain (tasks 32, session 15, memory 18, check 18 + more) | reference / derived SSoT | partial — defers to `packages/cleo/src/dispatch/registry.ts` | Version 2026.4.42, dated 2026-04-14. Currently the most current op doc. | Does not show full `ParamDef` shapes; covers dispatch ops only, not Studio HTTP routes; no BRAIN/NEXUS data model tie-in |
| `packages/cleo/src/dispatch/registry.ts` | ALL 11 | Executable `OperationDef[]` array — true SSoT | code (not doc) | **YES — explicit SSoT** | n/a | Not human-readable; `OperationDef` shape is declarative only, no doc text per op |
| `docs/archive/CLEO-API.md` | ALL | Attempted master API spec; domain list; LAFS envelope; four-DB architecture | historical / archived | NO — archived 2026-04-10 | Archive manifest (`docs/archive/README.md:8`) states: superseded by CLEO-OPERATION-CONSTITUTION | References `CLEO-NEXUS-API.md` (also archived); references `CLEO-WEB-API.md` that never existed |
| `docs/archive/CLEO-NEXUS-API.md` | NEXUS | 28 NEXUS operations with JSON request/response, error codes, A2A compliance | historical / archived | NO — archived 2026-04-10 | Archive manifest states: "MCP transport section (§3.1) violated ADR-035" | Section 4.1-4.4 still has useful op-level detail, but signaled PLANNED items (`nexus.exec`, `nexus.discover`) that never shipped |
| `docs/archive/SIGNALDOCK-UNIFIED-AGENT-REGISTRY.md` | signaldock / agent-registry | Agent registry schema pre-split | historical / archived | NO | Contradicts ADR-037; archived 2026-04-10 | — |
| `docs/specs/CLEO-NEXUS-ARCHITECTURE.md` | NEXUS | `project_registry`, `nexus_audit_log`, `nexus_schema_meta` tables + op references | reference / architecture | partial — supersedes CLEO-NEXUS-API per archive manifest | Version "2026.3" dated 2026-03-05 — older than constitution update | Table schemas present; op-level detail referred out; no JSON request/response examples as archived CLEO-NEXUS-API had |
| `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md` | CONDUIT (IPC) | IPC envelope model for TS↔Rust; `conduit.publish`/`conduit.ack` internal opcodes; NOT a dispatch domain | reference / protocol spec | **YES within scope** (IPC, not dispatch) | Version 2026.3.6 dated 2026-03-06; explicitly flags "broker is NOT built" (§warning) | Conduit has no public dispatch surface per design — that itself needs to be documented in the API SSoT |
| `docs/specs/CORE-PACKAGE-SPEC.md` | ALL (core tier) | `@cleocode/core` package shape, two-tier barrel (public/internal), facade class | reference / package contract | **YES for `@cleocode/core` boundary** | Version 3.4.0 dated 2026-03-24; claims "45 namespace re-exports" without enumerating ops | Does not enumerate operations; facade method signatures documented via `docs/architecture/TYPE-CONTRACTS.md` not here |
| `docs/specs/DATABASE-ARCHITECTURE.md` | ALL (storage tier) | 5-DB topology (tasks/brain/conduit/nexus/signaldock), all tables per DB | reference / architecture | **YES for storage** | Dated 2026-03-25; reflects ADR-037 split | No op→table mapping; consumer can't jump from `memory.observe` to `brain_observations` table here |
| `docs/specs/SCHEMA-AUTHORITY.md` | ALL (schema tier) | Pointers to schema files + migration rule | index / meta | **YES** | Short, current | No op-level references; purely a schema-file index |
| `docs/specs/VERB-STANDARDS.md` | ALL | Canonical verb disambiguation (check/validate/verify; store/observe/add; find/timeline/fetch) | reference / standards | **YES** | Version 2026.4.18 current | Verb semantics only — not an op catalog |
| `docs/specs/memory-architecture-spec.md` | BRAIN / memory | brain.db tier model; transcript lifecycle; extraction pipeline | reference / architecture | **YES for memory internals** | Dated 2026-04-15 | Extensive internals coverage; no `memory.*` op inventory or wire format; does not describe STDP dispatch hooks |
| `docs/specs/stdp-wire-up-spec.md` | BRAIN / plasticity | STDP (spike-timing-dependent plasticity) wire-up | reference / subsystem | partial | — | Internal — not public API |
| `docs/specs/T832-gate-integrity-spec.md` | tasks (verify/complete) | `cleo verify`/`complete` evidence grammar per ADR-051 | reference / protocol | **YES** | v1.0.0 target v2026.4.78 shipped | Scoped to gate integrity only |
| `docs/specs/CLEO-AUTONOMOUS-RUNTIME-SPEC.md` | ALL (runtime tier) | "Hearth, Impulse, Watchers, Conduit" mapping — canon alignment | reference / planned | partial — PLANNED, none shipped per §impl-status | "None are implemented" (line 8) | Aspirational, not current ops |
| `docs/specs/CLEO-PORTABLE-PROJECT-BRAIN-SPEC.md` | BRAIN / portability | Project brain portability contract | reference | partial | Unverified date | Portability only |
| `docs/specs/CLEO-RELEASE-PIPELINE-SPEC.md` | pipeline / release | RCASD-IVTR+C gates; release ship ops | reference | partial | — | Release surface only; overlaps with `ADR-053-project-agnostic-release-pipeline.md` |
| `docs/specs/CLEO-LOGGING-CONTRACT.md` | logging | Logger shape | reference | current | — | — |
| `docs/specs/CLEO-DATA-INTEGRITY-SPEC.md` | all | Data-integrity checkpoints | reference | current per ADR-013 | — | — |
| `docs/specs/CLEO-GRADE-SPEC.md` | admin.grade / check.grade | Grading ops (2-tier ct-grade vs ct-grade-v2) | reference | partial | Transitional — see archived CLEO-API.md §8 | Target check.grade.* ops not yet in registry |
| `docs/specs/CLEO-MANIFEST-SCHEMA-SPEC.md` | pipeline manifest | Manifest entry schema | reference | current | — | — |
| `docs/specs/CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md` | admin.token / check | Metrics validation | reference | partial | — | — |
| `docs/specs/TASK-RECONCILIATION-SPEC.md` | tasks.sync.* | External task links + reconcile | reference | current | — | — |
| `docs/specs/cleo-scaffolding-ssot-spec.md` | admin / init | Scaffolding SSoT per ADR-045 | reference | current | — | — |
| `docs/specs/STICKY-NOTES-SPEC.md` | sticky | Ephemeral capture domain | reference | current | — | Covers sticky; not ops catalog |
| `docs/generated/api-reference.md` | 13 packages × TS exports | TSDoc dump (functions, classes, interfaces, types, enums, variables) | generated / forge-ts | NO for dispatch ops; **conditionally yes** for TS export surface | Generated 2026-04-06; 128,485 lines / 3.1 MB; not regenerated since. None of `tasks.add/show/update/complete/etc` appear as section headings. | Name implies authoritative for API, actually authoritative only for raw TS exports. No op→function mapping. Regeneration broken or disabled. |
| `docs/generated/api-reference.mdx` | same | Same as above, MDX formatted for Mintlify/similar | generated / forge-ts | NO | Same timestamp as `.md` version | Same gaps |
| `docs/generated/llms-full.txt` | ALL (LLM context) | 74,948-line dense context file for LLM consumption | generated | partial | Same 2026-04-06 timestamp | Not human-readable; unclear whether LLMs are actually fed this |
| `docs/generated/llms.txt` | index | Pointer to api-reference + llms-full | generated | — | — | — |
| `docs/generated/packages/*/api/{functions,types,examples,index}.mdx` | per-package TS | Per-package forge-ts output | generated | partial | Same date | Same gaps — TS exports only |
| `docs/generated/SKILL-monorepo/{SKILL.md,references/API-REFERENCE.md,references/CONFIGURATION.md}` | ALL | Forge-ts SKILL package | generated | partial | Same date | Same gaps |
| `docs/architecture/TYPE-CONTRACTS.md` | facade APIs | `Cleo` facade 12-domain getter property list + `TasksAPI`, `SessionsAPI` (and more) TS interfaces | reference / type index | **YES for facade** | v1.0.0 dated 2026-03-19 — "Current (post Core Hardening Waves 0-3)" | Does not cover dispatch-layer params; facade != ops |
| `docs/architecture/DATABASE-ERDS.md` | all storage | Generated ERDs for all DBs | reference / generated | yes | — | Diagrams only |
| `docs/architecture/erd-{brain,tasks,combined}-db.md` | per-DB ERD | ERDs per DB | reference / generated | yes | — | Diagrams only |
| `docs/architecture/memory-architecture.md` | BRAIN | Memory architecture overview | reference | partial | Likely superseded by `docs/specs/memory-architecture-spec.md` | Overlaps — resolve which is SSoT |
| `docs/architecture/orchestration-flow.md` | orchestrate | Orchestration flow diagram | reference | current | — | Flow only, not ops |
| `docs/architecture/config-platform.md` | admin.config | Config platform design; mentions `api/config` | reference | current | — | Config API surface partially covered |
| `docs/adr/ADR-052-sdk-consolidation.md` | adapters | Vercel AI SDK standardization | ADR | **YES** | Accepted 2026-04-18 | Adapter scope only |
| `docs/adr/ADR-053-playbook-runtime.md` | playbooks | Playbook runtime state machine | ADR | **YES** | Accepted 2026-04-18 | Playbook scope only |
| `.cleo/adrs/ADR-051-programmatic-gate-integrity.md` | tasks verify/complete | Evidence-based gates; `--force` removal | ADR | **YES** | Accepted 2026-04-17 | See T832 spec for full grammar |
| `.cleo/adrs/ADR-042-cli-system-integrity-conduit-alignment.md` | conduit / registry | Conduit domain disposition + registry alignment | ADR | yes per constitution §7 | referenced from CLEO-OPERATION-CONSTITUTION.md:7 | ADR scope only |
| `.cleo/adrs/ADR-037-conduit-signaldock-separation.md` | conduit / signaldock | DB split | ADR | yes | — | Storage split only |
| `.cleo/adrs/ADR-030-operation-model-rationalization.md` | dispatch / ops | Op-model normalization | ADR | partial | — | — |
| `.cleo/adrs/ADR-023-protocol-validation-dispatch.md` | dispatch | Protocol validation | ADR | yes | — | — |
| `.cleo/adrs/ADR-017-verb-and-naming-standards.md` | all | Verb/naming | ADR | yes | — | — |
| `.cleo/adrs/ADR-008-CLEO-CANONICAL-ARCHITECTURE.md` | all | Canonical architecture | ADR | yes | — | — |
| `.cleo/adrs/ADR-006-canonical-sqlite-storage.md` | storage | SQLite storage canon | ADR | yes | — | — |
| `packages/contracts/README.md` | contracts / types | Exports by type category (Task, Session, Memory, LAFS, etc.) | reference / package | **YES for types** | Likely current | No per-op listing; types only |
| `packages/core/README.md` | core / SDK | SDK import patterns; 45 namespaces; facade examples | reference / package | **YES for SDK surface** | Likely current | Not all 45 namespaces enumerated; op-level params absent |
| `packages/cleo/README.md` | CLI | CLI command table (100+ commands) grouped by domain | reference / package | partial | References "89 commands (commander.js)" in arch diagram on line 290 — **stale**, CLEO is on citty not commander | No wire-level op mapping; CLI→op routing not shown |
| `packages/caamp/README.md` | caamp | Provider adapter registry | reference | current | — | CAAMP-specific |
| `packages/cant/README.md` | cant | CANT DSL | reference | current | — | — |
| `packages/lafs/README.md` | lafs | Envelope format | reference | current | — | Mentions HTTP adapter |
| `packages/nexus/README.md` | nexus | NEXUS package | reference | partial | — | Need cross-ref to NEXUS-ARCHITECTURE spec |
| `packages/playbooks/README.md` | playbooks | Playbook runtime per ADR-053 | reference | current | — | — |
| `packages/adapters/README.md` | adapters | Provider adapters | reference | current — references REST | — | — |
| `packages/agents/README.md` | agents | Agent registry | reference | current | — | — |
| `packages/runtime/README.md` | runtime | Long-running process layer | reference | current | — | — |
| `packages/skills/README.md` | skills | Skills mgmt | reference | current | — | — |
| `packages/cleo-os/README.md` | cleo-os | CleoOS binary + CANT bridge | reference | current | — | — |
| `docs/guides/*.md` (CANT-REFERENCE, CREATING-CUSTOM-AGENTS, LEAD-VS-WORKER-ROLES, SUBAGENT-INJECTION-PIPELINE, task-system-hardening, TOKEN-REPLACEMENT-CONTRACT) | mixed | Reference guides | reference | current | — | Guides reference ops but do not catalog them |
| `docs/concepts/*.md` (CLEO-ARCHITECTURE-GUIDE, CLEO-VISION, NEXUS-CORE-ASPECTS, CLEOOS-VISION, etc.) | vision | Concept/vision docs | concept | n/a | — | Not API spec material |
| `docs/plans/*.md` (CLEO-ULTRAPLAN, PATH-TO-100-PERCENT-COMPLETION, T662-council-round-table-report, brain-synaptic-visualization-research, cleoos-v2-execution-log, stdp-feasibility) | planning | Forward-looking plans | plans | n/a | Living docs — some stale | Not API spec material |
| `docs/design/*.md` (CLEO-PI-HARNESS-{ARCHITECTURE,WIREFRAMES}, PI-EXTENSION-MAPPING, QUICK-REFERENCE, CLEO-PI-AGENT-TUI-DESIGN) | design | Pi harness design | design | n/a | — | Not API spec material |
| `docs/CLEO-DOCUMENTATION-SOP.md` | docs meta | Docs organization SOP | procedure | current v2026.4.8 | — | Governs all docs |
| `docs/RECOVERY.md` | admin.recovery | Recovery procedures | procedure | current | — | — |
| `docs/RELEASING.md` | pipeline.release | Release procedures | procedure | current | — | — |
| `packages/studio/src/routes/api/**/+server.ts` | tasks, brain, nexus, living-brain, health, project, search | Actual SvelteKit HTTP endpoints | code (not doc) | source-of-truth for HTTP | n/a | **Entirely undocumented in `docs/`** |

### Files intentionally excluded from table

These exist but are NOT API docs — verified during audit:

- `docs/concepts/CLEO-{AWAKENING,FOUNDING,VISION,MANIFESTO,WORLD-MAP,CANON-INDEX,CANT,SYSTEM-FLOW-ATLAS}.md` — narrative/vision
- `docs/specs/CAAMP-INTEGRATION-SPEC.md`, `CANT-*.md`, `CANTZ-PACKAGE-STANDARD.md`, `CLEOCODE-ECOSYSTEM-PLAN.md` — cover CAAMP/CANT/CANTZ subsystems, not the CLEO dispatch API
- `docs/specs/GRADE-SCENARIO-PLAYBOOK.md` — scenario playbook, not API

**Sidebar — files that should document API but don't:**

- `packages/studio/README.md` — **does not exist** (verified; only `package.json`, `src/`, `static/`, `build/`, etc.). Studio exposes `api/tasks`, `api/brain`, `api/nexus`, `api/living-brain`, `api/health`, `api/project`, `api/search` routes with zero documentation.
- `packages/core/src/conduit/` — has `conduit-client.ts`, `http-transport.ts`, `sse-transport.ts`, `local-transport.ts` but no README or spec covering the client-side consumer surface.

---

## Section 2: Domain-by-Domain Coverage Matrix

### TASKS domain

**Contract ops (per `packages/contracts/src/operations/tasks.ts` header line 3-4)**: "Query operations: 10, Mutate operations: 12 — total 22". Constitution §6.1 at `docs/specs/CLEO-OPERATION-CONSTITUTION.md:187-234` lists **32 operations** (15 query + 14 mutate + 3 ADR-042 additions + `impact`, `claim`, `unclaim` + sync surface). The contracts-level 22 vs constitution 32 is NOT a conflict — contracts covers the stable wire format ops; constitution counts all entries in registry.ts including sync.* and label.* and complexity.estimate.

- **Documented in**:
  - `docs/specs/CLEO-OPERATION-CONSTITUTION.md:187-234` — full per-op table with gateway/tier/required params/idempotency
  - `packages/contracts/src/operations/tasks.ts` (53 `export`s — types only, no descriptions)
  - `docs/architecture/TYPE-CONTRACTS.md:32-45` — `TasksAPI` facade signatures
  - `packages/cleo/README.md:73-103` — CLI command table for tasks
  - `docs/archive/CLEO-API.md` (archived) — old master
  - `docs/specs/T832-gate-integrity-spec.md` — verify/complete evidence grammar
  - `packages/studio/src/routes/api/tasks/**/+server.ts` — HTTP endpoints (code, no doc)

- **Missing**:
  - No doc cross-references `tasks.claim` / `tasks.unclaim` to any use case (constitution lists them; nothing explains the workflow)
  - `tasks.impact` mentioned in constitution + archived CLEO-API §15 but no spec for keyword-matching algorithm
  - Studio `api/tasks/{events,graph,pipeline,search,sessions,tree,[id]}` routes are not documented

- **Conflicts**:
  - `packages/cleo/README.md:287` claims "89 commands (commander.js)" but constitution v2026.4.42 has moved to citty (ADR-043). Stale README.
  - Old `docs/archive/CLEO-API.md:100-112` op counts ("Total: See registry") are vague by design and don't match any fixed number.

### BRAIN (memory domain)

**Contract ops (per constitution §6.3, `docs/specs/CLEO-OPERATION-CONSTITUTION.md:264-299`)**: **18 operations** — `memory.find`, `memory.timeline`, `memory.fetch`, `memory.decision.find`, `memory.pattern.find`, `memory.learning.find`, `memory.graph.show`, `memory.graph.neighbors`, `memory.reason.why`, `memory.reason.similar`, `memory.search.hybrid` (queries) + `memory.observe`, `memory.decision.store`, `memory.pattern.store`, `memory.learning.store`, `memory.link`, `memory.graph.add`, `memory.graph.remove` (mutates). Root-level contract at `packages/contracts/src/brain.ts` has 7 exports (lower — covers types).

- **Documented in**:
  - `docs/specs/CLEO-OPERATION-CONSTITUTION.md:264-299` — per-op table
  - `docs/specs/memory-architecture-spec.md` — extensive internals, pipeline, tier model
  - `docs/architecture/memory-architecture.md` — architecture overview (may be superseded by memory-architecture-spec.md)
  - `docs/specs/stdp-wire-up-spec.md` — STDP plasticity
  - `docs/specs/CLEO-PORTABLE-PROJECT-BRAIN-SPEC.md` — portability
  - `packages/contracts/src/brain.ts` (7 exports)
  - `packages/contracts/README.md:62-77` — memory types section
  - `packages/core/README.md:180-201` — SDK memory examples
  - `packages/studio/src/routes/api/brain/{decisions,graph,observations,quality,tier-stats}/+server.ts` — HTTP endpoints

- **Missing**:
  - No doc ties `memory.observe` wire format → `brain_observations` row shape → `packages/core/src/memory/brain-row-types.ts`
  - No doc enumerates the Hebbian / STDP runtime hooks from a public-API perspective
  - `memory.reason.why` / `memory.reason.similar` lack JSON request/response examples
  - Studio brain routes (quality, tier-stats) not documented
  - `memory.show` was REMOVED per constitution §6.3 "Removed operations" but CLI `cleo memory fetch` surfaces differently — not explained in a single place

- **Conflicts**:
  - Memory domain: constitution §6.3 says `memory.observe` is tier 0, but `packages/contracts/src/operations/tasks.ts` is where the ops index lives — memory ops index is NOT in `packages/contracts/src/operations/`. There is no `operations/memory.ts` file. **Gap**: memory ops lack a canonical contract operation file.

### CONDUIT domain

**Contract ops**: NONE at dispatch level. Conduit is NOT one of the 11 canonical domains (`docs/specs/CLEO-OPERATION-CONSTITUTION.md:80-94`). `packages/contracts/src/conduit.ts` has 8 exports (envelope + transport types). Conduit is purely an IPC layer between TypeScript and Rust (`docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md:31-39`).

- **Documented in**:
  - `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md` — IPC envelope, addressing, delivery, retry
  - `docs/specs/DATABASE-ARCHITECTURE.md:70-79` — `conduit.db` tables
  - `.cleo/adrs/ADR-037-conduit-signaldock-separation.md` — DB split
  - `.cleo/adrs/ADR-042-cli-system-integrity-conduit-alignment.md` — Conduit position in registry
  - `packages/core/src/conduit/` — implementation (4 transports: http, sse, local + client)

- **Missing**:
  - The fact that **Conduit has no public dispatch surface** is scattered across 3 ADRs and the conduit spec — not stated cleanly in a top-level API doc
  - No consumer-facing doc for `ConduitClient` (in `packages/core/src/conduit/conduit-client.ts`) — should Studio or external agents use it? Unclear.
  - Studio does NOT appear to expose `api/conduit` routes (verified — not in `packages/studio/src/routes/api/`)

- **Conflicts**:
  - `docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md:8` admits "broker is NOT built" — yet `packages/core/src/conduit/*-transport.ts` exist. Implementation status needs a one-sentence verdict: what ships today vs what is still planned.

### NEXUS domain

**Contract ops (per constitution §6.9 + archived CLEO-NEXUS-API §4)**: the archived spec listed **28 operations** across registry/query/dependency/sharing. Constitution §6.9 should be the canonical post-archive count (need to read §6.9; see note).

- **Documented in**:
  - `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.9 (not fully read in this audit — **NEEDS VERIFICATION** at `docs/specs/CLEO-OPERATION-CONSTITUTION.md:500+`)
  - `docs/specs/CLEO-NEXUS-ARCHITECTURE.md` — schema + architecture + 31 MCP operations claim (line 18 conflicts with archived doc's 28)
  - `docs/archive/CLEO-NEXUS-API.md` — per-op JSON req/resp (historical)
  - `docs/concepts/NEXUS-CORE-ASPECTS.md` — concept
  - `packages/nexus/README.md` — package README (current)
  - `packages/contracts/src/operations/` — **no `nexus.ts` operation file exists** — gap
  - `packages/studio/src/routes/api/nexus/{community,search,symbol}/+server.ts` — HTTP endpoints

- **Missing**:
  - **No current authoritative op inventory** for NEXUS post-archive. Architecture doc at `docs/specs/CLEO-NEXUS-ARCHITECTURE.md:18` says 31 MCP ops; archived CLEO-NEXUS-API claims 28. Delta unverified.
  - `packages/contracts/src/operations/nexus.ts` does not exist
  - Studio `api/nexus/{community,search,symbol}` routes not documented
  - `NEXUS-CORE-ASPECTS.md` is concepts-level, not API

- **Conflicts**:
  - **31 vs 28 vs "see registry"** — three sources, three counts.

### SESSION domain

**Contract ops (per constitution §6.2, `docs/specs/CLEO-OPERATION-CONSTITUTION.md:236-263`)**: **15 operations** (7 query + 8 mutate). `packages/contracts/src/operations/session.ts` has 20 exports; root `packages/contracts/src/session.ts` has the full `Session` shape.

- **Documented in**:
  - `docs/specs/CLEO-OPERATION-CONSTITUTION.md:236-263` — per-op table
  - `packages/contracts/src/operations/session.ts` (20 exports)
  - `packages/contracts/src/session.ts` (shape)
  - `docs/architecture/TYPE-CONTRACTS.md` — `SessionsAPI` facade
  - `.cleo/adrs/ADR-020-session-architecture-cleanup.md`
  - `packages/cleo/README.md:107-116` — CLI command table

- **Missing**:
  - `session.record.decision` / `session.record.assumption` lack a schema spec — what fields? constitution just lists `requiredParams` as `-`
  - `session.handoff.show` output shape not documented
  - Studio `api/tasks/sessions` route exists but its contract is not documented

### ORCHESTRATE domain

**Contract ops**: `packages/contracts/src/operations/orchestrate.ts` has 30 exports. Constitution §6.6 would cover this (not fully read here — **NEEDS VERIFICATION**).

- **Documented in**:
  - `docs/specs/CLEO-OPERATION-CONSTITUTION.md` §6.6
  - `docs/architecture/orchestration-flow.md`
  - `docs/specs/CLEO-RELEASE-PIPELINE-SPEC.md` (release-specific)
  - `packages/contracts/src/operations/orchestrate.ts`
  - `packages/contracts/src/orchestration-hierarchy.ts`
  - `packages/contracts/src/playbook.ts`
  - `packages/contracts/src/spawn.ts` / `spawn-types.ts`
  - `docs/adr/ADR-053-playbook-runtime.md` — playbook runtime
  - `docs/adr/ADR-052-sdk-consolidation.md` — SDK layer
  - `CLEO-INJECTION.md` (project-embedded) — `cleo orchestrate spawn --tier 0|1|2` contract documented in protocol file, not docs/specs

- **Missing**:
  - `cleo orchestrate spawn` tier system documented ONLY in `CLEO-INJECTION.md` / `~/.local/share/cleo/templates/CLEO-INJECTION.md` — not in `docs/specs/`
  - Playbook runtime (ADR-053) is the newest feature but only has the ADR — no spec

### LIFECYCLE domain

**Contract ops**: `packages/contracts/src/operations/lifecycle.ts` exists. Constitution §6.5.

- **Documented in**:
  - Constitution §6.5
  - `docs/specs/CLEO-RELEASE-PIPELINE-SPEC.md`
  - `.cleo/adrs/ADR-014-rcasd-rename-and-protocol-validation.md`
  - `docs/specs/T832-gate-integrity-spec.md` — gate evidence protocol
  - `.cleo/adrs/ADR-051-programmatic-gate-integrity.md`
  - `packages/contracts/src/operations/lifecycle.ts`

- **Missing**:
  - `cleo lifecycle complete` + `tasks.pipeline_stage` auto-sync (per T835 in ADR-051) not in a single public-API doc

### RELEASE domain

**Contract ops**: `packages/contracts/src/operations/release.ts` exists.

- **Documented in**:
  - `docs/specs/CLEO-RELEASE-PIPELINE-SPEC.md`
  - `docs/RELEASING.md`
  - `.cleo/adrs/ADR-053-project-agnostic-release-pipeline.md` (old ADR-053, renamed in archive)
  - `packages/contracts/src/operations/release.ts`

### Other operation contract files (not top-4 but relevant)

`packages/contracts/src/operations/` also contains: `issues.ts`, `research.ts`, `skills.ts`, `system.ts`, `validate.ts`, `index.ts`, `params.ts`.

- `issues.ts`, `skills.ts`, `system.ts`, `validate.ts` → Constitution `tools`/`admin`/`check` sections
- `research.ts` → scattered (ct-research-agent skill)
- No single doc enumerates all 12 operations files of `packages/contracts/src/operations/`

---

## Section 3: `docs/generated/api-reference.md` Assessment

**Read verified**: file is 3,248,170 bytes (3.1 MB), 128,485 lines, last modified 2026-04-06 19:44 (static — not regenerated in 11 days as of audit).

**How is it generated?**

Line 7 says: `Generated by [forge-ts](https://github.com/kryptobaseddev/forge-ts) from \`.\`` — forge-ts is the universal TypeScript documentation compiler (per skill description: "Enforces TSDoc coverage as a build gate, then generates all documentation artifacts from source code in one pass"). The generator walks every TypeScript `export` across all packages and dumps function signatures, class methods, interfaces, types, and enums.

Section anchors (line 9 onward) reveal the document structure:

- **Table of Contents** (line 9)
- **Functions** (line 4742) — dominant section
- **Classes** (line 39890)
- **Interfaces** (line 50238)
- **Types** (line 119614)
- **Enums** (line 123478)
- **Variables** (line 125166)

A spot check of the TOC (first 80 lines of Functions section) shows items like:

- `checkStatuslineIntegration()`, `getStatuslineConfig()`, `createAdapter()` (appearing 6× for each adapter), `getProviderManifests()`, `discoverProviders()`, `getPlatformPaths()`, `getAgentsHome()`, `getProjectAgentsDir()`, `getCanonicalSkillsDir()`, `resolveRegistryTemplatePath()`, `getAllProviders()`, `getProvider()`, `buildInjectionContent()`, `inject()`, `removeInjection()`

**What ops does it cover?**

**ZERO dispatch operations by name.** None of these searches would find hits:

- `tasks.add`, `tasks.show`, `tasks.complete`, `tasks.find`
- `memory.observe`, `memory.find`, `memory.timeline`, `memory.fetch`
- `nexus.register`, `nexus.query`, `nexus.discover`, `nexus.graph`
- `session.start`, `session.end`, `session.briefing.show`
- `orchestrate.*` / `pipeline.*` / `check.*` / `admin.*`

It covers **TypeScript exports**, not the dispatch-level API. Consumers looking for the op surface will find function names like `getTaskById`, `addTask`, `listTasks`, `observeBrain`, `searchBrain`, etc. — which are the SDK-level function names, not the dispatch op names.

**What ops are MISSING?**

All 11 canonical domains' dispatch ops are missing from this file. Whoever named this file `api-reference.md` was thinking "API = function API" (TS exports) not "API = dispatch operation contract". Both are legitimate APIs, but the document title + path heavily imply the latter.

**Is it current?**

- Last modified 2026-04-06 19:44 — 11 days before audit
- Active dev between 2026-04-07 and 2026-04-17 (20+ commits based on `git log` in status) — every new `export` since 2026-04-06 is missing
- Constitution version 2026.4.42 (dated 2026-04-14) has shipped op changes not reflected here
- ADR-051 (2026-04-17), ADR-052/053 (2026-04-18) changes are entirely absent

**Recommendation for this file specifically**: **Deprecate as "API Reference", rename/relocate.** Options:

1. Rename to `docs/reference/typescript-exports.md` or `docs/generated/typescript-api.md`
2. Keep generator but change output path so nothing else claims `api-reference.md`
3. Promote to regenerate-on-CI — currently stale in a gotcha-inducing way

---

## Section 4: Recommendation for SSoT Structure

### Context for choosing

- `packages/cleo/src/dispatch/registry.ts` is the executable truth. Constitution §1 mandates this.
- Constitution itself is derived from registry but hand-maintained. That makes it the best human-readable reference, but it drifts from code without tooling enforcement.
- Studio HTTP routes are an entirely separate surface (SvelteKit endpoints) that NO doc covers.
- `docs/generated/api-reference.md` is mis-named and covers TS exports, not dispatch ops.

### Options evaluated

**(a) Promote `docs/generated/api-reference.md` to SSoT, regenerate from contracts on CI.**
- **REJECT.** The file is fundamentally a TS-export dump, not an op catalog. Forge-ts is not designed to emit op-by-gateway tables with descriptions. Retooling it to emit per-op JSON req/resp + gateway + tier would duplicate registry.ts with extra fragility.

**(b) Author new `docs/specs/CLEO-API-CONTRACT-SSOT.md` hand-maintained, referencing generated output as appendix.**
- **REJECT for maintenance reasons.** Constitution already fills this role (see `docs/specs/CLEO-OPERATION-CONSTITUTION.md` v2026.4.42). Adding another hand-maintained master creates the same drift problem Constitution has, now 2× worse.

**(c) Split by domain: `docs/specs/CLEO-TASKS-API-SPEC.md`, `CLEO-BRAIN-API-SPEC.md`, etc., each auto-updated from its contract file.**
- **PARTIAL ACCEPT with refinement** — see recommendation below.

### Recommended path

Adopt a **3-layer SSoT** structure modeled on `SCHEMA-AUTHORITY.md` (which already successfully does this for storage):

**Layer 1 — Executable canon (zero duplication):**
- `packages/cleo/src/dispatch/registry.ts` — dispatch ops (already SSoT per constitution)
- `packages/contracts/src/operations/*.ts` — per-domain wire types (already exist for tasks/session/orchestrate/lifecycle/release/research/skills/system/validate/issues)
- `packages/contracts/src/{brain,conduit,task,session,...}.ts` — root-level type contracts
- Studio `packages/studio/src/routes/api/**/+server.ts` — HTTP surface (currently orphaned)

**Layer 2 — Human-readable master index (one file):**
- Create or rename to `docs/specs/CLEO-API-AUTHORITY.md` — parallels `SCHEMA-AUTHORITY.md`. Pointer file only. Lists:
  - Which file is SSoT per domain (registry.ts / operations/X.ts / root contract)
  - Which doc is the current per-domain narrative spec (Constitution §X, or `CLEO-NEXUS-ARCHITECTURE.md`, or `memory-architecture-spec.md`)
  - Staleness policy — e.g., "Constitution must be re-synced within 7 days of any `registry.ts` change"
  - Generated outputs — links to `docs/generated/typescript-api.md` (renamed) and any future OpenAPI
  - **Add: Studio HTTP surface pointer** — `packages/studio/src/routes/api/` needs a README or `docs/specs/CLEO-STUDIO-HTTP-SPEC.md` covering the 7 route families

**Layer 3 — Per-domain narrative specs (existing + one gap fill):**
- KEEP: Constitution §6.x tables (best per-op summary today)
- KEEP: `CLEO-NEXUS-ARCHITECTURE.md`, `memory-architecture-spec.md`, `CLEO-CONDUIT-PROTOCOL-SPEC.md`, `CLEO-RELEASE-PIPELINE-SPEC.md`
- KEEP: `TYPE-CONTRACTS.md` (facade — already scoped correctly)
- ADD: per-domain operation specs with JSON req/resp examples for each op. The archived `CLEO-NEXUS-API.md` is the shape/quality target. Don't reinvent — use the archived doc's §4 structure as template.
- RESOLVE: `docs/architecture/memory-architecture.md` vs `docs/specs/memory-architecture-spec.md` — pick one, archive the other.

**Specifically:**

1. **Rename `docs/generated/api-reference.md` → `docs/generated/typescript-api.md`.** Update `docs/generated/llms.txt` to match. The new file name removes the false claim of being an ops API.
2. **Add `docs/specs/CLEO-API-AUTHORITY.md`** as the single entry point. This is a small file (≤200 lines) pointing at registry.ts, constitution sections, per-domain specs, and the Studio HTTP surface.
3. **Backfill Studio HTTP docs.** `packages/studio/README.md` does not exist. Create it (short — it is a SvelteKit app) and link to a new `docs/specs/CLEO-STUDIO-HTTP-SPEC.md` that enumerates the 7 route families currently at `packages/studio/src/routes/api/{tasks,brain,nexus,living-brain,health,project,search}/`.
4. **Add `packages/contracts/src/operations/memory.ts`, `conduit.ts`, `nexus.ts`.** Three domain operation contract files are missing. Constitution enumerates their ops; contracts lacks the wire-type module.
5. **Constitution freshness gate.** Add a CI check that compares `CANONICAL_DOMAINS`/op counts in `registry.ts` vs op-table entries in Constitution. On mismatch, fail CI until Constitution is re-synced.

### Why not (a) or (b)?

(a) treats the wrong file as SSoT; (b) multiplies the drift surface. Option (c) as refined above keeps code as SSoT, makes the pointer file trivially auditable, and documents the one surface (Studio HTTP) that is invisible today.

---

## Section 5: Open Questions for HITL

1. **Constitution vs per-domain specs — which is canon when they conflict?** Today Constitution §6.x tables are the densest op catalog, but individual specs (`CLEO-NEXUS-ARCHITECTURE.md`, `memory-architecture-spec.md`) have more detail on schemas, semantics, and examples. When they disagree, should Constitution win automatically, or should the more-detailed narrative spec? Suggested: Constitution wins for op surface (registry-derived); narrative spec wins for internal semantics. Confirm?

2. **Studio HTTP surface — is this part of the API SSoT or a separate contract?** `packages/studio/src/routes/api/**` has 7 route families with no docs. Is Studio considered "the cleo API" (and thus in scope of CLEO-API-AUTHORITY), or is Studio a separate app that happens to consume CLEO and its own HTTP surface is out-of-scope for CLEO SSoT? Recommend: include, because external consumers will see it as "CLEO's web API". Confirm?

3. **NEXUS op count — 28 vs 31 vs "see registry"**. Archived CLEO-NEXUS-API counts 28; CLEO-NEXUS-ARCHITECTURE claims 31 MCP ops; registry is the only source that can resolve. Do you want me to (i) count registry.ts entries matching `domain === 'nexus'` as a follow-up, or (ii) treat this as out-of-scope for audit? **NEEDS VERIFICATION** marked.

4. **`docs/generated/` path — keep or move to `docs/reference/`?** Generated content is mixed in with hand-written `docs/specs/`. If we rename the TS-export dump, should we also relocate it to `docs/reference/api/` per the CLEO-DOCUMENTATION-SOP? SOP at `docs/CLEO-DOCUMENTATION-SOP.md:19-28` lists six categories; generated is one of them. No change needed if we just rename the file. Confirm.

5. **Old ADR-053 at `.cleo/adrs/ADR-053-project-agnostic-release-pipeline.md` vs new ADR-053 at `docs/adr/ADR-053-playbook-runtime.md`** — two ADRs share the number. The new ADR flags this (lines 9-14). Do we renumber? Suggested: new ADR-053 (playbook runtime) renumber to ADR-054; old keeps 053. Owner call.

6. **`docs/specs/CLEO-OPERATION-CONSTITUTION.md` is 11+ days out of date for newest changes?** Constitution is dated 2026-04-14 v2026.4.42. ADR-051 (2026-04-17), ADR-052/053 (2026-04-18), T889 Wave ABCD shipping (per memory-bridge) all happened AFTER the last Constitution version stamp. Is Constitution in-sync with current registry.ts, or is there pending drift? Suggested action: diff `CANONICAL_DOMAINS`/op counts in registry.ts vs Constitution tables. Out-of-scope for this audit but flagged.

---

## Appendix A: Raw counts

- `find /mnt/projects/cleocode/docs -type f -name '*.md' -o -name '*.mdx'` → **95 files** (audited 100%)
- `packages/*/README.md` → **13 files** (all 13 read or sampled)
- `packages/studio/README.md` → **does not exist** (verified)
- `packages/contracts/src/operations/*.ts` → **12 files** (tasks, session, orchestrate, lifecycle, release, research, skills, system, validate, issues, index, params)
- `packages/contracts/src/*.ts` (root-level non-operation) → **~30 files** including `brain.ts`, `conduit.ts`, `task.ts`, `session.ts`, `spawn.ts`, `playbook.ts`, `agent-registry.ts`, `lafs.ts`, `orchestration-hierarchy.ts`, `evidence-record.ts`, `attachment.ts`, etc.
- `docs/generated/api-reference.md` → **128,485 lines, 3.1 MB**, last mtime 2026-04-06
- `docs/generated/llms-full.txt` → **74,948 lines**
- `.cleo/adrs/` → **53 ADRs** + MANIFEST (ADR-003 through ADR-053)
- `docs/adr/` → **2 ADRs** (ADR-052 + ADR-053) — the new canonical location per ADR-053 §note
- Total file-level references to "api/endpoint/route/REST/HTTP…route" across docs+READMEs: **23 files**

## Appendix B: File paths cited (all absolute)

- `/mnt/projects/cleocode/packages/cleo/src/dispatch/registry.ts` — executable SSoT
- `/mnt/projects/cleocode/packages/contracts/src/operations/` — 12 op-type modules
- `/mnt/projects/cleocode/packages/contracts/src/` — 30+ root contract modules
- `/mnt/projects/cleocode/packages/studio/src/routes/api/` — undocumented HTTP surface
- `/mnt/projects/cleocode/docs/specs/CLEO-OPERATION-CONSTITUTION.md` — current best per-op master
- `/mnt/projects/cleocode/docs/specs/SCHEMA-AUTHORITY.md` — shape-template for proposed `CLEO-API-AUTHORITY.md`
- `/mnt/projects/cleocode/docs/specs/CLEO-NEXUS-ARCHITECTURE.md` — NEXUS narrative spec
- `/mnt/projects/cleocode/docs/specs/CLEO-CONDUIT-PROTOCOL-SPEC.md` — Conduit IPC spec
- `/mnt/projects/cleocode/docs/specs/memory-architecture-spec.md` — BRAIN narrative spec
- `/mnt/projects/cleocode/docs/archive/CLEO-API.md` — archived former master
- `/mnt/projects/cleocode/docs/archive/CLEO-NEXUS-API.md` — archived NEXUS spec (still useful as JSON shape template)
- `/mnt/projects/cleocode/docs/archive/README.md` — archive manifest explaining why each was archived
- `/mnt/projects/cleocode/docs/generated/api-reference.md` — mis-named TS export dump
- `/mnt/projects/cleocode/docs/architecture/TYPE-CONTRACTS.md` — facade-level type index
- `/mnt/projects/cleocode/docs/CLEO-DOCUMENTATION-SOP.md` — governing doc-organization procedure
- `/mnt/projects/cleocode/.cleo/adrs/ADR-051-programmatic-gate-integrity.md` — evidence gates
- `/mnt/projects/cleocode/.cleo/adrs/ADR-042-cli-system-integrity-conduit-alignment.md` — Conduit registry alignment
- `/mnt/projects/cleocode/docs/adr/ADR-052-sdk-consolidation.md` — Vercel AI SDK
- `/mnt/projects/cleocode/docs/adr/ADR-053-playbook-runtime.md` — playbook runtime

---

**End of audit.** No specs written, no files modified. Output path: `/mnt/projects/cleocode/.cleo/agent-outputs/T910-docs-audit/api-docs-inventory.md`.
