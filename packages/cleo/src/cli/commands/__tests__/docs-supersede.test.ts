/**
 * Integration test for `cleo docs supersede <oldSlug> <newSlug>` (T10162).
 *
 * Exercises the full vertical stack — dispatch handler → core
 * {@link supersedeDoc} → SQLite transaction → schema invariants — against a
 * real tasks.db backed by a temp project dir. The CLI subcommand itself is a
 * thin wrapper over `dispatchFromCli` (no business logic), so asserting the
 * dispatch behaviour is the right unit boundary: the CLI cannot diverge from
 * what the dispatch handler accepts.
 *
 * @task T10162
 * @epic T10157 — C-DOCS-SSOT
 * @saga T9855 — SG-TEMPLATE-CONFIG-SSOT
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocsHandler } from '../../../dispatch/domains/docs.js';

/** Shape of `attachments` rows we inspect during the supersede assertions. */
interface AttachmentSupersedeRow {
  id: string;
  slug: string | null;
  lifecycle_status: string;
  supersedes: string | null;
  superseded_by: string | null;
}

/** Shape of the `docs.supersede` success envelope payload. */
interface SupersedeData {
  oldSlug: string;
  newSlug: string;
  oldAttachmentId: string;
  newAttachmentId: string;
  supersededAt: string;
  edgeId: string;
  reason?: string;
}

let tempDir: string;
let fixtureOld: string;
let fixtureNew: string;

/**
 * Seed two docs via the live `docs.add` mutate path so the supersede
 * transaction operates on real, slug-addressable rows.
 */
async function seedTwoDocs(
  handler: DocsHandler,
  slugs: { oldSlug: string; newSlug: string },
): Promise<{ oldId: string; newId: string }> {
  const addOld = await handler.mutate('add', {
    ownerId: 'T100',
    file: fixtureOld,
    slug: slugs.oldSlug,
    type: 'note',
    attachedBy: 'supersede-test',
  });
  expect(addOld.success, JSON.stringify(addOld)).toBe(true);
  const oldData = addOld.data as { attachmentId: string };

  const addNew = await handler.mutate('add', {
    ownerId: 'T100',
    file: fixtureNew,
    slug: slugs.newSlug,
    type: 'note',
    attachedBy: 'supersede-test',
  });
  expect(addNew.success, JSON.stringify(addNew)).toBe(true);
  const newData = addNew.data as { attachmentId: string };

  return { oldId: oldData.attachmentId, newId: newData.attachmentId };
}

/**
 * Read an `attachments` row by slug using the canonical chokepoint.
 * Returns `undefined` when the slug does not resolve.
 */
async function readBySlug(slug: string): Promise<AttachmentSupersedeRow | undefined> {
  const { openCleoDb } = await import('@cleocode/core/internal');
  const handle = await openCleoDb('project');
  try {
    const db = handle.db as DatabaseSync;
    return db
      .prepare(
        'SELECT id, slug, lifecycle_status, supersedes, superseded_by FROM attachments WHERE slug = ?',
      )
      .get(slug) as AttachmentSupersedeRow | undefined;
  } finally {
    await handle.close();
  }
}

describe('docs.supersede (T10162) — atomic lifecycle flip + lineage edge', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-supersede-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');

    fixtureOld = join(tempDir, 'old.md');
    fixtureNew = join(tempDir, 'new.md');
    await writeFile(fixtureOld, '# old\n\nbody-of-the-older-doc', 'utf-8');
    await writeFile(fixtureNew, '# new\n\nbody-of-the-newer-doc', 'utf-8');

    const { _resetSlugAllocatorState_TESTING_ONLY } = await import('@cleocode/core/internal');
    _resetSlugAllocatorState_TESTING_ONLY();
  });

  afterEach(async () => {
    const { closeDb, _resetSlugAllocatorState_TESTING_ONLY } = await import(
      '@cleocode/core/internal'
    );
    closeDb();
    _resetSlugAllocatorState_TESTING_ONLY();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('flips lifecycle_status and links both rows atomically', async () => {
    const handler = new DocsHandler();
    const { oldId, newId } = await seedTwoDocs(handler, {
      oldSlug: 'note-old-001',
      newSlug: 'note-new-001',
    });

    const response = await handler.mutate('supersede', {
      oldSlug: 'note-old-001',
      newSlug: 'note-new-001',
      reason: 'cycle bump',
    });

    expect(response.success, JSON.stringify(response)).toBe(true);
    const data = response.data as SupersedeData;
    expect(data.oldSlug).toBe('note-old-001');
    expect(data.newSlug).toBe('note-new-001');
    expect(data.oldAttachmentId).toBe(oldId);
    expect(data.newAttachmentId).toBe(newId);
    expect(data.reason).toBe('cycle bump');
    expect(data.edgeId).toBe(`supersedes:${newId}->${oldId}`);
    expect(data.supersededAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Both rows reflect the supersession atomically.
    const oldRow = await readBySlug('note-old-001');
    const newRow = await readBySlug('note-new-001');
    expect(oldRow?.lifecycle_status).toBe('superseded');
    expect(oldRow?.superseded_by).toBe(newId);
    expect(oldRow?.supersedes).toBeNull();
    expect(newRow?.lifecycle_status).toBe('draft');
    expect(newRow?.supersedes).toBe(oldId);
    expect(newRow?.superseded_by).toBeNull();
  });

  it('returns E_NOT_FOUND when oldSlug does not resolve', async () => {
    const handler = new DocsHandler();
    // Seed only the new slug — old slug intentionally missing.
    await handler.mutate('add', {
      ownerId: 'T101',
      file: fixtureNew,
      slug: 'note-new-only',
      type: 'note',
      attachedBy: 'supersede-test',
    });

    const response = await handler.mutate('supersede', {
      oldSlug: 'does-not-exist',
      newSlug: 'note-new-only',
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_NOT_FOUND');
    expect(response.error?.message ?? '').toContain('does-not-exist');
  });

  it('returns E_NOT_FOUND when newSlug does not resolve', async () => {
    const handler = new DocsHandler();
    await handler.mutate('add', {
      ownerId: 'T102',
      file: fixtureOld,
      slug: 'note-old-only',
      type: 'note',
      attachedBy: 'supersede-test',
    });

    const response = await handler.mutate('supersede', {
      oldSlug: 'note-old-only',
      newSlug: 'does-not-exist',
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_NOT_FOUND');
    expect(response.error?.message ?? '').toContain('does-not-exist');
  });

  it('rejects with E_INVALID_INPUT when oldSlug === newSlug', async () => {
    const handler = new DocsHandler();
    await handler.mutate('add', {
      ownerId: 'T103',
      file: fixtureOld,
      slug: 'self-supersede',
      type: 'note',
      attachedBy: 'supersede-test',
    });

    const response = await handler.mutate('supersede', {
      oldSlug: 'self-supersede',
      newSlug: 'self-supersede',
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_INVALID_INPUT');
  });

  it('re-supersession overwrites the supersession pointer (latest-wins)', async () => {
    const handler = new DocsHandler();

    // Seed 3 docs: v1 (old), v2 (first successor), v3 (second successor).
    const fixtureV3 = join(tempDir, 'v3.md');
    await writeFile(fixtureV3, '# v3\n\nbody-of-the-third-doc', 'utf-8');

    await handler.mutate('add', {
      ownerId: 'T104',
      file: fixtureOld,
      slug: 'chain-v1',
      type: 'note',
      attachedBy: 'supersede-test',
    });
    const addV2 = await handler.mutate('add', {
      ownerId: 'T104',
      file: fixtureNew,
      slug: 'chain-v2',
      type: 'note',
      attachedBy: 'supersede-test',
    });
    const addV3 = await handler.mutate('add', {
      ownerId: 'T104',
      file: fixtureV3,
      slug: 'chain-v3',
      type: 'note',
      attachedBy: 'supersede-test',
    });
    const v2Id = (addV2.data as { attachmentId: string }).attachmentId;
    const v3Id = (addV3.data as { attachmentId: string }).attachmentId;

    // First supersession: v1 → v2.
    const r1 = await handler.mutate('supersede', {
      oldSlug: 'chain-v1',
      newSlug: 'chain-v2',
    });
    expect(r1.success, JSON.stringify(r1)).toBe(true);

    const afterFirst = await readBySlug('chain-v1');
    expect(afterFirst?.lifecycle_status).toBe('superseded');
    expect(afterFirst?.superseded_by).toBe(v2Id);

    // Second supersession: v1 → v3. Schema uses single-FK pointers, so the
    // latest write wins on the older row's `superseded_by`. The transaction
    // still succeeds — there is no "already-superseded" hard reject today.
    const r2 = await handler.mutate('supersede', {
      oldSlug: 'chain-v1',
      newSlug: 'chain-v3',
    });
    expect(r2.success, JSON.stringify(r2)).toBe(true);

    const afterSecond = await readBySlug('chain-v1');
    expect(afterSecond?.lifecycle_status).toBe('superseded');
    expect(afterSecond?.superseded_by).toBe(v3Id);

    const v3Row = await readBySlug('chain-v3');
    expect(v3Row?.supersedes).toBe((afterSecond as AttachmentSupersedeRow).id);
  });

  it('rolls back fully when the second slug lookup misses (no partial write)', async () => {
    const handler = new DocsHandler();
    await handler.mutate('add', {
      ownerId: 'T105',
      file: fixtureOld,
      slug: 'rollback-old',
      type: 'note',
      attachedBy: 'supersede-test',
    });

    const response = await handler.mutate('supersede', {
      oldSlug: 'rollback-old',
      newSlug: 'never-existed',
    });
    expect(response.success).toBe(false);

    // Old row MUST remain in its pre-call state — no partial flip.
    const row = await readBySlug('rollback-old');
    expect(row?.lifecycle_status).toBe('draft');
    expect(row?.superseded_by).toBeNull();
    expect(row?.supersedes).toBeNull();
  });
});
