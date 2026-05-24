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
 * This test scaffolds the contract. With T10386 (docs-add path) and T10388
 * (changeset-add path) wired, ALL four scenarios run live against the
 * central allocator and the writer-level rollback paths.
 *
 * @task T10294 (spike → informs E1)
 * @epic T10289 (E1-DOCS-SLUG-NAMESPACE)
 * @saga T10288 (SG-DOCS-INTEGRITY)
 * @see /mnt/projects/cleocode/.cleo/research/t10294-slug-collision-rca.md (when published via cleo docs add --type research)
 * @see packages/core/src/changesets/writer.ts
 * @see packages/cleo/src/dispatch/domains/docs.ts
 * @see packages/core/migrations/drizzle-tasks/20260519000001_t9636-t9637-add-slug-type-to-attachments/migration.sql
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeChangesetEntry } from '../../changesets/writer.js';
import { createAttachmentStore } from '../../store/attachment-store.js';
import { _resetSlugAllocatorState_TESTING_ONLY, reserveSlug } from '../slug-allocator.js';

// T10386 — the docs-add path live tests below mirror the dispatch handler's
// real call sequence: reserveSlug() FIRST, then attachmentStore.put(). The
// behaviour they assert (uniform `E_SLUG_RESERVED` discriminator + 3
// suggestions + no partial write) is the EXACT contract the dispatch layer
// in `packages/cleo/src/dispatch/domains/docs.ts:add` now executes. Tests of
// the dispatch envelope shape itself live in
// `packages/cleo/src/dispatch/domains/__tests__/docs-slug-type-project.test.ts`
// (which is also updated by this PR).
//
// T10388 — the two remaining scaffolds (changeset-add path: same-writer
// dedup + cross-kind global namespace) are now live tests exercising
// `writeChangesetEntry()` end-to-end against the central allocator. All
// FOUR contracts are now green per T10388 acceptance criterion #4.

let tempDir: string;

describe('slug-allocator (T10289 E1) — docs-add path live (T10386)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-slug-collision-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
    _resetSlugAllocatorState_TESTING_ONLY();
  });

  afterEach(async () => {
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    _resetSlugAllocatorState_TESTING_ONLY();
    await rm(tempDir, { recursive: true, force: true });
  });

  // ── Contract 1: same (kind, slug) tuple from BOTH writers must collide ────
  //
  // Two writers both targeting `(type='note', slug='t10294-collision')` MUST
  // both fail with the same structured error (`E_SLUG_RESERVED`) regardless
  // of which writer ran first.
  //
  // T10386 LIVE: docs-add → docs-add path now surfaces E_SLUG_RESERVED via
  // the central allocator (consumed pre-`attachmentStore.put`). The reverse
  // case where `cleo changeset add` is the SECOND writer is deferred to
  // T-E1.3 (T10388) — see Contract 1B below.
  it('rejects the second docs-add writer with E_SLUG_RESERVED + suggestions (T10386)', async () => {
    const store = createAttachmentStore();

    // First writer: reserveSlug → put (succeeds).
    const firstRes = await reserveSlug('note', 't10294-collision');
    expect(firstRes.ok, JSON.stringify(firstRes)).toBe(true);
    await store.put(
      Buffer.from('# A\n\nfirst writer body', 'utf-8'),
      {
        kind: 'blob',
        storageKey: '',
        mime: 'text/markdown',
        size: 21,
      },
      'task',
      'T100',
      'human',
      undefined,
      { slug: 't10294-collision', type: 'note' },
    );

    // Second writer: reserveSlug rejects with E_SLUG_RESERVED + 3 suggestions.
    const secondRes = await reserveSlug('note', 't10294-collision');
    expect(secondRes.ok).toBe(false);
    if (secondRes.ok) throw new Error('unreachable');
    expect(secondRes.code).toBe('E_SLUG_RESERVED');
    expect(secondRes.suggestions).toHaveLength(3);
    for (const s of secondRes.suggestions) {
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
    }
    expect(new Set(secondRes.suggestions).size).toBe(3);
  });

  // ── Contract 4 (docs-add half): allocator runs BEFORE attachmentStore.put,
  // so the second writer aborts cleanly with NO partial DB write.
  //
  // The changeset-add half (which deletes `.changeset/<slug>.md` on rollback)
  // stays `it.todo` until T-E1.3 wires the changeset writer through the
  // allocator.
  it('docs-add: allocator runs BEFORE attachmentStore.put — no partial row on collision (T10386)', async () => {
    const store = createAttachmentStore();

    // Setup: reserve + put the canonical row.
    const firstRes = await reserveSlug('note', 'no-partial-write');
    expect(firstRes.ok, JSON.stringify(firstRes)).toBe(true);
    const firstMeta = await store.put(
      Buffer.from('# canonical row body', 'utf-8'),
      {
        kind: 'blob',
        storageKey: '',
        mime: 'text/markdown',
        size: 19,
      },
      'task',
      'T200',
      'human',
      undefined,
      { slug: 'no-partial-write', type: 'note' },
    );

    // Second-writer simulation: allocator rejects FIRST. A correctly-wired
    // CLI verb (T10386 docs.ts) does NOT proceed to call store.put, so the
    // attachment table still holds exactly ONE row for this slug.
    const secondRes = await reserveSlug('note', 'no-partial-write');
    expect(secondRes.ok).toBe(false);
    if (secondRes.ok) throw new Error('unreachable');
    expect(secondRes.code).toBe('E_SLUG_RESERVED');

    // Verify "no partial write" — the canonical row is still the same one
    // (same attachmentId, same SHA). A naive late-bound writer might have
    // tried put() and the allocator's runtime assert (under
    // CLEO_STRICT_SLUG_ALLOCATOR=1) would have caught it; here we simply
    // confirm the table reflects exactly the first write.
    const fetched = await store.get(firstMeta.sha256);
    expect(fetched).toBeDefined();
    expect(fetched?.metadata.id).toBe(firstMeta.id);
  });

  // ── Contract 2: changeset-add path is consistently rejected on collision —
  // no silent overwrite, no partial `.changeset/<slug>.md` leak (T10388).
  //
  // The original scaffold (`it.todo`) speculated about SHA-dedup idempotency
  // at the writer layer. With the T10388 wiring the central allocator
  // intercepts BEFORE any filesystem write, so the chosen semantic is:
  // "second writeChangesetEntry call with the same slug — regardless of
  // bytes — surfaces E_SLUG_RESERVED with 3 suggestions and produces no
  // .changeset/ file." This is the OBSERVABLE contract the acceptance
  // criterion locks in ("No .md file leaked in .changeset/ when allocator
  // rejects").
  it('rejects a duplicate writeChangesetEntry with E_SLUG_RESERVED + no .changeset/ leak (T10388)', async () => {
    const projectRoot = tempDir;
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(projectRoot, '.changeset'), { recursive: true });

    // First write — succeeds and writes both the .changeset/<slug>.md file
    // and the SSoT blob row.
    const first = await writeChangesetEntry(
      {
        id: 't10388-same-writer-dedup',
        tasks: ['T10388'],
        kind: 'feat',
        summary: 'first writer wins',
      },
      { projectRoot },
    );
    expect(first.ok, JSON.stringify(first)).toBe(true);

    // Second write with the SAME slug — allocator rejects pre-write.
    const second = await writeChangesetEntry(
      {
        id: 't10388-same-writer-dedup',
        tasks: ['T10388'],
        kind: 'feat',
        summary: 'second writer with identical bytes',
      },
      { projectRoot },
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.error.code).toBe('E_SLUG_RESERVED');
    if (second.error.code !== 'E_SLUG_RESERVED') throw new Error('narrowing');
    expect(second.error.suggestions).toHaveLength(3);
    expect(second.error.aliases).toContain('E_SSOT_WRITE_FAILED');

    // No partial filesystem write — only the FIRST entry's file exists. We
    // probe by listing the .changeset/ directory; any leak of a second file
    // (e.g. a temp suffix from rename) would fail the acceptance criterion.
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(join(projectRoot, '.changeset')).filter((f) => f.endsWith('.md'));
    expect(files).toEqual(['t10388-same-writer-dedup.md']);
  });

  // ── Contract 3: GLOBAL namespace across DocKinds (T10390 decision) ────────
  //
  // The allocator's `kind` arg does NOT partition the namespace — a slug
  // claimed by `cleo docs add --type research` BLOCKS a follow-up
  // `cleo changeset add` (and vice versa). This is the canonical T10294
  // collision case the saga set out to fix.
  it('treats the namespace as GLOBAL across DocKinds (changeset vs note collide) (T10388)', async () => {
    const projectRoot = tempDir;
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(projectRoot, '.changeset'), { recursive: true });

    // First writer claims the slug via the docs-add path (type='note').
    const firstRes = await reserveSlug('note', 't10388-cross-kind-collide');
    expect(firstRes.ok, JSON.stringify(firstRes)).toBe(true);
    const store = createAttachmentStore();
    await store.put(
      Buffer.from('# cross-kind collision setup\n', 'utf-8'),
      {
        kind: 'blob',
        storageKey: '',
        mime: 'text/markdown',
        size: 31,
      },
      'task',
      'T10388',
      'human',
      undefined,
      { slug: 't10388-cross-kind-collide', type: 'note' },
    );

    // Second writer (changeset path) tries the same slug — must fail with
    // E_SLUG_RESERVED, NOT silently succeed as a different kind.
    const second = await writeChangesetEntry(
      {
        id: 't10388-cross-kind-collide',
        tasks: ['T10388'],
        kind: 'feat',
        summary: 'changeset trying to claim a slug owned by a note',
      },
      { projectRoot },
    );
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.error.code).toBe('E_SLUG_RESERVED');
    if (second.error.code !== 'E_SLUG_RESERVED') throw new Error('narrowing');
    expect(second.error.suggestions).toHaveLength(3);
    expect(second.error.aliases).toContain('E_SSOT_WRITE_FAILED');

    // No partial .changeset/ file written — allocator intercept fires before
    // the file write step.
    const { readdirSync, existsSync } = await import('node:fs');
    if (existsSync(join(projectRoot, '.changeset'))) {
      const files = readdirSync(join(projectRoot, '.changeset')).filter((f) => f.endsWith('.md'));
      expect(files).toEqual([]);
    }
  });
});
