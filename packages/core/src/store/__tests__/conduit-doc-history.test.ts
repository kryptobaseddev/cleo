/**
 * Conduit doc-history accessors — the re-keyed CleoDocs schema (T13354).
 *
 * Covers the settled design (spec cleodocs-rearch-design §3/§10, D11165):
 * slug → immutable doc uid resolution incl. the alias table, the version DAG
 * (uid + parent_version_uid; version_number is a local display ordinal),
 * append-only approvals with tombstone revokes, the derived contributors
 * rollup, the max-HLC head projection with conflict recording, and the
 * local-only section CRDT state.
 *
 * Temp-dir harness per test (same pattern as docs/__tests__ doctor tests).
 *
 * @task T13354
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

/** Seed a conduit attachment row; returns its uid. */
async function seedDoc(slug: string): Promise<string> {
  const { getDb } = await import('../../store/sqlite.js');
  const { conduitAttachments } = await import('../../store/schema/cleo-project/conduit.js');
  const db = await getDb(tempDir);
  const content = Buffer.from(`# ${slug}\n`, 'utf-8');
  await db
    .insert(conduitAttachments)
    .values({
      slug,
      conversationId: 'conv-1',
      fromAgentId: 'agent-test',
      content,
      originalSize: content.length,
      compressedSize: content.length,
      contentHash: `sha-${slug}`,
    })
    .run();
  const row = await db
    .select({ uid: conduitAttachments.uid })
    .from(conduitAttachments)
    .where((await import('drizzle-orm')).eq(conduitAttachments.slug, slug))
    .get();
  if (!row?.uid) throw new Error(`seedDoc: no uid for ${slug}`);
  return row.uid;
}

/** Seed a root version for a doc; returns its uid. */
async function seedVersion(attachmentUid: string, author = 'agent-a'): Promise<string> {
  const { appendConduitAttachmentVersion } = await import('../../store/conduit-doc-history.js');
  const row = await appendConduitAttachmentVersion(tempDir, {
    attachmentUid,
    parentVersionUid: null,
    authorAgentId: author,
    storageKey: `ab/blob-${author}`,
    contentHash: `hash-${author}`,
    originalSize: 10,
    compressedSize: 10,
    tokens: 3,
    tokensAdded: 3,
  });
  return row.uid ?? '';
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-conduit-history-'));
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

describe('conduit doc history accessors (T13354)', () => {
  it('resolves a doc uid by live slug, then by alias, and null for unknown', async () => {
    const { recordConduitDocAlias, resolveConduitDocUid } = await import(
      '../../store/conduit-doc-history.js'
    );
    const uid = await seedDoc('doc-one');
    expect(await resolveConduitDocUid(tempDir, 'doc-one')).toBe(uid);

    await recordConduitDocAlias(tempDir, { slug: 'doc-one-old', docUid: uid, reason: 'rename' });
    expect(await resolveConduitDocUid(tempDir, 'doc-one-old')).toBe(uid);
    expect(await resolveConduitDocUid(tempDir, 'never-existed')).toBeNull();
  });

  it('alias identity is natural: re-recording the same pair is one row', async () => {
    const { recordConduitDocAlias } = await import('../../store/conduit-doc-history.js');
    const uid = await seedDoc('doc-two');
    const first = await recordConduitDocAlias(tempDir, { slug: 'doc-two-old', docUid: uid });
    const second = await recordConduitDocAlias(tempDir, { slug: 'doc-two-old', docUid: uid });
    expect(second).toBe(first);

    const { getDb } = await import('../../store/sqlite.js');
    const { conduitDocSlugAliases } = await import('../../store/schema/cleo-project/conduit.js');
    const db = await getDb(tempDir);
    const rows = await db.select().from(conduitDocSlugAliases).all();
    expect(rows).toHaveLength(1);
  });

  it('appends versions as a DAG: uid identity, parent link, local display ordinal', async () => {
    const { appendConduitAttachmentVersion, listConduitAttachmentVersions } = await import(
      '../../store/conduit-doc-history.js'
    );
    const uid = await seedDoc('doc-three');
    const root = await seedVersion(uid, 'agent-a');
    expect(root).not.toBe('');

    const second = await appendConduitAttachmentVersion(tempDir, {
      attachmentUid: uid,
      parentVersionUid: root,
      authorAgentId: 'agent-b',
      storageKey: 'cd/blob-b',
      contentHash: 'hash-b',
      originalSize: 12,
      compressedSize: 12,
      tokens: 4,
      tokensAdded: 1,
      sectionsModified: ['s1', 's2'],
    });
    expect(second.parentVersionUid).toBe(root);
    expect(second.versionNumber).toBe(2);
    expect(second.uid).not.toBe(root);
    expect(JSON.parse(second.sectionsModified)).toEqual(['s1', 's2']);

    const all = await listConduitAttachmentVersions(tempDir, uid);
    expect(all.map((v) => v.versionNumber)).toEqual([2, 1]);

    // A second doc numbers independently (the ordinal is local display only).
    const other = await seedDoc('doc-other');
    const otherRoot = await seedVersion(other, 'agent-c');
    const otherRow = (await listConduitAttachmentVersions(tempDir, other))[0];
    expect(otherRow?.versionNumber).toBe(1);
    expect(otherRow?.uid).toBe(otherRoot);
  });

  it('history survives the parent: no cascade delete (FK NO ACTION refuses the delete)', async () => {
    const uid = await seedDoc('doc-guard');
    await seedVersion(uid);

    const { getDb } = await import('../../store/sqlite.js');
    const { conduitAttachments } = await import('../../store/schema/cleo-project/conduit.js');
    const { eq } = await import('drizzle-orm');
    const db = await getDb(tempDir);
    let attempt: unknown = null;
    try {
      await db.delete(conduitAttachments).where(eq(conduitAttachments.uid, uid)).run();
    } catch (err) {
      attempt = err;
    }
    expect(attempt).toBeInstanceOf(Error);
    // drizzle wraps driver errors in DrizzleQueryError; the FK text is on the cause.
    const cause = (attempt as { cause?: { message?: string } }).cause;
    expect(cause?.message ?? (attempt as Error).message).toMatch(/FOREIGN KEY/i);
    // The version row is untouched.
    const { listConduitAttachmentVersions } = await import('../../store/conduit-doc-history.js');
    expect(await listConduitAttachmentVersions(tempDir, uid)).toHaveLength(1);
  });

  it('records approvals per version (+ section) and revokes as tombstone rows', async () => {
    const {
      listConduitAttachmentApprovals,
      recordConduitAttachmentApproval,
      revokeConduitAttachmentApproval,
    } = await import('../../store/conduit-doc-history.js');
    const uid = await seedDoc('doc-four');
    const v = await seedVersion(uid);

    await recordConduitAttachmentApproval(tempDir, {
      attachmentUid: uid,
      versionUid: v,
      sectionId: 's1',
      reviewerAgentId: 'reviewer-1',
      versionReviewed: 1,
    });
    await revokeConduitAttachmentApproval(tempDir, {
      attachmentUid: uid,
      versionUid: v,
      sectionId: 's1',
      reviewerAgentId: 'reviewer-1',
      comment: 'withdrawing',
      versionReviewed: 1,
    });

    const rows = await listConduitAttachmentApprovals(tempDir, v);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.status).toBe('approved');
    expect(rows[1]?.status).toBe('revoked');
    expect(rows[1]?.sectionId).toBe('s1');
    // The approval never overwrote the original row.
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
  });

  it('rebuilds the derived contributors rollup from versions', async () => {
    const { rebuildConduitAttachmentContributors } = await import(
      '../../store/conduit-doc-history.js'
    );
    const uid = await seedDoc('doc-five');
    await seedVersion(uid, 'agent-a');
    await seedVersion(uid, 'agent-a');
    await seedVersion(uid, 'agent-b');

    const written = await rebuildConduitAttachmentContributors(tempDir);
    expect(written).toBe(2);

    const { getDb } = await import('../../store/sqlite.js');
    const { conduitAttachmentContributors } = await import(
      '../../store/schema/cleo-project/conduit.js'
    );
    const db = await getDb(tempDir);
    const rows = await db.select().from(conduitAttachmentContributors).all();
    const a = rows.find((r) => r.agentId === 'agent-a');
    const b = rows.find((r) => r.agentId === 'agent-b');
    expect(a?.attachmentUid).toBe(uid);
    expect(a?.versionCount).toBe(2);
    expect(a?.totalTokensAdded).toBe(6);
    expect(b?.versionCount).toBe(1);
    expect(a && b && a.firstContributionAt <= a.lastContributionAt).toBe(true);
  });

  it('keeps the max-HLC head and records losing concurrent heads as conflicts', async () => {
    const { getConduitDocHead, upsertConduitDocHead } = await import(
      '../../store/conduit-doc-history.js'
    );
    const uid = await seedDoc('doc-six');
    const v1 = await seedVersion(uid, 'agent-a');
    // A real sibling version (same DAG parent) — the head FK requires it.
    const { appendConduitAttachmentVersion } = await import('../../store/conduit-doc-history.js');
    const v2 = (
      await appendConduitAttachmentVersion(tempDir, {
        attachmentUid: uid,
        parentVersionUid: v1,
        authorAgentId: 'agent-b',
        storageKey: 'cd/blob-v2',
        contentHash: 'hash-v2',
        originalSize: 12,
        compressedSize: 12,
        tokens: 4,
      })
    ).uid as string;

    const replica = 'f4d5b7e5-4a36-4c39-9f8b-8e2d6a1f2c40';
    const first = await upsertConduitDocHead(tempDir, {
      attachmentUid: uid,
      headVersionUid: v1,
      headHlc: `0000000001000-000000-${replica}`,
    });
    expect(first.advanced).toBe(true);
    expect(first.conflictRecorded).toBe(false);

    // A losing concurrent head (lower HLC, different version) is recorded.
    const loser = await upsertConduitDocHead(tempDir, {
      attachmentUid: uid,
      headVersionUid: v2,
      headHlc: `0000000000999-000000-${replica}`,
    });
    expect(loser.advanced).toBe(false);
    expect(loser.conflictRecorded).toBe(true);
    expect(loser.head.headVersionUid).toBe(v1);
    expect(loser.head.conflictCount).toBe(1);
    const conflict = JSON.parse(loser.head.lastConflictJson ?? '{}') as { versionUid?: string };
    expect(conflict.versionUid).toBe(v2);

    // A higher HLC advances the head.
    const winner = await upsertConduitDocHead(tempDir, {
      attachmentUid: uid,
      headVersionUid: v2,
      headHlc: `0000000002000-000000-${replica}`,
    });
    expect(winner.advanced).toBe(true);
    expect(winner.head.conflictCount).toBe(1);

    // Idempotent re-apply of the same head records nothing.
    const repeat = await upsertConduitDocHead(tempDir, {
      attachmentUid: uid,
      headVersionUid: v2,
      headHlc: `0000000002000-000000-${replica}`,
    });
    expect(repeat.conflictRecorded).toBe(false);
    expect((await getConduitDocHead(tempDir, uid))?.conflictCount).toBe(1);
  });

  it('stores local section CRDT state (local-only) and rebases it on a landed version', async () => {
    const { readSectionCrdtState, rebaseSectionCrdtStates, writeSectionCrdtState } = await import(
      '../../store/conduit-doc-history.js'
    );
    const uid = await seedDoc('doc-seven');

    await writeSectionCrdtState(tempDir, {
      attachmentUid: uid,
      sectionId: 's1',
      snapshot: Buffer.from('loro-bytes-1'),
    });
    const first = await readSectionCrdtState(tempDir, uid, 's1');
    expect(first?.snapshot.toString('utf-8')).toBe('loro-bytes-1');
    expect(first?.baseVersionUid).toBeNull();

    await writeSectionCrdtState(tempDir, {
      attachmentUid: uid,
      sectionId: 's1',
      snapshot: Buffer.from('loro-bytes-2'),
    });
    expect((await readSectionCrdtState(tempDir, uid, 's1'))?.snapshot.toString('utf-8')).toBe(
      'loro-bytes-2',
    );

    await rebaseSectionCrdtStates(tempDir, uid, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    expect((await readSectionCrdtState(tempDir, uid, 's1'))?.baseVersionUid).toBe(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
    expect(await readSectionCrdtState(tempDir, uid, 's2')).toBeNull();
  });
});
