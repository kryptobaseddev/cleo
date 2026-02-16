---
title: "CLEO Canonical Plan and Decision Spec"
version: "1.2.0"
status: "stable"
created: "2026-02-13"
updated: "2026-02-16"
epic: "T4454"
authors: ["CLEO Development Team"]
supersedes:
  - "Execution authority split across CLEO-STRATEGIC-ROADMAP-SPEC.md and CLEO-V2-ARCHITECTURE-DECISIONS.md"
---

# CLEO Canonical Plan and Decision Spec

**Version**: 1.2.0
**Status**: STABLE
**Date**: 2026-02-16
**Authority**: This is the single canonical planning and decision document for CLEO going forward. It unifies strategy, architecture decisions, migration doctrine, and execution epics while preserving source context through traceability.

---

## 1. Authority and Scope

### 1.1 Document Hierarchy

1. `docs/concepts/vision.mdx` (immutable identity, highest authority)
2. `docs/specs/PORTABLE-BRAIN-SPEC.md` (product contract and invariants)
3. `docs/specs/CLEO-CANONICAL-PLAN-SPEC.md` (this document: canonical strategy + decisions + execution)
4. Supporting reference docs (roadmap, ADR record, migration doctrine, V2 architecture spec)

This document does not redefine product identity. It defines one unified execution approach and one authoritative decision state.

### 1.2 Canonical Commitments (Final)

1. **Both tracks run in parallel**: MCP native expansion and full TypeScript CLI rewrite proceed together and converge.
2. **LAFS is foundational**: output and error contracts must be LAFS-compliant across transports.
3. **CAAMP is canonical package management**: skills, MCP servers, and instruction injection standardize on CAAMP.
4. **CLI behavior remains transitional baseline** until convergence criteria are met.
5. **Full TypeScript is active now** under T4454 (T2021 superseded, T2112 gate removed).

---

## 2. Current Reality Baseline (Code-Verified)

> **Last verified**: 2026-02-16 via architecture validation (T4565/T4566), documentation audit (T4557), and bash deprecation analysis (T4567). Evidence: `claudedocs/agent-outputs/T4565-T4566-architecture-validation-report.md`, `claudedocs/agent-outputs/T4557-documentation-audit-report.md`.

### 2.1 TypeScript Migration Status (~75% Complete)

The Bash-to-TypeScript migration is substantially progressed:

| Component | Status | Evidence |
|-----------|--------|----------|
| **SQLite store layer** | Complete (6 tables) | `src/store/sqlite.ts`, `src/store/schema.ts` |
| **Task engine** | Complete (13 operations) | `src/core/tasks/` -- add, show, list, find, complete, update, delete, archive, deps, analyze, labels, hierarchy, relates |
| **Session engine** | Complete (5 operations) | `src/core/sessions/` -- start, end, resume, status, list |
| **System engine** | Complete (7 operations) | `mcp-server/src/engine/system-engine.ts` |
| **8 brain operations** | Complete | MCP native engine operational |
| **CLI commands** | 76 exist, 50 unregistered | `src/cli/commands/` -- registration in `src/cli/index.ts` pending |
| **All 79 Bash scripts** | TS equivalents exist | T4567 confirmed full porting |
| **All 106 Bash libs** | TS equivalents exist | T4567 confirmed full porting |

### 2.2 Architecture: Shared-Core Sibling Pattern

The V2 architecture follows a "Salesforce DX sibling" pattern with two interface layers:

```
src/cli/commands/*.ts  -->  src/core/*  -->  src/store/*   (CLI path: 100% compliant)
                                ^
mcp-server/src/domains/ -->  mcp-server/src/engine/*        (MCP path: parallel engine)
```

**CLI layer**: 100% shared-core compliant. All 16 registered commands properly delegate to `src/core/` modules (T4565 verified).

**MCP server layer**: Operates via independent engine at `mcp-server/src/engine/`. This creates duplicate implementations for task CRUD (8 ops), session management (4 ops), and separate data access layers. The engine was intentionally created to allow MCP to function without the Bash CLI, but future unification with `src/core/` is needed (see Remediation in T4565/T4566 report).

### 2.3 Engine and Operations

- Capability matrix currently defines **135 routed operations**.
- Mode split: **29 native**, **105 CLI**, **1 hybrid**.
- Native-capable operations today: **30 total** (29 native + 1 hybrid).

### 2.4 Platform and Dependencies

- MCP server requires **Node >=20**.
- `@cleocode/caamp` is installed and integrated.
- `@cleocode/lafs-protocol` is installed and available for conformance integration.
- `@cleocode/ct-skills` is installed and actively used in skills-domain operations.

### 2.5 Domain Surface

- Gateway matrices currently expose **9 query domains** and **10 mutate domains** (union: 10 domains, including `skills` and `issues`) with **63 query** and **60 mutate** operations.
- CAAMP provider/MCP/injection handling exists in system-domain code paths and remains part of canonical integration direction.

### 2.6 Documentation Landscape

- **1,778 documentation files** total (1,527 `.md` + 263 `.mdx`) -- T4557 audit
- ~310 canonical, ~210 supporting, ~330 superseded, ~915 agent outputs
- 81 `.mdx` command docs describe Bash CLI (will need TS updates)
- Dual `.md`/`.mdx` format exists in several areas

### 2.7 Scale Tier Vocabulary

| Tier | Projects | Agents | Storage | Target Phase |
|------|----------|--------|---------|-------------|
| **S** | 1 | 1 orchestrator + subagents | JSON files | Current |
| **M** | 2-3 | 2-5 concurrent | SQLite | Phase 2 |
| **L** | 3-10 | 5-20 concurrent | PostgreSQL | Phase 3 |
| **XL** | 10-100+ | 20-100+ | Distributed DB | Future |

Current state: Tier S (fully mature). Target: S to M foundation (Phase 0-1), M to L capability (Phase 2-3).

---

## 3. Unified Decision Ledger (D1-D6)

| Decision | Canonical Status | Canonical Interpretation |
|----------|------------------|--------------------------|
| D1: TypeScript Port | **FULL GO (~75% COMPLETE)** | CLI and MCP tracks operational in parallel; CLI 100% shared-core compliant; MCP has parallel engine pending unification; all 79 Bash scripts and 106 libs have TS equivalents; 50 of 76 CLI commands await registration |
| D2: JSON/JSONL Storage | **UNCHANGED** | JSON/JSONL remains system of record; optimize algorithms, not storage engine |
| D3: Manifest Validation | **UNCHANGED** | Four-gate model remains mandatory; Ajv schema gate preserved |
| D4: Technical Debt Tracking | **UNCHANGED** | JSONL debt ledger strategy remains valid |
| D5: CLI Framework | **ACTIVATED** | Commander.js is canonical CLI framework for V2 CLI track |
| D6: Multi-Agent Consensus | **UNCHANGED** | Consensus/challenge-loop direction remains protocol-layer architecture |

### 3.1 Conflict Resolution Rule

When legacy documents differ, apply this order:

1. Newer canonical statements in this document
2. Newer migration/V2 architecture statements
3. Older roadmap/ADR phrasing

This preserves intent and removes contradictory execution guidance.

---

## 4. Unified Strategic Plan (Phase 0 to 3.5)

The phase model is preserved in full. What changed is execution ordering for TypeScript work: CLI and MCP tracks now run in parallel.

### 4.1 Phase Definitions and Gates

- **Phase 0: Foundation**: implementation-gap closure + MCP/TypeScript foundation.
- **Phase 1: Validation**: evidence gates for adoption and strategic confidence.
- **Phase 2: Intelligence**: semantic capabilities + parity expansion.
- **Phase 2.5: Learning**: pattern extraction and adaptive prioritization.
- **Phase 3: Scale**: agent coordination and cross-project scale.
- **Phase 3.5: BRAIN Certification**: capability audit before BRAIN claims.

### 4.2 Evidence-Gate Policy (Retained)

- Phase progression stays gate-controlled (strict by default).
- Gate failures block progression and require remediation + revalidation.
- Strategic decisioning remains explicit; no "wait and see" ambiguity.

### 4.3 Migration Ordering Clarification

- Legacy sequential language (MCP-first then hotspots) is retained as historical context.
- Current canonical ordering is **parallel tracks with convergence**.
- This is a final decision and is not pending additional gates.

### 4.4 Mandatory Risk and Rollback Governance (Retained)

- The roadmap rollback model remains active: automatic and manual rollback triggers, then remediation and revalidation.
- Gate failures continue to block phase progression until root-cause and mitigation tasks are complete.
- Historical branch alternatives remain documented for provenance, but execution authority follows this canonical plan.

### 4.5 Transitional Authority Rules (Retained)

- During migration, CLI behavior remains baseline for parity comparison.
- Native TypeScript mismatches are fixed toward baseline behavior until convergence criteria are satisfied.
- Authority transfers to shared TypeScript core only after convergence criteria are fully met.

### 4.6 BRAIN-vs-Simplification Decision (Resolved)

The Strategic Roadmap (Section 3.2.3) defined a decision gate requiring explicit commitment to either BRAIN expansion or simplification at Phase 1. With the canonical commitment to "both tracks parallel" and D1 FULL GO, this decision is resolved: **BRAIN expansion path is the active direction**. The simplification fallback remains documented in the roadmap as a rollback option per Section 4.4 governance rules.

---

## 5. LAFS and CAAMP Integration Direction

### 5.1 LAFS

- LAFS envelope and error taxonomy are required target contracts across CLI/MCP.
- Machine-readable output is default; human-readable output is opt-in.
- Conformance validation is a required integration-phase outcome.

### 5.2 CAAMP

- CAAMP is the canonical package manager for:
  - Skill lifecycle
  - MCP server configuration and provider management
  - Agent instruction injection
- Canonical wording: the CAAMP package exposes broader API surface; current MCP adapter wraps the operational subset needed today, with expansion tracked under V2 integration tasks.

---

## 6. Main Epics and Execution Map

| Epic/Task | Canonical Role | Status Snapshot (2026-02-16) |
|----------|----------------|-------------------------------|
| T4454 | V2 master epic (parallel tracks, LAFS-native) | Active |
| T4540 | Wave 2 audit/cleanup epic | Active -- doc audit (T4557) complete, arch validation (T4565/T4566) complete, bash deprecation plan (T4567) complete, canonical doc updates (T4558) in progress |
| T4455-T4472 | CLI track phases 1-4 | Pending/active by phase; 50 unregistered commands identified |
| T4474-T4478 | MCP native expansion track | Pending (parallel); MCP engine operational with parallel engine gap identified |
| T4334 | MCP native engine foundation | P0-P2 done; P3-P4 pending |
| T4338 | Golden parity + CI gate | Pending |
| T4339 | Feature-flag rollout to GA | Pending |
| T4332 | CAAMP integration epic | Partially complete; remaining scope tracked |
| T4352 | Manifest hierarchy track | Pending |
| T2021 | Legacy full TS conversion epic | Superseded by T4454 |
| T2112 | Legacy stabilization gate | Removed for CLI-track activation |

### 6.1 Deferred Open Questions

The following questions from the original ADR (D1-D6) remain open and are tracked for future resolution:

| Question | Source | Status | Resolution Timeline |
|----------|--------|--------|-------------------|
| Bun Runtime for v2.1? | ADR D1 | Deferred | Post-V2 stabilization |
| Vector Embeddings for task search? | ADR D2 | Deferred | Phase 2 (semantic search) |
| SQLite threshold for scale? | ADR D2 | Deferred | Phase 2 (>10K tasks trigger) |
| Challenge loop complexity? | ADR D6 | Deferred | Phase 4 (configurable consensus) |

These questions do not block current execution. They will be evaluated at their respective phase gates.

### 6.2 Tracked Functionality Gaps

| Feature | Source | Epic/Task | Status |
|---------|--------|-----------|--------|
| Progressive disclosure L0-L3 | MCP-AGENT-INTERACTION-SPEC | T4454 (V2 Phase 4) | Planned |
| Bundle size target (<500KB) | ADR D5 | T4454 Phase 1 | Planned |
| Startup time target (<50ms) | ADR D5 | T4454 Phase 1 | Planned |
| BRAIN Certification | Roadmap Phase 3.5 | Untracked | Deferred to Phase 3.5 |
| Nexus validation gate | Roadmap Phase 1 | Untracked | Retained as Phase 1 gate |
| Web UI (Nexus Command Center) | T4284 epic, dashboard specs | T4284 | Active (Phase 0, read-only MVP) |

---

## 7. Preservation of Vital Context

No source document is deleted or invalidated as historical evidence.

- `docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md`: phase model, gates, metrics, risk framework
- `claudedocs/CLEO-V2-ARCHITECTURE-DECISIONS.md`: ADR rationale and tradeoff history (D1-D6)
- `docs/specs/CLEO-MIGRATION-DOCTRINE.md`: migration authority, convergence criteria, current engine inventory
- `docs/specs/CLEO-V2-ARCHITECTURE-SPEC.md`: detailed V2 architecture and LAFS technical contracts

These are now supporting references under this canonical layer.

---

## 8. Traceability Matrix

| Canonical Topic | Primary Source(s) |
|----------------|-------------------|
| Phase model (0-3.5), decision gates, risk and rollback | `docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md` |
| D1-D6 rationale and original constraints | `claudedocs/CLEO-V2-ARCHITECTURE-DECISIONS.md` |
| Parallel-tracks migration authority and convergence criteria | `docs/specs/CLEO-MIGRATION-DOCTRINE.md` |
| LAFS-native architecture design and conformance rules | `docs/specs/CLEO-V2-ARCHITECTURE-SPEC.md` |
| Code-verified operation counts and engine status | `mcp-server/src/engine/capability-matrix.ts`, `mcp-server/src/gateways/query.ts`, `mcp-server/src/gateways/mutate.ts`, `mcp-server/package.json` |
| Shared-core compliance audit (CLI 100%, MCP 0%) | `claudedocs/agent-outputs/T4565-T4566-architecture-validation-report.md` |
| Documentation inventory (1,778 files) | `claudedocs/agent-outputs/T4557-documentation-audit-report.md` |
| Bash deprecation status (all 79+106 ported to TS) | T4567 bash deprecation analysis |

---

## 9. Canonical Governance Rules

1. New strategic or architectural decisions MUST update this document first.
2. Supporting docs MAY expand detail but MUST NOT override canonical direction.
3. If a conflict is discovered, update this document and add reconciliation notes in the affected support doc.
4. Claims about implementation status MUST be code-verified before publication.

---

**Document Status**: STABLE
**Canonical Use**: Single source of truth for CLEO strategic direction, architecture decision state, migration approach, and epic alignment.
**Last Updated**: 2026-02-16 (T4558 -- Wave 2.1 canonical doc refresh incorporating T4557 doc audit, T4565/T4566 architecture validation, T4567 bash deprecation analysis)
**Next Review**: After T4454 Phase 1 completion or any new architectural decision.
