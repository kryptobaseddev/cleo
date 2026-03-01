# T4858: RCSD → RCASD Rename — Scope & Migration Strategy Decisions

**Task:** T4858 — Q&A: RCSD→RCASD rename scope and migration strategy
**Parent:** T4855 — RCSD Schema Review & RCASD Rename Analysis
**Date:** 2026-02-25
**Status:** Complete
**Depends:** T4856 (audit research — completed)

---

## Q1: What is the definitive expanded form of RCASD vs RCSD?

### RCSD (Original — 4 stages)

**R**esearch → **C**onsensus → **S**pecification → **D**ecomposition

The original pipeline had 4 planning stages followed by execution stages. There was no formal Architecture Decision stage — architectural decisions were embedded within Consensus or Specification.

### RCASD (Current — 5 planning stages)

**R**esearch → **C**onsensus → **A**rchitecture Decision → **S**pecification → **D**ecomposition

The "A" represents the **Architecture Decision** stage, added as stage 3 in the pipeline. This stage produces Architecture Decision Records (ADRs) and captures architectural choices that must be made between reaching consensus on findings and writing a specification.

### Full Pipeline: RCASD-IVTR (9 ordered + 1 cross-cutting)

```
Planning:  Research → Consensus → Architecture Decision → Specification → Decomposition
Execution: Implementation → Validation → Testing → Release
           (+ Contribution — cross-cutting, can attach to any stage)
```

### Why the stage was added

Architecture decisions are a distinct concern from consensus (which validates research findings) and specification (which documents requirements). An explicit Architecture Decision stage:
- Produces auditable ADRs with rationale
- Forces deliberate architectural choices before committing to a spec
- Aligns with industry-standard ADR practices

### Evidence in code

- `PIPELINE_STAGES` in `src/core/lifecycle/stages.ts:40-50` — `architecture_decision` is position 3
- `ProtocolType` enum in `src/mcp/lib/protocol-enforcement.ts:24` — `ARCHITECTURE_DECISION` present
- `RCSD_STAGES` in `src/core/lifecycle/index.ts:17` — includes `architecture_decision` (despite the name)

---

## Q2: What should be renamed vs kept as historical?

### Phase 1: Code Rename (exported symbols + comments)

**Rename — exported symbols (high impact, breaks API surface):**

| Current | Proposed | File |
|---------|----------|------|
| `RCSD_STAGES` | `RCASD_STAGES` | `src/core/lifecycle/index.ts:17` |
| `RcsdStage` | `RcasdStage` | `src/core/lifecycle/index.ts:18` |
| `RcsdManifest` | `RcasdManifest` | `src/core/lifecycle/index.ts:31` |

**Rename — comments and headers (~38 production code occurrences):**

| Pattern | Replacement |
|---------|-------------|
| "RCSD pipeline" | "RCASD-IVTR pipeline" |
| "RCSD-IVTR" | "RCASD-IVTR" |
| "RCSD pipeline lifecycle" | "RCASD-IVTR pipeline lifecycle" |
| "7 RCSD-IVTR protocols" | "10 RCASD-IVTR protocols" |

**Rename — test files (~49 occurrences):**

Test files reference `RCSD_STAGES`, `RcsdManifest`, and use RCSD in test descriptions. These follow the production renames.

### Phase 2: Disk Path Migration

| Current | Proposed | Notes |
|---------|----------|-------|
| `.cleo/rcsd/` | `.cleo/rcasd/` | Requires symlink transition period |
| `RCSD-INDEX.json` | `RCASD-INDEX.json` | Currently zeroed — could just recreate |
| `.cleo/rcsd/README.md` | Rewrite entirely | Also fix stale `.claude/` path reference |

### Phase 3: Documentation Sweep

- Mintlify docs: 20 files, 46 occurrences — update all "RCSD" to "RCASD-IVTR"
- Agent injection templates: update RCSD-IVTR references
- `docs.json` sidebar entries
- `llms.txt` LLM context

### Keep as Historical (do NOT rename)

| Item | Reason |
|------|--------|
| Archived schema filenames (`schemas/archive/rcsd-*.schema.json`) | Document the legacy format as-is |
| ADR body text | ADRs are point-in-time documents — add footnote, don't rewrite |
| Git history (commit messages, PR titles) | Immutable |
| `rcsd-hitl-resolution.schema.json` | Historical artifact |
| Task descriptions referencing RCSD | Historical context |

---

## Q3: Should the rename be atomic or phased?

### Decision: **Phased** (3 PRs)

**Rationale:** A single atomic rename touching ~200 references across ~79 files is high-risk and difficult to review. Phasing allows:
- Each PR is reviewable and revertable independently
- Code rename can land first, unblocking downstream work
- Disk migration can use a symlink transition to avoid breaking active pipelines
- Documentation sweep can be done incrementally

### Phase Plan

**PR 1 — Code rename:**
- Rename `RCSD_STAGES` → `RCASD_STAGES`, `RcsdStage` → `RcasdStage`, `RcsdManifest` → `RcasdManifest`
- Add `@deprecated` re-exports under old names for one release cycle
- Update all comments and headers in `src/`
- Update all test files
- Scope: ~23 files, ~87 occurrences

**PR 2 — Disk path migration:**
- Create `.cleo/rcasd/` directory
- Migrate manifests from `.cleo/rcsd/` to `.cleo/rcasd/`
- Create symlink `.cleo/rcsd → .cleo/rcasd` for backward compat
- Rewrite `README.md` for new directory
- Update path references in `src/core/paths.ts` (if applicable)
- Scope: ~5 files + directory operations

**PR 3 — Documentation sweep:**
- Update all mintlify docs (20 files)
- Update agent injection templates
- Add footnotes to ADRs
- Update `docs.json` navigation
- Scope: ~25 files, ~60 occurrences

---

## Q4: How does this interact with T4798 and T4844?

### T4798 — RCSD Lifecycle Pipeline Review

**Relationship:** Parallel — not blocking in either direction.

The lifecycle code works regardless of whether variables are named `RCSD_STAGES` or `RCASD_STAGES`. T4798's core work (T4800 — SQLite pipeline state machine) operates on stage string values (`'research'`, `'consensus'`, etc.) which don't change.

**Recommendation:** Execute the code rename (Phase 1) BEFORE T4798's unification work (T4800). Rationale: if T4800 lands first and introduces new code referencing `RCSD_STAGES`, the rename PR will need to cover those new references too. Doing the rename first means T4800 starts with the correct names.

### T4844 — RCASD Audit Logging

**Relationship:** Already uses "RCASD" in its title. Not blocked.

T4844 can proceed independently. Its implementation will naturally use whatever names exist in code at implementation time. If the rename lands first, T4844 uses `RCASD_STAGES`; if not, it uses `RCSD_STAGES` and gets renamed later.

### Dependency Order (Recommended)

```
T4856 (audit) ──done──→ T4858 (decisions) ──done──→ T4859 (design)
                                                         ↓
                                                    T4860 (ADR)
                                                         ↓
                                              Code rename PR (Phase 1)
                                                         ↓
                                              T4800 (SQLite pipeline) ← T4798
                                                         ↓
                                              Disk migration PR (Phase 2)
                                                         ↓
                                              Doc sweep PR (Phase 3)
```

---

## Q5: What is the backward-compatibility story?

### Code Backward Compat (one release cycle)

```typescript
// In src/core/lifecycle/index.ts after rename:

/** @deprecated Use RCASD_STAGES instead. Will be removed in next minor release. */
export const RCSD_STAGES = RCASD_STAGES;

/** @deprecated Use RcasdStage instead. */
export type RcsdStage = RcasdStage;

/** @deprecated Use RcasdManifest instead. */
export type RcsdManifest = RcasdManifest;
```

This allows any external consumers (if they exist) to migrate gradually. Remove the deprecated aliases in the following minor release.

### Disk Path Backward Compat (symlink transition)

```bash
# During migration:
mv .cleo/rcsd .cleo/rcasd
ln -s rcasd .cleo/rcsd     # Symlink for transition

# After one release cycle:
rm .cleo/rcsd               # Remove symlink
```

Any code reading `.cleo/rcsd/` continues to work through the symlink. Update `src/core/paths.ts` to use `.cleo/rcasd/` as the canonical path.

### Config Backward Compat

The `lifecycleEnforcement` config key does NOT reference RCSD — it uses generic `mode` values (`strict`, `advisory`, `off`). No config migration needed.

### Schema Backward Compat

Archived schemas stay in `schemas/archive/` under their original filenames. They are not loaded at runtime. No migration needed.

### `.cleo/rcsd/` Task Directories (19 existing)

The 19 existing task directories (`T3080/`, `T3951/`, etc.) contain `_manifest.json` files. These:
- Will be physically moved during disk migration (Phase 2)
- Remain accessible via symlink during transition
- Their internal `_manifest.json` content doesn't reference "RCSD" in field names
- Pipeline state is migrating to SQLite anyway (T4800), so the JSON manifests become historical artifacts

---

## Summary of Decisions

| # | Question | Decision |
|---|----------|----------|
| Q1 | What is RCASD? | Research → Consensus → Architecture Decision → Specification → Decomposition |
| Q2 | What to rename? | Code symbols + comments (Phase 1), disk paths (Phase 2), docs (Phase 3). Keep archived schemas and ADR body text as-is. |
| Q3 | Atomic or phased? | Phased — 3 PRs for reviewability and safety |
| Q4 | Interaction with T4798/T4844? | Parallel. Recommend rename before T4800 to avoid double-work. |
| Q5 | Backward compat? | `@deprecated` re-exports for one release cycle; symlink for disk paths; no config migration needed |
