/**
 * Two docs whose heads hold identical bytes both stay fetchable under their
 * own slugs (T14288 AC2, PR 3b-2). The registry row is content-addressed
 * (sha256 UNIQUE): before 3b-2, updating a doc to bytes another doc already
 * held moved the updated doc's slug onto that doc's row, so the other doc lost
 * its row. A doc with an identity now keeps its own row, and its head points
 * at the shared content.
 *
 * @task T14288
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { getDb, getNativeDb } from '../../store/sqlite.js';
import { docsAttachments } from '../../store/tasks-schema.js';
import { createDocsReadModel } from '../docs-read-model.js';
import { updateDocBySlug } from '../docs-update.js';
import { runLegacyDocMigration } from '../legacy-doc-migration.js';
import { readDoc } from '../read-doc.js';
import { listDocRefs, resolveDocRef } from '../slug-rename.js';

let env: TestDbEnv;

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Seed a legacy doc row whose bytes live in the blob store. */
async function seedDoc(
  slug: string,
  body: string,
  extra: Partial<typeof docsAttachments.$inferInsert> = {},
) {
  const bytes = Buffer.from(body);
  const hash = sha(bytes);
  const path = join(env.cleoDir, 'blobs', 'blobs', hash);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
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
  return hash;
}

beforeEach(async () => {
  env = await createTestDb();
});

afterEach(async () => {
  await env.cleanup();
});

describe('identical heads (T14288 AC2)', () => {
  it('a doc updated to another doc’s exact bytes keeps its slug, and the other doc keeps its own', async () => {
    const shared = '# Shared text\n\nthe same bytes in two docs.\n';
    const yHash = await seedDoc('content-y', shared, { type: 'spec', summary: 'Doc Y' });
    await seedDoc('content-x', '# X\n\nits own first text.\n', { type: 'note', summary: 'Doc X' });
    const native = getNativeDb(env.tempDir);
    if (!native) throw new Error('expected a native handle');
    const migrated = await runLegacyDocMigration({
      projectRoot: env.tempDir,
      db: native,
      cwd: env.tempDir,
    });
    expect(migrated.report.status).toBe('completed');

    const updated = await updateDocBySlug(env.tempDir, { slug: 'content-x', content: shared });
    expect(updated.ok).toBe(true);

    // Both docs resolve, each under its own slug, to the shared bytes.
    const x = await resolveDocRef(env.tempDir, 'content-x');
    const y = await resolveDocRef(env.tempDir, 'content-y');
    expect(x?.sha256).toBe(yHash);
    expect(y?.sha256).toBe(yHash);
    expect(x?.docUid).not.toBe(y?.docUid);
    expect(x?.meta.docType).toBe('note');
    expect(y?.meta.docType).toBe('spec');

    // Y's registry row is untouched: still Y's slug and metadata.
    const db = await getDb(env.tempDir);
    const yRow = await db
      .select()
      .from(docsAttachments)
      .where(eq(docsAttachments.sha256, yHash))
      .get();
    expect(yRow?.slug).toBe('content-y');
    expect(yRow?.summary).toBe('Doc Y');

    // Every surface reads both: read, list and the doc listing.
    const readX = await readDoc('content-x', { projectRoot: env.tempDir });
    const readY = await readDoc('content-y', { projectRoot: env.tempDir });
    expect(readX.frontmatter.slug).toBe('content-x');
    expect(readY.frontmatter.slug).toBe('content-y');
    expect(readX.frontmatter.summary).toBe('Doc X');
    expect(readY.frontmatter.summary).toBe('Doc Y');
    const model = createDocsReadModel(env.tempDir);
    const fetchedX = await model.fetchDecoded('content-x');
    const fetchedY = await model.fetchDecoded('content-y');
    expect(fetchedX.ok && fetchedX.content).toBe(shared);
    expect(fetchedY.ok && fetchedY.content).toBe(shared);
    expect((await listDocRefs(env.tempDir)).map((r) => r.slug).sort()).toEqual([
      'content-x',
      'content-y',
    ]);
  });
});
