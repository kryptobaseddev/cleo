# ADR Cross-Store Identity Map (T11191 deliverable)

**Generated:** 2026-06-04 · read-only sha256+title extraction across `.cleo/adrs/` + `docs/adr/`.
**Policy context:** ratified SLUG-PRIMARY (saga T11778); numbers are display aliases. This map is the prerequisite for reconcile/dedup (T11676) and any republish.

## Divergent + duplicate numbers (MUST reconcile)

| ADR# | store | sha256 | slug | title |
|---|---|---|---|---|
| 051 | .cleo/adrs | `cca796c26e33` | ADR-051-override-patterns.md | ADR-051: Override Patterns — When and How to Use CLEO_OWNER_OVERRIDE |
| 051 | .cleo/adrs | `88fef39a8044` | ADR-051-programmatic-gate-integrity.md | ADR-051 — Programmatic Gate Integrity: Evidence-Based Verify + Removal o |
| 051 | .cleo/adrs | `6a63832cd896` | ADR-051-worktree-extension.md | ADR-051 — Worktree Extension: Evidence Validation in Git Worktree Contex |
| 052 | .cleo/adrs | `87e6300fe246` | ADR-052-caamp-keeps-commander.md | ADR-052 — caamp Retains commander: Monorepo CLI Framework Divergence Acc |
| 052 | .cleo/adrs | `8572746de018` | ADR-052-sdk-consolidation.md | ADR-052: SDK Consolidation — Vercel AI SDK as the LLM Bridge |
| 053 | .cleo/adrs | `5fde3e699438` | ADR-053-playbook-runtime.md | ADR-053: Playbook Runtime as a Deterministic State Machine |
| 053 | .cleo/adrs | `1a4f4c4cd8a2` | ADR-053-project-agnostic-release-pipeline.md | ADR-053: Project-Agnostic Release Pipeline (T820) |
| 054 | .cleo/adrs | `a0580cfef072` | ADR-054-manifest-unification.md | ADR-054: Manifest/RCASD Architecture Unification |
| 054 | .cleo/adrs | `9865ec17cefa` | ADR-054-migration-system-hybrid-path-a-plus.md | ADR-054: Migration System — Hybrid Path A+ |
| 068 | .cleo/adrs | `90c07fc94697` | ADR-068-canonical-agent-system.md | ADR-068: Canonical Agent System — Single Layout, Auto-Install, Symmetric |
| 068 | .cleo/adrs | `0b57a4755777` | ADR-068-cleo-database-charter.md | ADR-068: CLEO Database Charter (12 DBs · ownership · lifecycle · concurr |
| 068 | docs/adr | `71e12a3ef5d6` | ADR-068-per-worktree-handoff.md | ADR-068: Per-Worktree Handoff Schema |
| 070 | .cleo/adrs | `0e43735c425a` | ADR-070-three-tier-orchestration.md | ADR-070: Three-tier orchestration: Orchestrator -> Lead -> Worker |
| 070 | .cleo/adrs | `1a9958762a4e` | ADR-070-verifier-backed-ac-auditor-loop.md | ADR-070 — Verifier-Backed Acceptance Criteria and the Auditor Loop |
| 072 | .cleo/adrs | `c28ec0175656` | ADR-072-unified-llm-provider-architecture.md | Unified LLM Provider Architecture — Three-Interface Stack (Transport / S |
| 072 | docs/adr | `c8cc2b601db2` | ADR-072-nexus-db-split.md | ADR-072: Nexus DB Topology Split — nexus-registry.db + nexus-graph/<proj |
| 078 | .cleo/adrs | `28fcc3e472e4` | ADR-078-docs-provenance.md | ADR-078: Docs SSoT as DB-Backed Provenance Graph with Supersession + Upd |
| 078 | docs/adr | `0866e1c7f6dd` | ADR-078-boundary-registry.md | ADR — Boundary Registry as SSoT for Rust/TS layering across cleocode |
| 079 | .cleo/adrs | `0113f7f7ab18` | ADR-079-docs-sdk-boundary-contract.md | ADR-079: Docs SDK Boundary Contract |
| 079 | .cleo/adrs | `1a545ec683a6` | adr-079-r1-ac-stable-ids.md | ADR-079-r1: Renamed to ADR-080 |
| 079 | .cleo/adrs | `0fa5e68f4801` | adr-079-r2-satisfies-binding.md | ADR-079-r2: Renamed to ADR-081 |
| 086 | .cleo/adrs | `31398d1e7b21` | ADR-086-cli-output-contract-e9.md | ADR-086: CLI Output Contract (E9 of Saga T9855) |
| 086 | docs/adr | `55d8ab46e6a0` | ADR-086-nested-nexus-disposition.md | ADR-086: Nested `~/.local/share/cleo/nexus/` Disposition — BAN |
| 088 | docs/adr | `28495951a617` | ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md | ADR: PM-Core V2 WorkGraph, Relations, and Completion Criteria |
| 088 | docs/adr | `741bca806ecf` | ADR-088-release-pipeline-coherence.md | ADR-087: Release Pipeline Coherence |

## Summary

- **Files:** 100 across 2 stores · **distinct numbers:** 86
- **DIVERGENT (same #, different decision):** ['051', '052', '053', '054', '068', '070', '072', '078', '079', '086', '088']
- **GAPS (ground truth, 3..89):** [40, 60]  ← note 076/077 are NOT gaps (exist in docs/adr)
- **Tombstones to delete:** `adr-079-r1` (→ADR-080), `adr-079-r2` (→ADR-081) — real 080/081 exist.
- **Mislabel:** `ADR-088-release-pipeline-coherence.md` titles itself 'ADR-087: Release Pipeline Coherence'.
- **ADR-051 has THREE divergent decisions; ADR-068 has THREE.**

## Reconcile recipe (slug-primary, per T11676)

For each divergent number: keep ALL decisions (they are distinct), assign each a unique next-free number as a DISPLAY ALIAS, the SLUG stays the canonical handle, mark none superseded (they are different decisions, not dups). Only true tombstones (079-r1/r2) are deleted. Then regenerate docs/adr from the DB once publish is idempotent.
