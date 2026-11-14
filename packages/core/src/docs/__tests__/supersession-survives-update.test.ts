/**
 * T14565 — a doc's supersession edges belong to the doc, not to the registry
 * row of one of its versions.
 *
 * `cleo docs update` moves the slug onto a new `docs_attachments` row. The
 * `supersedes` / `superseded_by` pointers name registry rows, so before the
 * fix the new row carried no outgoing pointer and every incoming pointer was
 * left naming the slugless old row: `docs fetch <old>` then showed
 * `lineage.supersededBy: null` and `currentSlug` back on the superseded doc.
 *
 * The lineage also lists every doc a survivor replaced (`predecessors`): the
 * `supersedes` pointer holds one doc, so a survivor of several named only the
 * latest.
 *
 * @task T14565
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BlobAttachment } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttachmentStore } from '../../store/attachment-store.js';
import { mirrorConduitDocMeta, resolveConduitDocUid } from '../../store/conduit-doc-history.js';
import { closeDb, getNativeDb } from '../../store/sqlite.js';
import { publishDocs } from '../docs-ops.js';
import { updateDocBySlug } from '../docs-update.js';
import { readDocLineage } from '../lineage.js';
import { renameDocSlug } from '../slug-rename.js';
import { supersedeDoc } from '../supersede.js';

describe('T14565 — supersession edges survive a successor update', () => {
  let projectRoot: string;
  let prevCleoDir: string | undefined;
  let prevCwd: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-t14565-'));
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    mkdirSync(join(projectRoot, '.git'), { recursive: true });
    prevCleoDir = process.env['CLEO_DIR'];
    process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
    prevCwd = process.cwd();
    process.chdir(projectRoot);
  });

  afterEach(() => {
    closeDb();
    process.chdir(prevCwd);
    if (prevCleoDir === undefined) delete process.env['CLEO_DIR'];
    else process.env['CLEO_DIR'] = prevCleoDir;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  async function seed(slug: string, body: string): Promise<void> {
    const bytes = Buffer.from(body, 'utf-8');
    const blob: Omit<BlobAttachment, 'sha256'> = {
      kind: 'blob',
      storageKey: '',
      mime: 'text/markdown',
      size: bytes.byteLength,
    };
    await createAttachmentStore().put(bytes, blob, 'task', 'T100', 'test', projectRoot, {
      slug,
      type: 'guide',
    });
  }

  async function update(slug: string, content: string): Promise<void> {
    const res = await updateDocBySlug(projectRoot, { slug, content });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (res.ok) expect(res.result.changed).toBe(true);
  }

  /** Both sides of the `older → newer` edge, as `docs fetch` reports them. */
  async function expectEdge(older: string, newer: string): Promise<void> {
    expect(await readDocLineage(projectRoot, older)).toMatchObject({
      lifecycleStatus: 'superseded',
      supersededBy: newer,
      currentSlug: newer,
    });
    const successor = await readDocLineage(projectRoot, newer);
    expect(successor).toMatchObject({
      supersedes: older,
      supersededBy: null,
      currentSlug: newer,
    });
    // The reciprocal side: the successor lists the doc it replaced.
    expect(successor?.predecessors).toContain(older);
  }

  it('supersede, update the successor twice: the old doc still names its successor (AC1, AC2)', async () => {
    // Neither doc has an identity yet, as after `cleo docs add`.
    await seed('old-guide', '# Old guide\n\nfirst\n');
    await seed('guide', '# Guide\n\nv1\n');
    await supersedeDoc(projectRoot, { oldSlug: 'old-guide', newSlug: 'guide' });
    await expectEdge('old-guide', 'guide');

    await update('guide', '# Guide\n\nv2\n');
    await expectEdge('old-guide', 'guide');

    await update('guide', '# Guide\n\nv3\n');
    await expectEdge('old-guide', 'guide');
  });

  it('keeps both sides when both docs carry an identity and the old doc is mirrored again', async () => {
    await seed('old-guide', '# Old guide\n\nfirst\n');
    await seed('guide', '# Guide\n\nv1\n');
    // A first text update adopts each doc into the identity family.
    await update('old-guide', '# Old guide\n\nsecond\n');
    await update('guide', '# Guide\n\nv2\n');
    expect(await resolveConduitDocUid(projectRoot, 'old-guide')).not.toBeNull();
    expect(await resolveConduitDocUid(projectRoot, 'guide')).not.toBeNull();
    await supersedeDoc(projectRoot, { oldSlug: 'old-guide', newSlug: 'guide' });

    await update('guide', '# Guide\n\nv3\n');
    await expectEdge('old-guide', 'guide');
    await update('guide', '# Guide\n\nv4\n');
    await expectEdge('old-guide', 'guide');

    // Any later metadata writer mirrors the registry row onto the identity
    // row (doctor, repair, a kind change): the edge must still be there.
    await mirrorConduitDocMeta(projectRoot, { slug: 'old-guide' });
    await mirrorConduitDocMeta(projectRoot, { slug: 'guide' });
    await expectEdge('old-guide', 'guide');
  });

  it('keeps the edge when the successor returns to bytes an earlier version held', async () => {
    await seed('old-guide', '# Old guide\n\nfirst\n');
    await seed('guide', '# Guide\n\nv1\n');
    await update('guide', '# Guide\n\nv2\n');
    await supersedeDoc(projectRoot, { oldSlug: 'old-guide', newSlug: 'guide' });
    // The slug moves back onto the row that already holds the v1 bytes.
    await update('guide', '# Guide\n\nv1\n');
    await expectEdge('old-guide', 'guide');
  });

  it('keeps a chain: updating the middle doc keeps its incoming and outgoing edges', async () => {
    await seed('guide-v1', '# Guide\n\none\n');
    await seed('guide-v2', '# Guide\n\ntwo\n');
    await seed('guide-v3', '# Guide\n\nthree\n');
    await supersedeDoc(projectRoot, { oldSlug: 'guide-v1', newSlug: 'guide-v2' });
    await update('guide-v2', '# Guide\n\ntwo, revised\n');
    await update('guide-v3', '# Guide\n\nthree, revised\n');
    await supersedeDoc(projectRoot, { oldSlug: 'guide-v2', newSlug: 'guide-v3' });
    await update('guide-v3', '# Guide\n\nthree, revised again\n');

    expect(await readDocLineage(projectRoot, 'guide-v1')).toMatchObject({
      supersededBy: 'guide-v2',
      currentSlug: 'guide-v3',
    });
    expect(await readDocLineage(projectRoot, 'guide-v2')).toMatchObject({
      supersedes: 'guide-v1',
      supersededBy: 'guide-v3',
      currentSlug: 'guide-v3',
    });
    expect(await readDocLineage(projectRoot, 'guide-v3')).toMatchObject({
      supersedes: 'guide-v2',
      supersededBy: null,
    });
  });

  it('a survivor that replaced several docs lists every one, through updates of either side', async () => {
    await seed('cant-old', '# CANT, old\n');
    await seed('cant-ts', '# CANT TypeScript integration\n');
    await seed('cant', '# CANT\n\nv1\n');
    await supersedeDoc(projectRoot, { oldSlug: 'cant-old', newSlug: 'cant' });
    // The single `supersedes` pointer now names the latest doc only.
    await supersedeDoc(projectRoot, { oldSlug: 'cant-ts', newSlug: 'cant' });

    const expectBothSides = async (predecessors: string[]) => {
      expect(await readDocLineage(projectRoot, 'cant')).toMatchObject({
        supersededBy: null,
        predecessors,
        currentSlug: 'cant',
      });
      for (const slug of predecessors) {
        expect(await readDocLineage(projectRoot, slug)).toMatchObject({
          lifecycleStatus: 'superseded',
          supersededBy: 'cant',
          predecessors: [],
          currentSlug: 'cant',
        });
      }
    };
    await expectBothSides(['cant-old', 'cant-ts']);

    await update('cant', '# CANT\n\nv2\n');
    await expectBothSides(['cant-old', 'cant-ts']);
    await update('cant', '# CANT\n\nv3\n');
    await expectBothSides(['cant-old', 'cant-ts']);

    // Writes to a predecessor: re-asserting its status, and a rename.
    const reasserted = await updateDocBySlug(projectRoot, {
      slug: 'cant-old',
      status: 'superseded',
    });
    expect(reasserted.ok).toBe(true);
    await renameDocSlug(projectRoot, {
      oldSlug: 'cant-ts',
      newSlug: 'cant-typescript',
      reason: 'test',
      authorAgentId: 'test',
    });
    await expectBothSides(['cant-old', 'cant-typescript']);

    for (const slug of ['cant-old', 'cant-typescript', 'cant'])
      await mirrorConduitDocMeta(projectRoot, { slug });
    await update('cant', '# CANT\n\nv4\n');
    await expectBothSides(['cant-old', 'cant-typescript']);
  });

  it('a pointer left on an old version row resolves through the doc history; one no history records is repaired by re-running docs supersede', async () => {
    await seed('old-guide', '# Old guide\n\nfirst\n');
    await seed('guide', '# Guide\n\nv1\n');
    await seed('scratch', '# Scratch\n');
    await update('old-guide', '# Old guide\n\nsecond\n');
    const v1 = await createAttachmentStore().findBySlug('guide', projectRoot);
    const scratch = await createAttachmentStore().findBySlug('scratch', projectRoot);
    await update('guide', '# Guide\n\nv2\n');
    await supersedeDoc(projectRoot, { oldSlug: 'old-guide', newSlug: 'guide' });
    const native = getNativeDb(projectRoot);
    if (!native || !v1 || !scratch) throw new Error('expected a native handle and both rows');
    const damage = async (rowId: string) => {
      native
        .prepare("UPDATE docs_attachments SET superseded_by = ? WHERE slug = 'old-guide'")
        .run(rowId);
      native.prepare("UPDATE docs_attachments SET supersedes = NULL WHERE slug = 'guide'").run();
      await mirrorConduitDocMeta(projectRoot, { slug: 'old-guide' });
      await mirrorConduitDocMeta(projectRoot, { slug: 'guide' });
    };

    // As an unfixed update (or a sync merge) leaves it: the old doc names the
    // slugless row of an earlier version, the successor's row names nothing.
    // The successor's history records that version, so the edge still reads.
    await damage(v1.metadata.id);
    expect(await readDocLineage(projectRoot, 'old-guide')).toMatchObject({
      supersededBy: 'guide',
      currentSlug: 'guide',
    });
    expect((await readDocLineage(projectRoot, 'guide'))?.predecessors).toEqual(['old-guide']);

    // A slugless row that no doc's history records resolves to nothing.
    native.prepare("UPDATE docs_attachments SET slug = NULL WHERE slug = 'scratch'").run();
    await damage(scratch.metadata.id);
    expect(await readDocLineage(projectRoot, 'old-guide')).toMatchObject({
      supersededBy: null,
      currentSlug: 'old-guide',
    });
    expect((await readDocLineage(projectRoot, 'guide'))?.predecessors).toEqual([]);

    // The supported repair: `cleo docs supersede <old> <new>` once more.
    await supersedeDoc(projectRoot, { oldSlug: 'old-guide', newSlug: 'guide' });
    await expectEdge('old-guide', 'guide');
    await update('guide', '# Guide\n\nv3\n');
    await expectEdge('old-guide', 'guide');
  });

  it("a doc added with the bytes of a successor's old version is its own doc and inherits no edge", async () => {
    const V1 = '# Guide\n\nv1\n';
    const V2 = '# Guide\n\nv2\n';
    await seed('old-guide', '# Old guide\n\nfirst\n');
    await seed('guide', V1);
    await supersedeDoc(projectRoot, { oldSlug: 'old-guide', newSlug: 'guide' });
    await update('guide', V2);

    // The registry holds one row per content hash: this doc takes the row the
    // successor's first version left behind.
    const store = createAttachmentStore();
    const v2RowId = (await store.findBySlug('guide', projectRoot))?.metadata.id;
    await seed('unrelated', V1);
    const alone = {
      supersedes: null,
      supersededBy: null,
      predecessors: [],
    };
    expect(await readDocLineage(projectRoot, 'unrelated')).toMatchObject({
      ...alone,
      currentSlug: 'unrelated',
    });
    await expectEdge('old-guide', 'guide');
    expect((await readDocLineage(projectRoot, 'guide'))?.predecessors).toEqual(['old-guide']);

    // A version row an unfixed update left with its pointer: the doc that
    // takes the row drops it.
    await update('guide', '# Guide\n\nv3\n');
    const native = getNativeDb(projectRoot);
    const oldRow = (await store.findBySlug('old-guide', projectRoot))?.metadata.id;
    if (!native || !v2RowId || !oldRow) throw new Error('expected a native handle and both rows');
    native.prepare('UPDATE docs_attachments SET supersedes = ? WHERE id = ?').run(oldRow, v2RowId);
    await seed('another', V2);
    expect(await readDocLineage(projectRoot, 'another')).toMatchObject({
      ...alone,
      currentSlug: 'another',
    });
    expect((await readDocLineage(projectRoot, 'guide'))?.predecessors).toEqual(['old-guide']);
    expect((await readDocLineage(projectRoot, 'old-guide'))?.supersededBy).toBe('guide');
  });

  it('a publish after the successor updates leaves the edge in place', async () => {
    await seed('old-guide', '# Old guide\n\nfirst\n');
    await seed('guide', '# Guide\n\nv1\n');
    await supersedeDoc(projectRoot, { oldSlug: 'old-guide', newSlug: 'guide' });
    await update('guide', '# Guide\n\nv2\n');
    await update('guide', '# Guide\n\nv3\n');

    const published = await publishDocs({
      ownerId: 'T100',
      attachmentId: 'guide',
      toPath: 'docs/guide/guide.md',
      projectRoot,
    });
    expect(published.bytes).toBeGreaterThan(0);
    await expectEdge('old-guide', 'guide');
  });
});
