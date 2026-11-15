# Architecture Decision Records

Generated from the CLEO docs store (T14108, 2026-11-14): one row per ADR mirror in this folder. Do not edit by hand. The store is the source of truth (`cleo docs fetch <slug>`); T14543 replaces this page with the generated docs index.

| ADR | Title | Superseded by |
|---|---|---|
| [ADR-003](adr-003-mcp-engine-unification.md) | MCP Engine Unification | [adr-086-cli-output-contract-e9](adr-086-cli-output-contract-e9.md) |
| [ADR-004](adr-004-typescript-first-architecture.md) | TypeScript-First Architecture |  |
| [ADR-005](adr-005-migration-safety.md) | Migration Safety Architecture |  |
| [ADR-006](adr-006-canonical-sqlite-storage.md) | Canonical SQLite Storage Architecture | `adr-090-nexus-graph-residency-split` |
| [ADR-007](adr-007-domain-consolidation.md) | CLEO Domain Architecture — 10-Domain Shared-Core Model | [adr-058-dispatch-type-inference](adr-058-dispatch-type-inference.md) |
| [ADR-008](adr-008-cleo-canonical-architecture.md) | CLEO Canonical Architecture — Shared-Core with CQRS Dispatch |  |
| [ADR-009](adr-009-brain-cognitive-architecture.md) | CLEO BRAIN Cognitive Architecture — Unified Reference | `adr-093-portable-memory-system-of-record` |
| [ADR-010](adr-010-node-sqlite-engine-choice.md) | SQL Engine & ORM Layer Selection |  |
| [ADR-011](adr-011-project-configuration-architecture.md) | Project Configuration Architecture |  |
| [ADR-012](adr-012-drizzle-kit-migration-system.md) | Drizzle-Kit Migration System for DDL Management | [adr-054-migration-system-hybrid-path-a-plus](adr-054-migration-system-hybrid-path-a-plus.md) |
| [ADR-013](adr-013-data-integrity-checkpoint-architecture.md) | Data Integrity & Checkpoint Architecture |  |
| [ADR-014](adr-014-rcasd-rename-and-protocol-validation.md) | RCASD Rename and Protocol Output Validation Architecture |  |
| [ADR-015](adr-015-multi-contributor-architecture.md) | Multi-Contributor .cleo/ Architecture |  |
| [ADR-016](adr-016-installation-channels-and-dev-runtime-isolation.md) | Installation Channels and Dev Runtime Isolation |  |
| [ADR-017](adr-017-verb-and-naming-standards.md) | Verb and Naming Standards |  |
| [ADR-018](adr-018-unified-status-registry.md) | Unified Status Registry |  |
| [ADR-019](adr-019-canonical-logging-architecture.md) | Canonical Logging Architecture | [adr-024-multi-store-canonical-logging](adr-024-multi-store-canonical-logging.md) |
| [ADR-020](adr-020-session-architecture-cleanup.md) | Session Architecture Cleanup — Drizzle-First, Zero Legacy |  |
| [ADR-021](adr-021-memory-domain-refactor.md) | Memory Domain Refactor — Cognitive-Only Cutover |  |
| [ADR-022](adr-022-task-completion-hardening.md) | Task Completion Hardening and Canonical Done Semantics | [adr-051-programmatic-gate-integrity](adr-051-programmatic-gate-integrity.md) |
| [ADR-023](adr-023-protocol-validation-dispatch.md) | Protocol Validation Dispatch Architecture |  |
| [ADR-024](adr-024-multi-store-canonical-logging.md) | Multi-Store Canonical Logging Architecture |  |
| [ADR-025](adr-025-warp-protocol-chains.md) | Warp Protocol Chains | `T11764` |
| [ADR-026](adr-026-release-system-consolidation.md) | Release System Consolidation | [adr-065-pr-required-release-flow](adr-065-pr-required-release-flow.md) |
| [ADR-027](adr-027-manifest-sqlite-migration.md) | Manifest SQLite Migration |  |
| [ADR-028](adr-028-changelog-generation-model.md) | CHANGELOG Generation Model — Task-Anchored Changesets DSL |  |
| [ADR-029](adr-029-contributor-project-dev-channel-detection.md) | Contributor Project Dev Channel Detection |  |
| [ADR-030](adr-030-operation-model-rationalization.md) | Operation Model Rationalization (268→164) |  |
| [ADR-031](adr-031-provider-adapter-architecture.md) | Provider Adapter Architecture |  |
| [ADR-032](adr-032-provider-agnostic-memory-bridge.md) | Provider-Agnostic Memory Bridge |  |
| [ADR-035](adr-035-pi-v2-v3-harness.md) | Pi v2+v3 — Native Operations and Exclusive Orchestration | `adr-098-retire-the-pi-cleoos-harness` |
| [ADR-036](adr-036-cleoos-database-topology.md) | CleoOS Database Topology + Lifecycle | `adr-090-nexus-graph-residency-split` |
| [ADR-037](adr-037-conduit-signaldock-separation.md) | Conduit + Signaldock Separation | `adr-090-nexus-graph-residency-split` |
| [ADR-038](adr-038-backup-portability.md) | Cross-Machine Backup Portability |  |
| [ADR-039](adr-039-lafs-envelope-unification.md) | LAFS Envelope Unification (CLI Canonical Shape) |  |
| [ADR-041](adr-041-worktree-handle-spawn-contract.md) | — WorktreeHandle as SpawnOptions Contract |  |
| [ADR-042](adr-042-cli-system-integrity-conduit-alignment.md) | CLI System Integrity — Conduit Domain Disposition and Registry Alignment | `T964` |
| [ADR-043](adr-043-native-citty-command-migration.md) | — Native Citty Command Architecture for Shim Removal |  |
| [ADR-044](adr-044-canon-reconciliation.md) | — Canon Reconciliation: 6 Systems, 11 Domains, Moving Op Count, SSoT Hierarchy | `T565` |
| [ADR-045](adr-045-cleo-scaffolding-ssot.md) | T310/T311 orphan files |  |
| [ADR-046](adr-046-stdp-phase-5-implementation.md) | -stdp-phase-5-implementation |  |
| [ADR-047](adr-047-autonomous-gc-and-disk-safety.md) | -autonomous-gc-and-disk-safety |  |
| [ADR-048](adr-048-memory-extraction-pipeline.md) | -memory-extraction-pipeline |  |
| [ADR-049](adr-049-harness-sovereignty.md) | — Harness Sovereignty: CLEO-Owned Memory + Per-Provider Agent Folder Abstraction | `adr-098-retire-the-pi-cleoos-harness` |
| [ADR-050](adr-050-cleoos-sovereign-harness.md) | — CleoOS Sovereign Harness: Distribution Binding Charter | `adr-098-retire-the-pi-cleoos-harness` |
| [ADR-051](adr-051-override-patterns.md) | Override Patterns — When and How to Use CLEO_OWNER_OVERRIDE |  |
| [ADR-051](adr-051-programmatic-gate-integrity.md) | — Programmatic Gate Integrity: Evidence-Based Verify + Removal of Silent Bypass |  |
| [ADR-051](adr-051-worktree-extension.md) | — Worktree Extension: Evidence Validation in Git Worktree Contexts |  |
| [ADR-052](adr-052-caamp-keeps-commander.md) | — caamp Retains commander: Monorepo CLI Framework Divergence Accepted |  |
| [ADR-052](adr-052-sdk-consolidation.md) | SDK Consolidation — Vercel AI SDK as the LLM Bridge |  |
| [ADR-053](adr-053-playbook-runtime.md) | Playbook Runtime as a Deterministic State Machine |  |
| [ADR-053](adr-053-project-agnostic-release-pipeline.md) | Project-Agnostic Release Pipeline (T820) |  |
| [ADR-054](adr-054-manifest-unification.md) | Manifest/RCASD Architecture Unification |  |
| [ADR-054](adr-054-migration-system-hybrid-path-a-plus.md) | Migration System — Hybrid Path A+ |  |
| [ADR-055](adr-055-agents-architecture-and-meta-agents.md) | Agents Architecture + Meta-Agents |  |
| [ADR-056](adr-056-db-ssot-and-release-completion-invariant.md) | DB SSoT, naming convention, and the release-completion invariant (archiveReason enum + post-release gate) |  |
| [ADR-057](adr-057-contracts-core-ssot.md) | Contracts/Core SSoT layering — uniform `(projectRoot, params)` Core API and OpsFromCore-inferred dispatch |  |
| [ADR-058](adr-058-dispatch-type-inference.md) | Dispatch Type Inference via `OpsFromCore<C>` — Pattern, Migration Recipe, and Escape Hatches |  |
| [ADR-059](adr-059-override-pumps.md) | — Override Governance Pumps |  |
| [ADR-061](adr-061-project-agnostic-verify-tools.md) | Project-Agnostic Evidence Tools + Cross-Process Result Cache |  |
| [ADR-062](adr-062-worktree-merge-not-cherry-pick.md) | Worktree integration uses `git merge --no-ff` (not cherry-pick) |  |
| [ADR-063](adr-063-release-pipeline.md) | Canonical Release Pipeline | [adr-065-pr-required-release-flow](adr-065-pr-required-release-flow.md) |
| [ADR-064](adr-064-caamp-adapters-boundary.md) | CAAMP↔Adapters Ownership Boundary |  |
| [ADR-065](adr-065-pr-required-release-flow.md) | PR-Required Release Flow |  |
| [ADR-066](adr-066-task-taxonomy-consolidation.md) | Task Taxonomy Consolidation — `--kind` Canonical, AC-Everywhere, System-Wide Severity Attestation |  |
| [ADR-067](adr-067-project-root-resolution.md) | Project Root Resolution — Refuse-with-Error, `project-info.json` Marker, and Worktree Env→ALS Bridge |  |
| [ADR-068](adr-068-amendment-3-1-worktree-cli-routing.md) | Amendment §3.1 — Worktree-Aware CLI Routing for SSoT Writes |  |
| [ADR-068](adr-068-canonical-agent-system.md) | Canonical Agent System — Single Layout, Auto-Install, Symmetric Playbook Tiers, and Universal-Tier Pre-Flight |  |
| [ADR-068](adr-068-cleo-database-charter.md) | CLEO Database Charter (12 DBs · ownership · lifecycle · concurrency) | `adr-090-nexus-graph-residency-split` |
| [ADR-068](ADR-068-per-worktree-handoff.md) | Per-Worktree Handoff Schema | `D11210` |
| [ADR-069](adr-069-cleo-coordination-layers.md) | CLEO Coordination Layers — Workflow / Messaging / Storage / Data | `D11176` |
| [ADR-070](adr-070-three-tier-orchestration.md) | Three-tier orchestration: Orchestrator -> Lead -> Worker |  |
| [ADR-070](adr-070-verifier-backed-ac-auditor-loop.md) | — Verifier-Backed Acceptance Criteria and the Auditor Loop |  |
| [ADR-071](adr-071-cleo-observability-event-bus.md) | CLEO Observability — Vendor-Agnostic Agent Event Bus |  |
| [ADR-072](ADR-072-nexus-db-split.md) | Nexus DB Topology Split — nexus-registry.db + nexus-graph/<projectId>.db | `adr-090-nexus-graph-residency-split` |
| [ADR-072](adr-072-unified-llm-provider-architecture.md) | Unified LLM Provider Architecture — Three-Interface Stack |  |
| [ADR-073](adr-073-above-epic-naming.md) | Task Hierarchy Charter — Saga / Epic / Task / Subtask | [adr-088-pm-core-v2-workgraph-relations-completion-criteria](ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md) |
| [ADR-074](adr-074-skills-telemetry-pr-diff-transport.md) | Skills telemetry transport — scrubbed PR diff (no HTTPS endpoint) |  |
| [ADR-075](adr-075-skills-federation-trust-ladder.md) | Skills federation trust ladder + 120-pattern skills-guard rule set |  |
| [ADR-076](ADR-076-canonical-docs-ssot.md) | Canonical Docs SSoT |  |
| [ADR-077](ADR-077-worktreeinclude-canonical-location.md) | `.worktreeinclude` at repo root is the canonical worktree-include file (T9983) |  |
| [ADR-078](ADR-078-boundary-registry.md) | ADR — Boundary Registry as SSoT for Rust/TS layering |  |
| [ADR-078](adr-078-docs-provenance.md) | Docs SSoT as DB-Backed Provenance Graph with Supersession + Update-in-Place |  |
| [ADR-079](adr-079-docs-sdk-boundary-contract.md) | Docs SDK Boundary Contract |  |
| [ADR-080](adr-080-ac-stable-ids.md) | AC Stable IDs — Single Canonical UUID + Positional Alias |  |
| [ADR-081](adr-081-satisfies-binding.md) | Cross-task `satisfies:` Binding Grammar |  |
| [ADR-082](adr-082-core-tools-first-class.md) | Core Tools as First-Class (RESERVED) | `adr-098-retire-the-pi-cleoos-harness` |
| [ADR-083](adr-083-cleo-persona-and-hierarchy-reconciliation.md) | Cleo Persona, Three Roles, Four Scopes, Saga as TaskType — Final Reconciliation | `adr-098-retire-the-pi-cleoos-harness` |
| [ADR-084](adr-084-cleoos-sentient-harness.md) | CleoOS Sentient Harness — Cleo Persona Substrate | `adr-098-retire-the-pi-cleoos-harness` |
| [ADR-085](adr-085-cross-db-invariants.md) | Cross-DB Invariants Catalogue | `adr-090-nexus-graph-residency-split` |
| [ADR-086](adr-086-cli-output-contract-e9.md) | CLI Output Contract (E9 of Saga T9855) |  |
| [ADR-086](ADR-086-nested-nexus-disposition.md) | Nested `~/.local/share/cleo/nexus/` Disposition — BAN |  |
| [ADR-087](ADR-087-worktree-ffi-topology.md) | Worktree FFI Topology |  |
| [ADR-088](ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md) | ADR: PM-Core V2 WorkGraph, Relations, and Completion Criteria |  |
| [ADR-088](ADR-088-release-pipeline-coherence.md) | Release Pipeline Coherence |  |
| [ADR-089](ADR-089-cleo-daemon-native-dispatch.md) | Cleo Daemon — Native Autonomous Dispatch for Saga Lifecycles | [adr-097-goal-protocol-ocg-runtime](ADR-097-goal-protocol-ocg-runtime.md) |
| [ADR-097](ADR-097-goal-protocol-ocg-runtime.md) | CLEO owns the goal protocol; CLEO Goal is the goal runtime |  |