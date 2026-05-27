# T766 — File Attachments + llmtxt-core Integration Proposal

**Task**: T766 (child of epic T760)
**Date**: 2026-04-16
**Agent**: cleo-prime (research specialist)
**Status**: Proposal — awaiting owner approval before implementation

---

## 0. Executive Summary

**Decision: ADOPT `llmtxt` (npm) + `llmtxt-core` (Rust, via WASM) as CLEO's attachment substrate.**

The single most important fact this audit surfaced: **the owner is the author of both `llmtxt-core` (crates.io) and `llmtxt` (npm)**. They are not third-party dependencies — they are in-family with CLEO, already peer-depend on `@cleocode/lafs`, and already prove they solve the exact problem we face (content-addressed document storage, compression, versioning, progressive disclosure, patch-based multi-agent collaboration).

CLEO today has four **disconnected** attachment-shaped surfaces:

| Primitive | Where | Capability | Gap |
|---|---|---|---|
| `lifecycle_evidence` table | `tasks.db` | URI + type (file/url/manifest), stage-scoped | Only visible to RCASD epics; not attachable to regular tasks, observations, decisions, or messages |
| CONDUIT `attachments` + `attachment_versions` + `attachment_approvals` + `attachment_contributors` | `conduit.db` | Full-featured Rust-side: blobs, versioning, approvals, contributor tracking (migrations 0012 + 0018) | **Zero TypeScript CLI surface** — no `cleo attach`, no domain handler, no contract type. Tables exist, nothing writes or reads them through cleo |
| `cleo research add --sources` | `tasks.db` research table | URL list on a research entry | Free-text comma-separated strings; no hashing, no typing, no local caching |
| `agent-outputs/` folder + `MANIFEST.jsonl` | `.cleo/agent-outputs/` | Convention for agent writes | Not a first-class CLI primitive — agents write paths by hand, no hash, no schema, no dedup, no query |

None of these compose. An agent cannot today run `cleo attach T766 ./spec.pdf --desc "RFC draft v3"` and have that attachment be visible from `cleo show`, `cleo memory fetch`, a BRAIN observation, a CONDUIT message, or a subagent prompt. Worse, the **most-capable existing substrate (CONDUIT's versioned attachment tables) is completely unreachable from the CLI** — 93 lines of SQL schema with no CLI on top.

The proposal below unifies all four into one `Attachment` contract backed by `llmtxt` primitives, with a tiered storage model (embedded SQLite for hot; content-addressed filesystem for large blobs; optional remote S3 via llmtxt.my for cross-machine share).

---

## 1. Current State Audit

### 1.1 What exists (with file/line citations)

**Task schema** — `packages/contracts/src/task.ts:170`:
```ts
/** File paths associated with this task. @defaultValue undefined */
files?: string[];
```
A bare string array. No hash, no mime, no description, no versioning, no content addressing. Writing `"/tmp/foo.md"` into it is valid; the path may not exist at read time.

**Lifecycle evidence** — `packages/core/src/lifecycle/evidence.ts:22`:
```ts
export type EvidenceType = 'file' | 'url' | 'manifest';
export interface EvidenceRecord {
  id: string;
  stageId: string;
  uri: string;
  type: EvidenceType;
  recordedAt: string;
  recordedBy?: string;
  description?: string;
}
```
Good shape, but stage-scoped only (requires an epic + RCASD stage). The URI is relative-to-`.cleo/` but there is no integrity hash, no content copy, no mime tag. `getEvidence()` returns 14 rows today in this project, mostly for T4881 research artifacts.

**CONDUIT attachments** — `packages/core/src/store/conduit-sqlite.ts:188` + `crates/signaldock-storage/migrations/0012_attachments.sql` + `0018_attachment_versioning.sql`:
- `attachments(slug, conversation_id, from_agent_id, content BLOB, original_size, compressed_size, content_hash, format, title, tokens, expires_at, storage_key, mode, version_count, current_version, created_at)`
- `attachment_versions(id, slug, version_number, author_agent_id, change_type, patch_text, storage_key, content_hash, original_size, compressed_size, tokens, change_summary, sections_modified TEXT json, tokens_added, tokens_removed, created_at)`
- `attachment_approvals(id, slug, reviewer_agent_id, status, comment, version_reviewed, created_at, updated_at)`
- `attachment_contributors(slug, agent_id, version_count, total_tokens_added, total_tokens_removed, first_contribution_at, last_contribution_at)`

This is **the most-developed attachment substrate in the codebase**. It already implements: compression, content-hashing, versioned patches (`patch_text`), approval workflow, contributor stats. It is **unused** — the Rust side has it, the TS side has the schema, and there is no CLI handler, no contract type in `packages/contracts/`, no `cleo attach` command, and no wiring from `cleo agent send` to attachments. It is a latent capability.

**Research entries** — `cleo research add -t T766 --topic "…" --findings "…" --sources "url1,url2"`. Sources are comma-separated strings on a task-scoped research row; no content capture, no mime, no hash, no offline cache.

**BRAIN observations** — `brain_observations` table has `files_read_json` and `files_modified_json` (plain JSON arrays of paths) and `facts_json`, but no attachment type, no integrity hash, no content body. An observation cannot carry an attached PDF or document.

**CONDUIT messages** — `ConduitMessage.metadata?: Record<string, unknown>` is the only extensibility point. No typed attachment field.

**Agent-outputs folder** — `.cleo/agent-outputs/MANIFEST.jsonl` is a convention enforced by subagent prompts (including this one), not the schema. Files are written manually by agents; paths are opaque; no hash, no query surface, no cross-reference from `cleo show <taskId>` to "these files are attached to this task."

### 1.2 Gaps table

| Desire | Current state | Gap |
|---|---|---|
| Attach a file to a task | `task.files: string[]` — bare paths | No hash; path may vanish; no content preserved; not a query surface |
| Query "what files are attached to T766?" | `cleo show T766` returns the `files` array of strings | No type (mime), no size, no hash, no canonical storage location |
| Subagent receives "the 3 attachments for this task" when spawned | No — subagent receives a prompt string only | `SpawnContext.prompt: string` is untyped; no attachment bundle |
| Share a file between agents on the same machine | CONDUIT has `attachments` table but no CLI | Schema exists, no writer/reader |
| Share a file with a remote agent | No | Possible via llmtxt.my SaaS but not wired |
| BRAIN observation with attached PDF source | `files_read_json` string array | No content, no mime; path-only |
| Programmatic gate (T763) says "file at `.cleo/attachments/<sha>.md` must exist and match hash" | No attachment storage by hash | `linkProvenance()` exists but writes to `lifecycle_evidence`, not to a content-addressed store |
| Generate `llms.txt` for a CLEO-managed project so other agents can self-discover what this project is | No | `llmtxt init` exists; CLEO doesn't use it |
| Generate per-task `llms.txt` bundle summarising attachments | No | Requires attachments-as-primitive first |

---

## 2. llmtxt-core Evaluation

### 2.1 What it is (literal)

From `crates.io/crates/llmtxt-core` 2026.4.5 README (fetched 2026-04-16):

> Portable Rust primitives for llmtxt content workflows.
> `llmtxt-core` is the single source of truth for compression, hashing, signing, patching, similarity, and version reconstruction used by both:
> - native Rust consumers like SignalDock (Axum backend)
> - the TypeScript package `llmtxt` via WASM bindings

**Provides**:
- `compress` / `decompress` (zlib-compatible, RFC 1950)
- `hash_content` — SHA-256 hex
- token estimation + compression ratios
- `generate_signed_url` / `verify_signed_url` — HMAC-SHA256
- `create_patch` / `apply_patch` — unified diff for document versioning
- `reconstruct_version` / `squash_patches` — patch-stack management
- n-gram Jaccard text similarity
- base62 encoding (for slugs)
- organisation-scoped signature variants
- WASM exports for the TS `llmtxt` package

**Dimensions** (from crates.io metadata):
- License: **MIT**
- Rust edition 2024
- 33 source files, 7776 LOC (v2026.4.5)
- 191 downloads total, 191 recent (small but deliberate; the author is the primary consumer)
- Keywords: `agent`, `llm`, `patch`, `signing`, `wasm`
- Dependency shape: feature-gated `wasm` (default on), feature-gated `crdt` (yrs)
- Published via GitHub trustpub (OIDC) from `kryptobaseddev/llmtxt` repo

### 2.2 What the npm `llmtxt` package adds (2026.4.5)

From `registry.npmjs.org/llmtxt/latest` (fetched 2026-04-16) and the repo README:

- `bin: llmtxt` CLI (`init`, `create-doc`, `push-version`, `sync`)
- `sdk` subpath — `isValidTransition`, `evaluateApprovals`, `planRetrieval`, `reconstructVersion`, `attributeVersion`, `buildContributorSummary`
- `local` subpath — `LocalBackend` (embedded SQLite via `better-sqlite3` + Drizzle ORM 1.0.0-beta.21)
- `remote` subpath — `RemoteBackend` (HTTP client for `api.llmtxt.my`)
- `disclosure`, `similarity`, `graph`, `crdt-primitives`, `embeddings` submodules
- **`peerDependencies: { "@cleocode/lafs": ">=2026.3" }`** — optional but declared
- `multiWayDiff` / `cherryPickMerge` — the exact primitives missing from llmtxt.my SaaS that we flagged in `llmtxt-my-sitrep-2026-04-11.md` Issues 1 & 2 are now implemented client-side in WASM

### 2.3 The llms.txt spec (llmstxt.org) is ALSO relevant

Separate from llmtxt-core/llmtxt (which is content-primitive infrastructure), there is the **llms.txt specification** at llmstxt.org — an H1 + blockquote + H2-section-of-links markdown format for a site's root-level `/llms.txt` file, intended as an LLM-consumable site index. Tools like `llms_txt2ctx` expand the link list into `llms-ctx-full.txt` — a single concatenated markdown with all linked resources inlined.

CLEO can participate **both ways**:

1. **CLEO generates `llms.txt` for a project it manages** — rooting at the project's README, linking to key tasks/epics, ADRs, and test harness docs. Agents dropped into the project can curl `llms.txt` and self-orient.

2. **CLEO generates a per-task `llms-ctx-full.txt` bundle** — when an agent is spawned on T766, the spawner builds `/tmp/cleo-spawn-T766/llms.txt` + `llms-ctx-full.txt` from the task description, acceptance criteria, linked research, and attachment bodies. The subagent reads one file to load full context.

The **llmtxt npm package primitives** (compression, hashing, patch, progressive disclosure) are the substrate; the **llms.txt spec** is the wire format.

### 2.4 Fit to CLEO

| Dimension | Fit | Reasoning |
|---|---|---|
| Ownership risk | **Zero** | Same author as CLEO. Same GitHub org (kryptobaseddev). Same release cadence (CalVer 2026.4.x). Same license (MIT). |
| Type-contract alignment | **Strong** | `llmtxt` already declares peer-dep on `@cleocode/lafs`. It is architected to compose with CLEO. |
| Primitive coverage | **Exceeds need** | We need: hash, compress, store-blob, diff, apply-patch, token-count. Ships: all six + multi-way diff + cherry-pick merge + signed URLs + similarity + CRDT + embeddings. |
| Footprint | **Acceptable** | WASM build ~190 KB (v2026.4.5 crate size). TS package 1.7 MB unpacked. Zero new network dependency (LocalBackend is embedded). |
| Evidence it works | **Yes — already field-tested** | See `llmtxt-my-sitrep-2026-04-11.md` (SaaS side), plus the fact that the author ships SignalDock against the same crate. |
| Canonicality | **Strong** | Replaces three ad-hoc primitives (task.files, research.sources, agent-outputs convention) with one typed contract. |

**Weaknesses honestly acknowledged**:
- Small install base (191 crate downloads) — but we are primary consumer, so this is expected.
- WASM add-on — 190 KB is small but non-zero. Unusable in browsers where our TS packages already restrict to Node (`engines.node: ">=22"`).
- Drizzle beta dependency — matches CLEO's `drizzle-orm` 1.0.0-beta use (see `feedback_drizzle_v1.md` memory: "MUST use drizzle-orm v1.0.0-beta, never downgrade"). Already aligned.
- One more dependency to audit in release gates. Mitigated by same-author ownership.

### 2.5 Potential uses

**(a) Per-project `llms.txt`** — `cleo llmstxt generate --root .` emits `./llms.txt` at the project root with H1 = project name, blockquote = one-line summary (from `project-info.json`), H2 sections linking to `AGENTS.md`, `.cleo/memory-bridge.md`, `.cleo/nexus-bridge.md`, ADRs, top-5 open epics.

**(b) Per-task `llms-ctx-full.txt` bundle for spawner** — When the spawner (LOOM) prepares a subagent's working context for task T766, it builds an `llms-ctx-full.txt` concatenating: T766 description, acceptance criteria, all linked research entries, the body of each attachment (via `llmtxt.reconstructVersion` at current version), and the memory-bridge snapshot. This is handed to the subagent as its `{{CONTEXT_FILE}}` token rather than raw paths.

**(c) `cleo memory fetch <id> --format llmstxt`** — When fetching a brain entry, emit an llms-ctx-full.txt containing the entry's text plus all attached source files reconstructed from the content-addressed store. Token-budget-aware via `planRetrieval`.

**(d) Attachment storage** — Use `llmtxt.LocalBackend` as the substrate under `.cleo/attachments/` instead of raw-file writes. Gives versioning, patches, approvals, and contributor stats for free.

---

## 3. Proposed CLEO Attachment Architecture

### 3.1 The `Attachment` contract

Add to `packages/contracts/src/attachment.ts` (new file):

```ts
/** Discriminated attachment kinds. */
export type Attachment =
  | LocalFileAttachment
  | UrlAttachment
  | BlobAttachment
  | LlmsTxtAttachment
  | LlmtxtDocAttachment;

export interface AttachmentCommon {
  /** Unique attachment ID. Pattern: `att_<base62>`. */
  id: string;
  /** Free-text description. Max 280 chars. */
  description?: string;
  /** Optional agent-authored title. Max 120 chars. */
  title?: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** Agent that created this attachment. */
  createdBy: string;
  /** Labels for filtering (e.g., "rfc", "test-fixture", "screenshot"). */
  labels?: string[];
}

/** A file on disk inside the CLEO project (read-only reference). */
export interface LocalFileAttachment extends AttachmentCommon {
  kind: 'local-file';
  /** Path relative to the project root (forward-slashes only). */
  path: string;
  /** SHA-256 hex of the file at attach time. Computed on attach, verified on read. */
  sha256: string;
  /** IANA MIME type. */
  mime: string;
  /** Size in bytes at attach time. */
  size: number;
}

/** A remote URL, optionally cached to the content-addressed store. */
export interface UrlAttachment extends AttachmentCommon {
  kind: 'url';
  url: string;
  /** If cached: SHA-256 of fetched body; storage path is `.cleo/attachments/sha256/<hash>.<ext>`. */
  cachedSha256?: string;
  /** ISO 8601 when cached. */
  cachedAt?: string;
  /** HTTP status observed on last cache. */
  cachedStatus?: number;
  mime?: string;
}

/** Bytes stored in the content-addressed store — no external path dependency. */
export interface BlobAttachment extends AttachmentCommon {
  kind: 'blob';
  /** SHA-256 of the uncompressed content. */
  sha256: string;
  /** Storage key inside `.cleo/attachments/sha256/`. */
  storageKey: string;
  mime: string;
  size: number;
  /** Token count estimate (via llmtxt-core). */
  tokens?: number;
}

/** A generated or fetched llms.txt snapshot — useful for "this is the live site index." */
export interface LlmsTxtAttachment extends AttachmentCommon {
  kind: 'llms-txt';
  /** Where the llms.txt came from. */
  source: 'url' | 'generated';
  /** Origin URL if source='url'; omit for 'generated'. */
  originUrl?: string;
  /** Full content stored inline (llms.txt is small by design). */
  content: string;
  /** SHA-256 of `content`. */
  sha256: string;
  /** ISO 8601 when fetched or generated. */
  fetchedAt: string;
}

/** A pointer into an llmtxt document (local or remote) — carries versioning. */
export interface LlmtxtDocAttachment extends AttachmentCommon {
  kind: 'llmtxt-doc';
  /** Document slug from llmtxt LocalBackend or llmtxt.my. */
  slug: string;
  /** Which llmtxt backend owns the document. */
  backend: 'local' | 'remote';
  /** API base URL if backend='remote' (e.g., 'https://api.llmtxt.my'). */
  baseUrl?: string;
  /** Current version observed at attach time. */
  pinnedVersion?: number;
  /** SHA-256 of the content at `pinnedVersion`. */
  pinnedContentHash?: string;
}
```

### 3.2 Attachable targets

Extend the following types with an optional `attachments: Attachment[]` field:

- `Task` (`packages/contracts/src/task.ts`) — adds task-scoped attachments. Populates on `cleo attach <taskId> …`.
- `BrainObservation` (extend `brain_observations` with an `attachments_json` TEXT column) — an observation that cites a PDF carries the PDF.
- `BrainDecision` — same.
- `ConduitMessage` — typed replacement for `metadata.attachments`.
- `LifecycleStage` via `lifecycle_evidence` — the existing `EvidenceRecord` row becomes a **generated view over attachments filtered to the stage**; migrate on read, keep write path for backward compat.
- `Session` — session-scoped attachments (screenshots of the test run, logs).

### 3.3 Storage model

Content-addressed filesystem with SQLite index. All-local by default; optional remote mirror to llmtxt.my via signed URLs.

```
.cleo/
├── attachments/
│   ├── sha256/
│   │   ├── 3a/
│   │   │   └── 3a7b9c...0e.md           # actual bytes, named by hash prefix + rest
│   │   ├── ab/
│   │   │   └── abcdef...12.pdf
│   │   └── ...
│   └── index.db                          # SQLite: id → sha256 → mime, size, created_at, ref_count
└── llmtxt/                               # llmtxt LocalBackend storage
    └── ...                               # managed by llmtxt.LocalBackend (docs, versions, patches)
```

`attachments/index.db` schema (Drizzle):

```ts
export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),          // att_<base62> — llmtxt.generateId()
  sha256: text('sha256').notNull(),     // content hash (llmtxt.hashContent)
  kind: text('kind').notNull(),         // 'local-file' | 'url' | 'blob' | 'llms-txt' | 'llmtxt-doc'
  mime: text('mime'),
  size: integer('size'),
  tokens: integer('tokens'),            // llmtxt-core token estimate
  path: text('path'),                   // for local-file
  url: text('url'),                     // for url
  llmtxtSlug: text('llmtxt_slug'),      // for llmtxt-doc
  llmtxtBackend: text('llmtxt_backend'), // 'local' | 'remote'
  llmtxtPinnedVersion: integer('llmtxt_pinned_version'),
  title: text('title'),
  description: text('description'),
  labelsJson: text('labels_json'),      // JSON array
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by').notNull(),
});

export const attachmentRefs = sqliteTable('attachment_refs', {
  attachmentId: text('attachment_id').notNull(),     // → attachments.id
  targetType: text('target_type').notNull(),         // 'task' | 'observation' | 'decision' | 'message' | 'session' | 'stage'
  targetId: text('target_id').notNull(),             // T766, O-abc, msg_xyz, ses_..., stage-T760-research
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.attachmentId, table.targetType, table.targetId] }),
  refsTargetIdx: index('idx_attachment_refs_target').on(table.targetType, table.targetId),
  refsAttachmentIdx: index('idx_attachment_refs_attachment').on(table.attachmentId),
}));
```

Key design choices (owner decisions required):
- **Content-addressed, not id-addressed** — two `cleo attach` invocations with the same file share one blob. Ref-count on `attachment_refs`; blob is GC-eligible when no refs remain (manual `cleo attachments gc`, never auto).
- **Junction table for many-to-many** — one attachment can be referenced by multiple tasks, observations, messages (e.g., the same RFC PDF attached to T760 the epic AND to every child task that reviews it).
- **Prefix-shard on disk** — `sha256/ab/abcdef…` to keep any single directory under 1000 entries at scale.
- **SQLite index separate from tasks.db** — `.cleo/attachments/index.db` is the attachment registry; `.cleo/tasks.db` does NOT learn about attachments (it learns about references via the junction table queried at read time). This keeps the domain separation clean (attachments are an infrastructure primitive; tasks are a domain).
- **llmtxt handles blob storage for `llmtxt-doc` kind** — delegates to `llmtxt.LocalBackend` which uses its own `.cleo/llmtxt/` directory. We only store the pointer.

### 3.4 CLI surface

All commands LAFS-enveloped, aligned to existing CLEO conventions.

| Command | Purpose | Example |
|---|---|---|
| `cleo attach <target> <file>` | Attach a local file to a task, observation, decision, message, or session | `cleo attach T766 ./docs/rfc-003.md --desc "RFC draft v3" --labels rfc,spec` |
| `cleo attach <target> --url <url>` | Attach a URL; optionally cache body | `cleo attach T766 --url https://llmstxt.org --cache --desc "llms.txt spec upstream"` |
| `cleo attach <target> --blob` | Attach stdin as bytes (for programmatic upload) | `cat report.pdf \| cleo attach T766 --blob --mime application/pdf --title "Pen-test report"` |
| `cleo attach <target> --llmtxt-doc <slug> [--backend local\|remote]` | Attach an llmtxt document pointer | `cleo attach T766 --llmtxt-doc 9fZLOnf5 --backend remote --baseUrl https://api.llmtxt.my` |
| `cleo attachments list <target>` | List attachments for a target | `cleo attachments list T766` |
| `cleo attachments show <attachmentId>` | Show metadata + ref graph | `cleo attachments show att_3a7b9c` |
| `cleo attachments fetch <attachmentId>` | Print absolute path to the blob + JSON metadata (for agent `Read`) | `cleo attachments fetch att_3a7b9c` |
| `cleo attachments search <query>` | FTS over titles + descriptions + filenames | `cleo attachments search "pen-test"` |
| `cleo attachments detach <attachmentId> <target>` | Remove a reference (blob kept if other refs exist) | `cleo attachments detach att_3a7b9c T766` |
| `cleo attachments gc [--dry-run]` | Remove unreferenced blobs from filesystem | `cleo attachments gc --dry-run` |
| `cleo llmstxt generate [--for <taskId>\|--root .] [--output llms.txt]` | Emit llms.txt per spec | `cleo llmstxt generate --root . --output llms.txt` |
| `cleo llmstxt bundle <taskId> [--output bundle.txt] [--budget 40000]` | Emit llms-ctx-full.txt with all task context + attachment bodies, respecting token budget via `planRetrieval` | `cleo llmstxt bundle T766 --output /tmp/T766-ctx.txt --budget 40000` |

### 3.5 Validation / integrity

- On `cleo attach`, compute `llmtxt.hashContent(bytes)` → `sha256`. Store the file at `.cleo/attachments/sha256/<hash[0..2]>/<hash[2..]>.<ext>`.
- On `cleo attachments fetch`, re-hash the stored bytes; if mismatch, return `E_ATTACHMENT_CORRUPT` with the expected vs actual hash.
- For `local-file` kind, on every fetch also hash the source path and emit a warning if it has drifted from the stored `sha256` (file was edited since attach).
- For `url` kind with `--cache`, respect HTTP ETag / Last-Modified on re-cache. Store multiple cached versions? — **No** (YAGNI). Overwrite with newest and update `cachedAt`.

---

## 4. Integration Points

### 4.1 Programmatic gates (T763)

The programmatic gate spec (separate deliverable) defines `Gate` entries as small typed objects. An attachment-backed gate:

```ts
// From T763's Gate contract
type Gate =
  | { kind: 'attachment'; attachmentId: string; hash: string; required: true }
  | { kind: 'attachment-label'; label: string; minCount: number };

// Example: task gate requiring "an RFC attachment labelled rfc must exist"
{
  kind: 'attachment-label',
  label: 'rfc',
  minCount: 1
}

// Example: release gate requiring a specific signed manifest
{
  kind: 'attachment',
  attachmentId: 'att_releaseManifest',
  hash: '3a7b9c...0e',
  required: true
}
```

`cleo verify T766` walks the gate list; each `attachment` gate resolves the stored sha256 via `attachments/index.db` and checks hash equality.

### 4.2 BRAIN integration

Extend `BrainObservation` and `BrainDecision` with `attachments: Attachment[]` (denormalised from `attachment_refs`). Research observations now carry their source documents:

```bash
cleo observe "Reviewed llmtxt-core v2026.4.5 README; confirms SHA-256 + zlib + HMAC primitives" \
  --type observation \
  --title "T766 llmtxt-core audit" \
  --attach att_llmtxtCoreReadme \
  --attach att_T766proposal
```

On retrieval:

```bash
cleo memory fetch O-abc123
# Returns JSON with attachments[], each carrying id + sha256 + fetch command
```

### 4.3 LOOM / spawner integration

Extend `SpawnContext` in `packages/contracts/src/spawn.ts`:

```ts
export interface SpawnContext {
  taskId: string;
  prompt: string;
  workingDirectory?: string;
  /** Attachments bundled into the subagent's context. Spawner materialises these into a `/tmp/cleo-spawn-<taskId>/` working copy. */
  attachments?: Attachment[];
  /** If true, spawner emits `llms-ctx-full.txt` at the working dir root combining prompt + attachments. */
  emitLlmsCtxBundle?: boolean;
  options?: Record<string, unknown>;
}
```

Spawner behaviour: on spawn, materialise `local-file` and `blob` attachments into `<workingDirectory>/attachments/<label-or-filename>`. Emit `llms-ctx-full.txt` combining the prompt and all attachment bodies (respecting a configurable token budget). Subagent receives a single path token `{{CONTEXT_BUNDLE}}` instead of manually reading 7 files.

### 4.4 CONDUIT messaging integration

The existing `conduit.db attachments` / `attachment_versions` / `attachment_approvals` tables become the **SQLite backing store for `llmtxt-doc` kind attachments specifically**. We do NOT build a parallel attachment system in CONDUIT — we reuse what is there, through llmtxt's LocalBackend, and surface it via the unified `Attachment` contract.

Concrete mapping:
- `conduit.db.attachments.slug` ↔ `Attachment.id` when kind is `llmtxt-doc` and backend is `local`.
- `conduit.db.attachment_versions` is internally consulted when `cleo attachments show` renders version history for an `llmtxt-doc`.
- `conduit.db.attachment_approvals` exposed via `cleo attachments approve <attachmentId> --agent <id>` (deferred — phase 3).

This is the single biggest unlock: the CONDUIT attachment schema stops being dead weight and starts doing work the moment `cleo attach` exists.

### 4.5 llms.txt for CLEO-managed projects

`cleo init` optionally scaffolds a `llms.txt` at the project root:

```markdown
# Cleocode

> LLM-first task management and agent orchestration platform. CalVer-versioned monorepo (TypeScript + Rust).

- [AGENTS.md](./AGENTS.md): project-level agent injection contract
- [docs/CLEOOS-VISION.md](./docs/CLEOOS-VISION.md): platform vision
- [docs/CLEO-ULTRAPLAN.md](./docs/CLEO-ULTRAPLAN.md): 21-section ultraplan

## Tasks & Epics

- [Active epics](./.cleo/memory-bridge.md): current working context
- [Open bugs](./.cleo/memory-bridge.md#observations): recent bugs

## Architecture Decisions

- [ADR index](./.cleo/adrs/): 39 ADRs as of 2026-04

## Optional

- [Test coverage](./.cleo/metrics/TOKEN_USAGE.jsonl): ~500 test files, 7275 passing
```

This file is regenerated on `cleo session end` alongside the memory bridge.

---

## 5. Decision: adopt llmtxt-core + llmtxt? 

**ADOPT.**

Reasoning with honest trade-offs:

| Option | Outcome |
|---|---|
| **A. Adopt llmtxt (npm) as dependency** (CHOSEN) | Ship in v2026.4.66+. Fast: ~2-3 weeks for attachment contract + CLI + junction table + LOOM wiring. Own-source, same-author, MIT, already used in-family. Risk: one more versioned dep in the release flow. |
| B. Wrap just the llmtxt-core crate directly via WASM | Same net functionality as (A) but we reimplement `LocalBackend` + collaborative doc lifecycle + CLI. 3× more engineering for zero added value — we'd be shadowing the npm package the owner already shipped. Reject. |
| C. Build in-house (no dep) | Means implementing SHA-256 + zlib + unified-diff + signed URL + HMAC + progressive disclosure ourselves. SHA-256 and zlib are trivial (Node builtins). Patch + progressive disclosure + similarity are not — ~3 months of engineering to match what llmtxt already does. Reject unless avoiding the dep is an owner constraint. |
| D. Skip (stay with status quo) | Four disconnected attachment-shaped surfaces persist. `task.files` stays a bare string array. CONDUIT attachments schema remains unused. Subagents keep receiving raw path strings. Reject — epic T760 owner directive says this is a flagship deliverable. |

**Why A beats B**: the npm package already builds the WASM, ships type declarations, exposes `LocalBackend` with Drizzle migrations that match our Drizzle beta, and implements the collaborative lifecycle the Rust crate alone does not. We consume it. Full stop.

**Phased roll-out**:

1. **Phase 1 (v2026.4.66 candidate)**: add `@cleocode/contracts` `Attachment` types. Add `.cleo/attachments/` storage with SQLite index + content-addressed blobs. Ship `cleo attach <task> <file>`, `cleo attachments list|show|fetch|detach`. Wire `lifecycle_evidence.linkProvenance()` to also insert an `attachment_refs` row with `targetType='stage'`. Ship tests.

2. **Phase 2 (v2026.4.67)**: add `--url` and `--blob` kinds. Wire `cleo attach` to extend `BrainObservation.attachments`. Add `llmtxt-doc` kind + `--llmtxt-doc` flag; depend on `llmtxt` npm. Extend `SpawnContext` and LOOM to materialise attachments into subagent working dir. Add `cleo llmstxt generate --root .`.

3. **Phase 3 (v2026.4.68)**: add `cleo llmstxt bundle <taskId>` with token budget via `llmtxt.planRetrieval`. Wire CONDUIT `attachment_versions` / `attachment_approvals` to `cleo attachments versions <id>` / `cleo attachments approve <id>`. Ship `cleo attachments gc`.

4. **Phase 4 (v2026.4.69)**: integrate T763 programmatic gates with `attachment` and `attachment-label` kinds. Document in CLEO-ULTRAPLAN §N.

---

## 6. Open questions for owner

1. **Blob storage location** — `.cleo/attachments/` inside the project, or `.cleo/` sibling to `tasks.db`? Proposal: `.cleo/attachments/` (in-project, copied on worktree via git if committed, otherwise ignored per existing `.cleo/` gitignore rules). **Not committed by default** — matches existing policy for tasks.db / brain.db.

2. **Max attachment size** — 50 MB soft cap? Larger goes to llmtxt.my remote mode via signed URL, never stored locally. Proposal: 50 MB default, configurable via `config.json:attachments.maxLocalSize`.

3. **GC policy** — never auto; `cleo attachments gc --dry-run` → explicit `cleo attachments gc --apply`. Matches owner's consistent preference for no-surprise destructive operations.

4. **Mime detection** — `file` command fallback, or embed a MIME database? Proposal: `mime-types` npm package (5 KB, well-maintained).

5. **Registered-account llmtxt.my remote features** — The SaaS SITREP flagged that `POST /documents/:slug/transition` / `approve` / signed-URLs require a registered account. For Phase 3, do we require owner to have an llmtxt.my account, or skip remote backend until anonymous lifecycle support lands? Proposal: Phase 3 ships `llmtxt-doc backend='local'` only (embedded, no network); remote backend deferred until llmtxt.my anonymous lifecycle support lands per Issue 4 of the SITREP.

---

## 7. Out of scope (deferred)

- Binary diffing of non-text attachments (PDF, PNG). Use content-addressed replace only; versioning is opaque for binary.
- Encryption at rest. Current threat model assumes the developer's filesystem is trusted.
- Remote-first mode (default attachments to llmtxt.my). Keep default local; user opts in.
- CRDT-based concurrent edit reconciliation. llmtxt supports `yrs`/Yjs via feature flag; not exercised here.

---

## 8. Summary tables

### 8.1 Attachment kinds (5)

| Kind | Purpose | Storage | Example |
|---|---|---|---|
| `local-file` | Point at a file that must exist at a path | Path + hash in index | `./docs/rfc-003.md` |
| `url` | Point at a remote URL, optionally cached | URL + optional cached blob | `https://llmstxt.org` |
| `blob` | Store raw bytes content-addressed | Blob in `.cleo/attachments/sha256/…` | `stdin → cat report.pdf` |
| `llms-txt` | An llms.txt snapshot (site index) | Inline text content | Generated `llms.txt` for a project |
| `llmtxt-doc` | Pointer to an llmtxt document (versioned) | Delegated to llmtxt LocalBackend or remote | Slug `9fZLOnf5` on llmtxt.my |

### 8.2 CLI subcommands introduced (11)

- `cleo attach`
- `cleo attachments list`
- `cleo attachments show`
- `cleo attachments fetch`
- `cleo attachments search`
- `cleo attachments detach`
- `cleo attachments gc`
- `cleo attachments approve` (phase 3)
- `cleo attachments versions` (phase 3)
- `cleo llmstxt generate`
- `cleo llmstxt bundle`

### 8.3 Schema additions (2 new tables + 5 field extensions)

- New: `attachments` (`.cleo/attachments/index.db`)
- New: `attachment_refs` (`.cleo/attachments/index.db`)
- Extend: `Task` contract → `attachments?: Attachment[]` (populated on read via join)
- Extend: `BrainObservation`, `BrainDecision` → `attachments?: Attachment[]`
- Extend: `ConduitMessage` → `attachments?: Attachment[]`
- Extend: `SpawnContext` → `attachments?: Attachment[]` + `emitLlmsCtxBundle?: boolean`
- Reuse: `lifecycle_evidence` (kept, augmented to insert into `attachment_refs` on write)

---

## 9. References

- llmtxt-core README 2026.4.5: https://crates.io/crates/llmtxt-core (fetched 2026-04-16)
- llmtxt npm 2026.4.5 registry metadata (fetched 2026-04-16)
- llms.txt spec: https://llmstxt.org (fetched 2026-04-16)
- CLEO prior art:
  - `.cleo/agent-outputs/llmtxt-my-sitrep-2026-04-11.md` — SaaS multi-agent benchmark
  - `packages/core/src/lifecycle/evidence.ts:22-92` — existing `EvidenceRecord` + `linkProvenance`
  - `packages/core/src/store/conduit-sqlite.ts:188-260` — unused attachment tables
  - `packages/contracts/src/task.ts:170` — `files?: string[]` — the primitive we're replacing
  - `crates/signaldock-storage/src/migrations/sqlite/0018_attachment_versioning.sql` — full Rust-side attachment versioning
- Memory context:
  - `/home/keatonhoskins/.claude/projects/-mnt-projects-cleocode/memory/conduit-layered-stack.md` — "conduit.db tables: … attachments, attachment_versions"
  - `/home/keatonhoskins/.claude/projects/-mnt-projects-cleocode/memory/feedback_drizzle_v1.md` — use drizzle-orm 1.0.0-beta (llmtxt aligns)
- Pomodoro benchmark `SUPREME_REPORT.md` §7 recommendation: "Persistent research phase artifact — CLEO has `cleo memory find --type pattern` but there's no task-scoped research note: you can find patterns, but you can't attach a 'pre-build research summary' directly to an epic." — This proposal directly closes that gap.
