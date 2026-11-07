/**
 * The doc's metadata on its immutable identity row (T14288, PR 3a): every doc
 * metadata writer mirrors the registry row onto `conduit_attachments`, so the
 * uid carries the kind, lifecycle, supersession and provenance before the
 * readers move to it.
 *
 * @task T14288
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import {
  conduitDocMetaOfRow,
  mirrorConduitDocMeta,
  resolveConduitDocUid,
  setConduitDocMeta,
} from '../../store/conduit-doc-history.js';
import { conduitAttachments } from '../../store/schema/cleo-project/conduit.js';
import { getDb, getNativeDb } from '../../store/sqlite.js';
import { docsAttachments } from '../../store/tasks-schema.js';
import { updateDocBySlug } from '../docs-update.js';
import { runLegacyDocMigration } from '../legacy-doc-migration.js';
import { setDocKind } from '../slug-rename.js';
import { supersedeDoc } from '../supersede.js';

let env: TestDbEnv;

/** Seed a legacy doc row whose bytes live in the blob store. */
async function seedDoc(slug: string, extra: Partial<typeof docsAttachments.$inferInsert> = {}) {
  const body = Buffer.from(`# ${slug}\n\nbody.\n`);
  const hash = createHash('sha256').update(body).digest('hex');
  const path = join(env.cleoDir, 'blobs', 'blobs', hash);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  const db = await getDb(env.tempDir);
  await db
    .insert(docsAttachments)
    .values({
      id: `att-${slug}`,
      sha256: hash,
      attachmentJson: JSON.stringify({ kind: 'blob', mime: 'text/markdown', sha256: hash }),
      slug,
      createdAt: '2026-09-01T00:00:00.000Z',
      ...extra,
    })
    .run();
}

async function migrate(): Promise<void> {
  const native = getNativeDb(env.tempDir);
  if (!native) throw new Error('expected a native handle');
  const result = await runLegacyDocMigration({
    projectRoot: env.tempDir,
    db: native,
    cwd: env.tempDir,
  });
  expect(result.report.status).toBe('completed');
}

/** The identity row of a slug's doc. */
async function identityRow(slug: string) {
  const uid = await resolveConduitDocUid(env.tempDir, slug);
  if (uid === null) throw new Error(`no identity for ${slug}`);
  const db = await getDb(env.tempDir);
  const row = await db
    .select()
    .from(conduitAttachments)
    .where(eq(conduitAttachments.uid, uid))
    .get();
  if (!row) throw new Error(`no identity row for ${slug}`);
  return row;
}

beforeEach(async () => {
  env = await createTestDb();
});

afterEach(async () => {
  await env.cleanup();
});

describe('doc metadata on the identity row (T14288)', () => {
  it('migrate carries the registry metadata onto the new identity', async () => {
    await seedDoc('meta-migrated', {
      type: 'research',
      summary: 'What we found.',
      topics: '["sync"]',
      lifecycleStatus: 'accepted',
    });
    await migrate();
    const row = await identityRow('meta-migrated');
    expect(row).toMatchObject({
      docType: 'research',
      summary: 'What we found.',
      topics: '["sync"]',
      lifecycleStatus: 'accepted',
      supersedesUid: null,
      supersededByUid: null,
    });
  });

  it('a status update, a kind change and a supersession are mirrored', async () => {
    await seedDoc('meta-old', { type: 'spec' });
    await seedDoc('meta-new', { type: 'spec' });
    await migrate();

    const statusOnly = await updateDocBySlug(env.tempDir, { slug: 'meta-old', status: 'proposed' });
    expect(statusOnly.ok).toBe(true);
    expect((await identityRow('meta-old')).lifecycleStatus).toBe('proposed');

    await setDocKind(env.tempDir, 'att-meta-new', 'adr');
    expect((await identityRow('meta-new')).docType).toBe('adr');

    await supersedeDoc(env.tempDir, { oldSlug: 'meta-old', newSlug: 'meta-new' });
    const older = await identityRow('meta-old');
    const newer = await identityRow('meta-new');
    expect(older.lifecycleStatus).toBe('superseded');
    expect(older.supersededByUid).toBe(newer.uid);
    expect(newer.supersedesUid).toBe(older.uid);
  });

  it('a superseded identity stays superseded when its registry row leaves superseded (absorbing rule)', async () => {
    await seedDoc('meta-was', { summary: 'before' });
    await seedDoc('meta-now');
    await migrate();
    await supersedeDoc(env.tempDir, { oldSlug: 'meta-was', newSlug: 'meta-now' });
    const successor = (await identityRow('meta-now')).uid;

    // A registry row put back from superseded (as the pre-T14333 modernize
    // undo did): the identity row keeps the absorbing state every receiver
    // keeps, and the other columns still mirror.
    const db = await getDb(env.tempDir);
    await db
      .update(docsAttachments)
      .set({ summary: 'after', lifecycleStatus: 'draft', supersededBy: null })
      .where(eq(docsAttachments.id, 'att-meta-was'))
      .run();
    await mirrorConduitDocMeta(env.tempDir, { rowId: 'att-meta-was' });
    const row = await identityRow('meta-was');
    expect(row.lifecycleStatus).toBe('superseded');
    expect(row.supersededByUid).toBe(successor);
    expect(row.summary).toBe('after');
  });

  it('a content update mirrors the new registry row', async () => {
    await seedDoc('meta-content', { type: 'guide', summary: 'How to.' });
    await migrate();
    const updated = await updateDocBySlug(env.tempDir, {
      slug: 'meta-content',
      content: '# meta-content\n\nbody.\n\nmore.\n',
    });
    expect(updated.ok).toBe(true);
    const row = await identityRow('meta-content');
    expect(row.docType).toBe('guide');
    expect(row.lifecycleStatus).toBe('draft');
  });

  it('an unchanged mirror writes nothing', async () => {
    await seedDoc('meta-same', { type: 'note' });
    await migrate();
    const db = await getDb(env.tempDir);
    const reg = await db
      .select()
      .from(docsAttachments)
      .where(eq(docsAttachments.slug, 'meta-same'))
      .get();
    if (!reg) throw new Error('expected the registry row');
    const row = await identityRow('meta-same');
    const meta = await conduitDocMetaOfRow(env.tempDir, reg);
    expect(await setConduitDocMeta(env.tempDir, row.uid ?? '', meta)).toBe(false);
    expect(
      await setConduitDocMeta(env.tempDir, row.uid ?? '', { ...meta, summary: 'changed' }),
    ).toBe(true);
  });
});
