# T1096 — Unified Manifest CLI Surface, Migration Contract, Deprecation Plan & ADR-054 Outline

**Version**: 1.0.0
**Status**: APPROVED
**Date**: 2026-04-21
**Task**: T1096
**Epic**: T1093 — MANIFEST/RCASD Architecture Unification
**Depends On**: T1094 (inventory), T1095 (drift map)
**Supersedes**: ADR-027 §6.2 (migration execution gap)
**Authors**: cleo-db-lead (Wave 2 Spec)

---

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in RFC 2119.

---

## 0. Executive Summary

ADR-027 retired `MANIFEST.jsonl` in favour of the `pipeline_manifest` table in
`tasks.db`. That decision was correct. The execution gap (ADR-027 §6.2) is that
the **CLI surface** was never unified, `rcasd/` phase files were never ingested,
390 loose agent-output markdown files have no canonical home in `pipeline_manifest`,
and compiled agent prompts still instruct agents to `echo >> MANIFEST.jsonl`.

This spec closes all four gaps:

1. Defines the exact `cleo manifest <subcommand>` CLI surface (§2)
2. Specifies `rcasd/` FOLDING into `pipeline_manifest` (§3)
3. Specifies loose `.cleo/agent-outputs/*.md` ingestion (§4)
4. Provides the field-level migration contract from JSONL schema to `pipeline_manifest` (§5)
5. Defines the deprecation plan for `cleo research manifest` (§6)
6. Updates agent compilation requirements (§7)
7. Outlines ADR-054 (§8)
8. Provides programmatically verifiable acceptance criteria for T1097, T1098, T1099 (§9)

---

## 1. Background & Problem Statement

### 1.1 Current State (from T1094 inventory)

| Store | Count | State |
|-------|-------|-------|
| `MANIFEST.jsonl` lines | 319 | Active append target (MUST stop) |
| `.cleo/rcasd/` markdown files | 182 | Never ingested into `pipeline_manifest` |
| `.cleo/agent-outputs/*.md` loose files | 390 | Never ingested into `pipeline_manifest` |
| `pipeline_manifest` rows | 1 | Seed entry only — effectively empty |

### 1.2 Root Causes (from T1095 drift map)

- **P0**: Compiled agent prompt (`cleo-subagent.md`) BASE-001 still names
  `MANIFEST.jsonl` as the append target; Phase 3 `echo >> MANIFEST.jsonl`
  instruction actively conflicts with ADR-027
- **P0**: `orchestrator.md` (both `.claude/commands/` and adapters copy) instruct
  agents to call `cleo manifest show` — a command that does not exist
- **P0**: `ct-orchestrator/orchestrator-prompt.txt:20` references MANIFEST.jsonl
  write path
- **P1**: 45+ references across skill docs, shared protocol files, and CANT
  source files continue to instruct direct JSONL writes

### 1.3 Scope of This Spec

This spec is **normative for T1097, T1098, T1099** (implementation wave). It does
not implement anything itself — it defines the contracts those tasks MUST satisfy.

---

## 2. `cleo manifest` CLI Surface

### 2.1 Top-Level Command Registration

A new top-level command group `cleo manifest` MUST be registered in the CLEO CLI
(`packages/cleo/src/cli/index.ts`). It MUST expose the following subcommands:

| Subcommand | Dispatch Operation | Gateway | Description |
|------------|-------------------|---------|-------------|
| `show <id>` | `pipeline.manifest.show` | query | Show single entry by ID |
| `list` | `pipeline.manifest.list` | query | List entries with filters |
| `find <query>` | `pipeline.manifest.find` | query | FTS search across content + metadata |
| `stats` | `pipeline.manifest.stats` | query | Aggregate counts by type/status |
| `append` | `pipeline.manifest.append` | mutate | Insert new entry |
| `archive <id>` | `pipeline.manifest.archive` | mutate | Archive entry by ID |

### 2.2 Argument Schema

#### 2.2.1 `cleo manifest show <id>`

```
cleo manifest show <id>

Arguments:
  id  (positional, required)  Pipeline manifest entry ID

Exit codes:
  0   Success — entry printed as JSON to stdout
  4   Entry not found (E_NOT_FOUND)
  1   Unexpected error
```

#### 2.2.2 `cleo manifest list`

```
cleo manifest list [options]

Options:
  --filter <value>    Filter by status: active|archived|distilled|pending
                      "pending" = entries where metadata_json.actionable = true
  --task <id>         Filter by task_id
  --epic <id>         Filter by epic_id
  --type <type>       Filter by entry type (see §5.2 type enum)
  --limit <n>         Maximum rows to return (default: 50, max: 500)
  --offset <n>        Pagination offset (default: 0)
  --json              Output as JSON array (default: table)

Exit codes:
  0   Success
  1   Invalid filter value or unexpected error
```

#### 2.2.3 `cleo manifest find <query>`

```
cleo manifest find <query>

Arguments:
  query  (positional, required)  Full-text search string

Options:
  --limit <n>   Maximum rows to return (default: 20)
  --json        Output as JSON array

Exit codes:
  0   Success (zero results is still exit 0)
  1   Unexpected error
```

#### 2.2.4 `cleo manifest stats`

```
cleo manifest stats [options]

Options:
  --json   Output as JSON object

Output structure:
  total: number
  by_type: Record<string, number>
  by_status: Record<string, number>
  distilled: number
  pending_distillation: number

Exit codes:
  0   Success
  1   Unexpected error
```

#### 2.2.5 `cleo manifest append`

```
cleo manifest append [options]

Options:
  --entry <json>    (required) JSON string of entry fields
  --task <id>       Task ID to associate with this entry (shorthand for entry.task_id)
  --type <type>     Entry type (shorthand for entry.type) — see §5.2
  --content <text>  Entry content string (shorthand for entry.content)

Behaviour:
  - Computes SHA-256 content_hash from --content or entry.content
  - If an active entry with identical content_hash exists, returns existing ID
    without inserting (idempotent by ADR-027 §8)
  - Assigns created_at = datetime('now') if not provided in --entry

Exit codes:
  0   Success — entry ID printed to stdout
  9   Duplicate suppressed — existing entry ID printed with note to stderr
  1   Missing required fields or unexpected error
```

#### 2.2.6 `cleo manifest archive <id>`

```
cleo manifest archive <id>

Arguments:
  id  (positional, required)  Entry ID to archive

Options:
  --before <date>   Archive all active entries created before ISO date
                    (mutually exclusive with positional id)

Exit codes:
  0   Success
  4   Entry not found (E_NOT_FOUND)
  1   Unexpected error
```

### 2.3 Dispatch Mapping

All `cleo manifest` subcommands MUST dispatch via `dispatchFromCli()` to the
`pipeline` domain using the operation names in §2.1. They MUST NOT call
`dispatchFromCli('query', 'memory', ...)` — the manifest operations live in the
`pipeline` domain per ADR-021.

```typescript
// Canonical dispatch examples:
dispatchFromCli('query',  'pipeline', 'manifest.show',   { entryId: id })
dispatchFromCli('query',  'pipeline', 'manifest.list',   { filter, taskId, type, limit, offset })
dispatchFromCli('query',  'pipeline', 'manifest.find',   { query })
dispatchFromCli('query',  'pipeline', 'manifest.stats',  {})
dispatchFromCli('mutate', 'pipeline', 'manifest.append', { entry })
dispatchFromCli('mutate', 'pipeline', 'manifest.archive',{ id } | { beforeDate })
```

### 2.4 Help Text Requirements

`cleo manifest --help` MUST display the subcommand table from §2.1.
Each subcommand MUST display its own `--help` with argument schema per §2.2.
The help text MUST NOT reference `MANIFEST.jsonl` — only `pipeline_manifest`.

---

## 3. `rcasd/` Fate Decision — FOLD into `pipeline_manifest`

### 3.1 Decision

All `.cleo/rcasd/<task_id>/<phase>/<filename>.md` files MUST be ingested into
`pipeline_manifest` as individual rows. The `rcasd/` directory tree MUST be
retained on disk (do NOT delete); the files serve as `source_file` references.

### 3.2 ID Generation

Each `rcasd` file generates a `pipeline_manifest` entry with:

```
id = "<task_id>-rcasd-<phase>-<slug>"
```

where `<slug>` is the filename without `.md` extension, lowercased,
non-alphanumeric characters replaced with hyphens.

Example:
- File: `.cleo/rcasd/T876/research/T876-research.md`
- ID: `T876-rcasd-research-t876-research`

The ID MUST be globally unique. If a collision occurs (same task + phase +
slug already exists in `pipeline_manifest`), the existing entry MUST be updated
via `manifest.update` (not re-inserted) to preserve the `content_hash`
deduplication invariant.

### 3.3 Column Mapping for RCASD Files

| `pipeline_manifest` column | Source | Derivation |
|---------------------------|--------|------------|
| `id` | filename + path | `<task_id>-rcasd-<phase>-<slug>` per §3.2 |
| `task_id` | parent directory name | First path segment under `.cleo/rcasd/` |
| `epic_id` | NULL | Not resolvable from filesystem; set NULL on import |
| `session_id` | NULL | Not tracked in rcasd files |
| `type` | phase directory name | MUST apply §3.4 phase → type mapping |
| `content` | file contents | Full UTF-8 content of the `.md` file |
| `content_hash` | computed | SHA-256 of `content` |
| `status` | constant | `active` |
| `source_file` | file path | Relative path from project root |
| `metadata_json` | derived | `{"phase": "<phase>", "rcasd_origin": true}` |
| `created_at` | file mtime | ISO-8601 UTC; fallback to current datetime |
| `distilled` | constant | `0` |
| `brain_obs_id` | NULL | Not yet distilled |
| `archived_at` | NULL | Not archived |

### 3.4 Phase → `pipeline_manifest.type` Mapping (Normative)

| `rcasd/` phase directory | `pipeline_manifest.type` | `metadata_json.phase` |
|--------------------------|--------------------------|----------------------|
| `research` | `research` | `research` |
| `specification` | `specification` | `specification` |
| `architecture` | `architecture` | `architecture` |
| `consensus` | `consensus` | `consensus` |
| `decomposition` | `decomposition` | `decomposition` |
| `implementation` | `implementation` | `implementation` |
| `testing` | `validation` | `testing` |
| `validation` | `validation` | `validation` |
| `release` | `release` | `release` |

The `metadata_json.phase` field MUST preserve the original directory name
verbatim (e.g., `testing`, not `validation`) so that the RCASD phase is
recoverable from the SQLite record.

### 3.5 Atypical File Handling

The four atypical files identified in T1094 §4c MUST be handled as follows:

| File | Action |
|------|--------|
| `.cleo/rcasd/T919/consensus/auto-complete-policy.md` | Ingest as `type=consensus`, `task_id=T919`; note in `metadata_json.filename_note = "non-T-prefixed policy doc"` |
| `.cleo/rcasd/T1000/decomposition/worker-specs.md` | Ingest as `type=decomposition`, `task_id=T1000`; `metadata_json.filename_note = "worker allocation sub-document"` |
| `.cleo/rcasd/T991/decomposition/worker-specs.md` | Same pattern as T1000 |
| `.cleo/rcasd/T1007/decomposition/T1008-worker-spec.md` | Ingest as `type=decomposition`, `task_id=T1007`; `metadata_json.cross_task_ref = "T1008"` |

These entries MUST NOT be skipped; they contain valid RCASD content.

### 3.6 Idempotency

The RCASD ingestion function MUST be idempotent. Calling it multiple times on the
same `.cleo/rcasd/` tree MUST NOT create duplicate rows. Idempotency is enforced
via:
1. Primary key conflict (`INSERT OR IGNORE`) on `id`
2. `content_hash` deduplication check per ADR-027 §8

---

## 4. Loose `.cleo/agent-outputs/*.md` Ingestion

### 4.1 Scope

The 390 files at `.cleo/agent-outputs/*.md` (maxdepth=1) MUST be ingested into
`pipeline_manifest`. Subdirectory files (e.g., `T1007-tier3-design/`) are treated
separately and MAY be ingested in a future task.

### 4.2 Task ID Extraction

Task ID MUST be extracted from the filename using the following rules, in priority order:

1. **Standard pattern** `T\d+-...`: extract first `T\d+` segment as `task_id`
   - Example: `T523-R1-brain-audit-report.md` → `task_id = T523`
2. **Multi-task pattern** `T\d+-T\d+-...`: extract first `T\d+` as `task_id`;
   store remaining task IDs in `metadata_json.linked_tasks`
   - Example: `T760-T761-research.md` → `task_id = T760`, `linked_tasks = ["T761"]`
3. **Session/planning files** (`MASTER-*`, `NEXT-*`, `prime-*`): `task_id = NULL`;
   `type = documentation`
4. **Research standalone** (`R-*.md`): `task_id = NULL`; `type = research`
5. **Release notes** (`RELEASE-*.md`, `release-*.md`): `task_id = NULL`;
   `type = release`
6. **Special/unclassified** (see §4.3): `task_id = NULL`; type inferred per §4.3

### 4.3 Type Inference from Filename

When no explicit `type` field exists in file front-matter, MUST apply these
inference rules in order:

| Filename pattern (regex) | Inferred `type` |
|--------------------------|-----------------|
| `.*-research.*` | `research` |
| `.*-specification.*\|.*-spec.*` | `specification` |
| `.*-architecture.*\|.*-arch.*` | `architecture` |
| `.*-consensus.*` | `consensus` |
| `.*-decomposition.*\|.*-decomp.*` | `decomposition` |
| `.*-implementation.*\|.*-impl.*` | `implementation` |
| `.*-validation.*\|.*-validate.*` | `validation` |
| `.*-audit.*` | `research` |
| `.*-report.*` | `research` |
| `.*-fix.*\|.*-hotfix.*` | `implementation` |
| `.*-release.*` | `release` |
| `MASTER-.*\|NEXT-.*\|prime-.*` | `documentation` |
| `R-.*` | `research` |
| (none of the above) | `implementation` (fallback) |

### 4.4 Unclassified File Handling (17 files)

The 17 special/unclassified files identified in T1094 §5b MUST be ingested with
the following explicit overrides:

| Filename | `type` | `task_id` |
|----------|--------|-----------|
| `CANT-V2-PERSONA-SCHEMA-PLAN.md` | `specification` | NULL |
| `CLI-SYSTEM-AUDIT-2026-04-10.md` | `research` | NULL |
| `DOC-SYNC-AUDIT-2026-04-20.md` | `research` | NULL |
| `STAB-3-clean-install-results.md` | `validation` | NULL |
| `SYSTEM-VALIDATION-REPORT.md` | `validation` | NULL |
| `T-ladybugdb-research-report.md` | `research` | NULL |
| `T-verify-specs-report.md` | `validation` | NULL |
| `ci-workflow-complete.md` | `implementation` | NULL |
| `cicd-validation-report.md` | `validation` | NULL |
| `conduit-orchestration-wiring.md` | `implementation` | NULL |
| `deploy-templates-complete.md` | `implementation` | NULL |
| `fix-cant-core-size.md` | `implementation` | NULL |
| `fix-cant-lsp-match.md` | `implementation` | NULL |
| `github-templates-complete.md` | `implementation` | NULL |
| `graph-memory-bridge-implementation.md` | `implementation` | NULL |
| `llmtxt-my-sitrep-2026-04-11.md` | `research` | NULL |
| `research-node-sqlite.md` | `research` | NULL |

These entries MUST be ingested with `task_id = NULL`. A post-ingestion linking
pass MAY update `task_id` based on content analysis (out of scope for T1097–T1099).

### 4.5 Column Mapping for Loose Files

| `pipeline_manifest` column | Source | Derivation |
|---------------------------|--------|------------|
| `id` | filename | `<task_id>-loose-<slug>` or `loose-<slug>` if no task_id |
| `task_id` | filename | Per §4.2 rules |
| `epic_id` | NULL | Not resolvable from filename |
| `session_id` | NULL | Not tracked in loose files |
| `type` | filename | Per §4.3 inference rules |
| `content` | file contents | Full UTF-8 content of the `.md` file |
| `content_hash` | computed | SHA-256 of `content` |
| `status` | constant | `active` |
| `source_file` | file path | Relative path: `.cleo/agent-outputs/<filename>` |
| `metadata_json` | derived | `{"loose_origin": true, "original_filename": "<filename>"}` |
| `created_at` | file mtime | ISO-8601 UTC; fallback to current datetime |

### 4.6 Flat RCASD Phase Files (25 files)

The 25 files in `.cleo/agent-outputs/` that follow RCASD phase naming conventions
(e.g., `T523-R1-brain-audit-report.md`, `T549-CA1-tiered-typed-memory-spec.md`)
MUST be ingested as type `research` or `specification` per §4.3 filename pattern,
AND additionally tagged with `metadata_json.flat_rcasd = true` so they can be
identified for future migration into the `rcasd/` tree.

---

## 5. Migration Contract — JSONL Schema to `pipeline_manifest`

### 5.1 Field-by-Field Mapping (Normative)

This table supersedes the preliminary mapping in T1094 §3 and the partial mapping
in CLEO-MANIFEST-SCHEMA-SPEC.md §6.1, incorporating all field variants observed
in the 319-line corpus.

| JSONL legacy field(s) | `pipeline_manifest` column | Transformation |
|----------------------|---------------------------|----------------|
| `id` | `id` | Use as-is. If absent: generate `<taskId>-<timestamp>` |
| `task` / `taskId` / `task_id` | `task_id` | Use first non-null match in this order |
| `epic` | `epic_id` | Use as-is; NULL if absent |
| (not in JSONL) | `session_id` | Set NULL on JSONL import |
| `type` / `agent_type` | `type` | Apply §5.2 normalization table |
| (entire JSONL line, serialized) | `content` | Full JSON string of the source line |
| (computed) | `content_hash` | SHA-256 hex of `content` string |
| `status` | `status` | Apply §5.3 status normalization |
| (constant) | `distilled` | `0` |
| (none) | `brain_obs_id` | NULL |
| `output` / `outputFile` / `file` / `output_file` | `source_file` | First non-null match in this order |
| `key_findings` | `metadata_json.key_findings` | JSON array |
| `needs_followup` | `metadata_json.needs_followup` | JSON array |
| `topics` | `metadata_json.topics` | JSON array |
| `linked_tasks` | `metadata_json.linked_tasks` | JSON array |
| `evidence` | `metadata_json.evidence` | JSON array |
| `title` | `metadata_json.title` | String |
| `summary` | `metadata_json.summary` | String |
| `role` | `metadata_json.role` | String |
| `agent` | `metadata_json.agent` | String |
| `commit` | `metadata_json.commit` | String |
| `files` | `metadata_json.files` | JSON array |
| `slug` | `metadata_json.slug` | String |
| `date` / `timestamp` | `created_at` | Normalize to ISO-8601 UTC; if date-only (`YYYY-MM-DD`) append `T00:00:00Z` |
| (not in JSONL unless status=archived) | `archived_at` | Set to current datetime only if source `status = archived`; otherwise NULL |

All JSONL fields not listed above MUST be captured in `metadata_json` under their
original key name to prevent data loss.

### 5.2 Type Normalization Table (Normative)

This table is the authoritative source for mapping JSONL `type`/`agent_type`
values to canonical `pipeline_manifest.type` values. Implementations MUST
use this table, not ad-hoc string matching.

| JSONL type value(s) | `pipeline_manifest.type` |
|--------------------|--------------------------|
| `implementation`, `fix`, `worker`, `scaffolding`, `build-fix`, `completion`, `work`, `summary`, `task-output`, `task-completion-report`, `worker-output`, `refactor` | `implementation` |
| `research`, `audit`, `analysis`, `forensic`, `assessment`, `diagnostic`, `triage`, `investigation`, `rcasd-lead`, `lead` | `research` |
| `validation`, `verification`, `attestation`, `smoke-test` | `validation` |
| `specification` | `specification` |
| `consensus`, `synthesis`, `algorithm-council`, `schema-council`, `council-lead`, `council-audit`, `council-synthesis` | `consensus` |
| `decomposition`, `planning` | `decomposition` |
| `architecture-spec`, `design`, `Design` | `architecture` |
| `documentation` | `documentation` |
| `release`, `release-recovery` | `release` |
| (no type field) | Apply §5.4 fallback inference |

Case-insensitive matching MUST be applied before lookup (normalize input to lowercase).

### 5.3 Status Normalization Table (Normative)

| JSONL `status` value | `pipeline_manifest.status` |
|---------------------|---------------------------|
| `complete` | `active` |
| `completed` | `active` |
| `done` | `active` |
| `partial` | `active` |
| `archived` | `archived` (set `archived_at = created_at` if available) |
| `deferred` | `archived` |
| (absent) | `active` |

Note: MANIFEST.jsonl `complete`/`partial` status reflects agent completion state,
not entry lifecycle state. In `pipeline_manifest`, the entry lifecycle is
`active`/`distilled`/`archived`. Agent completion metadata SHOULD be stored in
`metadata_json.agent_status = "complete"` during migration.

### 5.4 Missing-Type Fallback Inference

For the 73 entries with no `type` or `agent_type` field, apply these inference
rules in order (first match wins):

1. Has `files`, `commit`, `tests_added`, or `files_changed` key → `implementation`
2. Has `key_findings` or `topics` without implementation keys → `research`
3. Has `version` or `tag` key → `release`
4. Has `summary` containing the word "audit" (case-insensitive) → `research`
5. Fallback → `implementation`

Entries that cannot be classified by these rules MUST be ingested with
`type = implementation` and `metadata_json.type_inferred = true` so they can be
manually corrected.

### 5.5 Idempotency via `content_hash`

The migration function MUST:
1. Compute `content_hash = SHA-256(content)` for each entry before insert
2. Use `INSERT OR IGNORE` on primary key `id` for idempotency
3. Additionally check `content_hash` uniqueness among `status = active` entries;
   if a duplicate hash exists, skip insert and log the collision

Calling `migrateManifestJsonl()` on an already-migrated dataset MUST return
`{ migrated: 0, skipped: N }` without errors.

### 5.6 Overlap Deduplication (JSONL + RCASD)

Some tasks have entries in both MANIFEST.jsonl AND `.cleo/rcasd/` (e.g., T487,
T870, T876, T882, T861, T1000, T991 per T1094 §7d).

Resolution rule:
- RCASD phase files (structured, per-phase markdown) take precedence over
  JSONL entries for the **same task + phase combination**
- JSONL entries for a task+phase that already has an RCASD file MUST be marked
  `metadata_json.superseded_by = "<rcasd-entry-id>"` and status set to `archived`
  during migration
- JSONL entries for tasks without corresponding RCASD files MUST be ingested
  normally

---

## 6. Deprecation Plan — `cleo research manifest`

### 6.1 Current State

`cleo research manifest` is a subcommand of `cleo research` that queries
`MANIFEST.jsonl` directly. This command exists in
`packages/cleo/src/cli/commands/research.ts` and wraps legacy file operations.

### 6.2 Deprecation Timeline

| Phase | CalVer | Action |
|-------|--------|--------|
| Phase 1 (immediate) | v2026.4.current | `cleo research manifest` MUST print a deprecation warning to stderr before executing |
| Phase 2 (next CalVer month bump) | v2026.5.x | `cleo research manifest` MUST delegate to `cleo manifest list` instead of reading JSONL directly; warning persists |
| Phase 3 (following month) | v2026.6.x | `cleo research manifest` subcommand MUST be removed entirely |

### 6.3 Deprecation Warning Text (Normative)

Phase 1 and Phase 2 MUST print this exact warning to stderr before producing output:

```
DEPRECATED: `cleo research manifest` is deprecated and will be removed in v2026.6.x.
Use `cleo manifest list` instead. See docs/specs/T1096-manifest-unification-spec.md
```

### 6.4 Phase 1 Implementation Requirements

The Phase 1 change (T1097 scope) MUST:
1. Add a deprecation warning print to `stderr` in `research.ts` `manifest` subcommand
2. Continue to execute the original functionality after printing the warning
3. NOT break existing callers during the transition period

### 6.5 `cleo research add` Alias

`cleo research add` MUST be preserved as an alias for `cleo manifest append`
for backwards compatibility. It MUST print the same deprecation warning. Removal
follows the same Phase 3 timeline.

### 6.6 Legacy Return Messages Preserved

The return message strings of the form `"[Type] complete. See MANIFEST.jsonl for
summary."` are **intentionally preserved** per T1095 §Key Decision. These strings
are agent-visible summary strings and do not instruct agents to perform file
operations. They MUST NOT be changed in this epic.

---

## 7. Agent Compilation Requirements

### 7.1 BASE-001 Update (Normative)

`BASE-001` in compiled agent prompts MUST be updated from:

```
BASE-001 | MUST append ONE line to MANIFEST.jsonl | Required
```

to:

```
BASE-001 | MUST call pipeline.manifest.append before cleo complete | Required
```

This change MUST be made in all of the following files (P0 severity per T1095):
- `/home/keatonhoskins/.claude/agents/cleo-subagent.md`
- `packages/agents/README.md`
- `packages/skills/skills/ct-cleo/references/loom-lifecycle.md`
- `packages/skills/skills/ct-orchestrator/references/SUBAGENT-PROTOCOL-BLOCK.md`

### 7.2 Phase 3 Echo Pattern Removal (Normative)

The following instruction MUST be removed from all compiled agent prompts:

```bash
echo '{"id":"{{TASK_ID}}-slug",...}' >> {{MANIFEST_PATH}}
```

And MUST be replaced with:

```bash
mutate pipeline.manifest.append {entry: {id: "{{TASK_ID}}-slug", type: "...", content: "...", taskId: "{{TASK_ID}}"}}
```

Equivalently, agents MAY use the new `cleo manifest append` CLI:

```bash
cleo manifest append --task {{TASK_ID}} --type <type> --content "<summary>"
```

### 7.3 `{{MANIFEST_PATH}}` Token Deprecation

The `{{MANIFEST_PATH}}` token in agent prompt templates MUST be deprecated.
All occurrences of `{{MANIFEST_PATH}}` in token tables MUST be removed from:
- `packages/skills/skills/_shared/subagent-protocol-base.md` (line 181)
- `packages/skills/skills/ct-orchestrator/references/orchestrator-tokens.md` (lines 74, 159)
- `packages/skills/skills/ct-epic-architect/references/commands.md` (line 201)
- `packages/skills/skills/_shared/task-system-integration.md` (line 172)
- `packages/core/templates/config.template.json` (deprecate `manifestFile` key)
- `packages/skills/skills/_shared/placeholders.json` (lines 74–76)

The `MANIFEST_PATH` placeholder in `placeholders.json` MUST have its `default`
value updated to `"pipeline_manifest"` and `description` updated to
`"Deprecated — use pipeline.manifest.append op instead"`.

### 7.4 `cleo manifest show` References (Normative)

All references to `cleo manifest show <id>` in orchestrator prompts MUST be
replaced with the correct dispatch form:

```
query pipeline manifest.show {entryId: "<id>"}
```

Files requiring this fix (P0 per T1095):
- `.claude/commands/orchestrator.md` (lines 92, 117, 128)
- `packages/adapters/src/providers/claude-code/commands/orchestrator.md` (same lines)
- `packages/skills/skills/ct-orchestrator/orchestrator-prompt.txt` (line 20)

### 7.5 cleo-subagent.cant and Compiled .md MUST Use `cleo manifest append`

The `cleo-subagent.cant` source file (already correct per T1095 §7) MUST be the
canonical source of truth for the compiled `cleo-subagent.md`. When compiled,
the `.md` MUST instruct agents to call:

```
cleo manifest append --task {{TASK_ID}} --type <type> --content "<content>"
```

or equivalently:

```
mutate pipeline manifest.append {entry: {...}}
```

The compiled `.md` MUST NOT instruct `echo >> MANIFEST.jsonl` in any section.
This requirement applies to ALL agent protocol compilation targets.

---

## 8. ADR-054 Outline

**Status**: Draft
**Supersedes**: ADR-027 §6.2 (migration execution gap)
**Related**: ADR-006, ADR-021, ADR-027, ADR-051

### 8.1 Context

ADR-027 (Manifest SQLite Migration) established `pipeline_manifest` as the
authoritative store for agent output artifacts and specified a one-time
`migrateManifestJsonl()` function. The migration function was specified but the
following execution gaps remained unaddressed:

1. No `cleo manifest` top-level CLI was created; agents have no ergonomic CLI
   for manifest operations
2. `rcasd/` phase files (182 files, 36 tasks) were never ingested into
   `pipeline_manifest`
3. 390 loose `.cleo/agent-outputs/*.md` files have no pipeline_manifest rows
4. Compiled agent prompts still instruct `echo >> MANIFEST.jsonl` despite ADR-027

### 8.2 Decision

ADR-054 MUST formally:

1. **Extend ADR-027** with the `cleo manifest` CLI surface (§2 of this spec)
2. **Mandate RCASD ingestion** as a required step in the RCASD-IVTR+C lifecycle
   model: any RCASD phase file written MUST be registered in `pipeline_manifest`
   via `cleo manifest append` before the phase is marked complete
3. **Mandate loose file ingestion** via the one-time migration task (T1098 scope)
4. **Retire the `{{MANIFEST_PATH}}` token** from all template files and
   placeholder systems
5. **Establish a `cleo manifest append` pre-complete requirement**: the CLEO
   lifecycle gate `cleo complete <task>` MUST verify that at least one
   `pipeline_manifest` entry exists for the task being completed (gate:
   `manifestAppended`) for tasks of type task (not epic/milestone)

### 8.3 Consequences

**Positive**:
- Single CLI surface for all manifest operations (`cleo manifest *`)
- `pipeline_manifest` becomes the true SSoT for agent artifact provenance
- RCASD phase history fully queryable via SQL
- Agents receive unambiguous, working CLI instructions

**Negative**:
- Compiled agent prompts require coordinated update across skills, prompts, and
  CANT source files (tracked in T1095 drift map)
- One-time migration of 571 artifacts (319 JSONL + 182 RCASD + ~70 unique loose)
  requires careful idempotency handling

**Neutral**:
- MANIFEST.jsonl retained as `.migrated` for one release cycle (existing ADR-027 §6.2 plan)
- Return message strings (`"See MANIFEST.jsonl for summary"`) preserved intentionally

### 8.4 ADR Number

This outline SHALL become **ADR-054** upon formal ratification. The file MUST
be created at `.cleo/adrs/ADR-054-manifest-cli-unification.md`.

---

## 9. Acceptance Criteria for Wave 3 Implementation Tasks

The following criteria are programmatically verifiable. Each MUST be checked by
the implementing agent before marking the task complete.

### 9.1 T1097 — `cleo manifest` CLI Registration + Deprecation Warning

| # | Criterion | Verification Command |
|---|-----------|---------------------|
| AC-1097-1 | `cleo manifest --help` exits 0 and lists all 6 subcommands | `cleo manifest --help \| grep -c "show\|list\|find\|stats\|append\|archive"` returns `6` |
| AC-1097-2 | `cleo manifest show <nonexistent>` exits 4 | `cleo manifest show NONEXISTENT_ID; echo $?` returns `4` |
| AC-1097-3 | `cleo manifest stats` exits 0 and returns valid JSON with `total` key | `cleo manifest stats --json \| jq '.total'` returns a number |
| AC-1097-4 | `cleo manifest append --task T1097 --type research --content "test"` exits 0 and returns an ID | `cleo manifest append --task T1097 --type research --content "test" \| grep -E "^[a-z]"` |
| AC-1097-5 | `cleo research manifest` prints deprecation warning to stderr | `cleo research manifest 2>&1 \| grep "DEPRECATED"` matches |
| AC-1097-6 | `pnpm biome ci .` exits 0 | `pnpm biome ci . ; echo $?` returns `0` |
| AC-1097-7 | `pnpm run build` exits 0 | `pnpm run build ; echo $?` returns `0` |
| AC-1097-8 | `pnpm run test` introduces zero new failures vs main | `pnpm run test 2>&1 \| tail -5` shows no new failures |
| AC-1097-9 | dispatch mapping uses `pipeline` domain (not `memory` domain) | `grep -n "dispatchFromCli" packages/cleo/src/cli/commands/manifest.ts \| grep "pipeline"` matches |

### 9.2 T1098 — RCASD Ingestion into `pipeline_manifest`

| # | Criterion | Verification Command |
|---|-----------|---------------------|
| AC-1098-1 | All 182 RCASD files have corresponding `pipeline_manifest` rows | `node -e "import('./...')" or SQL: `SELECT COUNT(*) FROM pipeline_manifest WHERE json_extract(metadata_json, '$.rcasd_origin') = 1` returns `≥ 182` |
| AC-1098-2 | Every ingested row has `content_hash` populated | `SELECT COUNT(*) FROM pipeline_manifest WHERE rcasd_origin AND content_hash IS NULL` returns `0` |
| AC-1098-3 | Phase mapping is correct: `testing` phase → `type = validation` | `SELECT COUNT(*) FROM pipeline_manifest WHERE json_extract(metadata_json, '$.phase') = 'testing' AND type != 'validation'` returns `0` |
| AC-1098-4 | Ingestion is idempotent: running twice produces same row count | Run migration twice; row count identical |
| AC-1098-5 | Task ID correctly extracted from path for all 36 task dirs | `SELECT DISTINCT task_id FROM pipeline_manifest WHERE json_extract(metadata_json, '$.rcasd_origin') = 1 ORDER BY task_id` returns 36 distinct non-NULL task IDs |
| AC-1098-6 | Atypical files are ingested (not skipped) | `SELECT COUNT(*) FROM pipeline_manifest WHERE source_file LIKE '%T919%auto-complete%'` returns `1` |
| AC-1098-7 | `pnpm biome ci .` and `pnpm run build` exit 0 | Standard gate |

### 9.3 T1099 — Loose `.md` Ingestion + JSONL Migration + Agent Prompt Fixes

| # | Criterion | Verification Command |
|---|-----------|---------------------|
| AC-1099-1 | All 390 loose `.md` files have corresponding `pipeline_manifest` rows | `SELECT COUNT(*) FROM pipeline_manifest WHERE json_extract(metadata_json, '$.loose_origin') = 1` returns `≥ 390` |
| AC-1099-2 | All 319 MANIFEST.jsonl entries have corresponding rows | `SELECT COUNT(*) FROM pipeline_manifest WHERE json_extract(metadata_json, '$.jsonl_origin') = 1` returns `≥ 319` (after dedup, may be less if overlaps archived) |
| AC-1099-3 | `content_hash` populated on all migrated rows | `SELECT COUNT(*) FROM pipeline_manifest WHERE content_hash IS NULL` returns `0` |
| AC-1099-4 | Status normalization applied: no rows with `status = 'complete'` or `status = 'done'` | `SELECT COUNT(*) FROM pipeline_manifest WHERE status IN ('complete','completed','done')` returns `0` |
| AC-1099-5 | Type normalization applied: no rows with legacy type values | `SELECT COUNT(*) FROM pipeline_manifest WHERE type IN ('fix','worker','audit','attestation','verification','design','release-recovery')` returns `0` |
| AC-1099-6 | `BASE-001` text in `cleo-subagent.md` references `pipeline.manifest.append` not `MANIFEST.jsonl` | `grep "BASE-001" ~/.claude/agents/cleo-subagent.md \| grep "MANIFEST.jsonl"` returns empty |
| AC-1099-7 | `echo >> MANIFEST.jsonl` pattern absent from compiled agent prompts | `grep -r "echo.*MANIFEST.jsonl" ~/.claude/agents/ packages/skills/skills/` returns empty |
| AC-1099-8 | `cleo manifest show` references in orchestrator.md replaced | `grep "cleo manifest show" .claude/commands/orchestrator.md` returns empty |
| AC-1099-9 | `{{MANIFEST_PATH}}` token removed from template files | `grep -r "MANIFEST_PATH" packages/skills/skills/_shared/ packages/core/templates/` returns only deprecated description strings |
| AC-1099-10 | `pnpm biome ci .`, `pnpm run build`, `pnpm run test` all exit 0 | Standard quality gates |

---

## 10. References

- ADR-006: SQLite as Single Source of Truth
- ADR-021: Memory Domain Refactor (manifest ops moved from memory to pipeline domain)
- ADR-027: Manifest SQLite Migration (normative retirement of MANIFEST.jsonl)
- ADR-051: Programmatic Gate Integrity (evidence requirements)
- `docs/specs/CLEO-MANIFEST-SCHEMA-SPEC.md` — table schema and 14 operations
- `docs/specs/CLEO-OPERATION-CONSTITUTION.md` — pipeline domain operations table
- `packages/cleo/src/cli/commands/research.ts` — existing research command (deprecation target)
- `packages/contracts/src/operations/research.ts` — research operations contract
- `/mnt/projects/cleocode/.cleo/agent-outputs/T1094-inventory.md` — Wave 1 inventory
- `/mnt/projects/cleocode/.cleo/agent-outputs/T1095-drift-map.md` — Wave 2 drift map
- T1094: Inventory audit (Wave 1)
- T1095: Drift map (Wave 2)
- T1097: `cleo manifest` CLI registration + deprecation (Wave 3)
- T1098: RCASD ingestion into `pipeline_manifest` (Wave 3)
- T1099: Loose md ingestion + JSONL migration + agent prompt fixes (Wave 3)

---

**END OF SPEC T1096**
