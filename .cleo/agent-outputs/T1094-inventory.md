# T1094: Inventory of Legacy Manifest/RCASD/MD Artifact Stores

**Generated**: 2026-04-21
**Task**: T1094 (child of epic T1093 — MANIFEST/RCASD Architecture Unification)
**Agent**: cleo-db-lead (contribution protocol)

---

## 1. Totals Table

| Store | Count | Notes |
|-------|-------|-------|
| `MANIFEST.jsonl` lines | 319 | 0 parse errors; all valid JSON |
| `.cleo/rcasd/` task directories | 36 | Includes T1094 (just created) |
| `.cleo/rcasd/` markdown files | 182 | Across 36 task dirs |
| `.cleo/agent-outputs/*.md` loose files | 390 | maxdepth=1; does NOT include subdir files |
| `.cleo/agent-outputs/` subdirectories | 28 | e.g. T1007-tier3-design, T760-rcasd, etc. |
| `pipeline_manifest` rows (tasks.db) | 1 | Single test/seed entry — effectively empty |

---

## 2. MANIFEST.jsonl Classification

### 2a. By `type` Field

The `type` (or `agent_type`) field is present on 246 of 319 entries; 73 entries have no type field at all.

| type value | count | pipeline_manifest mapping |
|-----------|-------|--------------------------|
| `implementation` | 133 | `implementation` |
| (no type field) | 73 | needs human review (see §5) |
| `research` | 13 | `research` |
| `audit` | 10 | `research` (audits are research artifacts) |
| `fix` | 10 | `implementation` |
| `validation` | 8 | `validation` |
| `specification` | 8 | `specification` |
| `worker` | 7 | `implementation` |
| `attestation` | 6 | `validation` |
| `documentation` | 6 | `documentation` |
| `design` | 4 | `architecture` |
| `verification` | 4 | `validation` |
| `analysis` | 2 | `research` |
| `architecture-spec` | 2 | `architecture` |
| `forensic` | 2 | `research` |
| `council-lead` | 2 | `consensus` |
| `triage` | 2 | `research` |
| `assessment` | 1 | `research` |
| `consensus` | 1 | `consensus` |
| `decomposition` | 2 | `decomposition` |
| `release` | 1 | `release` |
| `release-recovery` | 1 | `release` |
| `rcasd-lead` | 1 | `research` |
| `planning` | 1 | `decomposition` |
| `algorithm-council` | 1 | `consensus` |
| `schema-council` | 1 | `consensus` |
| `lead` | 1 | `research` |
| `synthesis` | 1 | `consensus` |
| `scaffolding` | 1 | `implementation` |
| `task-completion-report` | 1 | `implementation` |
| `investigation` | 1 | `research` |
| `worker-output` | 1 | `implementation` |
| `diagnostic` | 1 | `research` |
| `build-fix` | 1 | `implementation` |
| `smoke-test` | 1 | `validation` |
| `completion` | 1 | `implementation` |
| `work` | 1 | `implementation` |
| `summary` | 1 | `implementation` |
| `task-output` | 1 | `implementation` |
| `refactor` | 1 | `implementation` |
| `Design` (capitalized) | 1 | `architecture` (normalize case) |
| `council-audit` | 1 | `consensus` |
| `council-synthesis` | 1 | `consensus` |

### 2b. By `status` Field

| status | count |
|--------|-------|
| `complete` | 305 |
| (no status field) | 3 |
| `partial` | 5 |
| `completed` | 3 |
| `done` | 1 |
| `archived` | 1 |
| `deferred` | 1 |

**Note**: `completed` and `done` are non-canonical status values; normalize to `complete` on ingestion.

### 2c. Unique Task IDs Referenced (248 distinct)

The MANIFEST.jsonl references 248 unique task IDs (T030 through T991). The `task` field (or `taskId`/`task_id`) is the primary task reference. 71 entries have no parseable task ID.

### 2d. Key Schema Fields Observed

| JSONL field | frequency | notes |
|------------|-----------|-------|
| `status` | 316/319 | near-universal |
| `id` | 298/319 | entry identifier (often task-slug) |
| `date` | 252/319 | ISO date string |
| `task` | 239/319 | primary task_id reference |
| `type` | 239/319 | artifact type (missing in 73 entries) |
| `summary` | 221/319 | free-text summary |
| `title` | 181/319 | human-readable title |
| `output` | 159/319 | output file path |
| `files` | 66/319 | list of affected files |
| `needs_followup` | 65/319 | follow-up task IDs |
| `key_findings` | 56/319 | array of key findings |
| `timestamp` | 44/319 | ISO timestamp (some entries use `date`) |
| `epic` | 35/319 | parent epic ID |
| `file` | 34/319 | alternate output file field |
| `commit` | 28/319 | git commit SHA |
| `taskId` | 25/319 | alternate task ID field (non-canonical) |
| `evidence` | 23/319 | gate evidence strings |
| `outputFile` | 22/319 | alternate output file field |
| `role` | 21/319 | agent role |
| `task_id` | 18/319 | alternate task ID field |
| `linked_tasks` | 18/319 | array of linked task IDs |
| `output_file` | 17/319 | alternate output file field |
| `agent` | 15/319 | agent identifier |
| `slug` | 15/319 | URL slug |

---

## 3. Field Mapping: JSONL Schema to `pipeline_manifest` Columns (ADR-027 §6.1)

| JSONL legacy field(s) | `pipeline_manifest` column | transformation notes |
|----------------------|---------------------------|----------------------|
| `id` | `id` | use as-is; if missing, generate `<taskId>-<slug>` |
| `task` / `taskId` / `task_id` | `task_id` | normalize to first match; FK to tasks.id |
| `epic` | `epic_id` | FK to tasks.id |
| (session not in JSONL) | `session_id` | set NULL on import from JSONL |
| `type` / `agent_type` | `type` | apply type normalization table (see §2a) |
| full JSON line (serialized) | `content` | store original JSONL line as JSON string |
| (computed on import) | `content_hash` | SHA-256 of content field |
| `status` | `status` | normalize `completed`/`done` → `complete` |
| (false by default) | `distilled` | false on import |
| (none) | `brain_obs_id` | NULL on import; link during brain distillation |
| `output` / `outputFile` / `file` / `output_file` | `source_file` | normalize to first non-null match |
| `{key_findings, needs_followup, topics, linked_tasks, evidence}` | `metadata_json` | serialize as JSON object |
| `date` / `timestamp` | `created_at` | normalize to ISO 8601 UTC; default to 00:00:00 if date-only |
| (none) | `archived_at` | NULL unless status=archived; set to current timestamp |

### Type Normalization Rules (JSONL → pipeline_manifest.type)

| JSONL type(s) | pipeline_manifest type |
|--------------|----------------------|
| `implementation`, `fix`, `worker`, `scaffolding`, `build-fix`, `completion`, `work`, `summary`, `task-output`, `task-completion-report`, `worker-output`, `refactor` | `implementation` |
| `research`, `audit`, `analysis`, `forensic`, `assessment`, `diagnostic`, `triage`, `investigation`, `rcasd-lead`, `lead` | `research` |
| `validation`, `verification`, `attestation`, `smoke-test` | `validation` |
| `specification` | `specification` |
| `consensus`, `synthesis`, `algorithm-council`, `schema-council`, `council-lead`, `council-audit`, `council-synthesis` | `consensus` |
| `decomposition`, `planning` | `decomposition` |
| `architecture-spec`, `design`, `Design` | `architecture` |
| `documentation` | `documentation` |
| `release`, `release-recovery` | `release` |
| (no type field) | requires human review |

---

## 4. RCASD Phase Mapping

### 4a. Phase Distribution (all 182 markdown files)

| Phase (directory name) | file count | pipeline_manifest type mapping |
|-----------------------|-----------|-------------------------------|
| `research` | 34 | `research` |
| `decomposition` | 30 | `decomposition` |
| `consensus` | 29 | `consensus` |
| `specification` | 27 | `specification` |
| `architecture` | 23 | `architecture` |
| `implementation` | 22 | `implementation` |
| `validation` | 6 | `validation` |
| `testing` | 6 | `validation` |
| `release` | 5 | `release` |
| **Total** | **182** | |

### 4b. RCASD Task Directory Inventory (36 tasks)

| task_id | phases present | file count | notes |
|---------|---------------|-----------|-------|
| T091 | research, consensus | 2 | partial — no spec/impl |
| T310 | research, specification, consensus, decomposition | 4 | no impl/arch |
| T311 | research, specification, consensus, decomposition | 4 | no impl/arch |
| T484 | research, consensus | 2 | partial |
| T487 | research, specification, architecture, consensus, decomposition, implementation, testing, validation, release | 9 | full RCASD+TVR |
| T612 | research, specification, architecture, consensus, decomposition, implementation, testing, validation, release | 9 | full RCASD+TVR |
| T673 | research, specification, architecture, consensus, decomposition | 5 | no impl/test/release |
| T820 | research, specification, architecture, consensus, decomposition, implementation | 6 | no test/release |
| T828 | research, specification, architecture, consensus, decomposition, implementation | 6 | no test/release |
| T832 | research, specification, architecture, consensus, decomposition, implementation | 6 | no test/release |
| T861 | research, specification, architecture, consensus, decomposition, implementation, testing, validation, release | 9 | full RCASD+TVR |
| T863 | research | 1 | stub only |
| T870 | research, specification, architecture, consensus, decomposition, implementation, testing, validation, release | 9 | full RCASD+TVR |
| T876 | research, specification, architecture, consensus, decomposition, implementation, testing, validation, release | 9 | full RCASD+TVR |
| T882 | research, specification, architecture, consensus, decomposition, implementation, testing, validation | 8 | no release |
| T889 | research | 1 | stub only |
| T911 | research, specification, architecture, consensus, decomposition, implementation | 6 | no test/release |
| T919 | consensus (auto-complete-policy.md) | 1 | atypical filename — not T-prefixed |
| T939 | research, specification, architecture, consensus, decomposition | 5 | no impl |
| T940 | research, specification, architecture, consensus, decomposition | 5 | no impl |
| T941 | research, consensus | 2 | partial |
| T942 | research, specification, decomposition, implementation | 4 | no arch/consensus |
| T949 | research, specification, architecture, consensus, decomposition, implementation | 6 | no test/release |
| T962 | research, specification, architecture, consensus, decomposition, implementation | 6 | no test/release |
| T988 | research, specification, decomposition, implementation | 4 | no arch/consensus |
| T991 | research, specification, architecture, consensus, decomposition (x2), implementation | 7 | extra worker-specs.md in decomp |
| T1000 | research, specification, architecture, consensus, decomposition (x2), implementation | 7 | extra worker-specs.md in decomp |
| T1007 | research, specification, architecture, consensus, decomposition (x2), implementation | 7 | T1008-worker-spec.md in T1007/decomp |
| T1009 | research, specification, architecture, consensus, decomposition, implementation | 6 | |
| T1010 | research, specification, architecture, consensus, decomposition, implementation | 6 | |
| T1011 | research, specification, architecture, consensus, decomposition, implementation | 6 | |
| T1012 | research, specification, architecture, consensus, decomposition, implementation | 6 | |
| T1013 | research, specification, architecture, consensus, decomposition, implementation | 6 | |
| T1042 | research | 1 | stub only |
| T1093 | research | 1 | current epic — seed entry |
| T1094 | (this task — workspace being created) | — | |

### 4c. Atypical RCASD Files Needing Human Review

| file path | issue |
|-----------|-------|
| `.cleo/rcasd/T919/consensus/auto-complete-policy.md` | filename not T-prefixed; may be policy doc, not RCASD artifact |
| `.cleo/rcasd/T1000/decomposition/worker-specs.md` | generic filename, not T-prefixed; worker allocation sub-document |
| `.cleo/rcasd/T991/decomposition/worker-specs.md` | same pattern as above |
| `.cleo/rcasd/T1007/decomposition/T1008-worker-spec.md` | cross-task reference: T1007 dir contains T1008 spec |

---

## 5. Loose `.cleo/agent-outputs/*.md` Classification (390 files)

### 5a. By Naming Pattern

| pattern | count | description |
|---------|-------|-------------|
| Task-prefixed (`T\d+-...`) | 329 | standard agent output files linked to a task |
| RCASD phase suffixed (`T\d+-{research,specification,architecture,...}`) | 25 | RCASD artifacts stored flat (not in rcasd/ tree) |
| Multi-task (`T\d+-T\d+-...`) | 11 | cross-task or wave output files |
| Session/planning | 4 | MASTER-*, NEXT-*, prime-* |
| Research standalone | 2 | R-agent-sdk-comparison-2026.md, R-llm-memory-systems-research.md |
| Release notes | 2 | RELEASE-v2026.4.60-recovery.md, release-workflow-complete.md |
| Special/unclassified | 17 | see list below |

**Total loose files**: 390

### 5b. Special/Unclassified Files (17)

These files have no task ID prefix and require classification before ingestion:

| filename | inferred type | recommended action |
|----------|--------------|-------------------|
| `CANT-V2-PERSONA-SCHEMA-PLAN.md` | planning/design | link to CANT epic manually |
| `CLI-SYSTEM-AUDIT-2026-04-10.md` | audit | link to T505 (CLI audit epic) |
| `DOC-SYNC-AUDIT-2026-04-20.md` | audit | link to T910 or T1093 |
| `STAB-3-clean-install-results.md` | validation | link to stability epic |
| `SYSTEM-VALIDATION-REPORT.md` | validation | link to T484 or T870 |
| `T-ladybugdb-research-report.md` | research | task prefix missing numeric ID |
| `T-verify-specs-report.md` | verification | task prefix missing numeric ID |
| `ci-workflow-complete.md` | implementation | link to CI epic |
| `cicd-validation-report.md` | validation | link to CI epic |
| `conduit-orchestration-wiring.md` | implementation | link to CONDUIT epic |
| `deploy-templates-complete.md` | implementation | link to deploy tasks |
| `fix-cant-core-size.md` | implementation/fix | link to CANT epic |
| `fix-cant-lsp-match.md` | implementation/fix | link to CANT epic |
| `github-templates-complete.md` | implementation | link to infra tasks |
| `graph-memory-bridge-implementation.md` | implementation | link to BRAIN epic |
| `llmtxt-my-sitrep-2026-04-11.md` | research/report | link to llmtxt-core tasks |
| `research-node-sqlite.md` | research | link to T1041 or node:sqlite tasks |

### 5c. Flat RCASD Phase Files (25)

These 25 files follow RCASD phase naming conventions but reside in the flat `agent-outputs/` dir instead of `.cleo/rcasd/<task>/`. They are migration candidates for the rcasd tree:

Selected examples (pattern: `T\d+-{R1,R2,CA1,CA2,...}` or `T\d+-{research,specification,...}`):

| filename | inferred phase |
|----------|---------------|
| `T523-R1-brain-audit-report.md` | research |
| `T523-R2-ladybugdb-architecture-study.md` | research |
| `T523-R3-memory-system-code-review.md` | research |
| `T523-CA1-brain-integrity-spec.md` | specification |
| `T523-CA2-memory-sdk-spec.md` | specification |
| `T549-R1-memory-system-deep-audit.md` | research |
| `T549-R2-industry-memory-research.md` | research |
| `T549-R3-caamp-multiharness-audit.md` | research |
| `T549-R4-selfheal-intelligence-audit.md` | research |
| `T549-R5-context-rot-token-management.md` | research |
| `T549-R6-existing-specs-adrs-audit.md` | research |
| `T549-CA1-tiered-typed-memory-spec.md` | specification |
| `T549-CA2-extraction-pipeline-spec.md` | specification |
| `T549-CA3-jit-injection-spec.md` | specification |
| `T549-CA4-selfheal-intelligence-spec.md` | specification |
| `T553-R1-pi-caamp-adapter-audit.md` | research |
| `T513-R-gitnexus-pipeline-architecture.md` | research |
| `T513-CA-pipeline-spec.md` | specification |
| `T832-research.md` | research |
| (remaining 6 similar) | various |

---

## 6. `pipeline_manifest` Table (tasks.db)

### Schema

```sql
CREATE TABLE "pipeline_manifest" (
  `id` text PRIMARY KEY,
  `session_id` text,
  `task_id` text,
  `epic_id` text,
  `type` text NOT NULL,
  `content` text NOT NULL,
  `content_hash` text,
  `status` text DEFAULT 'active' NOT NULL,
  `distilled` integer DEFAULT false NOT NULL,
  `brain_obs_id` text,
  `source_file` text,
  `metadata_json` text,
  `created_at` text NOT NULL,
  `archived_at` text,
  CONSTRAINT `fk_pipeline_manifest_task_id` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pipeline_manifest_session_id` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pipeline_manifest_epic_id` FOREIGN KEY (`epic_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
)
```

### Current State

- **Row count**: 1 (seed/test entry)
- **Existing entry**: `id=res_1775873522415`, type=`researcher`, status=`partial`, task_id=NULL, session_id=NULL
- **Date**: 2026-04-11 (created during T091 testing)

This table is effectively empty from a production standpoint. The 319 MANIFEST.jsonl entries and 182 RCASD markdown files represent the full backlog for ingestion.

---

## 7. Ambiguous Entries Needing Human Review

### 7a. MANIFEST.jsonl Entries Without `type` Field (73 entries)

The 73 entries missing a `type` or `agent_type` field can often be inferred from their key set:

| inferred type | count | inference rule |
|--------------|-------|---------------|
| `implementation` | ~40 | has `files`, `commit`, `tests_added`, or `files_changed` |
| `research` | ~10 | has `key_findings` or `topics` without implementation keys |
| `release` | ~5 | has `version` or `tag` field |
| `audit` → `research` | ~8 | has `summary` about auditing config/code |
| truly ambiguous | ~10 | require manual inspection |

### 7b. Status Normalization Required

| non-canonical value | canonical | count |
|--------------------|-----------|-------|
| `completed` | `complete` | 3 |
| `done` | `complete` | 1 |
| (missing) | needs assignment | 3 |

### 7c. RCASD Files With Atypical Filenames

See §4c above — 4 files with non-standard naming in the rcasd tree.

### 7d. Overlapping Coverage (JSONL + RCASD)

Some tasks have both MANIFEST.jsonl entries AND RCASD workspace files (e.g., T487, T870, T876, T882, T861, T1000, T991). During ingestion into `pipeline_manifest`, these must be deduplicated:
- RCASD phase files (structured) take precedence over JSONL entries for same task+phase
- JSONL entries without corresponding RCASD files should be ingested as-is with `source_file` pointing to the `.cleo/agent-outputs/<task>-<slug>.md`

---

## 8. Migration Priority Recommendations

| priority | store | action | candidate task |
|----------|-------|--------|---------------|
| P0 | `pipeline_manifest` | ingest JSONL entries for completed tasks (T030–T991) | T1095 |
| P0 | `pipeline_manifest` | ingest RCASD phase files for all 36 task dirs | T1096 |
| P1 | flat RCASD files | move 25 flat agent-output RCASD-phase files into `.cleo/rcasd/<task>/` | T1097 |
| P1 | special files | manually assign task IDs to 17 unclassified loose files | T1098 |
| P2 | type normalization | apply type normalization rules to all 73 missing-type MANIFEST.jsonl entries | T1095 |
| P2 | status normalization | normalize `completed`/`done` → `complete` | T1095 |

---

## Appendix: Data Collection Commands

```bash
# MANIFEST.jsonl line count
wc -l .cleo/agent-outputs/MANIFEST.jsonl
# => 319

# RCASD task directories
ls .cleo/rcasd/ | wc -l
# => 36

# RCASD markdown files
find .cleo/rcasd -name "*.md" | wc -l
# => 182

# Loose agent-output MD files
find .cleo/agent-outputs -maxdepth 1 -name "*.md" | wc -l
# => 390

# pipeline_manifest rows
node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('.cleo/tasks.db'); console.log(db.prepare('SELECT COUNT(*) as cnt FROM pipeline_manifest').get())"
# => { cnt: 1 }
```
