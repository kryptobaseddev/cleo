/**
 * Slug-collision regression scaffold for Epic T10289 E1-DOCS-SLUG-NAMESPACE.
 *
 * Spike: T10294 (BUG: cleo changeset add slug collides with cleo docs add SSoT
 * slug — dual-write race).
 *
 * Today there are TWO writers that land bytes in the same `attachments` table
 * via two unrelated code paths:
 *
 *   1. `writeChangesetEntry()` — packages/core/src/changesets/writer.ts
 *      Renders a `---`-fenced markdown envelope for a {@link ChangesetEntry},
 *      then calls `attachmentStore.put(..., { slug, type: 'changeset' })`.
 *
 *   2. `dispatch docs/add` — packages/cleo/src/dispatch/domains/docs.ts
 *      Reads an arbitrary file's bytes, then calls the SAME
 *      `attachmentStore.put(..., { slug, type: '<user-supplied>' })`.
 *
 * Both paths share ONE slug namespace (the partial UNIQUE INDEX
 * `uniq_attachments_slug ON attachments(slug) WHERE slug IS NOT NULL`,
 * shipped by migration 20260519000001 for T9636/T9637). There is NO central
 * allocator; the SDK enforces uniqueness late, INSIDE store.put. The bytes
 * are different (rendered changeset markdown vs. user-supplied file bytes)
 * so the SHA pre-check does not coalesce them — the second writer always
 * loses.
 *
 * The collision IS detected today via {@link SlugCollisionError}, but each
 * writer renders that error differently:
 *
 *   - `cleo docs add` → LAFS `E_SLUG_TAKEN` with `details.suggestions`
 *     (good — operator can pick an alternative).
 *
 *   - `cleo changeset add` → LAFS `E_SSOT_WRITE_FAILED` (bad — the structured
 *     error code is lost in the generic catch in writer.ts:276-292, so the
 *     operator only sees "Slug '<x>' is already in use" as a generic message
 *     with no suggestions).
 *
 * The agreed remediation under Epic T10289 introduces a central slug
 * allocator (`packages/core/src/docs/slug-allocator.ts`) that BOTH writers
 * consult before doing any other work. The allocator's contract is:
 *
 *   - `reserve(kind, slug)` → returns OK or `E_SLUG_RESERVED` with
 *     suggestions
 *   - Atomically reserves the (kind, slug) tuple under a single chokepoint
 *   - Either rejects (a) consistently across every CLI verb that targets
 *     the same DocKind, OR (b) collapses the two writers entirely so only
 *     ONE code path can register a `changeset` slug
 *
 * This test scaffolds the contract. It is marked `it.todo` until the
 * allocator ships; once E1 lands, drop `.todo` and the test exercises the
 * canonical reservation path.
 *
 * @task T10294 (spike → informs E1)
 * @epic T10289 (E1-DOCS-SLUG-NAMESPACE)
 * @saga T10288 (SG-DOCS-INTEGRITY)
 * @see /mnt/projects/cleocode/.cleo/research/t10294-slug-collision-rca.md (when published via cleo docs add --type research)
 * @see packages/core/src/changesets/writer.ts
 * @see packages/cleo/src/dispatch/domains/docs.ts
 * @see packages/core/migrations/drizzle-tasks/20260519000001_t9636-t9637-add-slug-type-to-attachments/migration.sql
 */

import { describe, it } from 'vitest';

describe('slug-allocator (T10289 E1) — contract scaffold for two-writer race', () => {
  // ── Contract 1: same (kind, slug) tuple from BOTH writers must collide ────
  //
  // Two writers both targeting `(type='changeset', slug='t10294-collision')`
  // with DIFFERENT bytes MUST both fail with the same structured error
  // (`E_SLUG_RESERVED`) — regardless of which writer ran first.
  //
  // Status today (verified via /tmp/T10294-repro-K4Cr scratch project):
  //   - changeset add → docs add  : docs add raises E_SLUG_TAKEN (good)
  //   - docs add      → changeset : changeset raises E_SSOT_WRITE_FAILED (bad)
  //
  // After E1: BOTH paths route through the allocator and surface
  // E_SLUG_RESERVED + alternatives.
  it.todo(
    'rejects the second writer with E_SLUG_RESERVED + suggestions, regardless of writer order',
  );

  // ── Contract 2: idempotent re-reservation by the same writer + same bytes ─
  //
  // Calling `reserve('changeset', 't10294-foo')` twice from the SAME writer
  // with the SAME bytes MUST be a no-op (existing sha256 dedup behaviour
  // preserved). Only DIFFERENT bytes or DIFFERENT writers trigger the
  // collision error.
  it.todo('treats same-writer same-bytes re-reservation as idempotent (sha256 dedup)');

  // ── Contract 3: kind-scoped uniqueness vs. global uniqueness ──────────────
  //
  // Decision required in E1: do we keep one global slug namespace (current
  // schema) or migrate to a `(kind, slug)` composite uniqueness? Today every
  // DocKind shares one namespace, so `(type='spec', slug='foo')` collides
  // with `(type='changeset', slug='foo')` — even though they would never
  // share a publishDir. The allocator's API can hide this behind a kind-aware
  // facade so E1 can choose either backing without breaking callers.
  it.todo(
    'separates namespaces per DocKind OR exposes a clean error when kinds collide on the same slug',
  );

  // ── Contract 4: rollback semantics on the file-mirror side ────────────────
  //
  // `writeChangesetEntry` writes `.changeset/<slug>.md` FIRST (file mirror),
  // then calls `attachmentStore.put` (SSoT). On collision today the file is
  // removed via rmSync in the catch block (writer.ts:280-283), but the error
  // code returned to the caller is `E_SSOT_WRITE_FAILED` — the operator
  // cannot tell whether the failure was a slug collision or a transient DB
  // error. The allocator should be queried BEFORE the file write so a
  // collision aborts cleanly with no fs side-effects to roll back.
  it.todo('reserves slug BEFORE the file mirror is touched, eliminating rollback paths');
});
