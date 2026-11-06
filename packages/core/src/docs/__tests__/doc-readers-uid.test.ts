/**
 * Doc readers resolve through the immutable identity (T14288, PR 3b-1): a
 * slug, live or an old alias, reaches the doc on every reading surface, its
 * metadata comes from the identity row, and an alias counts as a taken slug.
 *
 * @task T14288
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { createAttachmentStore } from '../../store/attachment-store.js';
import {
  mirrorUnmirroredConduitDocs,
  resolveConduitDocUid,
} from '../../store/conduit-doc-history.js';
import { conduitAttachments } from '../../store/schema/cleo-project/conduit.js';
import { getDb, getNativeDb } from '../../store/sqlite.js';
import { docsAttachments } from '../../store/tasks-schema.js';
import { runLegacyDocMigration } from '../legacy-doc-migration.js';
import { readDocLineage } from '../lineage.js';
import { readDoc } from '../read-doc.js';
import { reserveSlug } from '../slug-allocator.js';
import { isDocSlugTaken, listDocRefs, renameDocSlug, resolveDocRef } from '../slug-rename.js';
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

beforeEach(async () => {
  env = await createTestDb();
});

afterEach(async () => {
  await env.cleanup();
});

describe('readers go through the doc identity (T14288 3b-1)', () => {
  it('an old alias reaches the doc on the read, lineage and lookup surfaces', async () => {
    await seedDoc('reader-old-name', { type: 'spec', summary: 'The spec.' });
    await migrate();
    await renameDocSlug(env.tempDir, {
      oldSlug: 'reader-old-name',
      newSlug: 'reader-new-name',
      authorAgentId: 'tester',
      reason: 'test',
    });

    const read = await readDoc('reader-old-name', { projectRoot: env.tempDir });
    expect(read.frontmatter.slug).toBe('reader-new-name');
    expect(read.frontmatter.kind).toBe('spec');
    expect(read.frontmatter.summary).toBe('The spec.');

    expect((await readDocLineage(env.tempDir, 'reader-old-name'))?.currentSlug).toBe(
      'reader-new-name',
    );
    const found = await createAttachmentStore().findBySlug('reader-old-name', env.tempDir);
    expect(found?.slug).toBe('reader-new-name');
    expect(found?.type).toBe('spec');
  });

  it('metadata comes from the identity row', async () => {
    await seedDoc('reader-meta', { type: 'note', summary: 'registry summary' });
    await migrate();
    const uid = await resolveConduitDocUid(env.tempDir, 'reader-meta');
    const db = await getDb(env.tempDir);
    await db
      .update(conduitAttachments)
      .set({ summary: 'identity summary' })
      .where(eq(conduitAttachments.uid, uid ?? ''))
      .run();
    expect((await resolveDocRef(env.tempDir, 'reader-meta'))?.meta.summary).toBe(
      'identity summary',
    );
    expect(
      (await listDocRefs(env.tempDir)).find((r) => r.slug === 'reader-meta')?.meta.summary,
    ).toBe('identity summary');
  });

  it('lineage follows supersession through the identity', async () => {
    await seedDoc('reader-v1');
    await seedDoc('reader-v2');
    await migrate();
    await supersedeDoc(env.tempDir, { oldSlug: 'reader-v1', newSlug: 'reader-v2' });
    const lineage = await readDocLineage(env.tempDir, 'reader-v1');
    expect(lineage?.supersededBy).toBe('reader-v2');
    expect(lineage?.currentSlug).toBe('reader-v2');
    expect((await readDocLineage(env.tempDir, 'reader-v2'))?.supersedes).toBe('reader-v1');
  });

  it('an alias is a taken slug for the allocator and the rename guard; a rename back is allowed', async () => {
    await seedDoc('reader-was');
    await migrate();
    await renameDocSlug(env.tempDir, {
      oldSlug: 'reader-was',
      newSlug: 'reader-is',
      authorAgentId: 'tester',
      reason: 'test',
    });
    expect(await isDocSlugTaken(env.tempDir, 'reader-was')).toBe(true);
    const reserved = await reserveSlug('note', 'reader-was', { cwd: env.tempDir });
    expect(reserved.ok).toBe(false);

    await seedDoc('reader-other');
    await expect(
      renameDocSlug(env.tempDir, {
        oldSlug: 'reader-other',
        newSlug: 'reader-was',
        authorAgentId: 'tester',
        reason: 'test',
      }),
    ).rejects.toThrow(/already taken/);
    // The doc's own old slug: a rename back.
    await renameDocSlug(env.tempDir, {
      oldSlug: 'reader-is',
      newSlug: 'reader-was',
      authorAgentId: 'tester',
      reason: 'test',
    });
    expect((await resolveDocRef(env.tempDir, 'reader-is'))?.slug).toBe('reader-was');
  });

  it('identity rows adopted before the metadata columns existed are mirrored once', async () => {
    await seedDoc('reader-unmirrored', { type: 'guide' });
    await migrate();
    const uid = await resolveConduitDocUid(env.tempDir, 'reader-unmirrored');
    const db = await getDb(env.tempDir);
    // An identity row from before the metadata columns: nothing mirrored.
    await db
      .update(conduitAttachments)
      .set({ lifecycleStatus: null, supersededByUid: null, docType: null })
      .where(eq(conduitAttachments.uid, uid ?? ''))
      .run();
    // Reads fall back to the registry row meanwhile.
    expect((await resolveDocRef(env.tempDir, 'reader-unmirrored'))?.meta.docType).toBe('guide');
    expect(await mirrorUnmirroredConduitDocs(env.tempDir)).toBe(1);
    expect(await mirrorUnmirroredConduitDocs(env.tempDir)).toBe(0);
    const row = await db
      .select()
      .from(conduitAttachments)
      .where(eq(conduitAttachments.uid, uid ?? ''))
      .get();
    expect(row?.docType).toBe('guide');
  });
});
