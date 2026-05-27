# ADR Reconciliation Report: SG-ADR-CANON (T11072)

**Date:** 2026-05-27
**Saga:** T11072 SG-ADR-CANON
**Epic:** T11073 E1-ADR-INVENTORY
**Status:** PENDING — Research Phase Complete, Ready for Agent Execution

---

## Executive Summary

The CLEO project has a catastrophic ADR (Architecture Decision Record) SSoT failure. ADRs exist in **three competing locations** with **84 numbering collisions**, **11 duplicate-numbered clusters**, and **no canonical provenance**. The previous attempt to fix this (T1824, 2026-05-04) chose `.cleo/adrs/` as the canonical location, which exacerbated the problem by creating a hidden, non-discoverable storage site that continues to receive new ADRs while `docs/adr/` also remains active.

**This saga (T11072) supersedes T1824** and establishes the permanent canonical policy:
- **Database (cleo tasks/brain/docs) is the sole SSoT**
- **`docs/adr/` contains only generated markdown artifacts**
- **`.cleo/adrs/` is deprecated and will be emptied**
- **All ADR history (create, amend, supersede) tracked in cleo docs with diff history**
- **No dot versions, no alpha/beta — provenance is the database record**

---

## The Three Competing Locations

| Location | File Count | Nature | Problem |
|----------|-----------|--------|---------|
| `.cleo/adrs/` | 89 files | Chosen as "canonical" by T1824 | Hidden dot-directory, violates project conventions, gitignored-adjacent |
| `docs/adr/` | 10 files | Supposedly migrated away | Still receiving new ADRs (ADR-087, 088, 089) |
| `cleo docs` blobs | 121 entries | Shadow storage | Base64-encoded duplicates, no filesystem linkage, duplicates exist |

**Total unique ADR numbers found:** 89 (001-089, with gaps)
**Total collisions (same number in multiple locations):** 84
**Duplicate numbers within a single location:** 11 clusters

---

## Duplicate-Numbered Clusters (The 11 Problem Areas)

### Cluster ADR-051 (3 files in FS, 3 entries in docs)
- `.cleo/adrs/ADR-051-override-patterns.md`
- `.cleo/adrs/ADR-051-programmatic-gate-integrity.md`
- `.cleo/adrs/ADR-051-worktree-extension.md`
- **Resolution needed:** Merge into single ADR-051 or renumber two as ADR-051.A and ADR-051.B

### Cluster ADR-052 (2 files in FS, 2 entries in docs)
- `.cleo/adrs/ADR-052-caamp-keeps-commander.md`
- `.cleo/adrs/ADR-052-sdk-consolidation.md`

### Cluster ADR-053 (2 files in FS, 2 entries in docs)
- `.cleo/adrs/ADR-053-playbook-runtime.md`
- `.cleo/adrs/ADR-053-project-agnostic-release-pipeline.md`

### Cluster ADR-054 (2 files in FS, 2 entries in docs)
- `.cleo/adrs/ADR-054-manifest-unification.md`
- `.cleo/adrs/ADR-054-migration-system-hybrid-path-a-plus.md`

### Cluster ADR-068 (3 files across 2 dirs, 3 entries in docs)
- `.cleo/adrs/ADR-068-canonical-agent-system.md`
- `.cleo/adrs/ADR-068-cleo-database-charter.md`
- `docs/adr/ADR-068-per-worktree-handoff.md`

### Cluster ADR-070 (2 files in FS, 2 entries in docs)
- `.cleo/adrs/ADR-070-three-tier-orchestration.md`
- `.cleo/adrs/ADR-070-verifier-backed-ac-auditor-loop.md`

### Cluster ADR-072 (2 files across 2 dirs, 1 entry in docs)
- `.cleo/adrs/ADR-072-unified-llm-provider-architecture.md`
- `docs/adr/ADR-072-nexus-db-split.md`

### Cluster ADR-078 (2 files across 2 dirs, 2 entries in docs)
- `.cleo/adrs/ADR-078-docs-provenance.md`
- `docs/adr/ADR-078-boundary-registry.md`

### Cluster ADR-086 (2 files across 2 dirs, 2 entries in docs)
- `.cleo/adrs/ADR-086-cli-output-contract-e9.md`
- `docs/adr/ADR-086-nested-nexus-disposition.md`

### Cluster ADR-087 (2 files across 2 dirs, 2 entries in docs)
- `.cleo/adrs/ADR-087-release-pipeline-coherence.md`
- `docs/adr/ADR-087-worktree-ffi-topology.md`
- **Note:** ADR-087-A (worktrunk-ssot-boundary) is an addendum, not a collision

### Cluster ADR-088 (2 files in FS, 1 entry in docs)
- `docs/adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md`
- `docs/adr/ADR-088-release-pipeline-coherence.md`

### Cluster ADR-079 (7 entries in docs — most fragmented)
- `adr-079-r2-satisfies-binding`
- `adr-079-r1-ac-stable-ids`
- `adr-079-docs-sdk-boundary-contract`
- `adr-079-core-tools-first-class`
- `adr-079-independent-validator`
- `adr-079-docs-as-active-validator`
- `adr-079-ac-stable-ids`
- **This is the most fragmented ADR — needs complete consolidation**

---

## Missing Numbers (Gaps in Sequence)

The following ADR numbers have **no files or entries** anywhere:
- ADR-040
- ADR-060
- ADR-069
- ADR-076 (has docs/adr/ADR-076-canonical-docs-ssot.md but no cleo docs entry)
- ADR-077 (has docs/adr/ADR-077-worktreeinclude-canonical-location.md)

**Hypotheses:**
- Skipped intentionally (reserved for future use)
- Renamed during drafting and never cleaned up
- Lost during the T1824 migration
- Never created (gaps in sequence)

---

## Root Cause: T1824 Failed Migration

**T1824 (2026-05-04):** "Decision Storage Consolidation + Programmatic ADR Management"
- **AC1:** Chose `.cleo/adrs/` as canonical filesystem location
- **AC3:** Wired `cleo docs publish` to write to `.cleo/adrs/`
- **AC8:** Declared "All future ADR creations are DB-first"

**Why it failed:**
1. `.cleo/adrs/` is a hidden dot-directory — non-discoverable, IDE-unfriendly
2. `.cleo/` is partially gitignored (runtime data safety per ADR-013 §9)
3. Contributors continued using `docs/adr/` because it's standard and visible
4. cleo docs stored base64 blobs, creating shadow copies
5. No lint gate enforced the `.cleo/adrs/` policy
6. The migration moved 13 files from `docs/adr/` to `.cleo/adrs/` but `docs/adr/` was not properly emptied or blocked

---

## Canonical Policy (ADR-090 — To Be Written)

### SSoT Hierarchy

```
Database (cleo tasks/brain/docs)  ←  SOLE SOURCE OF TRUTH
         │
         ├── decisions table: adr_sequence_number, slug, status, content
         ├── adr_revisions table: diff history, content hashes
         ├── adr_supersessions table: supersession chains
         │
         ▼
   cleo docs system
         │
         ├── fetch → read from database
         ├── add --type adr → write database + generate markdown
         ├── amend → new revision record + regenerate markdown
         ├── supersede → new ADR record + update supersession chain
         │
         ▼
    docs/adr/  ←  GENERATED ARTIFACT ONLY
         │
         ├── ADR-NNN-slug.md (read-only, regenerated on change)
         ├── Never edit directly — always through cleo docs
         ├── Git-tracked for human discoverability
```

### Addendum Naming

- **Base ADR:** `ADR-087-worktree-ffi-topology.md`
- **Addendum:** `ADR-087.A-worktrunk-ssot-boundary.md` (decimal suffix)
- **NOT allowed:** `ADR-087-A` (dash suffix), `ADR-087.1.2` (multiple dots)
- **Rationale:** Single decimal suffix is machine-sortable, unambiguous, and doesn't collide with base numbers

### Numbering Rules

1. Sequence is strictly monotonic — no gaps without documentation
2. Each number has exactly one canonical record
3. Addendums use decimal suffix (ADR-NNN.A)
4. Superseded ADRs keep their number, status changes to "superseded"
5. New ADR always gets next sequence number — never reuses old number

---

## Saga Structure: T11072 SG-ADR-CANON

### Epic E1: T11073 — ADR Inventory and Collision Matrix
- **T11066:** Audit all ADR locations and build collision matrix
- **T11071:** Reconcile specific duplicate-numbered ADR clusters
- **T11065:** P0: Reconcile ADR SSoT — Canonize numbering and unify storage

### Epic E2: T11074 — Policy and Schema Design
- **T11067:** Define canonical ADR storage and numbering policy
- **T11077:** Design database schema for ADR provenance and diff history
- **T11078:** Write ADR-090: Canonical ADR Policy (supersedes T1824)

### Epic E3: T11075 — Migration Execution
- **T11068:** Migrate `.cleo/adrs/` to `docs/adr/` and reconcile duplicates
- **T11069:** Fix cleo docs to reference files directly instead of shadow storage
- **T11079:** Backfill database records for all historical ADRs (001-089)

### Epic E4: T11076 — Lint Gates and Enforcement
- **T11070:** Add lint gate enforcing `docs/adr/` as only valid ADR location
- **T11080:** Implement cleo docs system to use filesystem references not base64 blobs
- **T11081:** Implement lint gates for ADR location, numbering, and provenance

---

## Supersession Chain

```
T11072 SG-ADR-CANON
  └─ supersedes ──► T1824 EPIC: Decision Storage Consolidation
                      └─ T1825 TASK: Migrate docs/adr/ → .cleo/adrs/
```

**Rationale for supersession:** T1824's choice of `.cleo/adrs/` as canonical location created the fragmentation problem. The hidden dot-directory is non-discoverable, violates project conventions, and `.cleo/` is partially gitignored. SG-ADR-CANON reverses this decision and establishes database-first SSoT with `docs/adr/` as generated artifact.

---

## Immediate Next Actions

1. **Start T11066** (Wave 0): Build complete collision matrix with content hashes
2. **Start T11067 in parallel**: Draft canonical policy document
3. **Block T11068 on T11066+T11067**: Cannot migrate until inventory and policy are complete
4. **T11078 (ADR-090) gates all other work**: Policy must be accepted before migration begins

---

## Evidence and References

- **Filesystem inventory:** 99 ADR files across `.cleo/adrs/` (89) and `docs/adr/` (10)
- **cleo docs inventory:** 121 ADR entries (many duplicates from blob storage)
- **Collision analysis:** 84 numbers exist in both filesystem and docs; 11 clusters have duplicates
- **T1824 record:** Done 2026-05-04, chose `.cleo/adrs/` as canonical — now superseded
- **ADR-013 §9:** `.cleo/` runtime data safety — why ADRs should not live there
- **T11064:** branch-lock.ts audit task (related worktrunk boundary finding)

---

## Files Referenced

| Path | Role |
|------|------|
| `.cleo/adrs/ADR-*.md` | 89 files — deprecated location |
| `docs/adr/ADR-*.md` | 10 files — standard location, still active |
| `packages/worktree/src/napi-binding.ts` | References ADR-087 (boundary contract) |
| `packages/core/src/spawn/branch-lock.ts` | References ADR-055 (worktree extension) |
| `docs/spec/worktree-lifecycle.md` | References ADR-087, ADR-055 |

---

*Report generated by cleo agent during T11072 saga initialization.*
*Database is SSoT. This markdown is a generated artifact.*
