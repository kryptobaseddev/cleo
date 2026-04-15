---
id: ADR-045
title: "ADR-045: .cleo/ Scaffolding SSoT — Canonical Artifact Layout"
status: proposed
date: 2026-04-15
authors: ["cleo-subagent Lead (T687)"]
related_tasks: ["T687"]
supersedes: null
amends: "ADR-014"
summary: "Establishes the single source of truth for every artifact type produced during RCASD-IVTR+C lifecycle runs. Eliminates four orphan directories (.cleo/research/, .cleo/consensus/, .cleo/specs/, .cleo/decomposition/) and the claudedocs/ legacy path. Skills and agent prompts MUST use .cleo/agent-outputs as OUTPUT_DIR default."
keywords: ["scaffolding", "rcasd", "ssot", "artifact", "path", "claudedocs", "agent-outputs"]
topics: ["lifecycle", "admin", "rcasd", "scaffolding"]
---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Context and Problem Statement

A full audit of the `.cleo/` directory (T687, 2026-04-15) found:

1. **Four orphan directories** at `.cleo/` root level: `research/`, `consensus/`, `specs/`, `decomposition/`. These contain T310/T311 RCASD files from 2026-04-08 that predate the canonical per-epic structure (`.cleo/rcasd/{epicId}/{stage}/`). Migration code in `consolidate-rcasd.ts` was never run for these tasks.

2. **13 misplaced agent output files** in `.cleo/rcasd/` root (audit-*.md files from T505). These are agent output files, not RCASD lifecycle artifacts. `.cleo/rcasd/` root MUST contain only `{epicId}/` subdirectories.

3. **Skill documentation drift**: `_shared/manifest-operations.md`, `ct-orchestrator/references/orchestrator-tokens.md`, `ct-epic-architect/references/commands.md`, and `_shared/subagent-protocol-base.md` all show `claudedocs/agent-outputs` as the `{{OUTPUT_DIR}}` default. The canonical path is `.cleo/agent-outputs` (defined in `packages/core/src/skills/injection/token.ts:82`). This creates a failure mode where agents that bypass token injection write to the wrong location.

4. **Two source code `@see` references** in `packages/contracts/src/backup-manifest.ts` and `packages/core/src/store/agent-registry-accessor.ts` point to `.cleo/specs/T311-backup-portability-spec.md` and `.cleo/specs/T310-conduit-signaldock-spec.md` — files at deprecated flat paths.

5. **ADR-014 status is `proposed`** despite the RCSD→RCASD rename having been fully executed. This ADR should be marked `accepted`.

---

## 2. Decision

### 2.1 Canonical Artifact Locations (immutable after this ADR)

The following table is the single authoritative source for artifact placement:

| Artifact Type | Canonical Path | DB Mirror |
|--------------|----------------|-----------|
| RCASD research | `.cleo/rcasd/{epicId}/research/{epicId}-research.md` | `lifecycle_stages.output_file` |
| RCASD consensus | `.cleo/rcasd/{epicId}/consensus/{epicId}-consensus.md` | `lifecycle_stages.output_file` |
| RCASD architecture decision | `.cleo/rcasd/{epicId}/architecture/{epicId}-architecture-decision.md` | `lifecycle_stages.output_file` |
| RCASD specification | `.cleo/rcasd/{epicId}/specification/{epicId}-specification.md` | `lifecycle_stages.output_file` |
| RCASD decomposition | `.cleo/rcasd/{epicId}/decomposition/{epicId}-decomposition.md` | `lifecycle_stages.output_file` |
| RCASD implementation | `.cleo/rcasd/{epicId}/implementation/{epicId}-implementation.md` | `lifecycle_stages.output_file` |
| RCASD validation | `.cleo/rcasd/{epicId}/validation/{epicId}-validation.md` | `lifecycle_stages.output_file` |
| RCASD testing | `.cleo/rcasd/{epicId}/testing/{epicId}-testing.md` | `lifecycle_stages.output_file` |
| RCASD release | `.cleo/rcasd/{epicId}/release/{epicId}-release.md` | `lifecycle_stages.output_file` |
| Architecture Decision Records | `.cleo/adrs/ADR-NNN-short-description.md` | `architecture_decisions.file_path` |
| Agent output (ad-hoc) | `.cleo/agent-outputs/{taskId}-{slug}.md` | `pipeline_manifest` (future) |
| Agent manifest | `.cleo/agent-outputs/MANIFEST.jsonl` | `manifest_entries` (future) |
| Published specification | `docs/specs/SPEC-NAME.md` | None |
| Engineering plan | `docs/plans/PLAN-NAME.md` | None |
| Concept/vision doc | `docs/concepts/NAME.md` | None |
| CANT agent persona | `.cleo/agents/{name}.cant` | None |
| SignalDock credentials | `.cleo/signaldock/{name}.json` | `agent_credentials` |
| Backups | `.cleo/backups/sqlite/`, `.cleo/backups/safety/` | None |

### 2.2 Deprecated Paths

The following paths are DEPRECATED. Existing files MUST be migrated per Section 3:

- `claudedocs/agent-outputs/` → `.cleo/agent-outputs/` (migration already in `cleo upgrade`)
- `claudedocs/research-outputs/` → `.cleo/agent-outputs/` (migration already in `cleo upgrade`)
- `.cleo/research/` → `.cleo/rcasd/{epicId}/research/`
- `.cleo/consensus/` → `.cleo/rcasd/{epicId}/consensus/`
- `.cleo/specs/` → `.cleo/rcasd/{epicId}/specification/`
- `.cleo/decomposition/` → `.cleo/rcasd/{epicId}/decomposition/`
- `.cleo/rcasd/*.md` (any files at rcasd root, not in subdirs) → `.cleo/agent-outputs/`

### 2.3 Skill Documentation Fix

Skills and shared protocol documents MUST use `.cleo/agent-outputs` as the default value for `{{OUTPUT_DIR}}`. The string `claudedocs/agent-outputs` MUST NOT appear in any skill file as a default path. This is enforced by T687-3.

### 2.4 ADR-014 Acceptance

ADR-014 (RCASD rename) MUST be marked `accepted`. The rename was executed. Marking it `proposed` creates false ambiguity.

---

## 3. Migration Plan

### Files to Move (all via `git mv`)

```bash
# T310/T311 orphan files
git mv .cleo/research/T310-signaldock-conduit-audit.md .cleo/rcasd/T310/research/T310-research.md
git mv .cleo/research/T311-backup-portability-audit.md .cleo/rcasd/T311/research/T311-research.md
git mv .cleo/consensus/T310-consensus.md .cleo/rcasd/T310/consensus/T310-consensus.md
git mv .cleo/consensus/T311-consensus.md .cleo/rcasd/T311/consensus/T311-consensus.md
git mv .cleo/specs/T310-conduit-signaldock-spec.md .cleo/rcasd/T310/specification/T310-specification.md
git mv .cleo/specs/T311-backup-portability-spec.md .cleo/rcasd/T311/specification/T311-specification.md
git mv .cleo/decomposition/T310-decomposition.md .cleo/rcasd/T310/decomposition/T310-decomposition.md
git mv .cleo/decomposition/T311-decomposition.md .cleo/rcasd/T311/decomposition/T311-decomposition.md

# 13 misplaced audit files from T505
git mv .cleo/rcasd/audit-agent.md .cleo/agent-outputs/T505-audit-agent.md
git mv .cleo/rcasd/audit-analysis.md .cleo/agent-outputs/T505-audit-analysis.md
git mv .cleo/rcasd/audit-code-docs.md .cleo/agent-outputs/T505-audit-code-docs.md
git mv .cleo/rcasd/audit-import-export.md .cleo/agent-outputs/T505-audit-import-export.md
git mv .cleo/rcasd/audit-lifecycle.md .cleo/agent-outputs/T505-audit-lifecycle.md
git mv .cleo/rcasd/audit-memory.md .cleo/agent-outputs/T505-audit-memory.md
git mv .cleo/rcasd/audit-research-orch.md .cleo/agent-outputs/T505-audit-research-orch.md
git mv .cleo/rcasd/audit-sessions.md .cleo/agent-outputs/T505-audit-sessions.md
git mv .cleo/rcasd/audit-system.md .cleo/agent-outputs/T505-audit-system.md
git mv .cleo/rcasd/audit-task-crud.md .cleo/agent-outputs/T505-audit-task-crud.md
git mv .cleo/rcasd/audit-task-org.md .cleo/agent-outputs/T505-audit-task-org.md
git mv .cleo/rcasd/audit-tooling.md .cleo/agent-outputs/T505-audit-tooling.md
git mv .cleo/rcasd/CLI-FULL-AUDIT-REPORT.md .cleo/agent-outputs/T505-CLI-FULL-AUDIT-REPORT.md
```

### Source Code Fixes

1. `packages/contracts/src/backup-manifest.ts:14` — update `@see` to point to `.cleo/rcasd/T311/specification/T311-specification.md` or `docs/specs/CLEO-DATA-INTEGRITY-SPEC.md`
2. `packages/core/src/store/agent-registry-accessor.ts:18` — update `@see` to point to `.cleo/rcasd/T310/specification/T310-specification.md`
3. All skill files showing `claudedocs/agent-outputs` → `.cleo/agent-outputs`
4. ADR-014 status: `proposed` → `accepted`

---

## 4. Consequences

### Positive
- All orphan directories eliminated; `.cleo/` directory is fully classified
- Skills give agents correct default paths, reducing write-to-wrong-location failures
- DB `lifecycle_stages.output_file` values remain valid (no path changes needed for T612/T673)
- `consolidate-rcasd.ts` migration can be run for T310/T311 to get DB records created

### Negative
- Any external references (docs, bookmarks) to `.cleo/specs/T310-*.md` or `.cleo/specs/T311-*.md` will 404 — acceptable since these are internal files
- Short-term: agents that have old skill text cached may still attempt `claudedocs/agent-outputs` — token injection in CAAMP overrides this at runtime

### Neutral
- `manifest_entries` table remains empty — ADR-027 activation is a separate epic
- CAAMP package's `docs/adrs/ADR-001/002` are internal to that package and are NOT affected by this ADR (different scope)

---

## 5. Related ADRs

- **ADR-013** — Data Integrity: runtime files not tracked in git, backups mandatory
- **ADR-014** — RCASD rename (MUST be marked accepted after this ADR)
- **ADR-027** — Manifest SQLite migration (future activation of `manifest_entries`)
- **ADR-038** — Backup portability
