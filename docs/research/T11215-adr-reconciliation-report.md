# ADR Inventory Audit and Collision Matrix

**Task ID**: T11215  
**Saga Parent**: SG-ADR-CANON (T11072)  
**Date**: May 28, 2026  
**Auditor**: Research Agent (Gemini 3.5 Flash)

---

## 1. Executive Summary

This audit represents a comprehensive reconciliation of all Architectural Decision Records (ADRs) across the CLEO codebase. In support of the parent Saga **SG-ADR-CANON (Canonical ADR Provenance and Numbering Reconciliation)**, we audited all filesystem storage locations and the active SQLite database (`tasks.db`) to map out the current landscape, identify all numbering collisions, and diagnose database synchronization issues.

Our audit identified:
- **104 total ADR-like markdown files** on disk.
- **90 unique ADR numbers** represented (ADR-001 through ADR-089, plus unnumbered files).
- **3 distinct active/legacy storage locations** on the filesystem.
- **9 active numbering collisions** (duplicate files/concepts assigned to the same ADR number).
- **1 major database-to-disk discrepancy** (missing files registered in DB).
- **20 filesystem files not registered** in the database.

---

## 2. ADR Storage Locations Audit

We found that ADR documents are currently fragmented across three main directory structures:

1. **`.cleo/adrs/` (Legacy Storage Location)**:
   - **File Count**: 90 markdown files.
   - **Role**: Historically served as the primary repository for ADRs. According to Saga AC4, this directory must be deprecated, emptied, and blocked by a lint gate.
   
2. **`docs/adr/` (Active SSoT Directory)**:
   - **File Count**: 12 markdown files (plus `ARCHIVED.md`).
   - **Role**: The intended target for the single canonical sequential ADR sequence. Currently, only the most recently written/migrated ADRs reside here. None of these are registered in the `tasks.db` database.
   
3. **`packages/lafs/docs/architecture/` (Package-Scoped)**:
   - **File Count**: 2 markdown files (`ADR-001-RFC9457-ERROR-OPTIMIZATION.md` and `RFC-ERROR-OPTIMIZATION.md`).
   - **Role**: Fragmented, package-specific architecture files that bypass the global ADR numbering system.

---

## 3. Collision Matrix

The following matrix documents all duplicate allocations of ADR numbers across the system, detailing the colliding files, their paths, titles, and status:

| ID | File Path | Title | Status / Date | Conflict Nature |
| :--- | :--- | :--- | :--- | :--- |
| **ADR-051** | `.cleo/adrs/ADR-051-override-patterns.md` | ADR-051: Override Patterns — When and How to Use CLEO_OWNER_OVERRIDE | - | Three separate documents are assigned `051` under `.cleo/adrs/`. |
| | `.cleo/adrs/ADR-051-programmatic-gate-integrity.md` | ADR-051 — Programmatic Gate Integrity: Evidence-Based Verify + Removal of Silent Bypass | - | |
| | `.cleo/adrs/ADR-051-worktree-extension.md` | ADR-051 — Worktree Extension: Evidence Validation in Git Worktree Contexts | 2026-05-18 (Accepted) | Only `worktree-extension.md` is registered in `tasks.db`. |
| **ADR-068** | `.cleo/adrs/ADR-068-canonical-agent-system.md` | ADR-068: Canonical Agent System — Single Layout, Auto-Install, Symmetric Playbook Tiers | 2026-05-05 (Accepted) | Severe concept overlap. Two entirely different core designs used `068` on successive days. Amendments/sub-schemas inherited the collided number. |
| | `docs/adr/ADR-068-cleo-database-charter.md` | ADR-068: CLEO Database Charter (12 DBs · ownership · lifecycle · concurrency) | 2026-05-06 (Accepted) | Both "Canonical Agent System" and "Database Charter" are registered in DB under `068`! |
| | `docs/adr/068-amendment-3-1-worktree-cli-routing.md` | ADR-068 Amendment §3.1 — Worktree-Aware CLI Routing for SSoT Writes | (Accepted) | |
| | `docs/adr/ADR-068-per-worktree-handoff.md` | ADR-068: Per-Worktree Handoff Schema | 2026-05-12 (Proposed) | |
| **ADR-070** | `.cleo/adrs/ADR-070-three-tier-orchestration.md` | ADR-070: Three-tier orchestration: Orchestrator -> Lead -> Worker | 2026-05-06 (Accepted) | Parallel tasks created two distinct ADRs under `070` in the same directory within 48 hours. Only `verifier-backed-ac` is in DB. |
| | `.cleo/adrs/ADR-070-verifier-backed-ac-auditor-loop.md` | ADR-070 — Verifier-Backed Acceptance Criteria and the Auditor Loop | 2026-05-08 (Accepted) | |
| **ADR-072** | `.cleo/adrs/ADR-072-unified-llm-provider-architecture.md` | Unified LLM Provider Architecture — Three-Interface Stack | 2026-05-14 (Implemented) | Under-coordinated parallel allocation across directories. Number `072` was used in `.cleo/adrs` and `docs/adr` on different topics. |
| | `docs/adr/ADR-072-nexus-db-split.md` | ADR-072: Nexus DB Topology Split — nexus-registry.db + nexus-graph/<projectId>.db | 2026-05-12 (Proposed) | |
| **ADR-078** | `.cleo/adrs/ADR-078-docs-provenance.md` | ADR-078: Docs SSoT as DB-Backed Provenance Graph | 2026-05-24 (Accepted) | Cross-directory overlap. Boundary Registry used `078` in `docs/adr/` on May 23, and Docs SSoT used `078` in `.cleo/adrs/` on May 24. |
| | `docs/adr/ADR-078-boundary-registry.md` | ADR — Boundary Registry as SSoT for Rust/TS layering | 2026-05-23 (Accepted) | |
| **ADR-079** | `.cleo/adrs/ADR-079-docs-sdk-boundary-contract.md` | ADR-079: Docs SDK Boundary Contract | 2026-05-23 (Accepted) | Revisions and renaming stubs. Revisions `r1` and `r2` remain on disk with the old `079` filename prefix instead of being cleaned up. |
| | `.cleo/adrs/adr-079-r1-ac-stable-ids.md` | ADR-079-r1: Renamed to ADR-080 | 2026-05-25 (Superseded) | |
| | `.cleo/adrs/adr-079-r2-satisfies-binding.md` | ADR-079-r2: Renamed to ADR-081 | 2026-05-25 (Superseded) | |
| **ADR-086** | `docs/adr/ADR-086-cli-output-contract.md` | ADR-086: CLI Output Contract (E9 of Saga T9855) | 2026-05-24 (Accepted) | Dual allocation under `docs/adr` within 24 hours. Furthermore, CLI Output Contract has path drift (see Section 4). |
| | `docs/adr/ADR-086-nested-nexus-disposition.md` | ADR-086: Nested `~/.local/share/cleo/nexus/` Disposition — BAN | 2026-05-23 (Accepted) | |
| **ADR-087** | `.cleo/adrs/ADR-087-envelope-first-doctrine.md` | ADR-087: Envelope-First Doctrine | 2026-05-28 (Proposed) | Overlap across directories. Worktree FFI used `087` in `docs/adr/` on May 24, and Envelope Doctrine used `087` in `.cleo/adrs/` on May 28. |
| | `docs/adr/ADR-087-worktree-ffi-topology.md` | ADR-087 — Worktree FFI Topology (4-surface napi-rs layout) | 2026-05-24 (Accepted) | |
| **ADR-088** | `docs/adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md` | ADR: PM-Core V2 WorkGraph, Relations, and Completion Criteria | 2026-05-25 (Draft) | Duplicate allocation within `docs/adr/` on the exact same day. "Release Coherence" text title says `087` (indicating a copy-paste drift). |
| | `docs/adr/ADR-088-release-pipeline-coherence.md` | ADR-088: Release Pipeline Coherence (Text says: ADR-087: Release Pipeline Coherence) | (Accepted) | |

---

## 4. Database-to-Filesystem Discrepancy Audit

We compared the `architecture_decisions` table in `tasks.db` with the physical files on disk:

1. **Database Path Drift / Missing File**:
   - `ADR-086: CLI Output Contract (E9 of Saga T9855)` is registered in the database with the path `.cleo/adrs/ADR-086-cli-output-contract-e9.md`.
   - **However, this file does not exist on disk** at that location.
   - Instead, the file resides at `docs/adr/ADR-086-cli-output-contract.md` but is unregistered.
   - *Diagnosis*: The file was migrated and renamed, but the database path record was never updated.

2. **Filesystem Files Missing from DB (20 total)**:
   - There are 20 physical files on disk that have no registered record in the `tasks.db` database.
   - This includes **all newer ADR files** located in `docs/adr/` (such as ADR-076, ADR-077, ADR-086, ADR-087, ADR-088, and ADR-089) and the package-scoped `packages/lafs/docs/architecture/ADR-001-RFC9457-ERROR-OPTIMIZATION.md`.
   - *Diagnosis*: The migration of documents to the new `docs/adr/` folder was done strictly on the filesystem, bypassing the database registration/sync pipeline.

---

## 5. Collision Root Causes & Resolutions

### Cluster A: Multi-Concept Number Collisions
- **ADR-051, ADR-068, ADR-070, ADR-072, ADR-078, ADR-086, ADR-087, ADR-088**
- **Cause**: Multi-agent parallel tasks creating different architectural documents simultaneously without centralized state validation. Because directories were split (legacy `.cleo/adrs` vs new `docs/adr`), workers failed to scan the other location before claiming a number.
- **Resolution**:
  - Implement a central SSoT sequence allocation mechanism (as specified in `SG-ADR-CANON` AC8).
  - Explicitly rename colliding files to unique numbers.
  - Recommended re-numbering scheme:
    - **ADR-051**: Keep `worktree-extension.md` as 051. Rename `override-patterns.md` to a vacant number, and `programmatic-gate-integrity.md` to another vacant number.
    - **ADR-068**: Keep `cleo-database-charter.md` as 068. Rename `canonical-agent-system.md` to a vacant number. Adjust `068-amendment...` and `per-worktree-handoff.md` to point to the new numbers.
    - **ADR-070**: Keep `verifier-backed-ac-auditor-loop.md` as 070. Rename `three-tier-orchestration.md` to a vacant number.
    - **ADR-072**: Keep `unified-llm-provider-architecture.md` as 072. Rename `nexus-db-split.md` to a vacant number.
    - **ADR-078**: Keep `boundary-registry.md` as 078. Rename `docs-provenance.md` to a vacant number.
    - **ADR-086**: Keep `nested-nexus-disposition.md` as 086. Rename `cli-output-contract.md` to a vacant number (e.g. 090).
    - **ADR-087**: Keep `worktree-ffi-topology.md` as 087. Rename `envelope-first-doctrine.md` to a vacant number (e.g. 091).
    - **ADR-088**: Keep `pm-core-v2-workgraph-relations-completion-criteria.md` as 088. Rename `release-pipeline-coherence.md` to a vacant number (e.g. 092).

### Cluster B: Revision Stubs
- **ADR-079** (`adr-079-r1...` and `adr-079-r2...`)
- **Cause**: Leftover draft stubs created during refactoring that were never cleaned up.
- **Resolution**: Safely delete the superseded stubs from disk since their content has been fully incorporated into `ADR-080` and `ADR-081` respectively.

---

## 6. Actionable Next Steps

To close out Saga `SG-ADR-CANON` (T11072), we recommend the following sequence of execution for the next tasks in the pipeline:

1. **Task T11216 (Numbering Policy)**:
   - Formulate the sequential numbering policy, defining `docs/adr/` as the single canonical storage.
   - Establish linting rules to prevent future raw writes to `.cleo/adrs/`.

2. **Task T11217 (Re-numbering and Migration)**:
   - Clean up the revision stubs in `.cleo/adrs/` (delete `adr-079-r1` and `adr-079-r2`).
   - Re-number and rename the colliding files according to the recommended re-numbering scheme.
   - Migrate all physical ADR files from `.cleo/adrs/` to `docs/adr/` (Saga AC3 & AC4).
   - Sync the relocated and re-numbered files back into `tasks.db` under the `architecture_decisions` table, updating paths and titles.

3. **Task T11218 (Lint Gates & CI Enforcement)**:
   - Deploy git-hooks or CI lint steps to ban files in `.cleo/adrs/`.
   - Implement validations in the `cleo check` suite to ensure no duplicate IDs are used in `docs/adr/`.
