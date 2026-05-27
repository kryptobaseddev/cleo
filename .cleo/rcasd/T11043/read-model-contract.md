# Docs Read-Model Contract

**Task**: T11043 (T10516-C1)
**Saga**: T10516 (SG-DOCS-CLI-SIMPLIFICATION)
**Epic**: T10519 (Docs storage/query consolidation behind one read model)
**Status**: Specification

---

## 1. Problem Statement

The `cleo docs` system has two distinct storage backends that each carry partial
state.  Callers currently choose between three divergent code paths depending on
what they are looking for:

| Path | Module | Backend | What it resolves |
|------|--------|---------|-----------------|
| A | `attachment-store.ts` | SQLite (`attachments` + `attachment_refs`) | Slug, type, owner, SHA-256, blob metadata, ref-count |
| B | `blob-ops.ts` → `CleoBlobStore` | llmtxt/blob manifest (filesystem) | Owner→blob list, named blob SHA, version history, blob bytes |
| C | `docs-publications.json` | JSON ledger (filesystem) | Published path, last-blob-SHA, drift classification |

**The result**: `cleo docs status`, `cleo docs fetch`, `cleo docs list`, and
`cleo docs publish` each resolve the same conceptual doc through **different
lookup chains** that may disagree on the latest SHA, version count, or
publication state.

---

## 2. Current Divergent Query Paths

### 2.1. Lookup by slug

| Caller | Code | Backend | Returns |
|--------|------|---------|---------|
| `docs.fetch` (dispatch) | `store.findBySlug(ref)` → `store.get(sha256)` | SQLite | Metadata + bytes |
| `findSimilarDocs` (docs-ops) | `store.findBySlug(seed)` → `store.get(sha256)` → `store.listAllInProject()` | SQLite | Seed content + ranked hits |
| `searchAllProjectDocs` (docs-ops) | `store.listAllInProject()` (no slug resolve) | SQLite | Flat scan of all refs |

**Divergence**: `findBySlug` only queries the `attachments` table by slug.
It does NOT return:
- Version history (only the latest `attachments` row)
- Publication state (ledger is a separate file)
- Blob manifest entries (llmtxt/blob store)

### 2.2. Lookup by owner

| Caller | Code | Backend | Returns |
|--------|------|---------|---------|
| `docs.list` (dispatch) | `store.listByOwner(ownerType, ownerId)` | SQLite | Attachment metadata list |
| `docs.list --project` (dispatch) | `store.listAllInProject(cwd, filter)` | SQLite (JOIN) | All refs with owner |
| `blobList` (blob-ops) | `CleoBlobStore.list(taskId)` | llmtxt/blob manifest | Blob entries (name, sha256, size, mime) |
| `listDocVersions` (docs-ops) | `blobList(ownerId)` | llmtxt/blob manifest | Version entries |
| `rankDocs` (docs-ops) | `blobList(ownerId)` | llmtxt/blob manifest | Ranked blob names |
| `searchDocs` (docs-ops) | `blobList(ownerId)` | llmtxt/blob manifest | Search hits |
| `publishDocs` (docs-ops) | `blobList(ownerId)` → `blobRead(ownerId, name)` | llmtxt/blob manifest | Bytes + target blob |
| `syncFromGit` (docs-ops) | `blobList(ownerId)` → `CleoBlobStore.attach()` | llmtxt/blob manifest | Write-side |
| `statusDocs` (docs-ops) | `listPublications()` + `blobList(ownerId)` for each row | JSON ledger + llmtxt/blob manifest | Drift items |

**Divergence**: Half the codebase queries SQLite for attachments; the other
half queries the llmtxt/blob manifest for blobs.  These two backends do NOT
share a transaction boundary.  An attachment registered via `attachmentStore.put`
(which writes to SQLite AND the filesystem under `.cleo/attachments/sha256/`)
may or may not appear in `blobList` (which reads the llmtxt/blob manifest).

### 2.3. Lookup by attachment ID / SHA-256

| Caller | Code | Backend | Returns |
|--------|------|---------|---------|
| `docs.fetch` (dispatch) | Resolution chain: SHA-256 → att_id → slug → prefix | SQLite | Metadata + bytes |
| `AttachmentStore.get(sha256)` | Direct SQLite row by sha256 | SQLite | Bytes + metadata |
| `AttachmentStore.getMetadata(attId)` | Direct SQLite row by id | SQLite | Metadata |
| `blobRead(ownerId, name)` | `CleoBlobStore.get(taskId, name)` | llmtxt/blob manifest | Bytes |

**Divergence**: `store.get(sha256)` reads from the `attachments` SQLite table
and the `.cleo/attachments/sha256/` filesystem.  `blobRead` reads from the
llmtxt/blob manifest and its own storage layout.  They may disagree on byte
content if a blob was attached through one path but not the other.

### 2.4. Publication / status

| Caller | Code | Backend | Returns |
|--------|------|---------|---------|
| `publishDocs` (docs-ops) | `blobList` → `blobRead` → atomic write → `recordPublication` | llmtxt/blob + JSON ledger | Publish result |
| `recordPublication` (docs-ops) | `readPublicationsLedger` → upsert → `writePublicationsLedger` | JSON ledger | void |
| `listPublications` (docs-ops) | `readPublicationsLedger` | JSON ledger | PublicationRecord[] |
| `statusDocs` (docs-ops) | `listPublications` → `blobList` per row → `readFile` SHA compare | JSON ledger + llmtxt/blob | Drift items |

**Divergence**: Publication state lives in a JSON sidecar
(`.cleo/docs-publications.json`), NOT in the SQLite `attachments` table.
Drift detection (`statusDocs`) must cross-reference the JSON ledger against
the llmtxt/blob manifest AND the published file on disk — three separate
state stores.

---

## 3. Canonical Read Model

### 3.1. Unified Doc Entry

The read model resolves every lookup key to a single canonical shape.
This is the **output contract** — what callers receive regardless of
how they looked up the doc.

```typescript
interface DocEntry {
  // ── Identity ──────────────────────────────────────
  /** Kebab-case slug, unique per project. null when unset. */
  slug: string | null;

  /** Attachment UUID (attachments.id). Always present. */
  attachmentId: string;

  /** Lowercase hex SHA-256 of the latest blob content. */
  sha256: string;

  /** IANA MIME type of the latest blob. null when unknown. */
  mimeType: string | null;

  /** Byte size of the latest blob. */
  sizeBytes: number;

  // ── Owner ─────────────────────────────────────────
  /** Entity type that holds the attachment ref. */
  ownerType: string;

  /** Entity ID that holds the attachment ref. */
  ownerId: string;

  // ── Taxonomy ──────────────────────────────────────
  /** Doc kind classification (adr, spec, research, …). null when unset. */
  type: string | null;

  /** Short human-readable summary. null when unset. */
  summary: string | null;

  /** Lifecycle status. Default: 'active'. */
  lifecycleStatus: string;

  /** ISO-8601 creation timestamp. */
  createdAt: string;

  /** Current reference count across all owners. */
  refCount: number;

  // ── Version history ───────────────────────────────
  /** How many blob versions exist for (ownerId, blobName). */
  versionCount: number;

  /** SHA-256 of the latest version in the blob manifest. */
  latestVersionSha256: string;

  /** All recorded versions, most-recent first. */
  versions: DocVersionRef[];

  // ── Publication state ─────────────────────────────
  /** Project-root-relative published path, or null if never published. */
  publishedPath: string | null;

  /** SHA-256 at the published path, or null if never published or deleted. */
  publishedSha: string | null;

  /** Drift classification relative to the docs SSoT. */
  drift: DocDrift | null;
}

interface DocVersionRef {
  /** Blob name in the manifest. */
  name: string;

  /** Content-address SHA-256. */
  sha256: string;

  /** Byte size. */
  sizeBytes: number;

  /** MIME type, when known. */
  mimeType?: string;
}

type DocDrift =
  | 'in-sync'          // publishedSha === latestVersionSha256
  | 'modified'         // publishedSha !== latestVersionSha256 (file exists)
  | 'deleted'          // published file missing from disk
  | 'never-published'; // no publication record
```

### 3.2. Lookup Keys

The read model accepts any of these input shapes and resolves them to
a `DocEntry | null`.

```typescript
type DocLookupKey =
  | { kind: 'by-slug'; slug: string }
  | { kind: 'by-attachment-id'; attachmentId: string }
  | { kind: 'by-sha256'; sha256: string }
  | { kind: 'by-owner-and-name'; ownerType: string; ownerId: string; name: string };
```

### 3.3. Query Operations

These are the ONLY functions the CLI layer should call.  Everything else
(blob-ops, attachment-store directly, publications ledger) becomes internal
to the read model.

```typescript
// ── Single-doc resolution ──────────────────────────────────

/**
 * Resolve a single doc by any canonical lookup key.
 *
 * Merges SQLite attachments row + llmtxt/blob manifest versions
 * + publications ledger drift into one DocEntry.
 *
 * Returns null when no doc matches the key.
 */
function resolveDoc(key: DocLookupKey): Promise<DocEntry | null>;

/**
 * Fetch raw bytes for a resolved doc.
 *
 * Must be called AFTER resolveDoc so we know the backend.
 * Returns null when the blob is not readable (missing file,
 * corrupted SHA).
 */
function fetchDocBytes(key: DocLookupKey): Promise<{ bytes: Buffer; entry: DocEntry } | null>;

// ── Listing ────────────────────────────────────────────────

interface DocListFilter {
  /** Restrict to one entity type. */
  ownerType?: string;

  /** Restrict to one entity ID. */
  ownerId?: string;

  /** Restrict to one doc kind (adr, spec, …). */
  type?: string;

  /** Restrict to docs with a slug (published). */
  hasSlug?: boolean;

  /** Max rows returned. Default: 50. */
  limit?: number;

  /** Pagination offset. Default: 0. */
  offset?: number;

  /** Sort key. Default: 'newest'. */
  orderBy?: 'newest' | 'slug' | 'sha';
}

interface DocListPage {
  /** Resolved doc entries for this page. */
  entries: DocEntry[];

  /** Total matching docs (for pagination). */
  totalCount: number;

  /** Applied limit. */
  limit: number;

  /** Applied offset. */
  offset: number;

  /** Applied sort. */
  orderBy: 'newest' | 'slug' | 'sha';
}

/**
 * List docs matching the filter, resolving each to a DocEntry.
 */
function listDocs(filter?: DocListFilter): Promise<DocListPage>;
```

### 3.4. Internal Resolution Algorithm

`resolveDoc` merges three backends in a fixed order:

```
1. SQLite (AttachmentStore) — canonical identity
   └─ findBySlug / get / getMetadata
   └─ Populates: slug, attachmentId, sha256, mimeType, sizeBytes,
                 ownerType, ownerId, type, summary, lifecycleStatus,
                 createdAt, refCount

2. llmtxt/blob manifest (blob-ops) — version history
   └─ blobList(ownerId)
   └─ Populates: versionCount, latestVersionSha256, versions[]
   └─ If latestVersionSha256 differs from step 1 sha256:
      WARN — blob manifest is ahead of attachments row

3. Publications ledger — publication state
   └─ listPublications → filter by (ownerId, publishedPath)
   └─ Populates: publishedPath, publishedSha, drift
```

**Backend merge rules:**

- `slug`, `attachmentId`, `ownerType`, `ownerId`, `type`: SQLite wins.
  These columns only exist in the `attachments` table.
- `sha256`, `mimeType`, `sizeBytes`: SQLite wins for the attachment row;
  the latest version SHA from the blob manifest is exposed separately as
  `latestVersionSha256`.
- `versions[]`: ONLY from the blob manifest.  SQLite does not track
  version history.
- `publishedPath`, `publishedSha`, `drift`: ONLY from the publications
  ledger.  SQLite does not track publication state.
- When the blob manifest has no entry for `(ownerId, name)`, set
  `versionCount = 0`, `latestVersionSha256 = sha256` (fall back to the
  attachment row SHA), and `versions = []`.
- When no publication record exists, set `publishedPath = null`,
  `publishedSha = null`, `drift = 'never-published'`.

### 3.5. What MUST NOT live in this module

The read model is a **query-only** contract.  It MUST NOT:

- Call `attachmentStore.put`, `attachmentStore.ref`, `attachmentStore.deref`
  (write-side stays in the store)
- Call `publishDocs`, `syncFromGit`, `recordPublication` (write-side stays
  in docs-ops)
- Call `searchDocs`, `searchAllProjectDocs`, `findSimilarDocs`, `rankDocs`,
  `mergeDocs`, `buildDocsGraph` (these are higher-level operations that
  USE the read model, not part of it)
- Import from `llmtxt/*` directly (go through blob-ops if needed)
- Contain CLI-only formatting or output rendering logic

---

## 4. Impact on CLI Surface

After the read model ships, the CLI `cleo docs` operations simplify:

| Current CLI path | After read model |
|-----------------|-----------------|
| `cleo docs list` → dispatch → `store.listByOwner` OR `store.listAllInProject` | → `listDocs(filter)` |
| `cleo docs fetch <ref>` → dispatch → resolution chain (SHA→id→slug→prefix) | → `resolveDoc({kind})` then `fetchDocBytes({kind})` |
| `cleo docs status` → `statusDocs()` → ledger read + per-row `blobList` | → `listDocs({hasSlug: true})` — drift is already on each entry |
| `cleo docs publish` → `publishDocs({ownerId, toPath})` → blobList → blobRead | → Read path: `resolveDoc({kind: 'by-owner-and-name', …})`. Write path stays in docs-ops. |

---

## 5. Acceptance Criteria Mapping

### AC1: Read-model contract names canonical inputs and outputs

Covered by §3.1 (`DocEntry`), §3.2 (`DocLookupKey`), and §3.3
(query operations).

### AC2: Contract identifies current divergent query paths

Covered by §2.1–§2.4.  Each subsection names the exact file, function,
backend, and return type.

### AC3: Follow-on tasks can implement without adding CLI-only business logic

The read model is a pure data layer — no CLI rendering, no dispatch
envelope construction, no output formatting.  §3.5 explicitly forbids
these concerns.  Follow-on tasks (T10519-C2, C3, …) implement the
`resolveDoc` / `listDocs` / `fetchDocBytes` functions inside
`packages/core/src/docs/` and the CLI dispatch layer calls them
through the existing typed-dispatch pattern.

---

## 6. Files Referenced

| File | Role |
|------|------|
| `packages/core/src/store/attachment-store.ts` | SQLite attachment registry (identity, slug, type, owner) |
| `packages/core/src/store/blob-ops.ts` | llmtxt/blob manifest reader (version history, blob names, bytes) |
| `packages/core/src/docs/docs-ops.ts` | Higher-level docs operations (publish, search, merge, status, sync) |
| `packages/cleo/src/dispatch/domains/docs.ts` | CLI dispatch layer (list, fetch, add, remove, update, supersede) |
| `packages/cleo/src/cli/commands/docs.ts` | CLI command definitions |
| `packages/contracts/src/operations/docs.ts` | Wire-format type contracts |
