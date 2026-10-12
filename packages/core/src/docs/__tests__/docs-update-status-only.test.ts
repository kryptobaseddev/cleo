/**
 * `cleo docs update <slug> --status <s>` alone is a lifecycle-only change — T12654.
 *
 * `--help` advertises every docs lifecycle status for `--status`, but an
 * update without `--file`/`--content` was refused, so a spec could not be
 * accepted without re-supplying its bytes (two agents hit it on 2026-09-28;
 * specs stayed at draft/proposed). {@link updateDocBySlug} now accepts
 * `status` alone and keeps the stored bytes.
 *
 * Isolated temp `.cleo/` per test, seeded through the canonical
 * `createAttachmentStore` write path (same pattern as display-alias.test.ts).
 *
 * @task T12654
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCS_LIFECYCLE_STATUSES } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

/** Seed an attachment row carrying `slug`. */
async function seedSlug(slug: string, content: string): Promise<string> {
  const { createAttachmentStore } = await import('../../store/attachment-store.js');
  const store = createAttachmentStore();
  const put = await store.put(
    Buffer.from(content, 'utf-8'),
    { kind: 'blob', storageKey: '', mime: 'text/markdown', size: content.length },
    'task',
    'T9999',
    'docs-update-status-only-test',
    undefined,
    { slug, type: 'note' },
  );
  return put.sha256;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-status-only-'));
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

describe('updateDocBySlug — status alone (T12654)', () => {
  it('applies every advertised lifecycle status without touching the bytes', async () => {
    const { updateDocBySlug } = await import('../docs-update.js');
    const sha = await seedSlug('t12654-spec', '# Spec\n\nBody.\n');

    // superseded is sticky (T12945), so it is applied last.
    const ordered = [...DOCS_LIFECYCLE_STATUSES.filter((s) => s !== 'superseded'), 'superseded'];
    for (const status of ordered) {
      const res = await updateDocBySlug(tempDir, { slug: 't12654-spec', status });
      expect(res.ok, `status ${status}: ${JSON.stringify(res)}`).toBe(true);
      if (!res.ok) continue;
      expect(res.result.lifecycleStatus).toBe(status);
      expect(res.result.changed).toBe(false);
      expect(res.result.sha256).toBe(sha);
    }

    const { createAttachmentStore } = await import('../../store/attachment-store.js');
    const row = await createAttachmentStore().findBySlug('t12654-spec', tempDir);
    expect(row?.lifecycleStatus).toBe('superseded');
  });

  it('refuses to leave superseded by --status or by a content edit, writing nothing (T12945)', async () => {
    const { updateDocBySlug } = await import('../docs-update.js');
    const sha = await seedSlug('t12945-old', '# Old\n\nBody.\n');
    expect((await updateDocBySlug(tempDir, { slug: 't12945-old', status: 'superseded' })).ok).toBe(
      true,
    );
    for (const params of [
      { slug: 't12945-old', status: 'accepted' as const },
      { slug: 't12945-old', content: '# Old\n\nEdited.\n' },
    ]) {
      const res = await updateDocBySlug(tempDir, params);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('E_INVALID_STATUS');
        expect(res.error.message).toMatch(/superseded.*cleo docs supersede t12945-old/s);
      }
    }
    // The origin keeps the doc superseded with its bytes, as every synced peer does.
    const { createAttachmentStore } = await import('../../store/attachment-store.js');
    const row = await createAttachmentStore().findBySlug('t12945-old', tempDir);
    expect(row?.lifecycleStatus).toBe('superseded');
    expect(row?.metadata.sha256).toBe(sha);
    // Re-asserting superseded is allowed.
    expect((await updateDocBySlug(tempDir, { slug: 't12945-old', status: 'superseded' })).ok).toBe(
      true,
    );
  });

  it('still rejects an update with no file, no content and no status', async () => {
    const { updateDocBySlug } = await import('../docs-update.js');
    await seedSlug('t12654-bare', 'x\n');
    const res = await updateDocBySlug(tempDir, { slug: 't12654-bare' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('E_INVALID_INPUT');
  });

  it('still rejects file and content together', async () => {
    const { updateDocBySlug } = await import('../docs-update.js');
    const res = await updateDocBySlug(tempDir, {
      slug: 't12654-both',
      file: join(tempDir, 'x.md'),
      content: 'y',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/mutually exclusive/);
  });
});
