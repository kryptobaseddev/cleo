# CLEO Pipeline Manifest Specification

**Status**: ACTIVE

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Overview

The pipeline manifest records agent output artifacts (research, implementation, specification and other deliverables) produced during CLEO work. It lives in the project store, `<project>/.cleo/cleo.db`, in the table `docs_pipeline_manifest`. It replaced the legacy append-only `MANIFEST.jsonl` file (ADR-027, ADR-054).

Source of truth for this spec:

| Concern | Source |
|---|---|
| Table schema | `packages/core/src/store/schema/cleo-project/docs.ts` (`docsPipelineManifest`) |
| Legacy table schema (read-only history) | `packages/core/src/store/schema/manifest.ts` (`pipelineManifest`, physical name `pipeline_manifest`) |
| Operations | `packages/core/src/memory/pipeline-manifest-sqlite.ts` |
| Entry identity and file-reference checks | `packages/core/src/memory/manifest-identity.ts` |
| CLI shorthand entry builder | `packages/core/src/memory/manifest-builder.ts` |
| RCASD and loose-file ingestion | `packages/core/src/memory/manifest-ingestion.ts` |
| Dispatch handlers (`pipeline` domain) | `packages/cleo/src/dispatch/domains/pipeline.ts` |
| CLI | `packages/cleo/src/cli/commands/manifest.ts`, `research.ts`, `migrate-claude-mem.ts` |

---

## 2. Storage

### 2.1 Tables

| Table | Role |
|---|---|
| `docs_pipeline_manifest` | Canonical table. Every write goes here. |
| `pipeline_manifest` | Legacy bare twin in the same `cleo.db`. Read on every query and merged with the canonical rows; never written by the manifest operations. |

Both tables are classified `portable-project` (synced and backed up) in `packages/core/src/store/table-classification.ts`.

Reads merge both tables by `id` (`readStoredRows`, `pipeline-manifest-sqlite.ts:83`). Each returned row carries `provenance: { databasePath, tables[] }` naming the table(s) it came from. When the same `id` exists in both tables with different stored values, the read fails with `E_MANIFEST_ID_CONFLICT`, listing both payloads and their SHA-256 hashes.

A mutation that touches a row present in the legacy table fails with `E_MANIFEST_LEGACY_REPAIR_REQUIRED` (`requireModernRows`, `pipeline-manifest-sqlite.ts:152`). Legacy rows are never migrated or rewritten implicitly.

### 2.2 `docs_pipeline_manifest` columns

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | text | PK | | Entry id (see §3.1). |
| `session_id` | text | yes | | Session id. |
| `task_id` | text | yes | | Primary task. Set from `linked_tasks[0]` on append. |
| `epic_id` | text | yes | | Not set by any current writer. |
| `type` | text | no | | Entry type (open taxonomy, no CHECK constraint). Holds `agent_type` on append. |
| `content` | text | no | | Append: the full entry serialized as JSON. Ingestion: the file's markdown. |
| `content_hash` | text | yes | | SHA-256 hex of `content`; see §2.4. |
| `status` | text | no | `'active'` | No CHECK constraint; see §2.3. |
| `distilled` | integer (boolean) | no | `false` | No writer sets it to true (§4.8). |
| `brain_obs_id` | text | yes | | Not set by any current writer. |
| `source_file` | text | yes | | Entry `file` reference, or the ingested file's repo-relative path. |
| `metadata_json` | text | yes | | JSON object; see §3.3. |
| `created_at` | text | no | `datetime('now')` | See §2.4 for the formats writers use. |
| `archived_at` | text | yes | | Set by archive; NULL while live. |

Indexes: `idx_docs_pipeline_manifest_task_id`, `_session_id`, `_distilled`, `_status`, `_content_hash` (`docs.ts:278-282`).

The legacy `pipeline_manifest` table has the same columns; in it `session_id`, `task_id` and `epic_id` reference `sessions`/`tasks` with `ON DELETE SET NULL`, and `created_at` has no default (`schema/manifest.ts:44-69`).

### 2.3 Status values

On append, an entry `status` of `completed` is stored as `active`; `partial` and `blocked` are stored as given (`entryToRow`, `pipeline-manifest-sqlite.ts:796`). Ingestion stores `active`. On read, a stored `active` is returned as `completed` (`rowToEntry`, `pipeline-manifest-sqlite.ts:747`).

Archiving sets `archived_at` only; it does not change `status`. Rows with a non-NULL `archived_at` are excluded from every list, find, pending and stats read; `show` still returns them.

### 2.4 Hash and timestamp formats

Writers do not agree on these formats today:

| Writer | `content_hash` | `created_at` |
|---|---|---|
| `pipelineManifestAppend`, `migrateManifestJsonlToSqlite` | first 16 hex chars of SHA-256 (`pipeline-manifest-sqlite.ts:254`) | `<entry.date> 00:00:00` (`:808`) |
| `ingestRcasdDirectories`, `ingestLooseAgentOutputs` | full 64-char SHA-256 hex (`manifest-ingestion.ts:80`) | file mtime as ISO-8601 (`manifest-ingestion.ts:207, 267`) |
| `pipelineManifestArchive` (`archived_at`) | | `YYYY-MM-DD HH:MM:SS` UTC (`now()`, `:250`) |

`content_hash` is not used for deduplication on append. `compact` compares full `content` (§4.7).

---

## 3. Entry contract

The operations exchange `ExtendedManifestEntry` objects (`packages/core/src/memory/index.ts:46, 458`), not raw rows.

### 3.1 Fields

| Field | Required on append | Notes |
|---|---|---|
| `id` | yes | At most 200 characters, matching `/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/` (`manifest-identity.ts:36, 44`). |
| `file` | yes | Project-relative path or `cleo://docs/<reference>` (§4.1). At most 1024 characters, no segment over 255 bytes, never escaping the project root. |
| `title` | yes | |
| `date` | yes | `YYYY-MM-DD`. |
| `status` | yes | `completed`, `partial` or `blocked`. |
| `agent_type` | yes | Stored in `type`. |
| `topics` | yes | string[] |
| `actionable` | yes | boolean |
| `key_findings` | no | string[] |
| `needs_followup` | no | string[] |
| `linked_tasks` | no | string[] of task ids. The first becomes `task_id`. |
| `confidence` | no | number |
| `file_checksum` | no | string |
| `duration_seconds` | no | number |

Missing required fields fail with `E_VALIDATION_FAILED`; a malformed id, linked task id or file reference fails with `E_VALIDATION`. Through the CLI/dispatch path a `linked_tasks` id that names no task in the project fails with `E_NOT_FOUND` (`requireExistingTasks`, `pipeline.ts:354-357`).

### 3.2 Row mapping on append

`entryToRow` (`pipeline-manifest-sqlite.ts:773`): `content` = `JSON.stringify(entry)`; `type` = `agent_type`; `task_id` = `linked_tasks[0]`; `source_file` = `file`; `metadata_json` = the fields `file`, `title`, `topics`, `key_findings`, `actionable`, `needs_followup`, `linked_tasks`, `confidence`, `file_checksum`, `duration_seconds`.

### 3.3 `metadata_json` read contract

Readers validate `metadata_json` against the field types in §3.1 (`manifestMetadataSchema`, `pipeline-manifest-sqlite.ts`). Unknown keys are kept. A legacy boolean `needs_followup` reads as `[]` (false) or `["follow-up needed (no task named)"]` (true).

Ingested rows carry their own keys: `phase`, `rcasd_origin`, `filename_note`, `cross_task_ref` (RCASD), or `loose_origin`, `original_filename`, `flat_rcasd` (loose files).

List, find, pending and stats skip a row whose `metadata_json` is not a JSON object or breaks the field contract, and report it in `data.malformed[]` with `data.malformedRemedy: "cleo doctor manifest-rows --repair"`. `show` fails on such a row with `E_MANIFEST_METADATA_INVALID`.

---

## 4. Operations

Registered dispatch operations in the `pipeline` domain (`pipeline.ts:426-432`):

| Operation | Gateway | Core function | Params |
|---|---|---|---|
| `manifest.show` | query | `pipelineManifestShow` | `entryId` |
| `manifest.list` | query | `pipelineManifestList` | `taskId`, `status`, `type` / `agent_type`, `topic`, `actionable`, `dateAfter`, `dateBefore`, `limit`, `offset` |
| `manifest.find` | query | `pipelineManifestFind` | `query`, `confidence`, `limit` |
| `manifest.stats` | query | `pipelineManifestStats` | `epicId` |
| `manifest.append` | mutate | `pipelineManifestAppend` | `entry` |
| `manifest.update` | mutate | `pipelineManifestUpdate` | `id`, `title`, `topics`, `key_findings`, `status`, `linkTask` |
| `manifest.archive` | mutate | `pipelineManifestArchive` | `beforeDate` (required) |

SDK-only functions in `pipeline-manifest-sqlite.ts` with no dispatch operation: `pipelineManifestPending`, `pipelineManifestRead`, `pipelineManifestCompact`, `pipelineManifestValidate`, `pipelineManifestContradictions`, `pipelineManifestSuperseded`, `pipelineManifestLink`, `distillManifestEntry`, `migrateManifestJsonlToSqlite`, plus the repair functions behind `cleo doctor manifest-rows`.

### 4.1 show

Returns the entry (archived included) plus `fileContent` and `fileExists`. A `cleo://docs/<reference>` file is resolved through the docs read model by slug or attachment id; any other URI scheme fails with `E_MANIFEST_REFERENCE_UNSUPPORTED`. A path that escapes the project fails with `E_MANIFEST_FILE_UNSAFE`. A missing ordinary file gives `fileExists: false`. Unknown id: `E_NOT_FOUND`.

### 4.2 list

Returns `{ entries, total, filtered }` plus a page object. Filters apply in the order `taskId` (id prefix or `linked_tasks` membership), `status`, `agent_type`, `topic`, `actionable`, `dateAfter`, `dateBefore` (`manifest-filter.ts`). Archived rows are excluded. Results are newest first.

### 4.3 find

Selects rows whose `content` or `type` contains `query` (SQL `LIKE`), then scores each entry: title match +0.5, topic +0.3, key finding +0.2, id +0.1. Entries scoring below `confidence` (default 0.1) are dropped, so a row that matches only inside `content` is not returned. Returns `{ query, results[] (with relevanceScore), total }`.

### 4.4 stats

Returns `total`, `byStatus`, `byType`, `actionable`, `needsFollowup`, `averageFindings`. `epicId` restricts to entries whose id starts with it or whose `linked_tasks` contains it.

### 4.5 append

Validates §3.1, then upserts into `docs_pipeline_manifest`: an existing `id` has `content`, `content_hash`, `status`, `metadata_json`, `source_file` and `task_id` replaced (`pipeline-manifest-sqlite.ts:1279`). Returns `{ appended: true, entryId }`.

### 4.6 update

Changes only the given fields of an existing entry in one transaction. `linkTask` is added to `linked_tasks` (kept unique) and never removes a link. Unknown id: `E_NOT_FOUND`.

### 4.7 archive and compact

`archive` sets `archived_at` on every live row whose `created_at` date is before `beforeDate` (`YYYY-MM-DD`) and returns `{ archived, remaining }`. There is no archive-by-id operation.

`compact` (SDK only) hard-deletes rows whose full `content` duplicates a newer row's.

### 4.8 Distillation

`distillManifestEntry` is a stub that returns `{ skipped: true, reason: 'distillation_pending_phase3' }` (`pipeline-manifest-sqlite.ts:1891`). Nothing writes `distilled = true` or `brain_obs_id`.

---

## 5. CLI

### 5.1 `cleo manifest`

| Command | Dispatches | Flags |
|---|---|---|
| `cleo manifest show <id>` | `manifest.show` (`entryId`) | |
| `cleo manifest list` | `manifest.list` | `--task`, `--type`, `--limit` (CLI default 50), `--offset`; `--filter`, `--epic`, `--json` are accepted but have no effect (§7) |
| `cleo manifest find <query>` | `manifest.find` | `--limit` (default 20); `--json` has no effect |
| `cleo manifest stats` | `manifest.stats` | `--json` has no effect; no epic filter is passed |
| `cleo manifest append` | `manifest.append` | `--entry <json>`, `--file <path>` or JSON on stdin; or shorthand `--task`, `--type`, `--content`, `--title`, `--status` |
| `cleo manifest archive` | `manifest.archive` | `--before-date <YYYY-MM-DD>`; the `<id>` positional is accepted but rejected by dispatch (§7) |

Shorthand append (`buildManifestEntryFromShorthand`, `manifest-builder.ts:101`) builds: `id` = `<task>-<type>-<YYYYMMDDHHMMSS>` (or `manifest-<stamp>` without a task); `type` defaults to `implementation`; `title` = first line of `--content` (120 chars); `file` = `.cleo/agent-outputs/<task>-<type>-<stamp>.md` (the file is not created); `status` = `completed`; `topics` = `[task, type]`; `key_findings` = `[content]`; `actionable` = `false`; `linked_tasks` = `[task]`. With `--entry` or `--file`, the shorthand flags override individual fields.

### 5.2 `cleo research`

`cleo research` subcommands are wrappers over the same operations:

| Command | Dispatches |
|---|---|
| `add` | `manifest.append` (id `res_<epoch-ms>`) |
| `show` | `manifest.show` |
| `list` | `manifest.list` (`--task`, `--status`, `--limit`) |
| `pending` | `manifest.list` with `status: 'pending'` |
| `link`, `update` | `manifest.update` |
| `stats` | `manifest.stats` |
| `links <taskId>` | `manifest.find` with `taskId` only |
| `archive` | `manifest.archive` (`--before-date`) |
| `manifest` | `manifest.list`; prints a deprecation warning to stderr |

### 5.3 Ingestion and repair

`cleo migrate manifest-ingest [--rcasd] [--loose]` (no flag = both) runs:

- `ingestRcasdDirectories`: every `.cleo/rcasd/<taskId>/<phase>/*.md`. `id` = `<taskId>-rcasd-<phase>-<slug>`; `type` from the phase (`testing` maps to `validation`; unknown phases to `implementation`); `metadata_json.phase` keeps the directory name.
- `ingestLooseAgentOutputs`: top-level `.cleo/agent-outputs/*.md` only. `id` = `<taskId>-loose-<slug>` or `loose-<slug>`; `task_id` from a leading `T<digits>`; `type` from a fixed override list, then filename patterns, falling back to `implementation`.

Slugs are the lowercased filename without `.md`, non-alphanumeric runs replaced by `-`. Each batch commits atomically; an identical existing row is skipped, a differing one fails with `E_MANIFEST_ID_CONFLICT`. Output: `ingested` and `skipped` counts per source.

`cleo doctor manifest-rows` lists rows whose metadata breaks the contract and (read-only) rows with an invalid id, linked task id or file reference. `--repair` prints the plan; `--repair --apply` moves each bad field under `_malformed` and writes a receipt; `--rollback <receipt>` undoes it.

### 5.4 Legacy `MANIFEST.jsonl` import

`migrateManifestJsonlToSqlite` (SDK only, no CLI or startup caller) reads `<project>/.cleo/MANIFEST.jsonl`, skips blank and unparseable lines, entries without an id, entries failing the identity checks, and ids already stored; inserts the rest through `entryToRow`; then renames the file to `MANIFEST.jsonl.migrated`. Returns `{ migrated, skipped, invalid[] }`.

---

## 6. Agent use

Agents record deliverables with `cleo manifest append` (shorthand or `--entry`). Canonical documents (spec, ADR, research, handoff and the other doc kinds) go through `cleo docs add|update|publish`, not through manifest entries or raw files; an entry may point at one with `file: "cleo://docs/<slug>"`.

---

## 7. Known defects

The CLI defects below are tracked in T14604.

| Defect | Location |
|---|---|
| `cleo manifest archive <id>` sends `{ id }`; the handler requires `beforeDate` and always returns `E_INVALID_INPUT`. | `cli/commands/manifest.ts:335`, `dispatch/domains/pipeline.ts:676-683` |
| `cleo manifest list --filter` and `--epic` send `filter` / `epicId`, which `filterManifestEntries` does not read. `--filter archived` could not work anyway: list excludes archived rows. | `cli/commands/manifest.ts:95, 97`, `memory/manifest-filter.ts` |
| `cleo research pending` filters on `status: 'pending'`, a value no entry has, so it is always empty. | `cli/commands/research.ts:161-167` |
| `cleo research links <taskId>` sends `{ taskId }` to `manifest.find`, which requires `query`; it always fails with `E_INVALID_INPUT`. | `cli/commands/research.ts:264-270`, `pipeline.ts:649-652` |
| `cleo research manifest --agent-type` sends `agentType`; the filter reads `agent_type` / `type`. | `cli/commands/research.ts:338` |
| `cleo research manifest` still ships; its warning promised removal in v2026.6.x. | `cli/commands/research.ts:326-330` |
| `content_hash` and `created_at` formats differ between append and ingestion (§2.4). | `pipeline-manifest-sqlite.ts:254, 808`; `manifest-ingestion.ts:80, 207, 267` |
| The `docs_pipeline_manifest.id` doc comment says "UUID v4"; ids are caller-chosen strings (§3.1). | `store/schema/cleo-project/docs.ts:237` |

---

## 8. References

- [ADR-006: canonical SQLite storage](../adr/adr-006-canonical-sqlite-storage.md)
- [ADR-021: memory domain refactor](../adr/adr-021-memory-domain-refactor.md)
- [ADR-027: manifest SQLite migration](../adr/adr-027-manifest-sqlite-migration.md)
- [ADR-054: manifest unification](../adr/adr-054-manifest-unification.md)
- [CLEO operation constitution](cleo-operation-constitution.md)
