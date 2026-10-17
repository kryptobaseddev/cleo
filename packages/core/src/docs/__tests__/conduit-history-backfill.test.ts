/**
 * T13727 — conduit history backfill + `docs versions` routing.
 *
 * Fixtures recreate the diagnosed pre-adoption shape: a doc at docVersion 3
 * whose updates all predated the conduit adoption, so `conduit_attachments`
 * holds the doc (adopted later) with ONE native version row (the first
 * post-adoption update, minted local ordinal 1, content = version 3), and
 * the history for versions 1..2 lives only in the docs-versioning audit log
 * plus the surviving registry/blob bytes. The backfill must synthesize those
 * rows honestly, idempotently, and `listDocVersions` must then list every
 * version BY SLUG from the conduit rows.
 *
 * Temp-dir harness per test (same pattern as docs-doctor.test.ts).
 *
 * @task T13727
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

const SLUG = 't13727-multi-version-doc';

// Real content addresses, computed from the actual bytes (honesty: the
// backfill rows must address real, hash-verified bytes).
const V1_TEXT = '# t13727 doc\n\nversion one\n';
const V2_TEXT = '# t13727 doc\n\nversion two\n';
const V3_TEXT = '# t13727 doc\n\nversion three\n';
const SHA1 = createHash('sha256').update(V1_TEXT).digest('hex');
const SHA2 = createHash('sha256').update(V2_TEXT).digest('hex');
const SHA3 = createHash('sha256').update(V3_TEXT).digest('hex');

/** Fixed pre-adversioning timeline: v1 created, then two changed updates. */
const T0 = '2026-10-01T09:00:00.000Z';
const T1 = '2026-10-02T09:00:00.000Z';
const T2 = '2026-10-03T09:00:00.000Z';

/** Seed one docs_attachments registry row (the pre-adoption write shape). */
async function seedRegistryRow(opts: {
  sha256: string;
  size: number;
  docVersion: number;
  createdAt: string;
  slug: string | null;
}): Promise<void> {
  const { getDb } = await import('../../store/sqlite.js');
  const { docsAttachments } = await import('../../store/tasks-schema.js');
  const db = await getDb(tempDir);
  await db
    .insert(docsAttachments)
    .values({
      id: `att-${opts.docVersion}-${opts.sha256.slice(0, 8)}`,
      sha256: opts.sha256,
      attachmentJson: JSON.stringify({
        kind: 'blob',
        sha256: opts.sha256,
        storageKey: `${opts.sha256.slice(0, 2)}/${opts.sha256.slice(2)}.txt`,
        mime: 'text/plain',
        size: opts.size,
      }),
      createdAt: opts.createdAt,
      slug: opts.slug,
      docVersion: opts.docVersion,
    })
    .run();
}

/** Write historical bytes to the legacy attachment tree (pre-mirror era). */
function seedLegacyBytes(text: string, sha256: string): void {
  const path = join(
    tempDir,
    '.cleo',
    'attachments',
    'sha256',
    sha256.slice(0, 2),
    `${sha256.slice(2)}.txt`,
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf-8');
}

/** Write the docs-versioning audit log: two changed revisions (v1→v2→v3). */
function seedAuditLog(): void {
  const auditDir = join(tempDir, '.cleo', 'audit');
  mkdirSync(auditDir, { recursive: true });
  const line = (ts: string, previousSha256: string, sha256: string, attachedBy: string) =>
    JSON.stringify({
      op: 'docs.update',
      slug: SLUG,
      firstAt: ts,
      lastAt: ts,
      revisions: [{ ts, previousSha256, sha256, changed: true, attachedBy }],
    });
  writeFileSync(
    join(auditDir, 'docs-versioning.jsonl'),
    `${line(T1, SHA1, SHA2, 'agent-updater-one')}\n${line(T2, SHA2, SHA3, 'agent-updater-two')}\n`,
    'utf-8',
  );
}

/**
 * The diagnosed fixture: registry rows for versions 1..3 (historical rows
 * re-homed to slug NULL, current row slugged at docVersion 3), legacy bytes
 * for every version, the audit log, an adopted conduit doc, and ONE native
 * conduit version row (the first post-adoption update, minted ordinal 1,
 * content = version 3) with its merged-text blob.
 */
async function seedPreAdoptionDoc(opts: { omitBytesForSha256?: string } = {}): Promise<string> {
  await seedRegistryRow({
    sha256: SHA1,
    size: V1_TEXT.length,
    docVersion: 1,
    createdAt: T0,
    slug: null,
  });
  await seedRegistryRow({
    sha256: SHA2,
    size: V2_TEXT.length,
    docVersion: 2,
    createdAt: T1,
    slug: null,
  });
  await seedRegistryRow({
    sha256: SHA3,
    size: V3_TEXT.length,
    docVersion: 3,
    createdAt: T2,
    slug: SLUG,
  });
  seedAuditLog();
  for (const [text, sha] of [
    [V1_TEXT, SHA1],
    [V2_TEXT, SHA2],
  ] as const) {
    if (sha === opts.omitBytesForSha256) continue;
    seedLegacyBytes(text, sha);
  }

  const { ensureConduitDoc, appendConduitAttachmentVersion } = await import(
    '../../store/conduit-doc-history.js'
  );
  const { uid } = await ensureConduitDoc(tempDir, {
    slug: SLUG,
    authorAgentId: 'human',
    content: Buffer.from(V3_TEXT, 'utf-8'),
  });

  // The first post-adoption update: minted local ordinal 1 (empty table),
  // content = version 3 — the exact row the T13725 diagnosis found.
  const storageKey = `${SHA3.slice(0, 2)}/${SHA3.slice(2)}.md`;
  const mergedPath = join(tempDir, '.cleo', 'attachments', 'sha256', storageKey);
  mkdirSync(dirname(mergedPath), { recursive: true });
  writeFileSync(mergedPath, V3_TEXT, 'utf-8');
  await appendConduitAttachmentVersion(tempDir, {
    attachmentUid: uid,
    parentVersionUid: null,
    authorAgentId: 'human',
    storageKey,
    contentHash: SHA3,
    originalSize: V3_TEXT.length,
    compressedSize: V3_TEXT.length,
    tokens: 5,
  });
  return uid;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-conduit-backfill-'));
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

describe('planConduitHistoryBackfill (T13727)', () => {
  it('plans the two missing pre-adoption versions for the diagnosed doc (docVersion 3, one conduit row)', async () => {
    await seedPreAdoptionDoc();
    const { planConduitHistoryBackfill } = await import('../conduit-history-backfill.js');

    const plans = await planConduitHistoryBackfill(tempDir);
    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    expect(plan.slug).toBe(SLUG);
    expect(plan.expectedVersions).toBe(3);
    expect(plan.existingVersions).toBe(1);
    expect(plan.complete).toBe(false);
    expect(plan.conflict).toBe(false);
    expect(plan.toBackfill).toHaveLength(2);
    expect(plan.gaps).toHaveLength(0);

    // Honest metadata: real hashes, real revision authors/timestamps, the
    // system label only for the unrecoverable original author.
    const [v1, v2] = plan.toBackfill;
    expect(v1!.position).toBe(1);
    expect(v1!.sha256).toBe(SHA1);
    expect(v1!.authorAgentId).toBe('cleo:backfill-t13727');
    expect(v1!.createdAt).toBe(T0); // the surviving registry row's creation instant
    expect(v1!.parentPosition).toBeNull();
    expect(v2!.position).toBe(2);
    expect(v2!.sha256).toBe(SHA2);
    expect(v2!.authorAgentId).toBe('agent-updater-one');
    expect(v2!.createdAt).toBe(T1);
    expect(v2!.parentPosition).toBe(1);
    expect(v1!.sizeBytes).toBe(V1_TEXT.length);
    expect(v2!.tokens).toBeGreaterThan(0);
  });

  it('is pure: planning twice yields identical plans and writes nothing', async () => {
    await seedPreAdoptionDoc();
    const { planConduitHistoryBackfill } = await import('../conduit-history-backfill.js');
    const { listConduitAttachmentVersions } = await import('../../store/conduit-doc-history.js');

    const first = await planConduitHistoryBackfill(tempDir);
    const second = await planConduitHistoryBackfill(tempDir);
    expect(second).toEqual(first);
    const uid = first[0]!.docUid;
    expect(await listConduitAttachmentVersions(tempDir, uid)).toHaveLength(1);
  });

  it('counts unrecoverable bytes as an explicit gap instead of fabricating content', async () => {
    await seedPreAdoptionDoc({ omitBytesForSha256: SHA2 });
    const { planConduitHistoryBackfill } = await import('../conduit-history-backfill.js');

    const plan = (await planConduitHistoryBackfill(tempDir))[0]!;
    expect(plan.toBackfill).toHaveLength(1);
    expect(plan.toBackfill[0]!.sha256).toBe(SHA1);
    expect(plan.gaps).toEqual([{ position: 2, sha256: SHA2 }]);
  });

  it('refuses (conflict) when the existing conduit row contradicts the audit chain', async () => {
    await seedPreAdoptionDoc();
    const { getDb } = await import('../../store/sqlite.js');
    const { conduitAttachmentVersions } = await import(
      '../../store/schema/cleo-project/conduit.js'
    );
    const { eq } = await import('drizzle-orm');
    const db = await getDb(tempDir);
    // Corrupt the native row's hash: the chain tail no longer aligns.
    await db
      .update(conduitAttachmentVersions)
      .set({ contentHash: '0'.repeat(64) })
      .where(eq(conduitAttachmentVersions.contentHash, SHA3))
      .run();

    const { planConduitHistoryBackfill } = await import('../conduit-history-backfill.js');
    const plan = (await planConduitHistoryBackfill(tempDir))[0]!;
    expect(plan.conflict).toBe(true);
    expect(plan.toBackfill).toHaveLength(0);
  });
});

describe('applyConduitHistoryBackfill (T13727)', () => {
  it('inserts honest rows (origin backfill-t13727, changeType migrated) chained by parent uid', async () => {
    const uid = await seedPreAdoptionDoc();
    const { planConduitHistoryBackfill, applyConduitHistoryBackfill } = await import(
      '../conduit-history-backfill.js'
    );
    const { listConduitAttachmentVersions } = await import('../../store/conduit-doc-history.js');

    const plan = (await planConduitHistoryBackfill(tempDir))[0]!;
    const result = await applyConduitHistoryBackfill(tempDir, plan);
    expect(result.inserted).toBe(2);
    expect(result.gaps).toBe(0);

    const rows = await listConduitAttachmentVersions(tempDir, uid);
    expect(rows).toHaveLength(3);
    const byHash = new Map(rows.map((r) => [r.contentHash, r]));
    const v1 = byHash.get(SHA1)!;
    const v2 = byHash.get(SHA2)!;
    const v3 = byHash.get(SHA3)!;

    // Parent chain in ascending version order; the pre-existing native row
    // (minted ordinal 1) keeps its identity untouched.
    expect(v1.parentVersionUid).toBeNull();
    expect(v2.parentVersionUid).toBe(v1.uid);
    expect(v3.parentVersionUid).toBeNull(); // history — not rewritten

    // Honesty contract pinned: provenance labels, real authors, real times.
    expect(v1.origin).toBe('backfill-t13727');
    expect(v2.origin).toBe('backfill-t13727');
    expect(v3.origin).toBeNull(); // natively written
    expect(v1.changeType).toBe('migrated');
    expect(v1.authorAgentId).toBe('cleo:backfill-t13727');
    expect(v2.authorAgentId).toBe('agent-updater-one');
    expect(v1.createdAt).toBe(T0);
    expect(v2.createdAt).toBe(T1);
    expect(v1.slug).toBe(SLUG);
    expect(v1.storageKey).toBe(`sha256:${SHA1}`);
  });

  it('is idempotent: a second run inserts nothing (row count equals docVersion)', async () => {
    const uid = await seedPreAdoptionDoc();
    const { planConduitHistoryBackfill, applyConduitHistoryBackfill } = await import(
      '../conduit-history-backfill.js'
    );
    const { listConduitAttachmentVersions } = await import('../../store/conduit-doc-history.js');

    const first = (await planConduitHistoryBackfill(tempDir))[0]!;
    await applyConduitHistoryBackfill(tempDir, first);
    expect(await listConduitAttachmentVersions(tempDir, uid)).toHaveLength(3);

    const second = (await planConduitHistoryBackfill(tempDir))[0]!;
    expect(second.complete).toBe(true);
    expect(second.toBackfill).toHaveLength(0);
    const rerun = await applyConduitHistoryBackfill(tempDir, second);
    expect(rerun.inserted).toBe(0);
    expect(await listConduitAttachmentVersions(tempDir, uid)).toHaveLength(3);
  });

  it('links across an unrecoverable gap and reports it', async () => {
    const uid = await seedPreAdoptionDoc({ omitBytesForSha256: SHA2 });
    const { planConduitHistoryBackfill, applyConduitHistoryBackfill } = await import(
      '../conduit-history-backfill.js'
    );
    const { listConduitAttachmentVersions } = await import('../../store/conduit-doc-history.js');

    const plan = (await planConduitHistoryBackfill(tempDir))[0]!;
    const result = await applyConduitHistoryBackfill(tempDir, plan);
    expect(result.inserted).toBe(1);
    expect(result.gaps).toBe(1);

    const rows = await listConduitAttachmentVersions(tempDir, uid);
    expect(rows).toHaveLength(2);
    const byHash = new Map(rows.map((r) => [r.contentHash, r]));
    expect(byHash.has(SHA2)).toBe(false); // never fabricated
    expect(byHash.get(SHA1)!.parentVersionUid).toBeNull();
  });

  it('writes nothing for a conflicting plan', async () => {
    const uid = await seedPreAdoptionDoc();
    const { getDb } = await import('../../store/sqlite.js');
    const { conduitAttachmentVersions } = await import(
      '../../store/schema/cleo-project/conduit.js'
    );
    const { eq } = await import('drizzle-orm');
    const db = await getDb(tempDir);
    await db
      .update(conduitAttachmentVersions)
      .set({ contentHash: '0'.repeat(64) })
      .where(eq(conduitAttachmentVersions.contentHash, SHA3))
      .run();

    const { planConduitHistoryBackfill, applyConduitHistoryBackfill } = await import(
      '../conduit-history-backfill.js'
    );
    const { listConduitAttachmentVersions } = await import('../../store/conduit-doc-history.js');
    const plan = (await planConduitHistoryBackfill(tempDir))[0]!;
    const result = await applyConduitHistoryBackfill(tempDir, plan);
    expect(result.inserted).toBe(0);
    expect(await listConduitAttachmentVersions(tempDir, uid)).toHaveLength(1);
  });
});

describe('docs versions routing + backfill (T13727 acceptance)', () => {
  it('a multi-version doc lists EVERY version by slug from the conduit rows after backfill', async () => {
    await seedPreAdoptionDoc();
    const { planConduitHistoryBackfill, applyConduitHistoryBackfill } = await import(
      '../conduit-history-backfill.js'
    );
    const plan = (await planConduitHistoryBackfill(tempDir))[0]!;
    await applyConduitHistoryBackfill(tempDir, plan);

    const { listDocVersions } = await import('../docs-ops.js');
    const result = await listDocVersions({ ownerId: SLUG, projectRoot: tempDir });

    expect(result.ownerId).toBe(SLUG);
    expect(result.versions).toHaveLength(3);
    // Newest first by the real timestamps: v3 (native, written now), v2, v1.
    expect(result.versions.map((v) => v.sha256)).toEqual([SHA3, SHA2, SHA1]);
    for (const entry of result.versions) {
      expect(entry.name).toBe(SLUG);
      expect(entry.attachmentId).toBe(entry.sha256);
      expect(entry.sizeBytes).toBeGreaterThan(0);
    }
    // docVersion present on every entry (display ordinal — pins the field).
    expect(result.versions.map((v) => v.docVersion).sort()).toEqual([1, 1, 2]);
  });

  it('falls back to the manifest listing for a doc slug with no conduit rows (never regresses)', async () => {
    // Registry row only — never adopted.
    await seedRegistryRow({
      sha256: SHA1,
      size: V1_TEXT.length,
      docVersion: 1,
      createdAt: T0,
      slug: 't13727-never-adopted',
    });
    seedLegacyBytes(V1_TEXT, SHA1);

    const { listDocVersions } = await import('../docs-ops.js');
    const result = await listDocVersions({
      ownerId: 't13727-never-adopted',
      projectRoot: tempDir,
    });
    // Never adopted → no conduit rows → manifest/registry fallback, which
    // finds no blobs for the slug and lists empty rather than regressing.
    expect(result.versions).toHaveLength(0);
  });
});

describe('cleo docs doctor wiring (T13727)', () => {
  function makeReceipt(): string {
    const receipt = join(tempDir, 'backup-receipt.json');
    writeFileSync(receipt, JSON.stringify({ backupId: 'test' }));
    return receipt;
  }

  it('dry run plans the backfill without writing; apply executes it and the post-scan is clean', async () => {
    await seedPreAdoptionDoc();
    const { runDocsDoctor } = await import('../doctor.js');

    const dry = await runDocsDoctor(tempDir, {});
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    const diag = dry.report.diagnostics.find((d) => d.kind === 'conduit-history-gaps');
    expect(diag?.count).toBe(1);
    expect(diag?.severity).toBe('warn');
    const planned = dry.report.repairs.filter((r) => r.action === 'backfill-conduit-versions');
    expect(planned).toHaveLength(1);
    expect(planned[0]!.applied).toBe(false);
    expect(dry.report.summary).toContain('conduit history');

    const applied = await runDocsDoctor(tempDir, { apply: true, backupReceiptPath: makeReceipt() });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const executed = applied.report.repairs.filter((r) => r.action === 'backfill-conduit-versions');
    expect(executed).toHaveLength(1);
    expect(executed[0]!.applied).toBe(true);
    expect(executed[0]!.detail).toContain('2 row(s) inserted');
    // Post-repair re-scan: the doc is complete, the diagnostic is clean.
    const postDiag = applied.report.diagnostics.find((d) => d.kind === 'conduit-history-gaps');
    expect(postDiag?.count).toBe(0);
  });

  it('--repair mode stays the T13653 blob-only path and does not plan conduit repairs', async () => {
    await seedPreAdoptionDoc();
    const { runDocsDoctor } = await import('../doctor.js');

    const result = await runDocsDoctor(tempDir, { repair: true, backupReceiptPath: makeReceipt() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.report.repairs.filter((r) => r.action === 'backfill-conduit-versions'),
    ).toHaveLength(0);
    // The diagnostic is still visible in every mode.
    expect(result.report.diagnostics.find((d) => d.kind === 'conduit-history-gaps')?.count).toBe(1);
  });
});
