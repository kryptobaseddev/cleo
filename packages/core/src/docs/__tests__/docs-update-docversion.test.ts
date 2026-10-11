/**
 * docVersion must advance on every content update — T13351.
 *
 * `updateDocBySlug` read `oldRow.doc_version` from a camelCase Drizzle row
 * (always `undefined`), so every update persisted `docVersion = 1` and the
 * reported version drifted from the stored one (reported 2, stored 1).
 * The `existingNewRow` dedupe branch never set `docVersion` at all. All
 * four sites now read `oldRow.docVersion` and persist `+ 1`.
 *
 * Isolated temp `.cleo/` per test, seeded through the canonical
 * `createAttachmentStore` write path (same pattern as
 * docs-update-status-only.test.ts).
 *
 * @task T13351
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

/** Seed an attachment row carrying `slug`. */
async function seedSlug(slug: string, content: string): Promise<void> {
  const { createAttachmentStore } = await import('../../store/attachment-store.js');
  const store = createAttachmentStore();
  await store.put(
    Buffer.from(content, 'utf-8'),
    { kind: 'blob', storageKey: '', mime: 'text/markdown', size: content.length },
    'task',
    'T9999',
    'docs-update-docversion-test',
    undefined,
    { slug, type: 'note' },
  );
}

/** Read the persisted row's docVersion straight from the store. */
async function storedDocVersion(slug: string): Promise<number | undefined> {
  const { eq } = await import('drizzle-orm');
  const { getDb } = await import('../../store/sqlite.js');
  const { attachments } = await import('../../store/tasks-schema.js');
  const db = await getDb(tempDir);
  const row = await db.select().from(attachments).where(eq(attachments.slug, slug)).get();
  return row?.docVersion;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-docversion-'));
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
});

describe('updateDocBySlug — docVersion advancement (T13351)', () => {
  it('increments docVersion on each content update: 1 → 2 → 3, reported and persisted', async () => {
    const { updateDocBySlug } = await import('../docs-update.js');
    await seedSlug('t13351-doc', '# Doc\n\nv1.\n');
    expect(await storedDocVersion('t13351-doc')).toBe(1);

    const first = await updateDocBySlug(tempDir, { slug: 't13351-doc', content: '# Doc\n\nv2.\n' });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(first.result.docVersion).toBe(2);
    expect(await storedDocVersion('t13351-doc')).toBe(2);

    const second = await updateDocBySlug(tempDir, {
      slug: 't13351-doc',
      content: '# Doc\n\nv3.\n',
    });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (!second.ok) return;
    expect(second.result.docVersion).toBe(3);
    expect(await storedDocVersion('t13351-doc')).toBe(3);
  });

  it('keeps docVersion on a status-only update (no new bytes)', async () => {
    const { updateDocBySlug } = await import('../docs-update.js');
    await seedSlug('t13351-status', '# Doc\n\nv1.\n');
    await updateDocBySlug(tempDir, { slug: 't13351-status', content: '# Doc\n\nv2.\n' });
    expect(await storedDocVersion('t13351-status')).toBe(2);

    const res = await updateDocBySlug(tempDir, { slug: 't13351-status', status: 'accepted' });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.result.changed).toBe(false);
    expect(res.result.docVersion).toBe(2);
    expect(await storedDocVersion('t13351-status')).toBe(2);
  });

  it('reports the current docVersion on a dry run without persisting anything', async () => {
    const { updateDocBySlug } = await import('../docs-update.js');
    await seedSlug('t13351-dry', '# Doc\n\nv1.\n');
    await updateDocBySlug(tempDir, { slug: 't13351-dry', content: '# Doc\n\nv2.\n' });

    const res = await updateDocBySlug(tempDir, {
      slug: 't13351-dry',
      content: '# Doc\n\nv3.\n',
      dryRun: true,
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.result.docVersion).toBe(2);
    expect(await storedDocVersion('t13351-dry')).toBe(2);
  });
});
