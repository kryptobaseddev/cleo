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

import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

async function doctor(opts: { apply?: boolean; olderThanDays?: number; receipt?: string } = {}) {
  const { runDocsDoctor } = await import('../doctor.js');
  return runDocsDoctor(tempDir, {
    ...(opts.apply !== undefined ? { apply: opts.apply } : {}),
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
    expect(actions).toEqual([
      'dangling-pointers:archive-dangling',
      'doc-version-skew:set-doc-version',
      // Two provenance rows: fix-prov derived links (applied), fix-skew had
      // nothing derivable (planned-but-noop entry).
      'empty-provenance:backfill-provenance',
      'empty-provenance:backfill-provenance',
    ]);
    const provRepairs = res.report.repairs.filter((r) => r.kind === 'empty-provenance');
    expect(provRepairs.filter((r) => r.applied)).toHaveLength(1);
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
