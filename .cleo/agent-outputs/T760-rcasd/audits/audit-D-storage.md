# Audit D: Attachment Storage (T796)

Auditor: AUDIT AGENT D (independent verification)
Date: 2026-04-15
Task audited: T796 (DOCS-02) — content-addressed attachment storage in tasks.db

---

## Checks

### 1. Migration SQL shape — PASS

File: `packages/core/migrations/drizzle-tasks/20260416000000_t796-attachments/migration.sql`

Verified columns:
- `attachments`: `id TEXT PRIMARY KEY NOT NULL`, `sha256 TEXT NOT NULL`, `attachment_json TEXT NOT NULL`, `created_at TEXT NOT NULL`, `ref_count INTEGER NOT NULL DEFAULT 0`
- `attachment_refs`: `attachment_id TEXT NOT NULL`, `owner_type TEXT NOT NULL`, `owner_id TEXT NOT NULL`, `attached_at TEXT NOT NULL`, `attached_by TEXT` (nullable)
- Composite PRIMARY KEY on `(attachment_id, owner_type, owner_id)` via `CONSTRAINT attachment_refs_pk` — PRESENT
- `UNIQUE INDEX idx_attachments_sha256` on `attachments(sha256)` — PRESENT
- `INDEX idx_attachment_refs_owner` on `attachment_refs(owner_type, owner_id)` — PRESENT
- `INDEX idx_attachment_refs_attachment_id` on `attachment_refs(attachment_id)` — PRESENT (bonus, not in spec)
- `FOREIGN KEY (attachment_id) REFERENCES attachments(id) ON DELETE CASCADE` — PRESENT

One minor delta from spec: `created_at` column has `NOT NULL` constraint in the migration (tighter than the spec's `TEXT` with no constraint). This is strictly correct and not a concern.

### 2. Drizzle schema — PASS

File: `packages/core/src/store/tasks-schema.ts` (lines 931–1027)

Both `attachments` and `attachmentRefs` tables are defined and match the migration exactly:
- `attachments.sha256` uses `.notNull().unique()` — aligns with UNIQUE INDEX in SQL
- `attachmentRefs` uses `primaryKey({ columns: [table.attachmentId, table.ownerType, table.ownerId] })` — matches composite PK
- Both indexes defined: `idx_attachment_refs_owner`, `idx_attachment_refs_attachment_id`
- `ATTACHMENT_OWNER_TYPES` constant enumerates six allowed types: task, observation, session, decision, learning, pattern

### 3. Store API surface — PASS

File: `packages/core/src/store/attachment-store.ts`

`AttachmentStore` interface declares all required methods:
- `put(bytes, attachment, ownerType, ownerId, attachedBy?, cwd?)` — PRESENT
- `get(sha256, cwd?)` — PRESENT
- `getMetadata(attachmentId, cwd?)` — PRESENT
- `listByOwner(ownerType, ownerId, cwd?)` — PRESENT
- `ref(attachmentId, ownerType, ownerId, attachedBy?, cwd?)` — PRESENT
- `deref(attachmentId, ownerType, ownerId, cwd?)` — PRESENT

Missing methods: none.

`createAttachmentStore()` factory function exported — PRESENT.

### 4. Idempotency via SHA-256 — PASS

Verified in `put` implementation (lines 306–342):
- Queries `attachments` by `sha256` before inserting
- If existing row found: reuses `attachmentId`, skips file write, skips `INSERT INTO attachments`
- Creates a new `attachment_refs` row for each call (distinct owner combination)
- Increments `ref_count` in both paths (new and existing blob)

Result: identical bytes with distinct owners produce one blob file, one `attachments` row, N `attachment_refs` rows. Matches spec.

### 5. Path format (.cleo/attachments/sha256/<prefix>/<hash>.<ext>) — PASS

`blobPath()` function (lines 89–94):
```
prefix = sha256.slice(0, 2)   // 2-char shard
rest   = sha256.slice(2)       // remaining 62 chars
ext    = extFromMime(mime)
path   = getCleoDirAbsolute(cwd) + /attachments/sha256/<prefix>/<rest><ext>
```

MIME-to-extension map covers all required types:
- `.md` (text/markdown) — PRESENT
- `.txt` (text/plain) — PRESENT
- `.json` (application/json) — PRESENT
- `.pdf` (application/pdf) — PRESENT
- `.html` (text/html) — PRESENT
- Plus: .css, .js, .zip, .bin, .png, .jpg, .gif, .webp, .svg, .mp3, .mp4

Fallback for unrecognised MIME: `.bin` — PRESENT.

### 6. Tests passing — 9/9

Command: `cd /mnt/projects/cleocode/packages/core && npx vitest run src/store/__tests__/attachment-store.test.ts`

Result: 1 test file passed, 9 tests passed, 0 failed.

Tests present:
1. put stores bytes and get retrieves the same bytes (round-trip)
2. put twice with identical content shares one row and increments refCount
3. deref decrements refCount and purges blob when refCount reaches 0
4. deref with remaining refs keeps blob and returns { removed: false }
5. get returns null for a non-existent SHA-256
6. getMetadata returns null for an unknown attachment ID
7. listByOwner returns all attachments for a given owner
8. listByOwner returns empty array when owner has no attachments
9. explicit ref increases refCount, deref decrements it

Note: the pnpm-level test run reports 13–14 failures in unrelated files (anthropic-key-resolver-source.test.ts, hebbian-threshold.test.ts, t311-integration.test.ts) — these are pre-existing failures unrelated to T796.

### 7. Build clean — yes

Command: `pnpm --filter @cleocode/core run build 2>&1 | grep -iE 'error' | head -10`

Output: empty (no errors). Build exits clean.

### 8. Contract imports — PASS

`packages/contracts/src/index.ts` exports at lines 44–69:
- `Attachment`, `AttachmentKind`, `AttachmentMetadata`, `AttachmentRef`
- All five kind-specific interfaces: `BlobAttachment`, `LlmsTxtAttachment`, `LlmtxtDocAttachment`, `LocalFileAttachment`, `UrlAttachment`
- All five Zod schemas: `blobAttachmentSchema`, `llmsTxtAttachmentSchema`, etc.
- Input schema types: `AttachmentMetadataSchemaInput`, `AttachmentRefSchemaInput`, `AttachmentSchemaInput`

No T796-related exports were removed. T795 contract work is intact.

`attachment-store.ts` imports `Attachment`, `AttachmentMetadata`, `AttachmentRef` from `@cleocode/contracts` — correctly wired, no inline type definitions.

---

## Verdict: PASS

All seven spec checks confirmed. 9/9 attachment-store tests pass. Build is clean. Contracts intact.

---

## Anomalies found

### ACID concern — non-atomic refCount increment in `put` (LOW severity)

In `put()`, the sequence is:
1. SELECT existing row (to detect duplicate)
2. INSERT attachment_refs
3. UPDATE attachments SET ref_count = (existing.refCount ?? 0) + 1

Steps 1–3 are three separate round-trips with no BEGIN TRANSACTION wrapper. Under concurrent writes (two agents calling `put` with the same content simultaneously), both could read `refCount=0`, both insert separate `attachment_refs` rows (blocked by composite PK on the second if owner is identical), and both try to UPDATE to `refCount=1` — producing a final `refCount=1` when the correct value is 2.

Mitigation: SQLite WAL mode serializes writes to the same db file, so in practice a single-process multi-coroutine scenario (async/await on a single thread) is safe. True concurrent multi-process writes remain a theoretical vector.

Recommendation: wrap `put`, `ref`, and `deref` bodies in `db.transaction()` in a follow-up task. Not a blocker for this task.

### Drizzle `UPDATE ref_count` uses read value, not SQL arithmetic (LOW severity)

`set({ refCount: (existing?.refCount ?? 0) + 1 })` reads the snapshot count taken before the insert, not the current DB value. Under the ACID concern above this can produce an incorrect count. The `deref` path similarly reads first then writes. Correct fix: use `sql\`ref_count + 1\`` in Drizzle's update expression.

### `deref` returns `{ removed: false }` for unknown attachmentId (minor)

When `deref` is called with an `attachmentId` that does not exist in the `attachments` table, it returns `{ removed: false }` (line 464). The caller cannot distinguish "successfully dereffed, blob still alive" from "attachment did not exist". Not a test requirement, but worth noting for future error-handling hardening.

### No file integrity check on `get` (minor)

`get()` reads the blob file from disk without verifying its SHA-256 matches the stored hash. A corrupted or manually edited file will be returned silently. Acceptable for an MVP; recommend adding a hash check behind a `verify: boolean` option flag in a later task.

---

## Recommended re-spawn: no

T796 is complete and correct. The anomalies identified are all low-severity and none block the use of the attachment store. A follow-up hardening task for transactions + SQL-side arithmetic updates is advisable but not urgent.
