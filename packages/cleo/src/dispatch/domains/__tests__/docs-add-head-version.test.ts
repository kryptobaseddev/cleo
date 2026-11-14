/**
 * `docs add` records the doc's identity, first version and head (T14329).
 *
 * Before T14329 a doc had no conduit identity until its first update, so
 * `docs fetch` carried no `metadata.headVersionUid` and the expected-base
 * fence (`docs update --base-version-uid`) was unavailable. Every add branch
 * with a slug (inline content, a text file, a binary file, a URL) now returns
 * `headVersionUid`, fetch shows the same uid, and an update declaring it as
 * its base lands.
 *
 * @task T14329
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DocsAddResult,
  DocsFetchResult,
  DocsListResult,
} from '@cleocode/contracts/operations/docs';
import { recordNewDocIdentity } from '@cleocode/core/docs/docs-update';
import { getDocsWikilinks, rebuildDocsWikilinks } from '@cleocode/core/docs/wikilinks';
import { backfillAdrIndex } from '@cleocode/core/migration/manual/T10165-backfill-adr-index';
import { createAttachmentStore } from '@cleocode/core/store/attachment-store';
import { awaitBackgroundOps } from '@cleocode/core/store/background-ops';
import { resolveConduitDocUid } from '@cleocode/core/store/conduit-doc-history';
import { yieldedDocSlug } from '@cleocode/core/store/row-identity';
import { closeAllDatabases, getNativeDb } from '@cleocode/core/store/sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchResponse } from '../../types.js';
import { DocsHandler } from '../docs.js';

let tempDir: string;

/** Add through the dispatch handler and return the result envelope's data. */
async function add(params: Record<string, unknown>): Promise<DocsAddResult> {
  const response = await new DocsHandler().mutate('add', {
    ownerId: 'T14329',
    attachedBy: 'head-test',
    ...params,
  });
  expect(response.error).toBeUndefined();
  expect(response.success).toBe(true);
  return response.data as DocsAddResult;
}

/** The fetched doc's head version uid. */
async function fetchedHead(slug: string): Promise<string | undefined> {
  const response = await new DocsHandler().query('fetch', { attachmentRef: slug });
  expect(response.success).toBe(true);
  return (response.data as DocsFetchResult).metadata.headVersionUid;
}

describe('docs.add records a head version for every doc it adds (T14329)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-add-head-'));
    vi.stubEnv('CLEO_ROOT', tempDir);
    vi.stubEnv('CLEO_DIR', join(tempDir, '.cleo'));
    vi.stubEnv('CLEO_BRAIN_BYPASS_WRITER_THREAD', '1');
    await mkdir(join(tempDir, '.cleo'));
    await writeFile(
      join(tempDir, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'head-test', projectRoot: tempDir }),
    );
  });

  afterEach(async () => {
    await awaitBackgroundOps();
    const { shutdownBrainWriter, _resetBrainWriterForTests } = await import(
      '@cleocode/core/memory/brain-writer-thread'
    );
    await shutdownBrainWriter();
    _resetBrainWriterForTests();
    await closeAllDatabases();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('inline content: add returns the head, fetch shows it, and an update on that base lands', async () => {
    const body = '# Research note\n\nFirst findings.\n';
    const added = await add({ content: body, slug: 'inline-research-note' });
    expect(added.headVersionUid).toMatch(/^[0-9a-f-]{36}$/);
    expect(await fetchedHead('inline-research-note')).toBe(added.headVersionUid);

    const updated = await new DocsHandler().mutate('update', {
      slug: 'inline-research-note',
      content: `${body}\n## More\n\nSecond pass.\n`,
      baseVersionUid: added.headVersionUid,
    });
    expect(updated.error).toBeUndefined();
    expect(updated.success).toBe(true);
    const nextHead = await fetchedHead('inline-research-note');
    expect(nextHead).toBeDefined();
    expect(nextHead).not.toBe(added.headVersionUid);
  });

  it('a text file, a binary file and a URL each get a head', async () => {
    const textPath = join(tempDir, 'spec.md');
    await writeFile(textPath, '# Spec\n\nBody.\n');
    const binaryPath = join(tempDir, 'diagram.png');
    await writeFile(binaryPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff, 0x00]));

    const text = await add({ file: textPath, slug: 'text-file-spec' });
    const binary = await add({ file: binaryPath, slug: 'binary-file-diagram' });
    const url = await add({ url: 'https://example.com/t14329', slug: 'external-reference' });

    for (const [slug, result] of [
      ['text-file-spec', text],
      ['binary-file-diagram', binary],
      ['external-reference', url],
    ] as const) {
      expect(result.headVersionUid, slug).toBeDefined();
      expect(await fetchedHead(slug), slug).toBe(result.headVersionUid);
    }
  });

  it('a slug-less attachment carries no head (it is not addressable as a doc)', async () => {
    const added = await add({ content: '# Untitled scratch\n\nno slug\n' });
    expect(added.headVersionUid).toBeUndefined();
  });

  it.each([
    'add-content',
    'add-file',
    'update',
  ] as const)('unsafe %s reuse returns the lineage code and fix in its dispatch envelope (T14584)', async (writer) => {
    const first = '# Guide\n\nv1\n';
    const handler = new DocsHandler();
    await add({ slug: 'old-guide', content: '# Old guide\n' });
    await add({ slug: 'guide', content: first });
    const version = await createAttachmentStore().findBySlug('guide', tempDir);
    expect(
      (await handler.mutate('update', { slug: 'guide', content: '# Guide\n\nv2\n' })).success,
    ).toBe(true);
    await add({ slug: 'other', content: first });
    expect((await handler.mutate('update', { slug: 'other', content: '# Other\n' })).success).toBe(
      true,
    );
    expect(
      (await handler.mutate('supersede', { oldSlug: 'old-guide', newSlug: 'guide' })).success,
    ).toBe(true);
    const native = getNativeDb(tempDir);
    if (!native || !version) throw new Error('expected the retired version');
    native
      .prepare("UPDATE docs_attachments SET superseded_by = ? WHERE slug = 'old-guide'")
      .run(version.metadata.id);

    let response: DispatchResponse;
    if (writer === 'update') {
      await add({ slug: 'target', content: '# Target\n' });
      response = await handler.mutate('update', { slug: 'target', content: first });
    } else if (writer === 'add-file') {
      const file = join(tempDir, 'reuse.md');
      await writeFile(file, first);
      response = await handler.mutate('add', { ownerId: 'T14329', slug: 'target', file });
    } else {
      response = await handler.mutate('add', { ownerId: 'T14329', slug: 'target', content: first });
    }

    expect(response).toMatchObject({
      success: false,
      error: {
        code: 'E_DOC_LINEAGE_AMBIGUOUS',
        fix: "Use different content bytes for 'target'; incoming supersession requires a distinct, uniquely identified live row for the original document.",
      },
    });
  });

  it.each([
    false,
    true,
  ])('migrate never adopts or lists a yielded version; already adopted=%s (T14584)', async (adopted) => {
    const first = '# Guide\n\nv1\n';
    const handler = new DocsHandler();
    await add({ slug: 'guide', content: first });
    const version = await createAttachmentStore().findBySlug('guide', tempDir);
    expect(
      (await handler.mutate('update', { slug: 'guide', content: '# Guide\n\nv2\n' })).success,
    ).toBe(true);
    const native = getNativeDb(tempDir);
    if (!native || !version) throw new Error('expected the retired version');
    const uid = native
      .prepare('SELECT uid FROM docs_attachments WHERE id = ?')
      .get(version.metadata.id)?.uid;
    if (typeof uid !== 'string') throw new Error('expected a version uid');
    const yielded = yieldedDocSlug('guide', uid);
    native
      .prepare('UPDATE docs_attachments SET slug = ?, related_tasks = ? WHERE id = ?')
      .run(yielded, '["T14329"]', version.metadata.id);
    if (adopted) {
      await recordNewDocIdentity(tempDir, {
        slug: yielded,
        authorAgentId: 'old-migration',
        bytes: Buffer.from(first),
      });
    }

    const migration = await handler.mutate('migrate', {});
    expect(migration).toMatchObject({ success: true, data: { status: 'completed', captured: 0 } });
    if (!adopted) expect(await resolveConduitDocUid(tempDir, yielded)).toBeNull();
    const listed = await handler.query('list', { project: true });
    expect(listed.success).toBe(true);
    expect((listed.data as DocsListResult).attachments.map((doc) => doc.slug)).not.toContain(
      yielded,
    );
    await rebuildDocsWikilinks({ projectRoot: tempDir });
    expect(await getDocsWikilinks(yielded, { projectRoot: tempDir })).toEqual([]);
  });

  it('update reclaims its own shared history with stale incoming pointers through the dispatch envelope (T14584)', async () => {
    const first = '# Guide\n\nv1\n';
    const handler = new DocsHandler();
    await add({ slug: 'old-guide', content: '# Old guide\n' });
    await add({ slug: 'guide', content: first });
    const version = await createAttachmentStore().findBySlug('guide', tempDir);
    expect(
      (await handler.mutate('update', { slug: 'guide', content: '# Guide\n\nv2\n' })).success,
    ).toBe(true);
    await add({ slug: 'other', content: first });
    expect((await handler.mutate('update', { slug: 'other', content: '# Other\n' })).success).toBe(
      true,
    );
    expect(
      (await handler.mutate('supersede', { oldSlug: 'old-guide', newSlug: 'guide' })).success,
    ).toBe(true);
    const native = getNativeDb(tempDir);
    if (!native || !version) throw new Error('expected the retired version');
    native
      .prepare("UPDATE docs_attachments SET superseded_by = ? WHERE slug = 'old-guide'")
      .run(version.metadata.id);

    expect(await handler.mutate('update', { slug: 'guide', content: first })).toMatchObject({
      success: true,
      data: { changed: true },
    });
    expect(
      native.prepare('SELECT slug FROM docs_attachments WHERE id = ?').get(version.metadata.id),
    ).toMatchObject({ slug: null });
    const fetched = await handler.query('fetch', { attachmentRef: 'old-guide' });
    expect(fetched).toMatchObject({
      success: true,
      data: { lineage: { supersededBy: 'guide', currentSlug: 'guide' } },
    });
  });

  it('ADR backfill reuse keeps the original successor in the fetch envelope (T14584)', async () => {
    const first = '# Guide\n\nv1\n';
    const handler = new DocsHandler();
    const legacy = Buffer.from('# Old guide\n');
    await createAttachmentStore().put(
      legacy,
      {
        kind: 'blob',
        storageKey: 'fixture',
        mime: 'text/markdown',
        size: legacy.length,
      },
      'task',
      'T14329',
      'head-test',
      tempDir,
      { slug: 'old-guide', type: 'guide' },
    );
    await add({ slug: 'guide', content: first });
    const version = await createAttachmentStore().findBySlug('guide', tempDir);
    expect(
      (await handler.mutate('update', { slug: 'guide', content: '# Guide\n\nv2\n' })).success,
    ).toBe(true);
    expect(
      (await handler.mutate('supersede', { oldSlug: 'old-guide', newSlug: 'guide' })).success,
    ).toBe(true);
    const native = getNativeDb(tempDir);
    if (!native || !version) throw new Error('expected the retired version');
    native
      .prepare("UPDATE docs_attachments SET superseded_by = ? WHERE slug = 'old-guide'")
      .run(version.metadata.id);
    await mkdir(join(tempDir, '.cleo', 'adrs'));
    await writeFile(join(tempDir, '.cleo', 'adrs', 'adr-101.md'), first);
    await writeFile(
      join(tempDir, '.cleo', 'adrs', 'adr-index.jsonl'),
      JSON.stringify({ id: 'ADR-101', file: '.cleo/adrs/adr-101.md', title: 'Guide replacement' }) +
        '\n',
    );

    expect((await backfillAdrIndex(tempDir, { dryRun: false })).updated).toBe(1);
    const fetched = await handler.query('fetch', { attachmentRef: 'old-guide' });
    expect(fetched).toMatchObject({
      success: true,
      data: { lineage: { supersededBy: 'guide', currentSlug: 'guide' } },
    });
    const current = await createAttachmentStore().findBySlug('guide', tempDir);
    expect(
      native.prepare("SELECT superseded_by FROM docs_attachments WHERE slug = 'old-guide'").get(),
    ).toMatchObject({ superseded_by: current?.metadata.id });
  });
});
