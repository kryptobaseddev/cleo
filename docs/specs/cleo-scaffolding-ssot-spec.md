# CLEO Scaffolding SSoT Specification

**Version**: 2026.04.15  
**Status**: DRAFT  
**Date**: 2026-04-15  
**Task**: T687  
**ADR**: ADR-045

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Purpose

This specification establishes the single source of truth (SSoT) for every artifact path in the CLEO project. It is the implementation contract for ADR-045 and resolves the owner Q5 directive (2026-04-15): orphan directories, stale skill paths, and unclear DB vs filesystem boundaries.

---

## 2. Canonical Artifact Path Registry

### 2.1 RCASD Lifecycle Stage Artifacts

All lifecycle stage artifacts for an epic with ID `{epicId}` (e.g., `T687`) MUST be placed at:

```
.cleo/rcasd/{epicId}/{stageSubdir}/{epicId}-{stageSlug}.md
```

Where `{stageSubdir}` and `{stageSlug}` are defined as:

| Stage Name | Subdir | Slug | Example |
|------------|--------|------|---------|
| `research` | `research` | `research` | `.cleo/rcasd/T687/research/T687-research.md` |
| `consensus` | `consensus` | `consensus` | `.cleo/rcasd/T687/consensus/T687-consensus.md` |
| `architecture_decision` | `architecture` | `architecture-decision` | `.cleo/rcasd/T687/architecture/T687-architecture-decision.md` |
| `specification` | `specification` | `specification` | `.cleo/rcasd/T687/specification/T687-specification.md` |
| `decomposition` | `decomposition` | `decomposition` | `.cleo/rcasd/T687/decomposition/T687-decomposition.md` |
| `implementation` | `implementation` | `implementation` | `.cleo/rcasd/T687/implementation/T687-implementation.md` |
| `validation` | `validation` | `validation` | `.cleo/rcasd/T687/validation/T687-validation.md` |
| `testing` | `testing` | `testing` | `.cleo/rcasd/T687/testing/T687-testing.md` |
| `release` | `release` | `release` | `.cleo/rcasd/T687/release/T687-release.md` |
| `contribution` | `contributions` | `contribution` | `.cleo/rcasd/T687/contributions/T687-contribution.md` |

RCASD artifact paths MUST be recorded in `lifecycle_stages.output_file` (relative to project root).

RCASD artifact directories MUST be git-tracked (`.cleo/.gitignore` already allows `!rcasd/**`).

### 2.2 Architecture Decision Records (ADRs)

ADR files MUST be placed at:

```
.cleo/adrs/ADR-NNN-short-description.md
```

Where `NNN` is a zero-padded three-digit sequential number.

ADRs MUST be managed via `cleo adr` CLI commands:
- `cleo adr list` — list all ADRs
- `cleo adr validate` — validate frontmatter
- `cleo adr sync` — sync filesystem files into `architecture_decisions` DB table

ADRs MUST NOT be placed under `docs/adrs/` (deprecated location). Exception: CAAMP package maintains its own `packages/caamp/docs/adrs/` for package-internal ADRs — this is out of scope for this spec.

The `architecture_decisions` table in `tasks.db` MUST mirror the filesystem state after each `cleo adr sync` run.

### 2.3 Agent Output Files

Ad-hoc agent output files (non-RCASD) MUST be placed at:

```
.cleo/agent-outputs/{taskId}-{slug}.md
```

Preferred naming conventions:
- Research outputs: `{taskId}-{topic-slug}.md` or `R-{topic-slug}.md` (for standalone research)
- Session outputs: `{date}_{topic-slug}.md` (legacy format, still acceptable)
- Validation/audit reports: `{taskId}-{slug}.md`

Agent output subdirectories are ALLOWED for grouped outputs (e.g., `.cleo/agent-outputs/T684-browser-validation/`).

The agent output manifest is stored in `pipeline_manifest` table in `tasks.db` (ADR-027). The legacy flat-file at `.cleo/agent-outputs/` is retired.

### 2.4 Output Directory Token Default

All skills, shared protocol documents, and agent injection templates MUST use `.cleo/agent-outputs` as the default value for `{{OUTPUT_DIR}}`. The string `claudedocs/agent-outputs` MUST NOT appear as a path default in any skill or protocol file.

The canonical token defaults are defined at `packages/core/src/skills/injection/token.ts`:
- `OUTPUT_DIR` → `.cleo/agent-outputs`
- `MANIFEST_PATH` → retired (ADR-027) — use `cleo manifest append` for pipeline_manifest

### 2.5 Published Specifications

Normative, human-facing specifications (RFC 2119 language, stable contracts) MUST be placed at:

```
docs/specs/SPEC-NAME.md
```

Naming convention: `UPPER-KEBAB-CASE.md`

Specifications in `docs/specs/` are distinct from RCASD specification stage artifacts (`.cleo/rcasd/{epicId}/specification/`). The RCASD specification is the working document produced during the RCASD pipeline. The `docs/specs/` version is the published, stable artifact promoted from the RCASD specification.

### 2.6 Engineering Plans

Active engineering plans (ULTRAPLAN, blueprints, research summaries, council reports) MUST be placed at:

```
docs/plans/PLAN-NAME.md
```

### 2.7 Other .cleo/ Subdirectories

| Directory | Purpose | Read/Write | Notes |
|-----------|---------|-----------|-------|
| `.cleo/agents/` | CANT persona profiles | R/W by agent system | `.cant` + `.md` pairs |
| `.cleo/cant/` | Runtime CANT team configs | R/W by CANT runtime | `team.cant`, `agents/` subdir |
| `.cleo/signaldock/` | SignalDock agent credentials | R/W by `cleo agent` | JSON credential files |
| `.cleo/backups/sqlite/` | Rotating SQLite snapshots | W by `cleo session end` + `cleo backup add` | ADR-013/ADR-038 |
| `.cleo/backups/safety/` | Pre-migration safety copies | W by `cleo upgrade` | One-time migration artifacts |
| `.cleo/backups/legacy-nested/` | Apr 7 nested package .cleo/ backups | ARCHIVE — do not modify | Historical |
| `.cleo/logs/` | Daily CLEO CLI audit logs | W by CLI | ADR-019/ADR-024 |
| `.cleo/metrics/` | Grade/compliance JSONL telemetry | W by `cleo grade` | Not git-tracked |
| `.cleo/snapshots/` | `cleo snapshot` exports | W by `cleo snapshot` | |
| `.cleo/attestation/` | Task completion proof files | W by attestation system | Archive when task ships |
| `.cleo/audit/` | T505 CLI audit JSONL | ARCHIVE | Apr 10 2026; T505 complete |
| `.cleo/chat/` | Conduit chatroom JSONL | W by Conduit | Not git-tracked |

---

## 3. DB vs Filesystem Boundary Rules

### 3.1 What Goes in DB Only

- Task state, status, priority, labels, acceptance criteria (`tasks` table)
- Session records, agent instances, token usage
- Pipeline stage state: started/completed timestamps, gate results
- ADR metadata: status, relationships, keywords (mirrored from files)
- Memory: decisions, patterns, learnings, observations (brain.db)
- Agent credentials and error logs

### 3.2 What Goes in Files Only

- RCASD stage content (full markdown)
- ADR full text (`.cleo/adrs/*.md`) — DB holds metadata only
- Agent output files (`.cleo/agent-outputs/`)
- Published specifications (`docs/specs/`)

### 3.3 What Goes in Both (DB tracks file)

- `lifecycle_stages.output_file` → points to `.cleo/rcasd/{epicId}/{stage}/*.md`
- `architecture_decisions.file_path` → points to `.cleo/adrs/ADR-NNN-*.md`

NO duplication of content between DB and files. DB always holds metadata + path pointer; file holds content.

---

## 4. Deprecated Paths and Migration Rules

### 4.1 MUST NOT Create

Workers MUST NOT create files at these paths after this spec is published:

- `claudedocs/agent-outputs/` (use `.cleo/agent-outputs/`)
- `claudedocs/research-outputs/` (use `.cleo/agent-outputs/`)
- `.cleo/research/` (use `.cleo/rcasd/{epicId}/research/`)
- `.cleo/consensus/` (use `.cleo/rcasd/{epicId}/consensus/`)
- `.cleo/specs/` (use `.cleo/rcasd/{epicId}/specification/`)
- `.cleo/decomposition/` (use `.cleo/rcasd/{epicId}/decomposition/`)
- `.cleo/rcasd/*.md` (files at rcasd root — use `.cleo/rcasd/{epicId}/{stage}/`)

### 4.2 Migration Commands (T687-1)

All orphan files from deprecated paths MUST be moved with `git mv` (not `cp` + `rm`) to preserve history.

See ADR-045 Section 3 for the complete list of `git mv` commands.

### 4.3 Reference Updates (T687-2 through T687-5)

All instructional files that reference deprecated paths MUST be updated:
- `packages/skills/skills/_shared/manifest-operations.md`
- `packages/skills/skills/_shared/subagent-protocol-base.md`
- `packages/skills/skills/ct-orchestrator/references/orchestrator-tokens.md`
- `packages/skills/skills/ct-epic-architect/references/commands.md`
- `packages/skills/skills/ct-consensus-voter/SKILL.md`
- `packages/contracts/src/backup-manifest.ts` (@see reference)
- `packages/core/src/store/agent-registry-accessor.ts` (@see reference)
- ADR-014 status: `proposed` → `accepted`

---

## 5. Compliance Rules for Future RCASD Runs

When an agent runs an RCASD lifecycle stage for epic `{epicId}`:

1. The agent MUST call `cleo lifecycle stage.status --task {epicId}` to confirm the current stage.
2. The agent MUST write the stage artifact to `.cleo/rcasd/{epicId}/{stageSubdir}/{epicId}-{stageSlug}.md`.
3. The agent MUST call `cleo lifecycle stage.advance --task {epicId}` to record completion (which sets `lifecycle_stages.output_file`).
4. The agent MUST NOT write RCASD stage content to `.cleo/agent-outputs/` (those are for ad-hoc outputs only).
5. The agent MUST NOT write published specifications directly; the ct-spec-writer skill handles `docs/specs/` placement.

For ad-hoc outputs (non-lifecycle agent work):

1. The agent MUST write to `{{OUTPUT_DIR}}/` where `{{OUTPUT_DIR}}` resolves to `.cleo/agent-outputs`.
2. The agent MUST append a single-line JSON entry to `{{MANIFEST_PATH}}`.

---

## 6. Related Documents

- [ADR-045: .cleo/ Scaffolding SSoT](../../.cleo/adrs/ADR-045-cleo-scaffolding-ssot.md)
- [ADR-014: RCASD Rename and Protocol Output Validation](../../.cleo/adrs/ADR-014-rcasd-rename-and-protocol-validation.md)
- [ADR-013: Data Integrity and Checkpoint Architecture](../../.cleo/adrs/ADR-013-data-integrity-checkpoint-architecture.md)
- [CLEO-DOCUMENTATION-SOP.md](../CLEO-DOCUMENTATION-SOP.md) — documentation canonical layout
- `packages/core/src/lifecycle/rcasd-paths.ts` — canonical path helper functions
- `packages/core/src/lifecycle/stage-artifacts.ts` — stage artifact scaffolding
- `packages/core/src/migration/agent-outputs.ts` — legacy claudedocs migration
