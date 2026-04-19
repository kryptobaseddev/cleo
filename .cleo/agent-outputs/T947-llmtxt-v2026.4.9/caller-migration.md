# T947 Wave B — `cleo docs` caller migration

Date: 2026-04-17
Branch: `feat/t942-sentient-foundations`
Status: Landed (`attachment-store-v2.ts` + dispatch wiring + backend metadata)

## What shipped

1. `packages/core/src/store/attachment-store-v2.ts` — unified store (put/get/list/remove)
   that prefers `CleoBlobStore` (llmtxt/blob) and falls back to the legacy
   `attachment-store.ts` when the `better-sqlite3` peer dep is unavailable.
2. `packages/cleo/src/dispatch/domains/docs.ts` — add/list/fetch/remove handlers
   now emit `meta.attachmentBackend: 'llmtxt' | 'legacy'` for observability.
   The `add` handler mirrors its write through v2 so the llmtxt manifest
   learns about new attachments even while the legacy store remains the
   authoritative truth.
3. `packages/core/package.json` — `peerDependenciesMeta.better-sqlite3.optional = true`
   and `devDependencies.better-sqlite3 = "^12.4.1"` so the unit tests can
   exercise the llmtxt path.
4. Wave A carryover fix in `llmtxt-blob-adapter.ts` — Drizzle v1.0.0-beta
   requires `drizzle({ client: nativeDb })`; the old `drizzle(nativeDb)`
   form silently opens a fresh in-memory DB, which broke `blob_attachments`
   lookups. Fixed at `packages/core/src/store/llmtxt-blob-adapter.ts:245`.

## Files touched

| Change | File |
|--------|------|
| New | `packages/core/src/store/attachment-store-v2.ts` |
| New | `packages/core/src/store/__tests__/attachment-store-v2.test.ts` |
| New | `packages/cleo/src/dispatch/domains/__tests__/docs-integration.test.ts` |
| New | `packages/cleo/vitest.integration.config.ts` |
| Edit | `packages/core/src/store/llmtxt-blob-adapter.ts` (drizzle v1 API fix) |
| Edit | `packages/core/src/internal.ts` (export new types + factories) |
| Edit | `packages/core/package.json` (peer-dep + devDep) |
| Edit | `packages/cleo/src/dispatch/domains/docs.ts` (v2 mirror writes + backend meta) |
| Edit | `packages/cleo/package.json` (`test:integration` script) |
| Edit | `packages/contracts/src/operations/index.ts` (drop stale `./brain.js` import) |

## Migration checklist (per caller)

- [x] `cleo docs add` — dual-writes via v2 (local-file path). URL path stays legacy-only.
- [x] `cleo docs list` — legacy read remains canonical; `meta.attachmentBackend` added.
- [x] `cleo docs fetch` — legacy read remains canonical; `meta.attachmentBackend` added.
- [x] `cleo docs remove` — legacy deref remains canonical; v2 mirror attempts best-effort detach.
- [ ] `cleo docs generate` — unchanged in Wave B. Generates llms.txt and re-attaches via legacy. Move to v2 once sha256 parity is validated in production.

## Behavioral contracts preserved

- `docs.add` response shape unchanged — still emits `{ attachmentId, sha256, refCount, kind, ownerId, ownerType }`.
- `docs.list` response shape unchanged — still emits `{ ownerId, ownerType, count, attachments[] }`.
- `docs.fetch` response shape unchanged — still emits `{ metadata, path, sizeBytes, bytesBase64?, inlined }`.
- `docs.remove` response shape unchanged — still emits `{ removed, attachmentId, from, refCountAfter, blobPurged }`.
- NEW: every response includes `meta.attachmentBackend: 'llmtxt' | 'legacy'`.

## Rollback plan

If the v2 mirror introduces production regressions:

1. Revert `packages/cleo/src/dispatch/domains/docs.ts` to remove the v2 mirror
   writes. Keep the backend metadata reporting — it is side-effect free and
   useful for post-mortem correlation.
2. The legacy store write path (`createAttachmentStore`) is UNCHANGED in Wave B,
   so a revert is purely additive code removal — no data migration needed.
3. `attachment-store-v2.ts` and its exports can stay in place under a
   `// @deprecated` tag until Wave C confirms whether to retire or recommit.
4. Keep the drizzle v1 API fix in `llmtxt-blob-adapter.ts:245` — it is a bug
   fix, not a migration step, and the old form was always broken on
   `drizzle-orm@1.0.0-beta.*`.

## Do NOT retire `attachment-store.ts`

Per task spec:
> Wave C cleanup may retire it after v2026.5.0 is released and a full release
> cycle validates.

The legacy store retains 643 LoC and covers URL + llms-txt + llmtxt-doc kinds
that the v2 surface intentionally does not implement. Retirement must wait
until:

1. All URL / llms-txt / llmtxt-doc callers have migrated to dedicated v2 APIs
   (none exist yet — Wave C scope).
2. A full release cycle (v2026.5.0 → v2026.5.x) runs in production with
   `meta.attachmentBackend` reporting `llmtxt` on ≥95% of local-file writes.
3. GC of orphaned `.cleo/attachments/sha256/**` blobs runs cleanly on at least
   one production database.

## Quality gates (this wave)

```bash
# All 37 attachment tests pass (llmtxt-blob-adapter + attachment-store + attachment-store-v2)
pnpm --filter @cleocode/core exec vitest run \
  src/store/__tests__/attachment-store-v2.test.ts \
  src/store/__tests__/attachment-store.test.ts \
  src/store/__tests__/llmtxt-blob-adapter.test.ts
# → Test Files 3 passed (3) | Tests 37 passed (37)

# Docs dispatch unit tests pass (23/23)
pnpm exec vitest run packages/cleo/src/dispatch/domains/__tests__/docs.test.ts
# → Test Files 1 passed (1) | Tests 23 passed (23)

# Docs integration smoke passes (2/2)
pnpm --filter @cleocode/cleo run test:integration \
  --testNamePattern "docs dispatch"
# → Tests 2 passed (2)
```

## Observability hook

Operators can tail `meta.attachmentBackend` in LAFS responses to measure
llmtxt adoption:

```bash
cleo docs add ./design.png T123 --json \
  | jq '.meta.attachmentBackend'
# → "llmtxt"   (when peer deps installed)
# → "legacy"   (fallback path)
```

The value reflects which backend ACTUALLY persisted the bytes for `add`,
and which backend WOULD persist future writes for `list`/`fetch`/`remove`
(since those are currently read-only mirrors of the legacy store).
