/**
 * T13734 — `docs update` keeps the prior version linked to its doc.
 *
 * The first update moved the slug to a new `attachments` row and the
 * conduit projection recorded only the new bytes, so v1 was reachable from
 * nothing and `docs versions --for <slug>` fell back to the owner-wide blob
 * list (sibling docs included). The update now records the pre-update bytes
 * as the root conduit version, and `listDocVersions` lists a slug's own
 * conduit history.
 *
 * Isolated temp `.cleo/` per test, seeded through `createAttachmentStore`
 * (same pattern as docs-update-docversion.test.ts).
 *
 * @task T13734
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

/** Seed a slugged doc on owner T9999 and return its sha256. */
async function seedSlug(slug: string, content: string): Promise<string> {
  const { createAttachmentStore } = await import('../../store/attachment-store.js');
  await createAttachmentStore().put(
    Buffer.from(content, 'utf-8'),
    { kind: 'blob', storageKey: '', mime: 'text/markdown', size: content.length },
    'task',
    'T9999',
    'docs-update-version-link-test',
    undefined,
    { slug, type: 'note' },
  );
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-version-link-'));
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

describe('docs update links the prior version to its doc (T13734)', () => {
  it('add then update yields v1 and v2 in the doc history, and versions --for lists only them', async () => {
    const { updateDocBySlug } = await import('../docs-update.js');
    const { listDocVersions } = await import('../docs-ops.js');
    const { listConduitAttachmentVersions, resolveConduitDocUid } = await import(
      '../../store/conduit-doc-history.js'
    );

    const v1Sha = await seedSlug('t13734-doc', '# Doc\n\nv1 body.\n');
    const siblingSha = await seedSlug('t13734-sibling', '# Sibling\n\nother doc.\n');

    const res = await updateDocBySlug(tempDir, {
      slug: 't13734-doc',
      content: '# Doc\n\nv2 body.\n',
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const docUid = await resolveConduitDocUid(tempDir, 't13734-doc');
    expect(docUid).not.toBeNull();
    const history = await listConduitAttachmentVersions(tempDir, docUid ?? '');
    expect(history).toHaveLength(2);
    const [head, root] = history;
    expect(root?.contentHash).toBe(v1Sha);
    expect(root?.parentVersionUid).toBeNull();
    expect(head?.parentVersionUid).toBe(root?.uid);

    const listed = await listDocVersions({ ownerId: 't13734-doc', projectRoot: tempDir });
    expect(listed.versions.map((v) => v.sha256)).toEqual([head?.contentHash, v1Sha]);
    expect(listed.versions.map((v) => v.sha256)).not.toContain(siblingSha);
  });

  it('a second update extends the same history instead of re-rooting it', async () => {
    const { updateDocBySlug } = await import('../docs-update.js');
    const { listDocVersions } = await import('../docs-ops.js');

    const v1Sha = await seedSlug('t13734-three', '# Doc\n\nv1.\n');
    expect(
      (await updateDocBySlug(tempDir, { slug: 't13734-three', content: '# Doc\n\nv2.\n' })).ok,
    ).toBe(true);
    expect(
      (await updateDocBySlug(tempDir, { slug: 't13734-three', content: '# Doc\n\nv3.\n' })).ok,
    ).toBe(true);

    const listed = await listDocVersions({ ownerId: 't13734-three', projectRoot: tempDir });
    expect(listed.versions).toHaveLength(3);
    expect(listed.versions.at(-1)?.sha256).toBe(v1Sha);
    expect(listed.versions.map((v) => v.docVersion)).toEqual([3, 2, 1]);
  });
});
