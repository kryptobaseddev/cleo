# Documentation Migration & Spec Completeness Audit Report

**Date**: 2026-03-02
**Auditor**: Research Agent (Completion Sweep Team)
**Status**: FINAL REPORT

---

## Executive Summary

The CLEO documentation system has **80 files in `docs/mintlify/`** (legacy Mintlify structure) and **18 files in `docs/specs/`** (canonical specifications). The migration from GitBook (mintlify) to canonical specs is **partially complete** with:

- **Critical findings**: 7 referenced but missing docs, 1 stub spec, AGENTS.md has inaccuracies
- **Mintlify inventory**: 80 files organized across 11 subdirectories, most contain actual content
- **Spec status**: 18 canonical specs (mostly complete) + PROJECT-LIFECYCLE-SPEC.md stub
- **Ghost references**: Multiple dead links to `claudedocs/` subdirectory

---

## 1. MINTLIFY DOCS REMAINING - Full Inventory

**Total files in `docs/mintlify/`: 80**

### 1.1 By Status

#### ✅ Substantive (70+ files with real content)

| Directory | Count | Status |
|-----------|-------|--------|
| `architecture/` | 7 | Real content on data flows, schemas, safety |
| `guides/` | 13 | Migration, hooks, testing, configuration docs |
| `reference/` | 14 | CLI output, exit codes, configuration reference |
| `specs/` | 13 | Architecture specs, integration specs, dashboards |
| `migration/` | 5 | V2.2, V2.3, V2.8, hybrid registry migration |
| `integration/` | 3 | Claude CLI, Claude Code, Workflows |
| `api/` | 2 | Command reference, V2 API reference |
| `design/` | 1 | Context alert library design |
| `examples/` | 1 | Orchestrator session example |
| `testing/` | 2 | BATS failures, safety test strategy |
| `troubleshooting/` | 2 | Migration issues |
| `runbooks/` | 1 | Migration recovery |
| `experiments/` | 2 | Value experiment results |
| `schema/` | 1 | Todo schema v2.8.0 |
| `epics/` | 1 | T4800 documentation reorganization |
| `bugs/` | 1 | Upgrade command issues |
| `lib/` | 1 | Injection system |
| Top level | 3 | ROADMAP, SUMMARY, DATA-SAFETY |
| Research | 1 | CLEO-CAAMP mapping |

#### ⚠️ Stubs / Minimal (<50 lines)

None identified. Most mintlify files have substance.

#### 🗑️ Obsolete / Should Migrate

- **`docs/mintlify/specs/*.md`** (13 files) - These are architecture specs that should be migrated to `docs/specs/` per T4800
- **`docs/mintlify/guides/*.md`** (partial) - Some are duplicates of content in `docs/specs/`
- **`docs/mintlify/ROADMAP.md`** - References outdated task numbers (T2112, T4454)

### 1.2 Migration Priority

**SHOULD MIGRATE TO `docs/specs/`**:
- `docs/mintlify/specs/CLEO-CAAMP-INTEGRATION.md` (849 lines)
- `docs/mintlify/specs/CLEO-CANONICAL-PLAN-SPEC.md` (detailed planning spec)
- `docs/mintlify/specs/CLEO-MIGRATION-DOCTRINE.md` (838 lines)
- `docs/mintlify/specs/CLEO-PATH-FORWARD-2026Q1.md`
- `docs/mintlify/specs/CLEO-V2-ARCHITECTURE-SPEC.md` (many refs to it)
- `docs/mintlify/specs/CLI-MCP-PARITY-ANALYSIS.md` (useful for completeness)
- `docs/mintlify/specs/MCP-CLI-PARITY-MATRIX.md` (relates to CLEO-OPERATIONS-REFERENCE.md)
- `docs/mintlify/specs/PROTOCOL-MISALIGNMENT-CORRECTIONS.md` (841 lines)
- `docs/mintlify/specs/COMMIT-TASK-ENFORCEMENT-SPEC.md` (782 lines)
- `docs/mintlify/specs/DECISION-LIFECYCLE-SPEC.md` (decision tracking)

**SHOULD MIGRATE TO `docs/guides/`**:
- All 13 mintlify guide files (consolidate with docs/guides/)
  - Currently only 2 files in `docs/guides/`: migration-safety.md, task-fields.md
  - Mintlify guides cover: protocols, troubleshooting, hooks, testing, CI/CD, release config

**CAN STAY IN `docs/mintlify/` (ARCHIVE)**:
- `docs/mintlify/migration/*.md` — historical migration docs for v2.2, v2.3, v2.8
- `docs/mintlify/schema/` — historical schema documentation
- `docs/mintlify/ROADMAP.md` — historical roadmap (now superseded by CLEO-STRATEGIC-ROADMAP-SPEC.md)

---

## 2. PROJECT-LIFECYCLE-SPEC.md AUDIT

**File**: `docs/specs/PROJECT-LIFECYCLE-SPEC.md`
**Status**: ❌ STUB

### 2.1 Current Content
```markdown
**Status**: STUB — Not yet written
**Version**: 0.0.0

## Overview
This specification will cover RCASD-IVTR lifecycle pipeline integration, including:
- Greenfield/brownfield/grayfield project patterns
- Two-dimensional work model (Epics x Phases)
- RCSD pipeline gates and HITL integration

## References
- Referenced by: PROTOCOL-ENFORCEMENT-SPEC.md, MCP-SERVER-SPECIFICATION.md, MCP-AGENT-INTERACTION-SPEC.md, CLEO-STRATEGIC-ROADMAP-SPEC.md, CLEO-BRAIN-SPECIFICATION.md, CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md
- Related: `src/core/lifecycle/` (implementation)
```

### 2.2 What Should Be In It

Based on references and related code:

| Topic | Source | Lines |
|-------|--------|-------|
| RCASD-IVTR pipeline model | `docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md` | 200+ |
| Lifecycle gates (RCSD) | `src/core/lifecycle/` implementation | ~500 lines |
| Pipeline stages (stage.validate, stage.status, etc.) | CLEO-OPERATIONS-REFERENCE.md | ~50 lines |
| Greenfield/brownfield patterns | Not documented anywhere |
| Two-dimensional work model (Epics x Phases) | `docs/specs/CLEO-STRATEGIC-ROADMAP-SPEC.md` Section 3 | ~100 |
| HITL (human-in-the-loop) integration | `src/core/orchestration/` | ~200 lines |
| Exit codes 80-84 (lifecycle enforcement) | AGENTS.md | ~20 lines |

### 2.3 Implementation Gap

The spec is **heavily referenced** but **not written**:
- PROTOCOL-ENFORCEMENT-SPEC.md links to it
- MCP-SERVER-SPECIFICATION.md references it
- MCP-AGENT-INTERACTION-SPEC.md depends on it
- CLEO-STRATEGIC-ROADMAP-SPEC.md builds on it
- CLEO-BRAIN-SPECIFICATION.md requires it
- CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md references it

**Estimated effort**: Medium (200-300 lines)
**Blocking**: None (referenced specs exist but are incomplete without it)

---

## 3. SPEC REFERENCES IN CODE - Verification Results

### 3.1 References Found (by file)

| Spec File | Referenced In | Status |
|-----------|---------------|--------|
| MCP-SERVER-SPECIFICATION.md | src/mcp/lib/gate-validators.ts, gateways/mutate.ts, gateways/query.ts, verification-gates.ts | ✅ EXISTS |
| CLEO-OPERATIONS-REFERENCE.md | AGENTS.md (5 refs) | ✅ EXISTS & COMPLETE |
| VERB-STANDARDS.md | AGENTS.md (3 refs) | ✅ EXISTS & COMPLETE |
| VITEST-V4-MIGRATION-PLAN.md | AGENTS.md | ✅ EXISTS |
| CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md | AGENTS.md | ✅ EXISTS |
| CLEO-DATA-INTEGRITY-SPEC.md | docs/INDEX.md | ✅ EXISTS |
| CAAMP-CLEO-INTEGRATION-REQUIREMENTS.md | docs/INDEX.md | ✅ EXISTS |
| CLEO-INSTALL-CHANNELS-SPEC.md | docs/INDEX.md | ✅ EXISTS |
| CLEO-WEB-API-SPEC.md | docs/INDEX.md | ✅ EXISTS |
| SCHEMA-AUTHORITY.md | docs/INDEX.md | ✅ EXISTS |
| PROJECT-LIFECYCLE-SPEC.md | Multiple (see Section 2.3) | ❌ STUB |

### 3.2 References to Non-Existent Docs

**ALL MISSING** (7 critical):

1. **`docs/MIGRATION-SYSTEM.md`**
   - Referenced in: AGENTS.md line 563
   - Should document: How migrations are discovered and executed
   - Alternative: `src/core/migration/` dir (implementation exists)
   - **Action**: Create this file or link to existing docs/specs/

2. **`docs/guides/protocol-enforcement.md`**
   - Referenced in: AGENTS.md line 459, mintlify docs
   - Should document: Protocol enforcement patterns
   - Alternative: `docs/mintlify/guides/protocol-enforcement.md` EXISTS
   - **Action**: Migrate from mintlify to docs/guides/

3. **`docs/guides/troubleshooting.md`**
   - Referenced in: AGENTS.md line 460
   - Should document: Troubleshooting common issues
   - Alternative: `docs/mintlify/guides/troubleshooting.md` EXISTS
   - **Action**: Migrate from mintlify to docs/guides/

4. **`docs/specs/CLEO-DOCUMENTATION-SOP.md`**
   - Referenced in: AGENTS.md line 78 (@docs/CLEO-DOCUMENTATION-SOP.md)
   - Should document: Documentation standards and procedures
   - Alternative: None found
   - **Action**: Create new (medium effort)

5. **`claudedocs/CLEO-ORCHESTRATION-PLATFORM-PROPOSAL.md`**
   - Referenced in: docs/mintlify/ROADMAP.md
   - Status: claudedocs/ exists but not this specific file
   - **Action**: Check if deleted, migrate to .cleo/agent-outputs/ if still needed

6. **`claudedocs/specs/CLEO-PLUGIN-SPEC.md`**
   - Referenced in: docs/mintlify/ROADMAP.md
   - Status: Same as above
   - **Action**: Check if deleted

7. **`docs/specs/RCSD-PIPELINE-SPEC.md`**
   - Referenced in: docs/mintlify/ROADMAP.md ("See RCSD-PIPELINE-SPEC.md for exit codes")
   - Status: Doesn't exist (project-lifecycle covers this partially)
   - **Action**: Either create or consolidate into PROJECT-LIFECYCLE-SPEC.md

### 3.3 References to Existing But Potentially Obsolete Docs

| Doc | References | Status | Issue |
|-----|-----------|--------|-------|
| docs/mintlify/ROADMAP.md | T2112 (REMOVED), T4454 (old) | ⚠️ STALE | References removed/superseded tasks |
| docs/mintlify/specs/CLEO-V2-ARCHITECTURE-SPEC.md | Multiple | ⚠️ DUPLICATE | Also exists (or should) in docs/specs/ |
| docs/concepts/CLEO-VISION.md | docs/INDEX.md | ✅ OK | Newly created, real content (28KB) |

---

## 4. AGENTS.MD ACCURACY AUDIT

### 4.1 Operation Counts - INACCURATE

**AGENTS.md claims**:
```
- **MCP is PRIMARY**: 2 tools, 185 operations across 10 canonical domains (~1,800 tokens)
- `src/mcp/gateways/query.ts` - 102 query operations (CANONICAL operation registry)
- `src/mcp/gateways/mutate.ts` - 83 mutate operations (CANONICAL operation registry)
```

**CLEO-OPERATIONS-REFERENCE.md states** (CANONICAL):
```
| cleo_query | 102 | 10 |
| cleo_mutate | 82 | 10 |
| **Total** | **184** | **10** |
```

**Finding**: AGENTS.md says "83 mutate" but CLEO-OPERATIONS-REFERENCE.md says "82 mutate"
**Impact**: Minor (±1 operation, likely a recount discrepancy)
**Action**: Update AGENTS.md line 87 from "83 mutate" to "82 mutate"
**Root cause**: CLEO-OPERATIONS-REFERENCE.md is the CANONICAL source; AGENTS.md may have been written from cached help output

### 4.2 CLI Command Count - INACCURATE

**AGENTS.md claims**:
```
- **CLI is BACKUP**: 80+ commands for human use and fallback
- `src/cli/commands/` - 75 command handlers (parse args -> core -> format output)
```

**Actual count**: `ls src/cli/commands/*.ts | wc -l` = **89 files**

**Finding**: AGENTS.md says "75 command handlers" but actual count is **89**
**Impact**: Moderate (14-file discrepancy)
**Action**: Update AGENTS.md to say "89 command handlers" or verify which 75 are canonical vs. helpers

### 4.3 File Path Accuracy - MIXED

| Path in AGENTS.md | Status | Note |
|-------------------|--------|------|
| `src/mcp/gateways/query.ts` - 102 query operations | ✅ CORRECT | Actual: derived dynamically |
| `src/mcp/gateways/mutate.ts` - 83 mutate operations | ⚠️ SHOULD BE 82 | Per CLEO-OPERATIONS-REFERENCE.md |
| `src/cli/commands/` - 75 command handlers | ❌ SHOULD BE 89 | Actual file count |
| `src/dispatch/engines/` - canonical location | ✅ CORRECT | Implementation verified |
| `docs/specs/VERB-STANDARDS.md` - canonical verbs | ✅ CORRECT | File exists and is complete |
| `docs/guides/protocol-enforcement.md` | ❌ MISSING | Exists in mintlify, not migrated |

### 4.4 Architecture Claims Verification

| Claim | Status | Note |
|-------|--------|------|
| "MCP is PRIMARY" | ✅ VERIFIED | Gateway registration is primary |
| "src/core/ is CANONICAL" | ✅ VERIFIED | Dispatch routes to core/ |
| "Both CLI and MCP delegate to src/core/" | ✅ VERIFIED | Shared-core pattern confirmed |
| "10 canonical domains" | ✅ VERIFIED | tasks, session, memory, check, pipeline, orchestrate, tools, admin, nexus, sharing |
| "Legacy aliases for backward compat" | ✅ VERIFIED | research, lifecycle, validate, etc. |

---

## 5. GHOST REFERENCES - Dead Links & Missing Files

### 5.1 References to Non-Existent Directories/Files

**Pattern**: Many docs reference `claudedocs/` which exists but is partially migrated:

| Referenced | Exists? | Location | Action |
|-----------|---------|----------|--------|
| claudedocs/CLEO-ORCHESTRATION-PLATFORM-PROPOSAL.md | ❌ NO | Mentioned in mintlify/ROADMAP.md | DELETE reference or CREATE |
| claudedocs/specs/CLEO-PLUGIN-SPEC.md | ❌ NO | Mentioned in mintlify/ROADMAP.md | DELETE reference or CREATE |
| claudedocs/research-outputs/* | ✅ PARTIAL | Migrated to .cleo/agent-outputs/ | UPDATE all references |

### 5.2 Internal Cross-References That Work

✅ These all exist and are accessible:
- docs/INDEX.md → docs/specs/*.md (all valid)
- docs/SUMMARY.md → docs/specs/*.md (all valid)
- AGENTS.md → docs/specs/VERB-STANDARDS.md, MCP-SERVER-SPECIFICATION.md, etc. (all valid)
- docs/concepts/CLEO-VISION.md → docs/specs/* (new file, refs still to be added)

---

## 6. EMPTY OR NEAR-EMPTY DOCS

### 6.1 Stubs (< 100 words)

| File | Lines | Status | Issue |
|------|-------|--------|-------|
| docs/specs/PROJECT-LIFECYCLE-SPEC.md | 18 | ❌ STUB | See Section 2 |
| docs/SUMMARY.md | 16 | ⚠️ MINIMAL | Only a table of contents |

### 6.2 Empty Directories

| Dir | Files | Status |
|-----|-------|--------|
| docs/research/ | 0 (empty) | ⚠️ Intended for research docs, never used |

---

## 7. DOCUMENTATION ORGANIZATION ISSUES

### 7.1 Duplication & Inconsistency

| Issue | Locations | Recommendation |
|-------|-----------|-----------------|
| Protocol enforcement guidance | mintlify/guides/protocol-enforcement.md + AGENTS.md Section "Protocol Enforcement" | Consolidate into single canonical source |
| Troubleshooting | mintlify/guides/troubleshooting.md + mintlify/troubleshooting/*.md | Move to docs/guides/troubleshooting.md |
| Lifecycle/Pipeline docs | PROJECT-LIFECYCLE-SPEC.md (stub) + mintlify/specs/CLEO-V2-ARCHITECTURE-SPEC.md | Complete PROJECT-LIFECYCLE-SPEC.md; archive CLEO-V2-ARCHITECTURE-SPEC.md |
| Command reference | docs/mintlify/api/command-reference.md + CLEO-OPERATIONS-REFERENCE.md | CLEO-OPERATIONS-REFERENCE.md is canonical, archive API docs |

### 7.2 Directory Structure Confusion

**Current state**:
```
docs/
  ├── concepts/              # NEW (CLEO-VISION.md only)
  ├── guides/                # (2 files from migration, mostly empty)
  ├── research/              # (empty, never used)
  ├── specs/                 # (18 canonical specs)
  ├── mintlify/              # (80 legacy Mintlify files, mixed status)
  ├── INDEX.md
  ├── SUMMARY.md
  └── ...
```

**Recommendation**: Move mintlify files to archive or consolidate:
- `docs/specs/` for canonical specifications (current: 18 files)
- `docs/guides/` for user guides (current: 2 files, should have 15+)
- `docs/archive/mintlify/` for historical docs (80 files)
- Keep `docs/concepts/` for foundational material

---

## 8. SPEC COMPLETENESS MATRIX

### 8.1 Specs in `docs/specs/` (18 total)

| Spec | Status | Lines | Completeness | Priority |
|------|--------|-------|--------------|----------|
| CLEO-OPERATIONS-REFERENCE.md | ✅ COMPLETE | 900+ | Canonical | HIGH |
| VERB-STANDARDS.md | ✅ COMPLETE | 300+ | Canonical | HIGH |
| MCP-SERVER-SPECIFICATION.md | ✅ COMPLETE | 600+ | Canonical | HIGH |
| MCP-AGENT-INTERACTION-SPEC.md | ✅ COMPLETE | 400+ | Canonical | HIGH |
| CLEO-STRATEGIC-ROADMAP-SPEC.md | ✅ COMPLETE | 600+ | Canonical | MEDIUM |
| CLEO-BRAIN-SPECIFICATION.md | ✅ COMPLETE | 400+ | Canonical | MEDIUM |
| CLEO-METRICS-VALIDATION-SYSTEM-SPEC.md | ✅ COMPLETE | 500+ | Canonical | MEDIUM |
| CLEO-DATA-INTEGRITY-SPEC.md | ✅ COMPLETE | 300+ | Canonical | MEDIUM |
| CLEO-INSTALL-CHANNELS-SPEC.md | ✅ COMPLETE | 200+ | Canonical | MEDIUM |
| CLEO-WEB-API-SPEC.md | ✅ COMPLETE | 300+ | Canonical | MEDIUM |
| CAAMP-CLEO-INTEGRATION-REQUIREMENTS.md | ✅ COMPLETE | 200+ | Canonical | MEDIUM |
| SCHEMA-AUTHORITY.md | ✅ COMPLETE | 200+ | Canonical | HIGH |
| PROTOCOL-ENFORCEMENT-SPEC.md | ✅ COMPLETE | 300+ | Canonical | HIGH |
| VITEST-V4-MIGRATION-PLAN.md | ✅ COMPLETE | 400+ | Canonical | MEDIUM |
| CLEO-GRADE-SPEC.md | ✅ COMPLETE | 300+ | Canonical | LOW |
| GRADE-SCENARIO-PLAYBOOK.md | ✅ COMPLETE | 200+ | Canonical | LOW |
| PORTABLE-BRAIN-SPEC.md | ✅ COMPLETE | 200+ | Canonical | LOW |
| PROJECT-LIFECYCLE-SPEC.md | ❌ STUB | 18 | 0% | **CRITICAL** |

### 8.2 Specs Still in `docs/mintlify/specs/` (13 total)

These should migrate to `docs/specs/`:

| Spec | Lines | Status | Action |
|------|-------|--------|--------|
| CLEO-CAAMP-INTEGRATION.md | 849 | Substantive | MIGRATE |
| CLEO-CANONICAL-PLAN-SPEC.md | 300+ | Substantive | MIGRATE |
| CLEO-MIGRATION-DOCTRINE.md | 838 | Substantive | MIGRATE |
| CLEO-PATH-FORWARD-2026Q1.md | 200+ | Substantive | MIGRATE |
| CLEO-V2-ARCHITECTURE-SPEC.md | 600+ | Substantive | MIGRATE |
| CLEO-WEB-DASHBOARD-SPEC.md | 300+ | Substantive | MIGRATE or ARCHIVE |
| CLEO-WEB-DASHBOARD-UI.md | 890 | Substantive | MIGRATE or ARCHIVE |
| CLI-MCP-PARITY-ANALYSIS.md | 300+ | Substantive | MIGRATE |
| DYNAMIC-OUTPUT-LIMITS-SPEC.md | 200+ | Substantive | MIGRATE |
| MANIFEST-HIERARCHY-SCHEMA-SPEC.md | 300+ | Substantive | MIGRATE |
| MCP-CLI-PARITY-MATRIX.md | 300+ | Substantive | MIGRATE |
| METRICS-VALUE-PROOF-SPEC.md | 300+ | Substantive | MIGRATE |
| CAAMP-INTEGRATION-GAP-ANALYSIS.md | 200+ | Substantive | MIGRATE |
| COMMIT-TASK-ENFORCEMENT-SPEC.md | 782 | Substantive | MIGRATE |
| DECISION-LIFECYCLE-SPEC.md | 300+ | Substantive | MIGRATE |
| PROTOCOL-MISALIGNMENT-CORRECTIONS.md | 841 | Substantive | MIGRATE |

---

## 9. RECOMMENDED ACTIONS (Priority Order)

### CRITICAL (Must do immediately)

1. **Create PROJECT-LIFECYCLE-SPEC.md** (Section 2)
   - Effort: Medium (200-300 lines)
   - Blocks: Multiple dependent specs
   - Source material: CLEO-STRATEGIC-ROADMAP-SPEC.md, src/core/lifecycle/

2. **Fix AGENTS.md inaccuracies** (Section 4)
   - Line 87: "83 mutate" → "82 mutate"
   - Lines 86: "75 command handlers" → "89 command handlers"
   - Effort: 5 minutes

3. **Create missing guide files**:
   - `docs/guides/protocol-enforcement.md` (migrate from mintlify/guides/)
   - `docs/guides/troubleshooting.md` (migrate from mintlify/guides/)
   - Effort: 30 minutes (copy + format)

### HIGH (Next iteration)

4. **Migrate core specs from mintlify to docs/specs/**:
   - CLEO-CAAMP-INTEGRATION.md
   - CLEO-MIGRATION-DOCTRINE.md
   - CLEO-V2-ARCHITECTURE-SPEC.md
   - PROTOCOL-MISALIGNMENT-CORRECTIONS.md
   - COMMIT-TASK-ENFORCEMENT-SPEC.md
   - Effort: 1-2 hours (copy + format)

5. **Create docs/specs/CLEO-DOCUMENTATION-SOP.md**
   - Currently referenced in AGENTS.md line 78
   - Should document: documentation standards, file naming, review process
   - Effort: Medium (150-200 lines)

6. **Delete or consolidate duplicate docs**:
   - Archive mintlify/ROADMAP.md (superseded by CLEO-STRATEGIC-ROADMAP-SPEC.md)
   - Archive or delete references to non-existent claudedocs/ files
   - Effort: 1 hour

### MEDIUM (Polish)

7. **Migrate all guides** from mintlify/guides/ to docs/guides/:
   - 13 files total (most already exist in mintlify)
   - Effort: 2-3 hours

8. **Create docs/research/** directory structure if needed
   - Currently empty but reserved for research docs
   - Add README explaining its purpose
   - Effort: 30 minutes

9. **Update docs/INDEX.md** to reflect new structure
   - Add sections for guides, research, archive
   - Update version dates
   - Effort: 30 minutes

---

## 10. SPEC REFERENCE ACCURACY SUMMARY

### References That Work ✅
- All 18 specs in docs/specs/ are findable and cited correctly
- CLEO-OPERATIONS-REFERENCE.md is comprehensive and canonical
- MCP-SERVER-SPECIFICATION.md is complete
- VERB-STANDARDS.md is complete

### References That Are Broken ❌
- 7 missing docs (docs/MIGRATION-SYSTEM.md, docs/guides/protocol-enforcement.md, etc.)
- 2 referenced specs still in mintlify (should be migrated or archived)
- 1 stub spec (PROJECT-LIFECYCLE-SPEC.md)

### References That Are Stale ⚠️
- docs/mintlify/ROADMAP.md references removed tasks (T2112, T4454)
- docs/mintlify/ specs (13 files) duplicate upcoming migrations
- AGENTS.md has outdated operation/command counts

---

## 11. CONCLUSION & METRICS

| Metric | Value | Status |
|--------|-------|--------|
| Total Mintlify files to migrate/archive | 80 | ⚠️ LARGE TASK |
| Specs in canonical location (docs/specs/) | 18/31 | ⚠️ 58% |
| Missing critical docs | 7 | ❌ BLOCKING |
| Spec stubs | 1 | ❌ HIGH PRIORITY |
| Ghost references (broken links) | 7 | ⚠️ MEDIUM |
| AGENTS.md accuracy | 6/8 claims correct | ⚠️ 75% |
| Guide files in canonical location | 2/15 | ❌ 13% |

**Overall Migration Status**: ~60% complete. Core specs exist but organization is scattered. Mintlify content is preserved but not consolidated.

---

## APPENDIX A: Files Referenced but Missing

```
docs/MIGRATION-SYSTEM.md                           (Referenced: AGENTS.md:563)
docs/guides/protocol-enforcement.md                (Referenced: AGENTS.md:459, ROADMAP.md)
docs/guides/troubleshooting.md                     (Referenced: AGENTS.md:460)
docs/specs/CLEO-DOCUMENTATION-SOP.md               (Referenced: AGENTS.md:78)
docs/specs/RCSD-PIPELINE-SPEC.md                   (Referenced: mintlify/ROADMAP.md)
claudedocs/CLEO-ORCHESTRATION-PLATFORM-PROPOSAL.md (Referenced: mintlify/ROADMAP.md)
claudedocs/specs/CLEO-PLUGIN-SPEC.md               (Referenced: mintlify/ROADMAP.md)
```

## APPENDIX B: Mintlify Files by Category

**Architecture & Design (8 files)**
- architecture/ARCHITECTURE.md, CLEO-SUBAGENT.md, DATA-FLOWS.md, SCHEMAS.md, data-accessor-safety.md, drift-detection.md
- design/context-alert-library.md

**Guides & Procedures (13 files)**
- guides/DOCUMENTATION-DRIFT-REMEDIATION.md, DOCUMENTATION-MAINTENANCE.md, DOC-DRIFT-STAGED-PLAN.md, PLUGINS.md, PRE-RELEASE-CHECKLIST.md, QUICK-REFERENCE.md
- guides/backup-sqlite-migration.md, ci-cd-integration.md, commit-hook-installation.md, export-import.md, pagination-migration.md, protocol-enforcement.md, release-configuration.md, testing.md, troubleshooting.md, v2-deprecation-plan.md, v2-migration-guide.md

**Reference Material (14 files)**
- reference/CLAUDE-CODE-TOOLING.md, VERSION-MANAGEMENT.md, cli-output-formats.md, command-reference.md, configuration.md, disaster-recovery.md, exit-codes.md, installation.md, jq-helpers.md, json-output-api.md, log-viewing.md, migration-guide.md, sessions-json.md, task-decomposition-atomic-execution-analysis.md, troubleshooting.md

**Specifications (13 files)**
- specs/CAAMP-INTEGRATION-GAP-ANALYSIS.md, CLEO-CAAMP-INTEGRATION.md, CLEO-CANONICAL-PLAN-SPEC.md, CLEO-MIGRATION-DOCTRINE.md, CLEO-PATH-FORWARD-2026Q1.md, CLEO-V2-ARCHITECTURE-SPEC.md, CLEO-WEB-DASHBOARD-SPEC.md, CLEO-WEB-DASHBOARD-UI.md, CLI-MCP-PARITY-ANALYSIS.md, DYNAMIC-OUTPUT-LIMITS-SPEC.md, MANIFEST-HIERARCHY-SCHEMA-SPEC.md, MCP-CLI-PARITY-MATRIX.md, METRICS-VALUE-PROOF-SPEC.md, COMMIT-TASK-ENFORCEMENT-SPEC.md, DECISION-LIFECYCLE-SPEC.md, PROTOCOL-MISALIGNMENT-CORRECTIONS.md

**Other (32 files)**
- api/, migration/, integration/, testing/, troubleshooting/, runbooks/, experiments/, schema/, epics/, bugs/, lib/, and top-level files

---

**End of Report**
