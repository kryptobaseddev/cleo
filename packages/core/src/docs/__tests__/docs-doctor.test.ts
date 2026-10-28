/**
 * `cleo docs doctor` — diagnostics, dry-run purity, repairs, backup gate — T13447.
 *
 * Isolated temp `.cleo/` per test, seeded through the canonical
 * `createAttachmentStore` write path (same harness as
 * docs-update-docversion.test.ts). The backup receipt is a plain temp file —
 * the module only checks existence + mtime freshness.
 *
 * @task T13447 (Epic T13340 / Saga T13339)
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

/** Seed a slugged blob doc through the canonical write path. */
async function seedSlug(slug: string, content: string): Promise<void> {
  const { createAttachmentStore } = await import('../../store/attachment-store.js');
  const store = createAttachmentStore();
  await store.put(
    Buffer.from(content, 'utf-8'),
    { kind: 'blob', storageKey: '', mime: 'text/markdown', size: content.length },
    'task',
    'T9999',
    'docs-doctor-test',
    undefined,
    { slug, type: 'note' },
  );
}

/** Seed a `local-file` row pointing at `path` through the canonical write path. */
async function seedLocalFile(slug: string, path: string): Promise<void> {
  const { createAttachmentStore } = await import('../../store/attachment-store.js');
  const store = createAttachmentStore();
  // Distinct bytes per row: the store dedupes on sha256, so identical
  // content would collapse two local-file seeds onto one attachments row.
  const bytes = Buffer.from(`# pointer ${slug}\n`, 'utf-8');
  await store.put(
    bytes,
    { kind: 'local-file', path, mime: 'text/markdown', size: bytes.length },
    'task',
    'T9999',
    'docs-doctor-test',
    undefined,
    { slug, type: 'note' },
  );
}

/** Read one row by slug straight from the store. */
async function rowBySlug(slug: string) {
  const { eq } = await import('drizzle-orm');
  const { getDb } = await import('../../store/sqlite.js');
  const { attachments } = await import('../../store/tasks-schema.js');
  const db = await getDb(tempDir);
  return db.select().from(attachments).where(eq(attachments.slug, slug)).get();
}

/**
 * Remove the blob-store mirror for `content` — since T13653 the canonical
 * put() mirrors bytes into `.cleo/blobs/blobs/`, so tests that exercise
 * UNMIGRATED rows must delete the mirror to simulate a pre-mirror write.
 */
function removeBlobMirror(content: string): void {
  const sha = createHash('sha256').update(content).digest('hex');
  rmSync(join(tempDir, '.cleo', 'blobs', 'blobs', sha), { force: true });
}

/** Patch arbitrary columns on the slugged row (test scaffolding). */
async function patchRow(slug: string, patch: Record<string, unknown>): Promise<void> {
  const { eq } = await import('drizzle-orm');
  const { getDb } = await import('../../store/sqlite.js');
  const { attachments } = await import('../../store/tasks-schema.js');
  const db = await getDb(tempDir);
  await db.update(attachments).set(patch).where(eq(attachments.slug, slug)).run();
}

/** Write one docs-versioning audit line for `slug` with `revisions` entries. */
function writeAuditLine(slug: string, revisions: number): void {
  const auditDir = join(tempDir, '.cleo', 'audit');
  mkdirSync(auditDir, { recursive: true });
  const now = new Date().toISOString();
  const entry = {
    op: 'docs.update',
    slug,
    firstAt: now,
    lastAt: now,
    revisions: Array.from({ length: revisions }, (_, i) => ({
      ts: now,
      previousSha256: `prev${i}`,
      sha256: `next${i}`,
      changed: true,
      lifecycleStatus: 'draft',
      attachedBy: 'docs-doctor-test',
    })),
  };
  writeFileSync(join(auditDir, 'docs-versioning.jsonl'), `${JSON.stringify(entry)}\n`);
}

/** A fresh backup receipt (plain file — the module only stats its mtime). */
function makeReceipt(): string {
  const receipt = join(tempDir, 'backup-receipt.json');
  writeFileSync(receipt, JSON.stringify({ backupId: 'test' }));
  return receipt;
}

/** A backup receipt whose mtime is one hour old. */
function makeStaleReceipt(): string {
  const receipt = makeReceipt();
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(receipt, old, old);
  return receipt;
}

async function doctor(
  opts: { apply?: boolean; repair?: boolean; olderThanDays?: number; receipt?: string } = {},
) {
  const { runDocsDoctor } = await import('../doctor.js');
  return runDocsDoctor(tempDir, {
    ...(opts.apply !== undefined ? { apply: opts.apply } : {}),
    ...(opts.repair !== undefined ? { repair: opts.repair } : {}),
    ...(opts.olderThanDays !== undefined ? { olderThanDays: opts.olderThanDays } : {}),
    ...(opts.receipt !== undefined ? { backupReceiptPath: opts.receipt } : {}),
  });
}

function diagnostic(report: { diagnostics: ReadonlyArray<{ kind: string }> }, kind: string) {
  const found = report.diagnostics.find((d) => d.kind === kind);
  expect(found, `diagnostic '${kind}' missing from report`).toBeDefined();
  if (!found) throw new Error('unreachable');
  return found;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-doctor-'));
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

describe('runDocsDoctor — diagnostics (T13447)', () => {
  it('flags local-file rows whose path is missing or inside a tmp dir', async () => {
    await seedLocalFile('gone-doc', join(tempDir, 'deleted', 'gone.md'));
    const tmpFile = join(tempDir, 'lives-in-tmp.md');
    writeFileSync(tmpFile, '# here\n');
    await seedLocalFile('tmp-doc', tmpFile);
    // An existing file outside any worktree/tmp dir is NOT dangling.
    await seedLocalFile('ok-doc', join(process.cwd(), 'package.json'));

    const res = await doctor();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const diag = diagnostic(res.report, 'dangling-pointers');
    expect(diag.count).toBe(2);
    const reasons = diag.items.map((i) => `${String(i['slug'])}:${String(i['reason'])}`).sort();
    expect(reasons).toEqual(['gone-doc:missing', 'tmp-doc:tmp']);
  });

  it('flags doc-version-skew when docVersion trails the audit log (revisions + 1)', async () => {
    await seedSlug('skew-doc', '# Doc\n\nv1.\n');
    writeAuditLine('skew-doc', 2); // expected docVersion = 2 + 1 = 3; stored = 1

    const res = await doctor();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const diag = diagnostic(res.report, 'doc-version-skew');
    expect(diag.count).toBe(1);
    expect(diag.items[0]).toMatchObject({ slug: 'skew-doc', docVersion: 1, expected: 3 });
  });

  it('flags empty-provenance on slugged text docs with retrievable content', async () => {
    await seedSlug('prov-doc', '# Note\n\nSee T12345 for the details.\n');
    // Simulate a pre-T13357 legacy row: the write path now derives provenance
    // on put, so NULL the columns back out to get the historical shape.
    await patchRow('prov-doc', { topics: null, relatedTasks: null });

    const res = await doctor();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const diag = diagnostic(res.report, 'empty-provenance');
    expect(diag.count).toBe(1);
    expect(diag.items[0]).toMatchObject({ slug: 'prov-doc' });
  });

  it('flags wikilinks-drift when expected topic edges are absent from docs_wikilinks', async () => {
    await seedSlug('wik-a', '# A\n');
    await seedSlug('wik-b', '# B\n');
    await patchRow('wik-a', { topics: JSON.stringify(['shared']) });
    await patchRow('wik-b', { topics: JSON.stringify(['shared']) });

    const res = await doctor();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const diag = diagnostic(res.report, 'wikilinks-drift');
    expect(diag.count).toBe(2); // wik-a→wik-b and wik-b→wik-a topic edges
  });

  it('reports legacy store surfaces that still exist on disk', async () => {
    mkdirSync(join(tempDir, '.cleo', 'attachments', 'sha256'), { recursive: true });
    writeFileSync(join(tempDir, '.cleo', 'attachments', 'index.db'), '');
    writeFileSync(join(tempDir, '.cleo', 'docs-publications.json'), '{}');

    const res = await doctor();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const diag = diagnostic(res.report, 'legacy-store-present');
    expect(diag.count).toBe(3);
  });

  it('legacy-blob-coverage: error when a content-bearing row has no blob-store counterpart (T13362 AC2)', async () => {
    // store.put mirrors into the blob store since T13653; delete the mirror
    // to simulate a pre-migration (unmigrated) row.
    await seedSlug('unmigrated-doc', '# Not migrated\n');
    removeBlobMirror('# Not migrated\n');

    const res = await doctor();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const diag = diagnostic(res.report, 'legacy-blob-coverage');
    expect(diag.severity).toBe('error');
    expect(diag.count).toBe(1);
    expect(diag.items[0]).toMatchObject({ slug: 'unmigrated-doc' });
  });

  it('legacy-blob-coverage: clean when every content-bearing row has a blob-store counterpart (T13362 AC2)', async () => {
    const content = '# Migrated\n';
    await seedSlug('migrated-doc', content);
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update(content).digest('hex');
    const blobDir = join(tempDir, '.cleo', 'blobs', 'blobs');
    mkdirSync(blobDir, { recursive: true });
    writeFileSync(join(blobDir, sha), content);

    const res = await doctor();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const diag = diagnostic(res.report, 'legacy-blob-coverage');
    expect(diag.severity).toBe('info');
    expect(diag.count).toBe(0);
  });

  it('flags stale drafts past the --older-than-days threshold', async () => {
    await seedSlug('old-draft', '# Old\n');
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await patchRow('old-draft', { createdAt: fortyDaysAgo });

    const res = await doctor();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(diagnostic(res.report, 'stale-drafts').count).toBe(1);

    const lenient = await doctor({ olderThanDays: 60 });
    expect(lenient.ok).toBe(true);
    if (!lenient.ok) return;
    expect(diagnostic(lenient.report, 'stale-drafts').count).toBe(0);
  });
});

describe('runDocsDoctor — dry-run purity (T13447)', () => {
  it('reports the repair plan but writes nothing', async () => {
    await seedSlug('dry-doc', '# Doc\n\nReferences T54321.\n');
    // Legacy-row shape (pre-T13357): the write path derived these on put.
    await patchRow('dry-doc', { topics: null, relatedTasks: null });
    writeAuditLine('dry-doc', 1); // expected 2, stored 1 → skew
    await seedLocalFile('dry-gone', join(tempDir, 'deleted', 'gone.md'));

    const res = await doctor();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.applied).toBe(false);
    expect(res.report.repairs.length).toBeGreaterThan(0);
    expect(res.report.repairs.every((r) => r.applied === false)).toBe(true);

    const row = await rowBySlug('dry-doc');
    expect(row?.docVersion).toBe(1);
    expect(row?.relatedTasks).toBeNull();
    expect(row?.topics).toBeNull();
    const gone = await rowBySlug('dry-gone');
    expect(gone?.lifecycleStatus).toBe('draft');
  });
});

describe('runDocsDoctor — apply (T13447)', () => {
  it('repairs doc-version-skew, backfills empty provenance, archives missing local-file rows', async () => {
    await seedSlug('fix-skew', '# Doc\n\nv1.\n');
    writeAuditLine('fix-skew', 2); // expected 3
    await seedSlug('fix-prov', '# Note\n\nSee T12345 and T67890.\n');
    // Legacy-row shape (pre-T13357): the write path derived these on put.
    await patchRow('fix-prov', { topics: null, relatedTasks: null });
    await seedLocalFile('fix-gone', join(tempDir, 'deleted', 'gone.md'));

    const res = await doctor({ apply: true, receipt: makeReceipt() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.applied).toBe(true);
    expect(res.report.backupReceiptPath).not.toBeNull();

    const skew = await rowBySlug('fix-skew');
    expect(skew?.docVersion).toBe(3);
    const prov = await rowBySlug('fix-prov');
    expect(prov?.relatedTasks).toBe(JSON.stringify(['T12345', 'T67890']));
    expect(prov?.topics).toBeNull(); // no labels → JSON-or-null policy keeps NULL
    const gone = await rowBySlug('fix-gone');
    expect(gone?.lifecycleStatus).toBe('archived');

    const actions = res.report.repairs.map((r) => `${r.kind}:${r.action}`).sort();
    // The seeds are mirrored into the blob store at put time (T13653), so no
    // legacy-blob-coverage backfill entries are planned.
    expect(actions).toEqual([
      'dangling-pointers:archive-dangling',
      'doc-version-skew:set-doc-version',
      // Two provenance rows: fix-prov derived links (applied), fix-skew had
      // nothing derivable (planned-but-noop entry).
      'empty-provenance:backfill-provenance',
      'empty-provenance:backfill-provenance',
      // Chained after the applied backfill: the derived edge set changes even
      // though the pre-repair drift was zero (T13561).
      'wikilinks-drift:rebuild-wikilinks',
    ]);
    const provRepairs = res.report.repairs.filter((r) => r.kind === 'empty-provenance');
    expect(provRepairs.filter((r) => r.applied)).toHaveLength(1);
  });

  it('apply envelope diagnostics reflect POST-repair state (T13560)', async () => {
    await seedSlug('post-skew', '# Doc\n\nSee T99999.\n');
    writeAuditLine('post-skew', 1); // expected 2, stored 1 → skew
    await seedSlug('post-prov', '# Note\n\nSee T12345.\n');
    // Legacy-row shape (pre-T13357): the write path derived these on put.
    await patchRow('post-prov', { topics: null, relatedTasks: null });
    await seedLocalFile('post-gone', join(tempDir, 'deleted', 'gone.md'));

    const res = await doctor({ apply: true, receipt: makeReceipt() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // The archived/skewed/backfilled offenders must NOT echo in the apply
    // envelope's diagnostics — they describe the state AFTER the repairs.
    expect(diagnostic(res.report, 'dangling-pointers').count).toBe(0);
    expect(diagnostic(res.report, 'doc-version-skew').count).toBe(0);
    expect(diagnostic(res.report, 'empty-provenance').count).toBe(0);
    expect(diagnostic(res.report, 'wikilinks-drift').count).toBe(0);
    expect(res.report.summary).toContain('finding(s) remain post-repair');

    // And the envelope must agree with a follow-up dry run on the live store.
    const followUp = await doctor();
    expect(followUp.ok).toBe(true);
    if (!followUp.ok) return;
    for (const d of res.report.diagnostics) {
      expect(diagnostic(followUp.report, d.kind).count).toBe(d.count);
    }
  });

  it('backfill-provenance also writes docs_wikilinks edges (T13561)', async () => {
    await seedSlug('wl-doc', '# Note\n\nSee T55555 for the details.\n');
    // Simulate the pre-T13357 legacy state: columns empty AND no edge rows,
    // so the pre-repair wikilinks-drift is zero while the backfill changes
    // the derived edge set.
    await patchRow('wl-doc', { topics: null, relatedTasks: null });
    const { eq } = await import('drizzle-orm');
    const { getDb } = await import('../../store/sqlite.js');
    const { docsWikilinks } = await import('../../store/schema/attachments.js');
    const db = await getDb(tempDir);
    await db.delete(docsWikilinks).where(eq(docsWikilinks.fromSlug, 'wl-doc')).run();

    const pre = await doctor();
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(diagnostic(pre.report, 'wikilinks-drift').count).toBe(0);

    const res = await doctor({ apply: true, receipt: makeReceipt() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(
      res.report.repairs.some(
        (r) => r.kind === 'wikilinks-drift' && r.action === 'rebuild-wikilinks' && r.applied,
      ),
    ).toBe(true);

    const edges = await db
      .select()
      .from(docsWikilinks)
      .where(eq(docsWikilinks.fromSlug, 'wl-doc'))
      .all();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ toSlug: 'T55555', relation: 'related-task' });

    // Re-run: the drift the backfill created is fully repaired.
    const post = await doctor();
    expect(post.ok).toBe(true);
    if (!post.ok) return;
    expect(diagnostic(post.report, 'wikilinks-drift').count).toBe(0);
  });

  it('excludes archived rows from the dangling-pointers count (T13562a)', async () => {
    await seedLocalFile('archived-gone', join(tempDir, 'deleted', 'gone.md'));
    await seedLocalFile('live-gone', join(tempDir, 'deleted', 'gone-2.md'));
    await patchRow('archived-gone', { lifecycleStatus: 'archived' });

    const res = await doctor();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(diagnostic(res.report, 'dangling-pointers').count).toBe(1);
    expect(res.report.repairs.filter((r) => r.kind === 'dangling-pointers')).toHaveLength(1);

    // Post-apply the archived offender stays excluded — the count drops to
    // zero instead of echoing the pre-repair 2.
    const applied = await doctor({ apply: true, receipt: makeReceipt() });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(diagnostic(applied.report, 'dangling-pointers').count).toBe(0);
  });

  it('clears the stale legacy path on blob rows whose content is alive (T13562b)', async () => {
    await seedSlug('blob-stale', '# Blob doc\n\nBody.\n');
    const row = await rowBySlug('blob-stale');
    expect(row).toBeDefined();
    // Inject the legacy shape: a blob payload carrying a stale source path
    // (e.g. a Linux path recorded on another machine).
    const payload = {
      ...(JSON.parse(row?.attachmentJson ?? '{}') as Record<string, unknown>),
      path: '/mnt/projects/other/deleted.md',
    };
    await patchRow('blob-stale', { attachmentJson: JSON.stringify(payload) });

    const res = await doctor({ apply: true, receipt: makeReceipt() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const clears = res.report.repairs.filter(
      (r) => r.kind === 'dangling-pointers' && r.action === 'clear-stale-path',
    );
    expect(clears).toHaveLength(1);
    expect(clears[0]?.applied).toBe(true);
    expect(diagnostic(res.report, 'dangling-pointers').count).toBe(0);

    const fixed = await rowBySlug('blob-stale');
    const fixedPayload = JSON.parse(fixed?.attachmentJson ?? '{}') as Record<string, unknown>;
    expect(fixedPayload['path']).toBeUndefined();
    expect(fixedPayload['kind']).toBe('blob');
    // Re-point, not archive — the doc stays live.
    expect(fixed?.lifecycleStatus).toBe('draft');
  });

  it('plans no re-point repair for a blob row whose content is gone (T13562b)', async () => {
    await seedSlug('blob-dead', '# Dead blob\n\nBody.\n');
    const row = await rowBySlug('blob-dead');
    const payload = {
      ...(JSON.parse(row?.attachmentJson ?? '{}') as Record<string, unknown>),
      path: '/mnt/projects/other/deleted.md',
    };
    await patchRow('blob-dead', { attachmentJson: JSON.stringify(payload) });
    // Remove the bytes from the content-addressed store (primary + keep-link).
    const { getDb } = await import('../../store/sqlite.js');
    const db = await getDb(tempDir);
    const sha = (await rowBySlug('blob-dead'))?.sha256 ?? '';
    const { rmSync, existsSync } = await import('node:fs');
    for (const p of [
      join(tempDir, '.cleo', 'attachments', 'sha256', sha.slice(0, 2), `${sha.slice(2)}.md`),
      join(tempDir, '.cleo', 'attachments', 'keep', sha.slice(0, 2), sha.slice(2)),
    ]) {
      if (existsSync(p)) rmSync(p);
    }
    void db;

    const res = await doctor();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(diagnostic(res.report, 'dangling-pointers').count).toBe(1);
    expect(
      res.report.repairs.some(
        (r) => r.kind === 'dangling-pointers' && r.action === 'clear-stale-path',
      ),
    ).toBe(false);
  });

  it('rebuilds docs_wikilinks when edges drifted', async () => {
    await seedSlug('rel-a', '# A\n');
    await seedSlug('rel-b', '# B\n');
    await patchRow('rel-a', { topics: JSON.stringify(['shared']) });
    await patchRow('rel-b', { topics: JSON.stringify(['shared']) });

    const res = await doctor({ apply: true, receipt: makeReceipt() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.repairs.some((r) => r.kind === 'wikilinks-drift' && r.applied)).toBe(true);

    const { eq } = await import('drizzle-orm');
    const { getDb } = await import('../../store/sqlite.js');
    const { docsWikilinks } = await import('../../store/schema/attachments.js');
    const db = await getDb(tempDir);
    const edges = await db
      .select()
      .from(docsWikilinks)
      .where(eq(docsWikilinks.fromSlug, 'rel-a'))
      .all();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ toSlug: 'rel-b', relation: 'topic' });
  });

  it('leaves an existing (but ephemeral) local-file row untouched', async () => {
    const tmpFile = join(tempDir, 'still-here.md');
    writeFileSync(tmpFile, '# here\n');
    await seedLocalFile('fix-tmp', tmpFile);

    const res = await doctor({ apply: true, receipt: makeReceipt() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Reported as dangling, but no archive repair was planned or applied —
    // content capture for existing files is T13360's scope.
    expect(diagnostic(res.report, 'dangling-pointers').count).toBe(1);
    expect(res.report.repairs.some((r) => r.kind === 'dangling-pointers')).toBe(false);
    const row = await rowBySlug('fix-tmp');
    expect(row?.lifecycleStatus).toBe('draft');
  });
});

describe('runDocsDoctor — backup gate (T13447)', () => {
  it('refuses apply without a backup receipt', async () => {
    await seedSlug('gate-doc', '# Doc\n');
    const res = await doctor({ apply: true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('E_DOCS_DOCTOR_BACKUP_REQUIRED');
  });

  it('refuses apply with a receipt older than 10 minutes', async () => {
    await seedSlug('gate-stale', '# Doc\n');
    const res = await doctor({ apply: true, receipt: makeStaleReceipt() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('E_DOCS_DOCTOR_BACKUP_STALE');
  });

  it('refuses apply when the receipt path does not exist', async () => {
    const res = await doctor({
      apply: true,
      receipt: join(tempDir, 'no-such-receipt.json'),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('E_DOCS_DOCTOR_BACKUP_REQUIRED');
  });
});

describe('runDocsDoctor — legacy-blob-coverage backfill (T13653)', () => {
  /** True when the blob store holds a file for `content`'s sha256. */
  function blobStoreHas(content: string): boolean {
    const sha = createHash('sha256').update(content).digest('hex');
    return existsSync(join(tempDir, '.cleo', 'blobs', 'blobs', sha));
  }

  it('dry run plans the backfill but writes nothing', async () => {
    await seedSlug('plan-doc', '# Plan only\n');
    removeBlobMirror('# Plan only\n');

    const res = await doctor();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const planned = res.report.repairs.filter(
      (r) => r.kind === 'legacy-blob-coverage' && r.action === 'backfill-blob-bytes',
    );
    expect(planned).toHaveLength(1);
    expect(planned[0]?.applied).toBe(false);
    expect(blobStoreHas('# Plan only\n')).toBe(false);
    // Coverage still errors pre-repair.
    expect(diagnostic(res.report, 'legacy-blob-coverage').count).toBe(1);
  });

  it('--repair mirrors hash-verified legacy bytes into the blob store', async () => {
    const content = '# Unmigrated\n\nReadable after repair.\n';
    await seedSlug('repair-doc', content);
    removeBlobMirror(content); // simulate a pre-mirror write
    expect(blobStoreHas(content)).toBe(false);

    const res = await doctor({ repair: true, receipt: makeReceipt() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.applied).toBe(true);
    expect(blobStoreHas(content)).toBe(true);
    // Post-repair envelope: the coverage diagnostic is clean …
    expect(diagnostic(res.report, 'legacy-blob-coverage').count).toBe(0);
    // … and a follow-up dry run agrees.
    const followUp = await doctor();
    expect(followUp.ok).toBe(true);
    if (!followUp.ok) return;
    expect(diagnostic(followUp.report, 'legacy-blob-coverage').count).toBe(0);
  });

  it('--repair is idempotent: a second run backfills nothing', async () => {
    const content = '# Idempotent\n';
    await seedSlug('idem-doc', content);
    removeBlobMirror(content); // simulate a pre-mirror write
    const first = await doctor({ repair: true, receipt: makeReceipt() });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(blobStoreHas(content)).toBe(true);

    const second = await doctor({ repair: true, receipt: makeReceipt() });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.report.repairs.filter((r) => r.kind === 'legacy-blob-coverage')).toHaveLength(0);
  });

  it('--repair refuses to run without a fresh backup receipt', async () => {
    await seedSlug('gate-repair', '# Doc\n');
    const res = await doctor({ repair: true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('E_DOCS_DOCTOR_BACKUP_REQUIRED');
  });

  it('--repair runs ONLY the backfill: dangling rows are not archived', async () => {
    const content = '# Coverage only\n';
    await seedSlug('cov-doc', content);
    removeBlobMirror(content); // simulate a pre-mirror write
    await seedLocalFile('dangling-stays', join(tempDir, 'deleted', 'gone.md'));

    const res = await doctor({ repair: true, receipt: makeReceipt() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Only legacy-blob-coverage actions in the repair list — and at least
    // one (the cov-doc backfill actually ran).
    expect(res.report.repairs.length).toBeGreaterThan(0);
    expect(res.report.repairs.every((r) => r.kind === 'legacy-blob-coverage')).toBe(true);
    // Backfill happened …
    expect(blobStoreHas(content)).toBe(true);
    // … but the dangling row is untouched.
    const row = await rowBySlug('dangling-stays');
    expect(row?.lifecycleStatus).toBe('draft');
    expect(diagnostic(res.report, 'dangling-pointers').count).toBe(1);
  });

  it('skips (never writes) legacy bytes that fail SHA-256 verification', async () => {
    const content = '# Tampered\n';
    await seedSlug('tamper-doc', content);
    removeBlobMirror(content); // the mirror would otherwise satisfy coverage
    const row = await rowBySlug('tamper-doc');
    const sha = row?.sha256 ?? '';
    const legacyPath = join(
      tempDir,
      '.cleo',
      'attachments',
      'sha256',
      sha.slice(0, 2),
      `${sha.slice(2)}.md`,
    );
    // Corrupt the legacy bytes — the recorded hash no longer matches.
    writeFileSync(legacyPath, '# Tampered by someone else\n');

    const res = await doctor({ repair: true, receipt: makeReceipt() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(blobStoreHas(content)).toBe(false);
    expect(diagnostic(res.report, 'legacy-blob-coverage').count).toBe(1);
    const backfill = res.report.repairs.find((r) => r.kind === 'legacy-blob-coverage');
    expect(backfill?.detail).toContain('SKIPPED');
    expect(backfill?.detail).toContain('SHA-256');
  });

  it('reports (and skips) shas whose legacy bytes are gone', async () => {
    const content = '# Bytes gone\n';
    await seedSlug('gone-bytes', content);
    removeBlobMirror(content); // the mirror would otherwise satisfy coverage
    const row = await rowBySlug('gone-bytes');
    const sha = row?.sha256 ?? '';
    const { rmSync } = await import('node:fs');
    // Primary AND keep-link — either alone still backfills (keep fallback).
    rmSync(join(tempDir, '.cleo', 'attachments', 'sha256', sha.slice(0, 2), `${sha.slice(2)}.md`));
    rmSync(join(tempDir, '.cleo', 'attachments', 'keep', sha.slice(0, 2), sha.slice(2)), {
      force: true,
    });

    const res = await doctor({ repair: true, receipt: makeReceipt() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(blobStoreHas(content)).toBe(false);
    expect(diagnostic(res.report, 'legacy-blob-coverage').count).toBe(1);
    const backfill = res.report.repairs.find((r) => r.kind === 'legacy-blob-coverage');
    expect(backfill?.detail).toContain('no legacy bytes found');
  });

  it('refuses --apply --repair together with a named error and writes nothing (T13654)', async () => {
    const content = '# Flag conflict\n';
    await seedSlug('flag-doc', content);
    removeBlobMirror(content); // a backfill would otherwise land
    const before = (await rowBySlug('flag-doc'))?.lifecycleStatus;

    const res = await doctor({ apply: true, repair: true, receipt: makeReceipt() });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('E_DOCS_DOCTOR_FLAG_CONFLICT');
    // Refusal happens before ANY mutation: no backfill, no repairs.
    expect(blobStoreHas(content)).toBe(false);
    expect((await rowBySlug('flag-doc'))?.lifecycleStatus).toBe(before);
  });

  it('replaces a truncated existing blob-store target from the verified source (T13654)', async () => {
    const content = '# Interrupted write\n';
    await seedSlug('trunc-doc', content);
    const row = await rowBySlug('trunc-doc');
    const sha = row?.sha256 ?? '';
    // Simulate the crash the tmp-then-rename fix prevents: a truncated file
    // already sits at the final content address.
    const target = join(tempDir, '.cleo', 'blobs', 'blobs', sha);
    writeFileSync(target, content.slice(0, 5));

    const res = await doctor({ repair: true, receipt: makeReceipt() });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(readFileSync(target, 'utf-8')).toBe(content);
    expect(diagnostic(res.report, 'legacy-blob-coverage').count).toBe(0);
    // No tmp file left behind.
    expect(
      readdirSync(join(tempDir, '.cleo', 'blobs', 'blobs')).filter((n) => n.includes('.tmp')),
    ).toEqual([]);
  });
});

describe('backfillBlobStoreBytes crash-safety (T13654)', () => {
  /** Seed a legacy source file for `content` and return its sha + path. */
  function seedLegacySource(content: string): { sha: string; sourcePath: string } {
    const sha = createHash('sha256').update(content).digest('hex');
    const sourcePath = join(tempDir, '.cleo', 'attachments', 'sha256', sha.slice(0, 2), 'src.md');
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, content);
    return { sha, sourcePath };
  }

  const targetOf = (sha: string) => join(tempDir, '.cleo', 'blobs', 'blobs', sha);

  it('writes via tmp-then-rename and leaves no tmp file', async () => {
    const { backfillBlobStoreBytes } = await import('../../store/blob-keep.js');
    const content = '# Clean write\n';
    const { sha, sourcePath } = seedLegacySource(content);

    const outcome = await backfillBlobStoreBytes(join(tempDir, '.cleo'), sha, sourcePath);

    expect(outcome).toBe('written');
    expect(readFileSync(targetOf(sha), 'utf-8')).toBe(content);
    expect(
      readdirSync(join(tempDir, '.cleo', 'blobs', 'blobs')).filter((n) => n.includes('.tmp')),
    ).toEqual([]);
  });

  it('returns present and leaves a verified existing target untouched', async () => {
    const { backfillBlobStoreBytes } = await import('../../store/blob-keep.js');
    const content = '# Already good\n';
    const { sha, sourcePath } = seedLegacySource(content);
    mkdirSync(dirname(targetOf(sha)), { recursive: true });
    writeFileSync(targetOf(sha), content);

    const outcome = await backfillBlobStoreBytes(join(tempDir, '.cleo'), sha, sourcePath);

    expect(outcome).toBe('present');
    expect(readFileSync(targetOf(sha), 'utf-8')).toBe(content);
  });

  it('replaces a corrupt existing target and returns written', async () => {
    const { backfillBlobStoreBytes } = await import('../../store/blob-keep.js');
    const content = '# Corrupt target\n';
    const { sha, sourcePath } = seedLegacySource(content);
    mkdirSync(dirname(targetOf(sha)), { recursive: true });
    writeFileSync(targetOf(sha), 'truncated');

    const outcome = await backfillBlobStoreBytes(join(tempDir, '.cleo'), sha, sourcePath);

    expect(outcome).toBe('written');
    expect(readFileSync(targetOf(sha), 'utf-8')).toBe(content);
    // The corrupt bytes are gone — no unhealable 'corrupt blob' state remains.
    expect(
      createHash('sha256')
        .update(readFileSync(targetOf(sha)))
        .digest('hex'),
    ).toBe(sha);
  });

  it('still refuses unverified source bytes even when no target exists', async () => {
    const { backfillBlobStoreBytes } = await import('../../store/blob-keep.js');
    const content = '# Untrusted\n';
    const sha = createHash('sha256').update(content).digest('hex');
    const sourcePath = join(tempDir, '.cleo', 'attachments', 'sha256', sha.slice(0, 2), 'src.md');
    mkdirSync(dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, '# tampered\n');

    const outcome = await backfillBlobStoreBytes(join(tempDir, '.cleo'), sha, sourcePath);

    expect(outcome).toBe('unverified');
    expect(existsSync(targetOf(sha))).toBe(false);
  });
});

describe('runDocsDoctor — publication-ledger-drift (T14117)', () => {
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

  /** Record one ledger row through the canonical accessor. */
  async function publish(blobName: string, publishedPath: string, lastBlobSha: string) {
    const { upsertDocsPublication } = await import('../publications-store.js');
    await upsertDocsPublication(tempDir, {
      ownerId: 'T9999',
      blobName,
      publishedPath,
      lastBlobSha,
    });
  }

  async function ledgerPaths(): Promise<string[]> {
    const { readDocsPublications } = await import('../publications-store.js');
    return (await readDocsPublications(tempDir)).map((r) => r.publishedPath).sort();
  }

  /**
   * Seed four ledger rows: a dead-worktree row and an in-root deleted row
   * whose blob an attachments row still holds, an in-root deleted row that is
   * the only reference to its blob, and a hand-edited (modified) mirror.
   */
  async function seedLedger(): Promise<void> {
    await seedSlug('published-doc', '# published\n');
    const held = sha('# published\n');
    await publish('dead.md', '../gone-worktree/docs/dead.md', held);
    await publish('removed.md', 'docs/removed.md', held);
    await publish('orphan.md', 'docs/orphan.md', sha('only the ledger knows me\n'));
    mkdirSync(join(tempDir, 'docs'), { recursive: true });
    writeFileSync(join(tempDir, 'docs', 'edited.md'), '# edited by hand\n');
    await publish('edited.md', 'docs/edited.md', held);
  }

  it('classifies outside-root, deleted and modified rows with a proposed repair', async () => {
    await seedLedger();
    const result = await doctor();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const diag = diagnostic(result.report, 'publication-ledger-drift');
    expect(diag.count).toBe(4);
    expect(diag.severity).toBe('warn');
    const byPath = new Map(diag.items.map((i) => [i['publishedPath'], i]));
    expect(byPath.get('../gone-worktree/docs/dead.md')).toMatchObject({
      drift: 'deleted',
      outsideRoot: true,
      proposed: 'prune-publication',
    });
    expect(byPath.get('docs/removed.md')).toMatchObject({
      drift: 'deleted',
      outsideRoot: false,
      proposed: 'prune-publication',
    });
    expect(byPath.get('docs/orphan.md')).toMatchObject({ proposed: 'republish-or-prune' });
    expect(byPath.get('docs/edited.md')).toMatchObject({
      drift: 'modified',
      proposed: 'reconcile-edit',
    });
  });

  it('dry run plans the prune but deletes no ledger row and writes no audit', async () => {
    await seedLedger();
    const before = await ledgerPaths();
    const result = await doctor();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const prunes = result.report.repairs.filter((r) => r.action === 'prune-publication');
    expect(prunes).toHaveLength(2);
    expect(prunes.every((r) => !r.applied)).toBe(true);
    expect(await ledgerPaths()).toEqual(before);
    expect(existsSync(join(tempDir, '.cleo', 'audit', 'docs-publications-prune.jsonl'))).toBe(
      false,
    );
  });

  it('apply prunes only protected deleted rows and audits each one first', async () => {
    await seedLedger();
    const result = await doctor({ apply: true, receipt: makeReceipt() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await ledgerPaths()).toEqual(['docs/edited.md', 'docs/orphan.md']);
    const audit = readFileSync(
      join(tempDir, '.cleo', 'audit', 'docs-publications-prune.jsonl'),
      'utf-8',
    )
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { op: string; record: { publishedPath: string } });
    expect(audit.map((a) => a.record.publishedPath).sort()).toEqual([
      '../gone-worktree/docs/dead.md',
      'docs/removed.md',
    ]);
    expect(audit.every((a) => a.op === 'docs.doctor.prune-publication')).toBe(true);
    // Post-repair diagnostics: only the two plan-only rows remain.
    expect(diagnostic(result.report, 'publication-ledger-drift').count).toBe(2);
  });

  it('a pruned row is restorable from its audit line', async () => {
    await seedLedger();
    await doctor({ apply: true, receipt: makeReceipt() });
    const line = readFileSync(
      join(tempDir, '.cleo', 'audit', 'docs-publications-prune.jsonl'),
      'utf-8',
    ).split('\n')[0];
    const { record } = JSON.parse(line ?? '') as {
      record: { ownerId: string; blobName: string; publishedPath: string; lastBlobSha: string };
    };
    await publish(record.blobName, record.publishedPath, record.lastBlobSha);
    expect(await ledgerPaths()).toContain(record.publishedPath);
  });
});
