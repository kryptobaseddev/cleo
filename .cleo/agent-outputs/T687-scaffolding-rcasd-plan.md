# T687 — .cleo/ Scaffolding Reality Check + Artifact SSoT Unification

**Epic**: T687  
**Phase**: R (Research) → C (Consensus) → A (Architecture) → S (Specification) → D (Decomposition)  
**Date**: 2026-04-15  
**Status**: Lead report — children NOT yet spawned (pending owner review)  
**Agent**: cleo-subagent Lead

---

## PHASE R — RESEARCH

### R1. .cleo/ Directory Full Inventory

Canonical tree (`find .cleo -type d | sort`, excluding `.git` objects):

```
.cleo/
├── adrs/                    # 44 ADR markdown files + MANIFEST.jsonl
├── agent-outputs/           # 130+ task output markdown files + MANIFEST.jsonl + T684-browser-validation/
├── agents/                  # .cant + .md persona profiles (12 files, Mar–Apr 2026)
├── attestation/             # 2 proof files (T572, T577)
├── audit/                   # 2 jsonl files (assumptions, decisions from T505)
├── backups/
│   ├── legacy-nested/       # Apr 7 backup of 5 nested package .cleo/ dirs
│   ├── operational/         # EMPTY
│   ├── safety/              # 4 pre-untrack files (brain/tasks/config/project-info)
│   ├── snapshot/            # 7 snapshot-YYYY-*.json files
│   └── sqlite/              # 10 rotating tasks-YYYYMMDD.db WAL snapshots
├── cant/
│   ├── agents/              # 4 .cant files (cleo-orchestrator, code-worker, dev-lead, docs-worker)
│   └── team.cant
├── chat/                    # 1 chatroom JSONL file (Apr 15, Conduit)
├── consensus/               # 2 consensus files: T310, T311 (from Apr 8 RCASD — ORPHAN)
├── decomposition/           # 2 decomposition files: T310, T311 (from Apr 8 RCASD — ORPHAN)
├── logs/                    # 7 daily cleo.YYYY-MM-DD.N.log files
├── metrics/                 # COMPLIANCE.jsonl, compliance-summary.json, GRADES.jsonl
├── rcasd/                   # CANONICAL RCASD: T091, T484, T612, T673 + 13 orphan audit-*.md files
│   ├── audit-*.md (×13)     # CLI audit agent outputs from T505 — MISPLACED (should be agent-outputs)
│   ├── CLI-FULL-AUDIT-REPORT.md # MISPLACED (should be agent-outputs)
│   ├── T091/                # Empty subdirs (consensus/, research/ have T091-*.md)
│   ├── T484/                # Empty subdirs (consensus/, research/ have T484-*.md)
│   ├── T612/                # Full RCASD: 9 stages populated
│   └── T673/                # Partial RCASD: 5 stages populated
├── research/                # 2 research files: T310, T311 (from Apr 8 RCASD — ORPHAN)
├── signaldock/              # 16 agent credential JSON files (clawmsgr-* and signaldock-*)
├── snapshots/               # 7 snapshot-YYYY-*.json export files
├── specs/                   # 2 spec files: T310, T311 (from Apr 8 RCASD — ORPHAN)
├── brain.db + WAL
├── tasks.db + WAL
├── conduit.db
├── config.json
├── project-context.json     # Tracked in git
├── project-info.json
├── memory-bridge.md         # Auto-generated, tracked in git
├── nexus-bridge.md          # Auto-generated, tracked in git
├── MANIFEST.jsonl           # ADR manifest (22KB, 44 entries)
├── .gitignore               # Deny-by-default, allow-list managed
├── .git/                    # Isolated .cleo git repo
├── teams.cant               # CANT team definition
├── brain-pre-cleo.db.bak    # Pre-migration backup
├── tasks-pre-cleo.db.bak    # Pre-migration backup
└── .fuse_hidden*            # OS filesystem artifact
```

**Classification of every subdirectory:**

| Directory | Classification | Evidence |
|-----------|---------------|----------|
| `.cleo/adrs/` | (a) Actively used — canonical ADR location | `packages/core/src/adrs/*.ts`, `cleo adr` CLI, gitignored allow-listed |
| `.cleo/agent-outputs/` | (a) Actively used — canonical output dir since v0.80.0 | `packages/core/src/paths.ts:629`, `config.template.json:103`, `core/schemas/config.schema.json:69` |
| `.cleo/agents/` | (a) Actively used — persona .cant + .md profiles | Referenced by CANT persona system, Mar–Apr 2026 |
| `.cleo/attestation/` | (b) Archive — completed task proofs (T572, T577) | 2 files, Apr 14 |
| `.cleo/audit/` | (b) Archive — T505 CLI audit assumptions/decisions JSONL | 2 files, Apr 10 |
| `.cleo/backups/` | (a) Actively used — ADR-013 backup system | `cleo backup add`, `cleo session end` triggers `vacuumIntoBackupAll` |
| `.cleo/cant/` | (a) Actively used — runtime CANT team config | Apr 13 |
| `.cleo/chat/` | (a) Actively used — Conduit chatroom JSONL | 1 file, Apr 15 |
| `.cleo/consensus/` | (c) ORPHAN DRIFT — T310/T311 files from Apr 8 RCASD that predate canonical `.cleo/rcasd/` | Should be `.cleo/rcasd/T310/consensus/` and `.cleo/rcasd/T311/consensus/` |
| `.cleo/decomposition/` | (c) ORPHAN DRIFT — same as above | Should be `.cleo/rcasd/T310/decomposition/` etc. |
| `.cleo/logs/` | (a) Actively used — CLEO CLI audit logs | ADR-019/ADR-024 logging system |
| `.cleo/metrics/` | (a) Actively used — grade/compliance telemetry | gitignored |
| `.cleo/rcasd/` | (a) Actively used — canonical RCASD lifecycle artifacts | `packages/core/src/lifecycle/rcasd-paths.ts`, DB `lifecycle_stages.output_file` |
| `.cleo/rcasd/*.md (root)` | (c) ORPHAN DRIFT — 13 `audit-*.md` + `CLI-FULL-AUDIT-REPORT.md` are T505 CLI audit outputs; they belong in `.cleo/agent-outputs/` | Confirmed: all dated Apr 10 2026, match T505 CLI audit epic |
| `.cleo/research/` | (c) ORPHAN DRIFT — T310/T311 research files from Apr 8 | Should be `.cleo/rcasd/T310/research/` |
| `.cleo/signaldock/` | (a) Actively used — SignalDock agent credentials | Mar 30 – Mar 31 |
| `.cleo/snapshots/` | (a) Actively used — `cleo snapshot` export/import | `cleo snapshot` command |
| `.cleo/specs/` | (c) ORPHAN DRIFT — T310/T311 spec files from Apr 8 | Should be `.cleo/rcasd/T310/specification/` |

### R2. Database Table Inventory

#### tasks.db (14.7MB, 687 tasks)

| Table | Row Count | RCASD Classification | Notes |
|-------|-----------|---------------------|-------|
| `tasks` | 687 | Task scaffolding | Primary task store |
| `architecture_decisions` | 41 | (i) RCASD: ADR artifacts | DB mirror of `.cleo/adrs/*.md` files; `file_path` column points to `.cleo/adrs/*.md` |
| `manifest_entries` | 0 | (i) RCASD: stage outputs | Schema exists, no rows — UNUSED. DB-based MANIFEST not yet activated (ADR-027 migration incomplete) |
| `pipeline_manifest` | 1 | (i) RCASD: stage outputs | 1 row, largely unused |
| `lifecycle_pipelines` | 2 | Task scaffolding | T612 and T673 pipelines |
| `lifecycle_stages` | 14 | (i) RCASD: stage tracking | `output_file` column: `.cleo/rcasd/{epicId}/{stage}/{epicId}-{stage}.md` — CONFIRMED canonical |
| `lifecycle_evidence` | ? | RCASD validation | Evidence records |
| `lifecycle_gate_results` | ? | RCASD validation | Gate enforcement |
| `lifecycle_transitions` | ? | RCASD state machine | Stage progression log |
| `adr_relations` | ? | RCASD: ADR graph | ADR–ADR relationships |
| `adr_task_links` | ? | RCASD: ADR–task links | ADR–task relationships |
| `sessions` | ? | Operational metadata | Session tracking |
| `agent_credentials` | ? | Operational | Agent auth |
| `agent_error_log` | ? | Operational | Error telemetry |
| `agent_instances` | ? | Operational | Agent spawn tracking |
| `task_dependencies` | ? | Task scaffolding | Dependency graph |
| `task_relations` | ? | Task scaffolding | Semantic relations |
| `task_work_history` | ? | Operational | Work log |
| `audit_log` | ? | Operational | CLI audit trail |
| `token_usage` | ? | Operational | Token telemetry |
| `external_task_links` | ? | Operational | External integrations |
| `release_manifests` | ? | Release lifecycle | Release records |
| `warp_chains` / `warp_chain_instances` | ? | Orchestration | WarpChain pipeline |
| `schema_meta` / `status_registry` / `__drizzle_migrations` | ? | Operational | Schema management |

**Key RCASD Persistence finding**: RCASD artifacts are persisted TWO ways:
- **DB** (`lifecycle_stages.output_file`): tracks WHICH file exists for which stage
- **Filesystem** (`.cleo/rcasd/{epicId}/{stage}/{epicId}-{stage}.md`): stores actual content
- **`architecture_decisions` table**: DB mirror of `.cleo/adrs/*.md` files (synced by `cleo adr sync`)
- **NO duplication** between DB and filesystem for RCASD content — DB tracks metadata, file holds content. This is CORRECT and intentional.

#### brain.db (2.8MB + 4.2MB WAL)

| Table | Row Count | Classification | Notes |
|-------|-----------|---------------|-------|
| `brain_observations` | 743 | (iii) Memory | Session observations, PostToolUse events — NOISY (see memory-bridge crisis) |
| `brain_page_nodes` | 1,052 | (iii) Memory | Graph nodes |
| `brain_page_edges` | 3,820 | (iii) Memory | Graph edges (Hebbian plasticity) |
| `brain_decisions` | 16 | (iii) Memory | Owner/consensus decisions |
| `brain_patterns` | 2 | (iii) Memory | Behavioral patterns |
| `brain_learnings` | 4 | (iii) Memory | Extracted learnings |
| `brain_embeddings` | ? | (iii) Memory | Semantic vectors |
| `brain_plasticity_events` | 0 | (iii) Memory | STDP events (table exists, no writer — T673 STDP bug) |
| `brain_sticky_notes` | 7 | (iii) Memory | Quick-capture notes |
| `brain_memory_links` | ? | (iii) Memory | Cross-type links |
| `brain_retrieval_log` | ? | (iii) Memory | Retrieval telemetry |
| `brain_usage_log` | ? | (iii) Memory | Usage analytics |
| `brain_schema_meta` | ? | Operational | Schema version |

**No RCASD content in brain.db** — memory DB is purely for extracted intelligence (patterns, decisions, learnings, observations). RCASD artifacts are not stored here.

### R3. Path Drift Audit

**Evidence table — all mentions of artifact path locations:**

| Path Pattern | Occurrences | Locations | Status |
|-------------|-------------|-----------|--------|
| `.cleo/adrs/` | 40+ | `packages/core/src/adrs/*.ts`, `packages/cleo/src/cli/commands/adr.ts`, 8+ README/docs | CANONICAL — correct |
| `docs/adrs/` | 2 | `packages/caamp/.../CLEOOS-VISION.md:344-345`, `packages/.../CORE-PACKAGE-SPEC.md:1237-1238` | DRIFT — old CAAMP/core spec references |
| `.cleo/agent-outputs` | 25+ | `packages/core/src/paths.ts:629`, `config.template.json`, `packages/agents/cleo-subagent/AGENT.md:266`, `cleo-subagent AGENT.md` | CANONICAL — correct |
| `claudedocs/agent-outputs` | 15+ | `packages/skills/skills/_shared/manifest-operations.md`, `ct-orchestrator/references/orchestrator-tokens.md`, `ct-epic-architect/references/commands.md`, `_shared/subagent-protocol-base.md` | DRIFT — skills/shared files hardcode legacy default |
| `claudedocs/research-outputs` | 5 | `packages/core/src/migration/agent-outputs.ts` | MIGRATION ONLY — migration code knows about this; no active agent writes here |
| `.cleo/rcasd/` | 20+ | `packages/core/src/lifecycle/rcasd-paths.ts`, `packages/core/src/lifecycle/stage-artifacts.ts`, `packages/core/src/lifecycle/consolidate-rcasd.ts`, DB `lifecycle_stages.output_file` | CANONICAL — correct |
| `.cleo/research/` | 2 | `packages/cleo/src/dispatch/domains/__tests__/pipeline-manifest.test.ts:124,276` | TEST ONLY — test fixture paths, and 2 orphan files on disk |
| `.cleo/consensus/` | 1 | `packages/skills/skills/ct-consensus-voter/SKILL.md:129` | DRIFT — skill uses legacy flat path |
| `.cleo/specs/` | 2 | `packages/contracts/src/backup-manifest.ts:14`, `packages/core/src/store/agent-registry-accessor.ts:18` | DRIFT — 2 contract `@see` references; 2 orphan files on disk |
| `docs/specs/` | 30+ | `packages/skills/skills/ct-spec-writer/SKILL.md:141,153,166`, `packages/skills/skills/ct-contribution/SKILL.md:303`, `packages/cleo/src/cli/commands/detect-drift.ts`, many contract `@see` refs | CANONICAL — ct-spec-writer sends specs here correctly |
| `docs/plans/` | 10+ | `packages/cleo-os/starter-bundle/README.md`, `packages/core/src/memory/decision-cross-link.ts`, memory-bridge.md | CANONICAL — plans live here |

**Critical Drift Finding: `claudedocs/agent-outputs` vs `.cleo/agent-outputs`**

The skills layer (`_shared/subagent-protocol-base.md`, `ct-orchestrator`, `ct-epic-architect`, `manifest-operations.md`) hardcodes `claudedocs/agent-outputs` as the `{{OUTPUT_DIR}}` default. The CAAMP injection system passes `{{OUTPUT_DIR}}` as a token at spawn time. But:
- The `packages/core/src/skills/injection/token.ts:82` defaults to `.cleo/agent-outputs`
- The `packages/agents/cleo-subagent/AGENT.md:266` shows `.cleo/agent-outputs`
- Actual skill SKILL.md files show `claudedocs/agent-outputs`

This creates a race: agents spawned via the proper CAAMP injection chain receive `.cleo/agent-outputs`, but the **default value shown in skill documentation** is `claudedocs/agent-outputs`. If token injection fails or is bypassed, agents write to the wrong location.

**Critical Drift Finding: `.cleo/consensus/`, `.cleo/research/`, `.cleo/specs/`, `.cleo/decomposition/` — ORPHAN DIRS**

These 4 directories exist at `.cleo/` root level with files from Apr 8 2026 (T310/T311 RCASD). The canonical system now puts these at `.cleo/rcasd/{epicId}/{stage}/`. The `consolidate-rcasd.ts` code even has a migration function for this (`migrateConsensusDir`), but it was never run for T310/T311. T310 and T311 were early RCASD runs before the per-epic directory structure was solidified.

**Critical Drift Finding: `.cleo/rcasd/audit-*.md` and `CLI-FULL-AUDIT-REPORT.md` — MISPLACED**

13 audit report files from T505 (CLI audit epic, Apr 10) were written to `.cleo/rcasd/` root instead of `.cleo/agent-outputs/`. These are agent output files, not RCASD lifecycle artifacts. The rcasd root should only contain `{epicId}/` subdirectories.

### R4. Prior Work Check

Memory search for "scaffolding", "rcasd", "cleo directory", "artifacts", "ADR" returned no relevant decisions. The BRAIN memory store has low-quality data (743 observations, 16 decisions — but most are session noise). No prior dedicated assessment found.

**However, prior code does exist:**
- `packages/core/src/lifecycle/consolidate-rcasd.ts` — explicitly written to handle migration from flat `.cleo/consensus/` to per-epic `.cleo/rcasd/{epicId}/consensus/` structure (task T5200, epic T4798 per TSDoc). This migration code was written but NOT RUN for T310/T311.
- `ADR-014` (`packages/core/.cleo/adrs/ADR-014-rcasd-rename-and-protocol-validation.md`) — documents the RCSD→RCASD rename; status=`proposed` (not `accepted`). The rename HAS been executed in code but the ADR is not marked accepted.

### R5. Skill/Agent/Instruction Path Audit

| File | Path Ref | Status |
|------|----------|--------|
| `packages/skills/skills/_shared/subagent-protocol-base.md:180` | `claudedocs/agent-outputs` | DRIFT |
| `packages/skills/skills/_shared/manifest-operations.md:16,75,457,541` | `claudedocs/agent-outputs` | DRIFT |
| `packages/skills/skills/ct-orchestrator/references/orchestrator-tokens.md:73,74,158,159` | `claudedocs/agent-outputs` | DRIFT |
| `packages/skills/skills/ct-epic-architect/references/commands.md:200` | `claudedocs/agent-outputs` | DRIFT |
| `packages/skills/skills/ct-consensus-voter/SKILL.md:129` | `.cleo/consensus/CONS-0042.json` | DRIFT — flat path, should be `.cleo/rcasd/{epicId}/consensus/` |
| `packages/skills/skills/ct-spec-writer/SKILL.md:141,153,166,186` | `docs/specs/` | CANONICAL |
| `packages/skills/skills/ct-contribution/SKILL.md:303,518,521` | `docs/specs/` | CANONICAL |
| `packages/agents/cleo-subagent/AGENT.md:266` | `.cleo/agent-outputs` | CANONICAL |
| `packages/core/src/skills/injection/token.ts:82,83,308` | `.cleo/agent-outputs` | CANONICAL |
| `packages/core/src/validation/manifest.ts:81` | `.cleo/agent-outputs` | CANONICAL |
| `packages/core/src/paths.ts:629,638,645` | `.cleo/agent-outputs` | CANONICAL |
| `packages/core/templates/config.template.json:103` | `.cleo/agent-outputs` | CANONICAL |
| `packages/core/schemas/config.schema.json:69,699,719` | `.cleo/agent-outputs` | CANONICAL |
| `docs/CLEO-DOCUMENTATION-SOP.md:29,33,75` | `.cleo/adrs/` and `docs/specs/` | CANONICAL |
| `packages/caamp/.../CLEOOS-VISION.md:344-345` | `docs/adrs/ADR-001/ADR-002` | DRIFT — CAAMP package references old `docs/adrs/` path (pre-migration) |
| `packages/.../CORE-PACKAGE-SPEC.md:1237-1238` | `docs/adrs/ADR-001/ADR-002` | DRIFT — worktree copy of old spec |
| `packages/contracts/src/backup-manifest.ts:14` | `.cleo/specs/T311-backup-portability-spec.md` | DRIFT — references orphan file at deprecated path |
| `packages/core/src/store/agent-registry-accessor.ts:18` | `.cleo/specs/T310-conduit-signaldock-spec.md` | DRIFT — references orphan file at deprecated path |

### R6. Reference Projects — Existing Structure

**`.cleo/adrs/`**: 44 ADRs (ADR-003 through ADR-044). No ADR-001 or ADR-002 — those are in CAAMP package as `docs/adrs/ADR-001` and `ADR-002` (old CAAMP-internal ADRs, separate from project-level ADRs). ADR-040 is missing (gap after ADR-039, before ADR-041).

**`docs/specs/`**: 27 spec files — well-populated, canonical, correct.

**`docs/plans/`**: Contains active plans (CLEO-ULTRAPLAN, T662 council report, brain research, etc.) and specs subdirs.

**`.cleo/agent-outputs/`**: 130+ files across 5 months. Some naming conventions used: `T###-slug.md` (most common), `R-research-topic.md` (research), `SYSTEM-VALIDATION-REPORT.md` (validation). A subdirectory `T684-browser-validation/` exists — the system supports subdirs.

**`.cleo/rcasd/`**: 4 epics with subdirectories (T091, T484, T612, T673). 13 orphan audit files at root.

---

## PHASE C — CONSENSUS: Option Analysis

### Option 1: Pure DB-First

**Description**: Add DB tables for RCASD stages — `rcasd_research`, `rcasd_consensus`, `rcasd_architecture`, `rcasd_specification`, `rcasd_decomposition` — storing full markdown content in TEXT columns. ADRs remain as files in `.cleo/adrs/`. MANIFEST.jsonl replaced by `manifest_entries` table (ADR-027 migration, already partially designed).

**Pros**: Full SQL query capability; no filesystem drift possible; single source of truth for structured data.

**Cons**: 
- Research/spec documents can be 50-100KB of markdown. Storing in SQLite TEXT is fine but complicates git diffs and human review.
- `manifest_entries` table already exists with 0 rows — ADR-027 migration was NEVER completed. Large implementation debt.
- Would require all skills to use a `cleo lifecycle artifact write` CLI command instead of `echo > file`. Non-trivial skill migration.
- ADR-013 data safety: DB files are not git-tracked — if DB is lost, all RCASD content is lost too.

**Migration complexity**: High. **Query capability**: Maximum. **Rollback risk**: High (DB loss = content loss without backups).

### Option 2: Hybrid — DB for State, Files for Narrative (RECOMMENDED)

**Description**: Current architecture, unified and cleaned. DB tracks WHICH stage is at WHICH state with a pointer to the canonical file path. Actual content lives as markdown in canonical folders:
- `.cleo/rcasd/{epicId}/{stage}/` — RCASD stage artifacts (ALL stages: research, consensus, architecture, specification, decomposition, implementation, validation, testing, release)
- `.cleo/adrs/` — ADRs (managed by `cleo adr sync`, DB-mirrored in `architecture_decisions`)
- `.cleo/agent-outputs/` — all ad-hoc agent output files (non-RCASD)
- `docs/specs/` — published, human-facing specifications
- `docs/plans/` — active engineering plans

**Pros**:
- Already mostly implemented (`rcasd-paths.ts`, `stage-artifacts.ts`, `lifecycle_stages.output_file`) — confirms correctness.
- ADRs are both file-based (reviewable in git) AND DB-queryable (via sync).
- Files are git-tracked (see `.cleo/.gitignore` allow-list: `!rcasd/**`).
- Skills can write directly with `bash echo` — no CLI dependency.
- Human-readable diffs in PRs.

**Cons**: Risk of drift if agents write to wrong paths. Requires documentation and skill updates.

**Migration complexity**: Low (moving 10 orphan files, updating skill docs). **Query capability**: Good (DB for state, grep for content). **Rollback risk**: Low.

### Option 3: Pure Filesystem

**Description**: Remove DB tracking entirely. All RCASD artifacts in files only. DB just has task state.

**Pros**: Simplest mental model.

**Cons**: No structured queries on stage status. Would require removing `lifecycle_stages` table and all pipeline tooling. Contradicts `cleo lifecycle` command. No auto-linking between ADRs and tasks. Regression from current capability.

**Migration complexity**: Very high. **Query capability**: Minimal. **Rollback risk**: Medium.

**Recommendation: Option 2 (Hybrid)** — the current design is correct; the problem is incomplete migration, orphan files, and stale skill documentation. Do not change the architecture. Clean up and document it.

---

## PHASE A — ARCHITECTURE DECISION

**Selected**: Option 2 (Hybrid). ADR-045 stub created at `.cleo/adrs/ADR-045-cleo-scaffolding-ssot.md`.

Key decisions encoded in ADR-045:
1. `.cleo/rcasd/{epicId}/{stage}/` is canonical for ALL RCASD stage artifacts
2. `.cleo/adrs/` is canonical for ADRs (files + DB mirror)
3. `.cleo/agent-outputs/` is canonical for ad-hoc agent outputs
4. `docs/specs/` is canonical for published human-facing specifications
5. `claudedocs/` is DEPRECATED — no new files, `cleo upgrade` migrates existing
6. `.cleo/consensus/`, `.cleo/research/`, `.cleo/specs/`, `.cleo/decomposition/` (flat) are DEPRECATED — migrate to `.cleo/rcasd/{epicId}/`
7. `manifest_entries` DB table remains RESERVED for future activation (ADR-027)

---

## PHASE S — SPECIFICATION HIGHLIGHTS

Full spec at `docs/specs/cleo-scaffolding-ssot-spec.md`. Summary:

### Canonical Path Table

| Artifact Type | Canonical Path | DB Table | Notes |
|--------------|----------------|----------|-------|
| RCASD research | `.cleo/rcasd/{epicId}/research/{epicId}-research.md` | `lifecycle_stages.output_file` | |
| RCASD consensus | `.cleo/rcasd/{epicId}/consensus/{epicId}-consensus.md` | `lifecycle_stages.output_file` | |
| RCASD architecture | `.cleo/rcasd/{epicId}/architecture/{epicId}-architecture-decision.md` | `lifecycle_stages.output_file` | |
| RCASD specification | `.cleo/rcasd/{epicId}/specification/{epicId}-specification.md` | `lifecycle_stages.output_file` | |
| RCASD decomposition | `.cleo/rcasd/{epicId}/decomposition/{epicId}-decomposition.md` | `lifecycle_stages.output_file` | |
| RCASD implementation | `.cleo/rcasd/{epicId}/implementation/{epicId}-implementation.md` | `lifecycle_stages.output_file` | |
| RCASD validation | `.cleo/rcasd/{epicId}/validation/{epicId}-validation.md` | `lifecycle_stages.output_file` | |
| RCASD testing | `.cleo/rcasd/{epicId}/testing/{epicId}-testing.md` | `lifecycle_stages.output_file` | |
| RCASD release | `.cleo/rcasd/{epicId}/release/{epicId}-release.md` | `lifecycle_stages.output_file` | |
| ADR | `.cleo/adrs/ADR-NNN-short-description.md` | `architecture_decisions.file_path` | `cleo adr sync` keeps in sync |
| Agent output | `.cleo/agent-outputs/{taskId}-{slug}.md` or `{date}_{topic}.md` | `pipeline_manifest` (future) | MANIFEST.jsonl at `.cleo/agent-outputs/MANIFEST.jsonl` |
| Spec (published) | `docs/specs/SPEC-NAME.md` | None | Human-facing, RFC 2119 |
| Plan (active) | `docs/plans/PLAN-NAME.md` | None | Engineering plans |
| CANT agent | `.cleo/agents/{name}.cant` | None | Team personas |
| SignalDock creds | `.cleo/signaldock/{name}.json` | `agent_credentials` | |
| Backups | `.cleo/backups/sqlite/` | None | ADR-013, ADR-038 |

### Deprecation Map

| Old Path | New Path | Tool |
|----------|----------|------|
| `claudedocs/agent-outputs/` | `.cleo/agent-outputs/` | `cleo upgrade` (already migrates) |
| `claudedocs/research-outputs/` | `.cleo/agent-outputs/` | `cleo upgrade` (already migrates) |
| `.cleo/research/{T###}-*.md` | `.cleo/rcasd/{epicId}/research/` | `git mv` |
| `.cleo/consensus/{T###}-*.md` | `.cleo/rcasd/{epicId}/consensus/` | `git mv` |
| `.cleo/specs/{T###}-*.md` | `.cleo/rcasd/{epicId}/specification/` | `git mv` |
| `.cleo/decomposition/{T###}-*.md` | `.cleo/rcasd/{epicId}/decomposition/` | `git mv` |
| `.cleo/rcasd/audit-*.md` (13 files) | `.cleo/agent-outputs/` | `git mv` |
| `.cleo/rcasd/CLI-FULL-AUDIT-REPORT.md` | `.cleo/agent-outputs/` | `git mv` |
| `docs/adrs/ADR-001/002` (CAAMP) | Keep as-is in CAAMP package (different scope) | No action |

---

## PHASE D — DECOMPOSITION

10 atomic child tasks defined below. All created via `cleo add --parent T687`.

---

## Evidence Summary

### Inventory Evidence

- `.cleo/` root files: `ls -la .cleo/` — 37,775KB total, 42 direct entries
- Directory tree: `find .cleo -type d | sort` — 300+ dirs (mostly .git objects)
- Functional dirs: 22 (excluding .git)

### DB Evidence

- `tasks.db .tables` — 27 tables, 687 tasks
- `brain.db .tables` — 35 tables, 743 observations, 1052 page nodes, 3820 page edges
- `lifecycle_stages` output_file values confirm `.cleo/rcasd/{epicId}/{stage}/` is canonical

### Drift Evidence

- `grep -rn "claudedocs" packages/ skills/` — 15+ hits in shared skill files (lines cited above)
- `grep -rn ".cleo/specs" packages/ skills/` — 2 source code `@see` refs pointing to orphan files
- `grep -rn ".cleo/consensus" packages/ skills/` — 1 skill example using flat path
- `.cleo/research/`, `.cleo/consensus/`, `.cleo/specs/`, `.cleo/decomposition/` — all contain T310/T311 files
- `.cleo/rcasd/audit-*.md` — 13 misplaced files confirmed Apr 10 date (T505)

### Prior Work Evidence

- `packages/core/src/lifecycle/consolidate-rcasd.ts` — migration code for this exact problem exists but was NOT run for T310/T311
- `ADR-014` (`status: proposed`) — RCASD rename ADR exists but is not marked accepted
- Brain memory search returned no relevant prior assessments on this topic
