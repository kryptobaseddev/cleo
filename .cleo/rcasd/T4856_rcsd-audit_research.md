# T4856: RCSD Reference Audit — Research Document

**Task:** T4856 — Research: Audit all RCSD references and map current state
**Parent:** T4855 — RCSD Schema Review & RCASD Rename Analysis
**Date:** 2026-02-25
**Status:** Complete

---

## 1. Source Code — Canonical Definitions

### `src/core/lifecycle/stages.ts` (Canonical Stage Source of Truth)

| Line | Reference | Status |
|------|-----------|--------|
| 3-4 | Header: "10-stage RCSD-IVTR lifecycle model" | **Active** — accurate description, acronym stale |
| 38 | Comment: "Consolidates: RCSD_STAGES, EXECUTION_STAGES, ENGINE_LIFECYCLE_STAGES" | **Active** — audit reference |
| 40-50 | `PIPELINE_STAGES` array — 9 ordered stages including `architecture_decision` at position 3 | **Active** — canonical. Contains the "A" stage but array name doesn't use RCSD/RCASD |

**Key finding:** `PIPELINE_STAGES` is the single source of truth. It correctly includes `architecture_decision` as stage 3 but the file header still says "RCSD-IVTR" instead of "RCASD-IVTR".

### `src/core/lifecycle/index.ts` (Lifecycle Exports)

| Line | Reference | Status |
|------|-----------|--------|
| 2 | Header: "RCSD pipeline lifecycle" | **Active** — stale acronym |
| 16 | Comment: "RCSD pipeline stages in order" | **Active** — stale acronym |
| 17 | `RCSD_STAGES` const (5 stages including `architecture_decision`) | **Active** — stale variable name |
| 18 | `RcsdStage` type | **Active** — stale type name |
| 30-41 | `RcsdManifest` interface | **Active** — stale interface name |

**Key finding:** This file defines the primary API types that downstream code imports. `RCSD_STAGES`, `RcsdStage`, and `RcsdManifest` are the most impactful symbols to rename.

### `src/core/lifecycle/pipeline.ts` (SQLite Pipeline State Machine)

| Line | Reference | Status |
|------|-----------|--------|
| 4 | Header: "unified RCSD-IVTR lifecycle" | **Active** — stale acronym in comment |
| 9 | Stage list in comment correctly shows all 9 stages including Architecture Decision | **Active** — description is accurate, acronym is not |

### `src/core/lifecycle/resume.ts`

| Line | Reference | Status |
|------|-----------|--------|
| Various | References `lifecycle_pipelines` table | **Active** — table name doesn't contain RCSD |
| Various | RCSD referenced in comments only | **Active** — stale acronym in comments |

### `src/core/skills/types.ts`

| Line | Reference | Status |
|------|-----------|--------|
| 79 | Comment: "RCSD-IVTR protocol types" | **Active** — stale acronym |
| 80-89 | `SkillProtocolType` union — 9 values (no `architecture_decision`, has `artifact-publish` and `provenance` instead) | **Active** — note: skill protocols diverge from pipeline stages |

**Key finding:** `SkillProtocolType` does NOT include `architecture_decision` or `validation`/`testing`. It includes `artifact-publish` and `provenance` which are NOT pipeline stages. The skill protocol type set is a superset/different-set from lifecycle stages.

---

## 2. Protocol Enforcement

### `src/mcp/lib/protocol-enforcement.ts`

| Line | Reference | Status |
|------|-----------|--------|
| 7 | Comment: "RCSD-IVTR lifecycle compliance" | **Active** — stale acronym |
| 19 | Comment: "Protocol types aligned with RCSD-IVTR lifecycle" | **Active** — stale acronym |
| 21-32 | `ProtocolType` enum — 10 values including `ARCHITECTURE_DECISION` | **Active** — enum values are correct, comment is stale |
| 37-48 | `PROTOCOL_EXIT_CODES` mapping — `ARCHITECTURE_DECISION` maps to `E_PROTOCOL_GENERIC` | **Active** — note: AD has no dedicated exit code |

### `src/mcp/lib/protocol-rules.ts`

| Line | Reference | Status |
|------|-----------|--------|
| 6-9 | Comment: "7 RCSD-IVTR protocols" | **Active** — stale count (should be 10) and acronym |

### Other enforcement files (25 files total with RCSD references in `src/`)

- `src/mcp/lib/gate-validators.ts` — 2 occurrences (comments)
- `src/mcp/lib/verification-gates.ts` — 1 occurrence (comment)
- `src/mcp/lib/PROTOCOL-ENFORCEMENT.md` — 6 occurrences (documentation)
- `src/mcp/engine/lifecycle-engine.ts` — 1 occurrence (comment)
- `src/dispatch/domains/pipeline.ts` — 1 occurrence (comment)
- `src/dispatch/lib/engine.ts` — referenced via import chain
- `src/cli/commands/lifecycle.ts` — 1 occurrence (comment)

---

## 3. Test Files

| File | Count | Type |
|------|-------|------|
| `src/mcp/__tests__/fixtures/lifecycle-scenarios.ts` | 14 | Fixture data with RCSD stage names |
| `src/mcp/lib/__tests__/lifecycle-gates.test.ts` | 11 | Gate validation tests |
| `src/mcp/__tests__/e2e/lifecycle-workflow.test.ts` | 9 | E2E lifecycle tests |
| `src/mcp/engine/__tests__/lifecycle-engine.test.ts` | 6 | Engine adapter tests |
| `src/core/lifecycle/__tests__/pipeline.integration.test.ts` | 3 | Pipeline integration tests |
| `src/core/lifecycle/__tests__/lifecycle.test.ts` | 2 | Core lifecycle tests |
| `src/mcp/lib/__tests__/protocol-enforcement.test.ts` | 1 | Protocol enforcement tests |
| `src/mcp/lib/__tests__/protocol-compliance.test.ts` | 1 | Compliance tests |
| `src/mcp/__tests__/e2e/error-handling.test.ts` | 1 | Error handling tests |
| `src/mcp/__tests__/fixtures/protocol-violations.ts` | 1 | Protocol violation fixtures |

**Total:** 49 occurrences across 10 test files.

---

## 4. On-Disk Artifacts (`.cleo/rcsd/`)

### Directory Structure

```
.cleo/rcsd/
├── RCSD-INDEX.json              # Master index — zeroed/empty (0 tasks, 0 specs)
├── README.md                    # Documents RCSD (4-stage) pipeline structure
└── 19 task directories:
    T3080/ T3951/ T4065/ T4067/ T4068/ T4069/
    T4130/ T4132/ T4133/ T4134/ T4176/ T4178/
    T4179/ T4180/ T4352/ T4386/ T4387/ T4431/ T4479/
```

### `RCSD-INDEX.json`
- Status: **Stale** — zeroed out (all counts 0, empty arrays)
- Schema ref: `https://claude-todo.dev/schemas/v1/rcsd-index.schema.json` (archived)

### `README.md`
- Status: **Stale** — documents the original 4-stage RCSD pipeline (Research → Consensus → Spec → Decompose)
- References old `.claude/rcsd/` path (line 8) instead of `.cleo/rcsd/`
- References schemas that are now in `schemas/archive/`
- Does NOT mention Architecture Decision stage

### Per-Task Directories
- Each contains `_manifest.json` files tracking pipeline state
- Format follows archived `rcsd-manifest.schema.json`
- These are the working artifacts of past RCSD research runs

---

## 5. Archived Schemas (`schemas/archive/`)

### 5a. `rcsd-research-output.schema.json` (v1.0.0)
- **Validates:** Research phase JSON output
- **Required fields:** `$schema`, `_meta` (researchId, taskId, shortName, createdAt), `query`, `status`, `sources`, `findings`
- **Relationship:** Validates output of research protocol (`protocols/research.md`)
- **Status:** Archived — actual research now uses markdown files + MANIFEST.jsonl entries

### 5b. `rcsd-consensus-report.schema.json` (v1.0.0)
- **Validates:** Consensus phase JSON output
- **Required fields:** `$schema`, `_meta` (reportId, taskId, shortName, createdAt), `researchRef`, `agents`, `claims`, `synthesis`, `statistics`
- **Relationship:** Validates output of consensus protocol with voting matrix and confidence scores
- **Status:** Archived — consensus now uses markdown reports + MANIFEST.jsonl entries

### 5c. `rcsd-spec-frontmatter.schema.json` (v1.0.0)
- **Validates:** YAML frontmatter in specification documents
- **Required fields:** `version`, `status`, `taskId`, `shortName`, `domain`, `synopsis`, `created`, `pipelineStage`
- **Status enum:** DRAFT, APPROVED, ACTIVE, IMMUTABLE, DEPRECATED
- **Relationship:** Validates metadata in `-SPEC.md` documents
- **Status:** Archived — specs still use frontmatter but validation isn't enforced at runtime

### 5d. `contribution.schema.json` (v2.0.0)
- **Validates:** Multi-agent contribution records
- **Required fields:** `$schema`, `_meta` (contributionId, createdAt, agentId), `sessionId`, `epicId`, `taskId`, `markerLabel`, `researchOutputs`, `decisions`
- **Relationship:** Validates output of contribution protocol
- **Status:** Archived — contributions now tracked via task completion + session records

### 5e. `rcsd-index.schema.json`
- **Validates:** The `RCSD-INDEX.json` master index
- **Status:** Archived — the index itself is zeroed out and unused

### 5f. `rcsd-manifest.schema.json`
- **Validates:** Per-epic `_manifest.json` files in task directories
- **Status:** Archived — pipeline state moving to SQLite (`lifecycle_pipelines` table per T4800)

### 5g. `rcsd-hitl-resolution.schema.json`
- **Validates:** Human-in-the-loop resolution records
- **Status:** Archived — HITL decisions now tracked through session records

---

## 6. Documentation

### Mintlify Docs (20 files, 46 occurrences)

**High-impact files:**
| File | Count | Content |
|------|-------|---------|
| `docs/mintlify/ROADMAP.md` | 8 | Roadmap references to RCSD pipeline |
| `docs/mintlify/specs/DECISION-LIFECYCLE-SPEC.md` | 6 | Decision lifecycle spec |
| `docs/mintlify/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md` | 4 | Strategic roadmap |
| `docs/mintlify/specs/CLEO-WEB-DASHBOARD-SPEC.md` | 3 | Dashboard spec |
| `docs/mintlify/docs.json` | 3 | Navigation/sidebar config |
| `docs/mintlify/concepts/cognitive-architecture.mdx` | 2 | Architecture concepts |
| `docs/mintlify/llms.txt` | 2 | LLM context file |
| `docs/mintlify/SUMMARY.md` | 2 | Documentation summary |
| `docs/mintlify/changelog/overview.mdx` | 2 | Changelog |
| `docs/mintlify/guides/troubleshooting.md` | 2 | Troubleshooting guide |
| `docs/mintlify/specs/PROTOCOL-ENFORCEMENT-SPEC.md` | 2 | Protocol enforcement |

### ADRs (`.cleo/adrs/`)

| File | Status |
|------|--------|
| `ADR-006-canonical-sqlite-storage.md` | **Historical** — references RCSD manifest migration to SQLite |
| `ADR-007-domain-consolidation.md` | **Historical** — references RCSD domain routing |
| `ADR-008-CLEO-CANONICAL-ARCHITECTURE.md` | **Historical** — canonical architecture with RCSD pipeline |
| `ADR-009-BRAIN-cognitive-architecture.md` | **Historical** — BRAIN architecture references RCSD |
| `archive/ADR-002-hybrid-storage-strategy.md` | **Archived** — old storage strategy |

### Agent Injection Templates

| File | RCSD Refs |
|------|-----------|
| `CLAUDE.md` | Indirect via `@.cleo/templates/AGENT-INJECTION.md` — references "RCSD-IVTR" in lifecycle description, "RCSD Pipeline" in protocol types |
| `.cleo/rcsd/README.md` | Direct — "Research-Consensus-Spec-Decompose (RCSD)" |
| `~/.cleo/templates/CLEO-INJECTION.md` | References "RCSD Pipeline" in protocol lifecycle |

**Note:** `AGENTS.md` and `GEMINI.md` do NOT contain direct RCSD references (confirmed via grep).

---

## 7. Summary Statistics

| Category | Files | Occurrences |
|----------|-------|-------------|
| Source code (`src/`) | 23 | 87 |
| - Production code | 13 | 38 |
| - Test files | 10 | 49 |
| Documentation (`docs/`) | 20 | 46 |
| ADRs (`.cleo/adrs/`) | 5 | ~15 |
| Agent templates | 3 | ~8 |
| On-disk artifacts (`.cleo/rcsd/`) | 21 | ~30 |
| Archived schemas | 7 | ~14 (filenames + internal refs) |
| **Total** | **~79** | **~200** |

---

## 8. Key Findings

1. **The "A" (Architecture Decision) stage exists in code but RCSD acronym was never updated.** `PIPELINE_STAGES` correctly includes `architecture_decision` at position 3. `ProtocolType` enum includes `ARCHITECTURE_DECISION`. But every comment and variable name still says "RCSD".

2. **Three distinct type systems reference the stages differently:**
   - `PIPELINE_STAGES` (stages.ts): 9 ordered stages — canonical
   - `SkillProtocolType` (skills/types.ts): 9 values but different set (includes `artifact-publish`, `provenance`; excludes `architecture_decision`, `validation`, `testing`)
   - `ProtocolType` enum (protocol-enforcement.ts): 10 values including all stages + `ARCHITECTURE_DECISION`

3. **On-disk `RCSD-INDEX.json` is zeroed out and stale.** Pipeline state is migrating to SQLite per T4800.

4. **`.cleo/rcsd/README.md` is doubly stale:** references old 4-stage pipeline AND old `.claude/` path.

5. **Archived schemas defined rich structured validation** (confidence scores, voting matrices, evidence chains) that the current markdown + MANIFEST.jsonl approach does not enforce. Whether to restore this validation is a design question for T4857/T4859.

6. **87 source code occurrences across 23 files** — a rename is non-trivial but well-scoped since most are comments. Only ~10 are in exported symbol names.
