# Schema Audit Report: RCASD Provenance Consolidation

**Date**: 2026-02-28
**Task**: T5112 (SBMU Epic) - Schema Audit
**Author**: schema-auditor agent

---

## 1. Schema Inventory

### 1.1 Active Schemas (`schemas/`)

| # | Schema File | Location | Fields | Active Refs in `src/` | Status |
|---|-------------|----------|--------|----------------------|--------|
| 1 | `context-state.schema.json` | `schemas/` | 14 | 2 (`schema-integrity.ts`, `context-monitor.ts`) | **KEEP** |
| 2 | `project-context.schema.json` | `schemas/` | 12 | 2 (`init.ts`, `schema-integrity.ts`) | **KEEP** |
| 3 | `projects-registry.schema.json` | `schemas/` | 12 | 2 (`nexus/registry.ts`, `project-registry.ts`) | **KEEP** |
| 4 | `research-manifest.schema.json` | `schemas/` | 24 | 0 (runtime refs to `MANIFEST.jsonl` not schema file) | **OPTIMIZE** |

### 1.2 Installed Schemas (`.cleo/schemas/` - copied by `cleo init`)

| # | Schema File | Source | Installed by `initSchemas()` | Runtime Use |
|---|-------------|--------|------------------------------|-------------|
| 1 | `config.schema.json` | `schemas/` | Yes | `schema-integrity.ts` validation |
| 2 | `project-info.schema.json` | `schemas/` | Yes | `schema-integrity.ts` validation |
| 3 | `project-context.schema.json` | `schemas/` | Yes | `schema-integrity.ts` validation |
| 4 | `todo.schema.json` | Untracked/orphan | No | None (legacy JSON-era) |
| 5 | `archive.schema.json` | Untracked/orphan | No | None (legacy JSON-era) |
| 6 | `log.schema.json` | Untracked/orphan | No | None (legacy JSON-era) |
| 7 | `qa-log.schema.json` | Untracked/orphan | No | None (legacy JSON-era) |

### 1.3 Archive Schemas (`schemas/archive/`)

28 schema files archived from the legacy JSON-era. None are referenced by active TypeScript code. These are historical artifacts.

### 1.4 MCP Server Archive (`.cleo/archive/mcp-server-v2026.2.5/schemas/`)

204 request/response schema files from the MCP server specification v2026.2.5. Archived and not referenced by runtime code.

---

## 2. Field Mapping: JSON Schema to Drizzle Tables

### 2.1 `todo.schema.json` (`.cleo/schemas/`) vs `tasks` table

| JSON Schema Field | Drizzle Column | Match | Notes |
|-------------------|---------------|-------|-------|
| `id` (T###) | `id` (text PK) | Exact | Same pattern |
| `title` | `title` | Exact | |
| `status` (pending/active/blocked/done) | `status` (6 values) | Subset | Drizzle adds `cancelled`, `archived` |
| `priority` | `priority` | Exact | Same 4 values |
| `phase` | `phase` | Exact | |
| `description` | `description` | Exact | |
| `files` (array) | `filesJson` (text) | Equivalent | JSON-serialized in SQLite |
| `acceptance` (array) | `acceptanceJson` (text) | Equivalent | JSON-serialized in SQLite |
| `depends` (array) | `taskDependencies` table | Normalized | Separate junction table |
| `blockedBy` (string) | `blockedBy` (text) | Exact | |
| `notes` (array) | `notesJson` (text) | Equivalent | JSON-serialized in SQLite |
| `labels` (array) | `labelsJson` (text) | Equivalent | JSON-serialized in SQLite |
| `createdAt` | `createdAt` | Exact | |
| `completedAt` | `completedAt` | Exact | |
| -- | `type` (epic/task/subtask) | **New in Drizzle** | Not in JSON schema |
| -- | `parentId` | **New in Drizzle** | Hierarchy via FK |
| -- | `size` (small/medium/large) | **New in Drizzle** | |
| -- | `position`, `positionVersion` | **New in Drizzle** | Ordering |
| -- | `origin` | **New in Drizzle** | Provenance |
| -- | `epicLifecycle` | **New in Drizzle** | Lifecycle link |
| -- | `cancelledAt`, `cancellationReason` | **New in Drizzle** | Cancellation tracking |
| -- | `archivedAt`, `archiveReason`, `cycleTimeDays` | **New in Drizzle** | Archive metadata (merged) |
| -- | `verificationJson` | **New in Drizzle** | Verification gates |
| -- | `createdBy`, `modifiedBy`, `sessionId` | **New in Drizzle** | Provenance |
| `_meta.checksum` | -- | **Removed** | Not needed in SQLite (DB handles integrity) |
| `_meta.activeSession` | -- | **Removed** | Sessions table handles this |
| `focus.currentTask` | `sessions.currentTask` | Moved | Session-scoped |
| `focus.sessionNote` | `sessions.notesJson` | Moved | Session-scoped |
| `phases` (object) | -- | **Not migrated** | Phase definitions not in Drizzle |
| `labels` (index) | -- | **Not migrated** | Computed index, no longer needed |

**Verdict**: `todo.schema.json` is **fully superseded** by the `tasks` Drizzle table. The Drizzle schema is a strict superset with additional provenance, hierarchy, and lifecycle fields.

### 2.2 `archive.schema.json` (`.cleo/schemas/`) vs `tasks` table

| JSON Schema Field | Drizzle Column | Notes |
|-------------------|---------------|-------|
| `archivedTasks[].id` | `tasks.id` | Same table, `status='archived'` |
| `archivedTasks[]._archive.archivedAt` | `tasks.archivedAt` | Merged into tasks table |
| `archivedTasks[]._archive.reason` | `tasks.archiveReason` | Merged |
| `archivedTasks[]._archive.cycleTimeDays` | `tasks.cycleTimeDays` | Merged |
| `statistics.*` | -- | Computed at query time |

**Verdict**: `archive.schema.json` is **fully superseded**. Archive is now just `status='archived'` in the unified tasks table.

### 2.3 `log.schema.json` (`.cleo/schemas/`) vs `audit_log` table

| JSON Schema Field | Drizzle Column | Notes |
|-------------------|---------------|-------|
| `entries[].id` | `audit_log.id` | Exact |
| `entries[].timestamp` | `audit_log.timestamp` | Exact |
| `entries[].action` | `audit_log.action` | Exact |
| `entries[].actor` | `audit_log.actor` | Exact |
| `entries[].taskId` | `audit_log.taskId` | Exact |
| `entries[].before` | `audit_log.beforeJson` | JSON-serialized |
| `entries[].after` | `audit_log.afterJson` | JSON-serialized |
| `entries[].details` | `audit_log.detailsJson` | JSON-serialized |
| -- | `audit_log.domain` | **New in Drizzle** (dispatch layer) |
| -- | `audit_log.operation` | **New in Drizzle** |
| -- | `audit_log.sessionId` | **New in Drizzle** |
| -- | `audit_log.durationMs` | **New in Drizzle** |
| -- | `audit_log.success` | **New in Drizzle** |
| -- | `audit_log.source` | **New in Drizzle** |
| -- | `audit_log.gateway` | **New in Drizzle** |
| -- | `audit_log.errorMessage` | **New in Drizzle** |

**Verdict**: `log.schema.json` is **fully superseded** by `audit_log` Drizzle table.

### 2.4 `config.schema.json` (`.cleo/schemas/`) - **No Drizzle equivalent**

This schema validates `config.json` which remains a JSON file (not migrated to SQLite). It defines archive policies, validation rules, session behavior, display settings, CLI configuration, and cancellation policies.

**Verdict**: **KEEP** - config.json is intentionally a JSON file for human editability and version control.

### 2.5 `project-info.schema.json` - **No Drizzle equivalent**

Validates `.cleo/project-info.json` containing schema versions, injection status, health diagnostics, and feature flags. Remains as a per-project JSON file.

**Verdict**: **KEEP** - project metadata that lives alongside the project, not in the task DB.

### 2.6 `project-context.schema.json` - **No Drizzle equivalent**

Validates `.cleo/project-context.json` containing LLM agent hints, testing framework detection, build config, directory structure. Generated by `cleo init --detect`.

**Verdict**: **KEEP** - agent-facing metadata consumed via `@` reference injection, not task data.

### 2.7 `context-state.schema.json` - **No Drizzle equivalent**

Validates `.cleo/.context-state.json` containing real-time context window usage metrics from Claude Code status line integration.

**Verdict**: **KEEP** - ephemeral runtime state file, not task data.

### 2.8 `projects-registry.schema.json` - **No Drizzle equivalent**

Validates the global `~/.cleo/projects-registry.json` tracking all CLEO-initialized projects (Nexus system).

**Verdict**: **KEEP** - global file outside any single project's SQLite DB.

### 2.9 `research-manifest.schema.json` - **Partial Drizzle overlap**

| JSON Schema Field | Drizzle Mapping | Notes |
|-------------------|----------------|-------|
| `id`, `file`, `title`, `date` | No table | MANIFEST.jsonl entries |
| `status` (complete/partial/blocked/archived) | Aligns with `MANIFEST_STATUSES` in status-registry.ts | |
| `topics`, `key_findings` | No table | Manifest-specific |
| `linked_tasks` | Could map to task references | |
| `agent_type` | No table | |
| `audit.lifecycle_state` | `lifecycleStages.stageName` | Overlaps with RCASD stage names |
| `audit.provenance_chain` | No table | **Candidate for RCASD frontmatter** |
| `audit.created_by`, `audit.validated_by` | Overlaps with `lifecycleEvidence.recordedBy` | Partial |

**Verdict**: **OPTIMIZE** - This schema defines fields not yet in Drizzle that are critical for RCASD provenance tracking. Key fields (`audit.provenance_chain`, `audit.lifecycle_state`, `audit.validation_status`) should inform the RCASD frontmatter spec.

---

## 3. Frontmatter Integration Analysis

### 3.1 Fields Suitable for RCASD Stage File Frontmatter

Based on analysis of `research-manifest.schema.json` audit fields and the Drizzle lifecycle tables, the following fields should be included in YAML frontmatter for RCASD stage output files:

```yaml
---
# Identity
epic: T1234
stage: research          # LIFECYCLE_STAGE_NAMES enum
task: T1235              # Task this stage output belongs to

# Provenance
created_by: research-agent-T1235
created_at: 2026-02-28T10:00:00Z
validated_by: null       # Set when validated
validated_at: null
lifecycle_state: research

# Status & Links
status: completed        # MANIFEST_STATUSES enum
linked_tasks: [T1235, T1236]
provenance_chain:
  - { type: research, id: research-2026-02-28 }

# Content metadata
title: "Authentication Architecture Research"
topics: [auth, security, oauth]
key_findings:
  - "OAuth 2.1 preferred over OAuth 2.0"
  - "PKCE flow required for public clients"
---
```

### 3.2 Mapping to Existing Drizzle Tables

These frontmatter fields map cleanly to the existing Drizzle lifecycle tables:

| Frontmatter Field | Drizzle Table.Column |
|-------------------|---------------------|
| `epic` | `lifecyclePipelines.taskId` |
| `stage` | `lifecycleStages.stageName` |
| `status` | `lifecycleStages.status` |
| `created_at` | `lifecycleStages.startedAt` |
| `lifecycle_state` | `lifecycleStages.stageName` (same) |
| `validated_by` | `lifecycleEvidence.recordedBy` |
| `provenance_chain` | `lifecycleTransitions` (partial) |
| `linked_tasks` | `taskRelations` / `taskDependencies` |

---

## 4. Consolidation Recommendations

### 4.1 Summary Table

| Schema | Recommendation | Reason |
|--------|---------------|--------|
| `schemas/context-state.schema.json` | **KEEP** | Active runtime validation (2 refs), no Drizzle equivalent |
| `schemas/project-context.schema.json` | **KEEP** | Active init + validation (2 refs), agent metadata |
| `schemas/projects-registry.schema.json` | **KEEP** | Active Nexus system (2 refs), global file |
| `schemas/research-manifest.schema.json` | **OPTIMIZE** | No direct imports but defines MANIFEST.jsonl structure; extract audit/provenance fields into RCASD frontmatter spec |
| `.cleo/schemas/config.schema.json` | **KEEP** | Active validation target, config.json stays as JSON |
| `.cleo/schemas/project-info.schema.json` | **KEEP** | Active validation target, per-project metadata |
| `.cleo/schemas/project-context.schema.json` | **KEEP** (duplicate) | Copy of `schemas/` version installed by `initSchemas()` |
| `.cleo/schemas/todo.schema.json` | **REMOVE** | Fully superseded by `tasks` Drizzle table |
| `.cleo/schemas/archive.schema.json` | **REMOVE** | Fully superseded by `tasks` Drizzle table (status=archived) |
| `.cleo/schemas/log.schema.json` | **REMOVE** | Fully superseded by `audit_log` Drizzle table |
| `.cleo/schemas/qa-log.schema.json` | **REMOVE** | No runtime references, no Drizzle equivalent, unused feature |
| `schemas/archive/` (28 files) | **REMOVE** | Already archived, no runtime references |
| `.cleo/archive/mcp-server-v2026.2.5/schemas/` (204 files) | **REMOVE** | Archived MCP spec, no runtime references |

### 4.2 Schemas to Remove (236 files)

1. **`.cleo/schemas/todo.schema.json`** - Legacy JSON-era task validation. All task data now in SQLite `tasks` table with richer schema.
2. **`.cleo/schemas/archive.schema.json`** - Legacy separate archive file. Now unified in `tasks` table with `status='archived'`.
3. **`.cleo/schemas/log.schema.json`** - Legacy JSONL audit log. Now `audit_log` table in SQLite.
4. **`.cleo/schemas/qa-log.schema.json`** - Never actively used in TypeScript codebase. Only referenced in `.gitignore`.
5. **`schemas/archive/`** (28 files) - Already explicitly archived.
6. **`.cleo/archive/mcp-server-v2026.2.5/schemas/`** (204 files) - Archived MCP version.

### 4.3 Schemas to Keep (6 files)

1. **`schemas/context-state.schema.json`** - Validates ephemeral `.context-state.json`
2. **`schemas/project-context.schema.json`** - Validates `project-context.json` (+ installed copy)
3. **`schemas/projects-registry.schema.json`** - Validates global Nexus registry
4. **`.cleo/schemas/config.schema.json`** - Validates `config.json`
5. **`.cleo/schemas/project-info.schema.json`** - Validates `project-info.json`
6. **`.cleo/schemas/project-context.schema.json`** - Installed copy (matches `schemas/` source)

### 4.4 Schemas to Optimize (1 file)

1. **`schemas/research-manifest.schema.json`** - Extract RCASD-relevant audit fields into the new frontmatter spec. The `audit` object (provenance_chain, lifecycle_state, validation_status) should become the canonical frontmatter structure for RCASD stage files. After extraction, this schema can remain as documentation or be archived.

---

## 5. New Fields for Drizzle Schema (RCASD Frontmatter Tracking)

### 5.1 Recommended Additions to `lifecycle_stages` Table

The following fields from the `research-manifest.schema.json` audit section are not yet captured in Drizzle and would support RCASD frontmatter sync:

```typescript
// Proposed additions to lifecycleStages table
outputFile: text('output_file'),           // Path to RCASD stage output file
createdBy: text('created_by'),             // Agent ID that executed this stage
validatedBy: text('validated_by'),         // Agent ID that validated output
validatedAt: text('validated_at'),         // When validation occurred
validationStatus: text('validation_status', {
  enum: ['pending', 'in_review', 'approved', 'rejected', 'needs_revision'],
}),
provenanceChainJson: text('provenance_chain_json'),  // Full lineage array
```

### 5.2 Recommended Additions to `lifecycle_evidence` Table

No additions needed. The existing table (`uri`, `type`, `recordedAt`, `recordedBy`, `description`) already supports evidence recording for RCASD stages.

### 5.3 New Table: `manifest_entries` (Optional)

If MANIFEST.jsonl data should be queryable via SQLite, a new table could mirror the research-manifest schema:

```typescript
export const manifestEntries = sqliteTable('manifest_entries', {
  id: text('id').primaryKey(),              // Slug with date suffix
  pipelineId: text('pipeline_id'),          // FK to lifecyclePipelines
  stageId: text('stage_id'),               // FK to lifecycleStages
  title: text('title').notNull(),
  date: text('date').notNull(),
  status: text('status', { enum: MANIFEST_STATUSES }).notNull(),
  agentType: text('agent_type'),
  outputFile: text('output_file'),
  topicsJson: text('topics_json').default('[]'),
  findingsJson: text('findings_json').default('[]'),
  linkedTasksJson: text('linked_tasks_json').default('[]'),
  createdBy: text('created_by'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});
```

This would enable the Phase 3 (SQLite sync) integration to dual-write manifest data.

---

## 6. Action Items for Phase 3 (SQLite Sync) Integration

1. **Remove orphaned schemas**: Delete `.cleo/schemas/{todo,archive,log,qa-log}.schema.json` from the init pipeline (they are NOT in `coreSchemas` array in `initSchemas()` already, so just delete the files from the repo)

2. **Add lifecycle stage provenance columns**: Migration to add `output_file`, `created_by`, `validated_by`, `validated_at`, `validation_status` to `lifecycle_stages` table

3. **Create frontmatter spec**: Document the canonical YAML frontmatter format for RCASD stage files, derived from `research-manifest.schema.json` audit fields

4. **Build sync module**: The `sync.ts` module (Task #7) should read frontmatter from RCASD stage files and sync to the Drizzle lifecycle tables

5. **Archive or deprecate `research-manifest.schema.json`**: After extracting provenance fields to frontmatter spec, move to `schemas/archive/` or add deprecation notice

6. **Clean up `schemas/archive/`**: Consider removing the 28 archived schemas entirely (they serve no runtime purpose) or moving to `.cleo/archive/`

7. **Clean up MCP archive schemas**: The 204 schemas in `.cleo/archive/mcp-server-v2026.2.5/schemas/` can be removed to reduce repo size

---

## 7. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Removing `todo.schema.json` breaks legacy validation | Low - only `archive/bash-legacy/` references it | Bash legacy is deprecated (ADR-004) |
| Adding columns to `lifecycle_stages` | Low - all new columns nullable | Standard Drizzle migration |
| Frontmatter format changes later | Medium - files already written | Version the frontmatter spec |
| `research-manifest.schema.json` deprecation | Low - no direct imports | Keep as documentation reference |

---

## 8. Summary Metrics

| Metric | Value |
|--------|-------|
| Total schema files found | 243 |
| Active + needed schemas | 6 |
| Schemas to optimize | 1 |
| Schemas to remove | 236 |
| Reduction | 97% |
| New Drizzle columns recommended | 5 (on `lifecycle_stages`) |
| New Drizzle tables recommended | 1 (optional `manifest_entries`) |
