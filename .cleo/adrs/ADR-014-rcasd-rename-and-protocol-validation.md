# ADR-014: RCASD Rename and Protocol Output Validation Architecture

**Date**: 2026-02-25
**Status**: proposed
**Related ADRs**: ADR-006, ADR-008, ADR-012
**Related Tasks**: T4855, T4856, T4857, T4858, T4859

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context and Problem Statement

### 1.1 Naming: RCSD vs RCASD

CLEO's lifecycle pipeline evolved from 4 planning stages (Research-Consensus-Specification-Decomposition) to 5 planning stages with the addition of Architecture Decision between Consensus and Specification. The full pipeline is now 9 ordered stages + 1 cross-cutting:

```
Planning:  Research → Consensus → Architecture Decision → Specification → Decomposition
Execution: Implementation → Validation → Testing → Release
           (+ Contribution cross-cutting)
```

The accurate acronym is **RCASD-IVTR**, but the codebase universally uses "RCSD" — in variable names (`RCSD_STAGES`, `RcsdManifest`), file paths (`.cleo/rcsd/`), schema names, documentation, and comments. 87 occurrences across 23 source files; ~200 total across ~79 files.

### 1.2 Archived Protocol Output Schemas

During the AJV-to-drizzle-zod migration (T4786), 4 protocol output schemas were archived because they had zero runtime code references:

| Schema | What It Validated | Complexity |
|--------|-------------------|------------|
| `rcsd-research-output.schema.json` | Research findings, citations, confidence scores | ~60 fields |
| `rcsd-consensus-report.schema.json` | Voting matrix, agent weights, verdicts, audit trail | ~80 fields |
| `rcsd-spec-frontmatter.schema.json` | Specification YAML frontmatter | ~25 fields |
| `contribution.schema.json` | Multi-agent decisions, conflicts, resolution voting | ~120 fields |

These schemas defined rich structured validation that the current MANIFEST.jsonl approach does not enforce. The existing runtime validators (`src/core/validation/protocols/`) only check manifest entry fields (e.g., `agent_type`), not the full output documents.

### 1.3 Protocol Type Divergence

Three type systems define protocol/stage types with different value sets:

- `PIPELINE_STAGES` (stages.ts): 9 stages including `architecture_decision`
- `PROTOCOL_TYPES` (protocol-validators.ts): 9 types — missing `architecture_decision`, `validation`, `testing`; includes `artifact-publish`, `provenance`
- `ProtocolType` enum (protocol-enforcement.ts): 10 values — all stages + contribution

---

## 2. Decision

### 2.1 RCSD → RCASD Rename: Phased Execution

The rename MUST be executed in 3 phases:

**Phase 1 — Code rename (one PR):**
- `RCSD_STAGES` → `RCASD_STAGES`
- `RcsdStage` → `RcasdStage`
- `RcsdManifest` → `RcasdManifest`
- All comments: "RCSD pipeline" → "RCASD-IVTR pipeline"
- `@deprecated` re-exports under old names for one release cycle
- Scope: ~23 files, ~87 occurrences

**Phase 2 — Disk path migration (one PR):**
- `.cleo/rcsd/` → `.cleo/rcasd/` with symlink during transition
- `RCSD-INDEX.json` → `RCASD-INDEX.json`
- Path references in `src/core/paths.ts`

**Phase 3 — Documentation sweep (one PR):**
- 20 mintlify docs files (~46 occurrences)
- Agent injection templates
- ADR footnotes (historical ADR body text is NOT rewritten)

Archived schema filenames in `schemas/archive/` MUST NOT be renamed — they document the legacy format.

### 2.2 Protocol Output Validation: Hybrid Approach

Protocol output validation SHALL use a **hybrid approach** — validate critical metadata fields only, not the full archived schema structures.

**Trigger mechanism:** Validation MUST run as a gate inside `ct complete` when a task has a protocol label. A supplementary `ct validate --protocol <type> <taskId>` command SHOULD be available for manual checks.

**Storage:** Protocol output documents MUST remain as files (markdown or JSON). Key metadata (confidence score, verdict, validation status, output file path) MUST be recorded in the `lifecycle_stages` SQLite table via new optional columns.

**Schema format:** Standalone Zod schemas in `src/core/validation/protocols/` — one file per protocol type that has archived schema equivalents.

### 2.3 Protocol File Role

Protocol markdown files (`protocols/*.md`) SHALL remain agent instructions only. They MUST NOT be parsed at runtime for validation rule extraction. The Zod schemas in `src/core/validation/protocols/` are the machine-readable validation counterpart.

### 2.4 Protocol Type Alignment

`PROTOCOL_TYPES` in `src/core/orchestration/protocol-validators.ts` SHOULD be aligned with `PIPELINE_STAGES` + `contribution` to eliminate the current divergence. The `artifact-publish` and `provenance` protocol types MAY remain as non-stage protocol types with their own validators.

---

## 3. Rationale

### 3.1 Phased Rename

An atomic rename touching ~200 references would be high-risk and difficult to review. Phasing allows independent review/revert per PR. The code rename (Phase 1) SHOULD land before T4800 (SQLite pipeline) to avoid renaming new code twice.

### 3.2 Hybrid Validation Scope

The full archived schemas were designed for a structured JSON workflow that never materialized. Current agent outputs are markdown files with MANIFEST.jsonl entries. Restoring the complete ~285 fields of validation would be over-engineered. The hybrid approach captures the most valuable signals:

- **Confidence scores** (0.0-1.0) — for quality tracking and pipeline gating
- **Verdicts** (PROVEN/REFUTED/CONTESTED/INSUFFICIENT) — for consensus decisions
- **Provenance links** (researchId → consensusReportId) — for pipeline traceability
- **Validation pass/fail** — for protocol compliance metrics

### 3.3 File-Based + SQLite Metadata

Document-like data (research findings, evidence chains, voting arguments) maps poorly to relational tables. Keeping documents as files preserves their natural format. Recording key metadata in `lifecycle_stages` enables cross-session queries and dashboard aggregation without duplicating document content.

### 3.4 ct complete as Primary Gate

`ct complete` is the natural integration point because:
- Agents already call it (zero workflow change)
- Exit codes 60-67 are already defined for protocol violations
- Blocking gate prevents incomplete outputs from being marked done
- The existing `src/core/validation/protocols/` directory is scaffolded for this

---

## 4. Consequences

### Positive

- Pipeline acronym accurately reflects the 5-stage planning model (RCASD)
- Protocol output quality is validated at completion time
- Key metadata is queryable in SQLite for metrics and dashboards
- Provenance chain (research → consensus → spec) is machine-verifiable
- `@deprecated` re-exports provide backward compatibility during transition

### Negative

- Rename touches ~200 references across 3 phases — non-trivial coordination
- Symlink transition period for `.cleo/rcsd/` adds temporary complexity
- Hybrid validation covers only critical fields — deep evidence chains remain unvalidated
- New Zod schemas add maintenance surface (4 files)

### Neutral

- Archived JSON Schema files remain in `schemas/archive/` as historical reference
- Historical ADR content is not rewritten (footnotes added instead)
- `lifecycle_stages` table gains optional columns — no breaking migration

---

## 5. Implementation Files

### New Files

| File | Purpose |
|------|---------|
| `src/core/validation/protocols/research.ts` | ResearchOutputMeta Zod schema (extend existing) |
| `src/core/validation/protocols/consensus.ts` | ConsensusOutputMeta Zod schema (extend existing) |
| `src/core/validation/protocols/specification.ts` | SpecFrontmatter Zod schema (extend existing) |
| `src/core/validation/protocols/contribution.ts` | ContributionMeta Zod schema (new) |
| `src/core/validation/protocols/index.ts` | Protocol validator registry and dispatcher |

### Modified Files

| File | Change |
|------|--------|
| `src/core/lifecycle/index.ts` | RCSD → RCASD rename + deprecated re-exports |
| `src/core/tasks/complete.ts` | Protocol validation gate |
| `src/store/schema.ts` | Optional columns on lifecycle_stages |
| `drizzle/` | Migration for schema extension |

---

## 6. Related Work

| Task/Epic | Relationship |
|-----------|-------------|
| T4798 (RCSD Lifecycle Pipeline Review) | Parallel — rename SHOULD land before T4800 |
| T4800 (SQLite Pipeline State Machine) | Extends lifecycle_stages table created by T4800 |
| T4844 (RCASD Audit Logging) | Already uses "RCASD" — not blocked |
| T4879 (IVTR Protocol Decomposition) | Subsequent work — extends validation to execution stages |
| T4786 (AJV→drizzle-zod migration) | Context — why schemas were archived |
