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
      // Even re-asserting superseded: a content edit would write a new
      // superseded row with no superseded_by.
      { slug: 't12945-old', content: '# Old\n\nEdited.\n', status: 'superseded' as const },
    ]) {
      const res = await updateDocBySlug(tempDir, params);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('E_INVALID_STATUS');
        expect(res.error.message).toMatch(
          /superseded.*cleo docs update t12945-old --status superseded --superseded-by/s,
        );
        // T14660: the command is a structured fix, not only message text.
        expect(res.error.fix).toBe(
          'cleo docs update t12945-old --status superseded --superseded-by NEW_SLUG',
        );
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

describe('updateDocBySlug — status superseded with a successor (T14657)', () => {
  it('records the same successor link the deprecated supersede wrote', async () => {
    const { updateDocBySlug } = await import('../docs-update.js');
    const { supersedeDoc } = await import('../supersede.js');
    await seedSlug('t14657-old-a', '# Old A\n');
    await seedSlug('t14657-new-a', '# New A\n');
    await seedSlug('t14657-old-b', '# Old B\n');
    await seedSlug('t14657-new-b', '# New B\n');

    await supersedeDoc(tempDir, { oldSlug: 't14657-old-a', newSlug: 't14657-new-a' });
    const res = await updateDocBySlug(tempDir, {
      slug: 't14657-old-b',
      status: 'superseded',
      supersededBy: 't14657-new-b',
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    expect(res.result.lifecycleStatus).toBe('superseded');
    expect(res.result.changed).toBe(false);

    const { resolveDocRef, supersessionSlugs } = await import('../slug-rename.js');
    const link = async (oldSlug: string, newSlug: string) => {
      const old = await resolveDocRef(tempDir, oldSlug);
      const next = await resolveDocRef(tempDir, newSlug);
      if (!old || !next) throw new Error(`unresolved ${oldSlug} or ${newSlug}`);
      return {
        status: old.ownRow.lifecycleStatus,
        oldNamesNew: old.ownRow.supersededBy === next.ownRow.id,
        newNamesOld: next.ownRow.supersedes === old.ownRow.id,
        newStatus: next.ownRow.lifecycleStatus,
        // The doctor reads the successor's slug off the identity rows.
        successorSlug: (await supersessionSlugs(tempDir, old)).supersededBy === newSlug,
      };
    };
    const viaSupersede = await link('t14657-old-a', 't14657-new-a');
    expect(viaSupersede).toEqual({
      status: 'superseded',
      oldNamesNew: true,
      newNamesOld: true,
      newStatus: viaSupersede.newStatus,
      successorSlug: true,
    });
    expect(await link('t14657-old-b', 't14657-new-b')).toEqual(viaSupersede);

    // T14660: the docs-versioning audit names the successor.
    const { readFile } = await import('node:fs/promises');
    const { DOCS_VERSIONING_AUDIT_FILE } = await import('../docs-update.js');
    const lines = (await readFile(join(tempDir, DOCS_VERSIONING_AUDIT_FILE), 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { slug: string; revisions: { supersededBy?: string }[] });
    const entry = lines.filter((line) => line.slug === 't14657-old-b').at(-1);
    expect(entry?.revisions.at(-1)?.supersededBy).toBe('t14657-new-b');
    expect(res.result.supersededBy).toBe('t14657-new-b');
  });

  it('refuses a successor with a content edit, another status, an unknown or the same doc', async () => {
    const { updateDocBySlug } = await import('../docs-update.js');
    const sha = await seedSlug('t14657-doc', '# Doc\n');
    await seedSlug('t14657-next', '# Next\n');

    const refused = [
      {
        slug: 't14657-doc',
        content: '# Edit\n',
        status: 'superseded',
        supersededBy: 't14657-next',
      },
      { slug: 't14657-doc', status: 'accepted', supersededBy: 't14657-next' },
      { slug: 't14657-doc', supersededBy: 't14657-next' },
      { slug: 't14657-doc', status: 'superseded', supersededBy: 't14657-missing' },
      { slug: 't14657-doc', status: 'superseded', supersededBy: 't14657-doc' },
    ] as const;
    const codes: string[] = [];
    const fixes: (string | undefined)[] = [];
    for (const params of refused) {
      const res = await updateDocBySlug(tempDir, params);
      expect(res.ok, JSON.stringify(params)).toBe(false);
      if (!res.ok) {
        codes.push(res.error.code);
        fixes.push(res.error.fix);
      }
    }
    // T14660: every refusal carries a structured, runnable fix.
    expect(fixes).toEqual([
      'cleo docs update t14657-doc --status superseded --superseded-by t14657-next',
      'cleo docs update t14657-doc --status superseded --superseded-by t14657-next',
      'cleo docs update t14657-doc --status superseded --superseded-by t14657-next',
      'cleo docs add OWNER_ID FILE --slug t14657-missing',
      'cleo docs update t14657-doc --status superseded --superseded-by NEW_SLUG',
    ]);
    expect(codes).toEqual([
      'E_INVALID_INPUT',
      'E_INVALID_INPUT',
      'E_INVALID_INPUT',
      'E_NOT_FOUND',
      'E_INVALID_INPUT',
    ]);
    const { resolveDocRef } = await import('../slug-rename.js');
    const ref = await resolveDocRef(tempDir, 't14657-doc');
    expect(ref?.ownRow.lifecycleStatus).not.toBe('superseded');
    expect(ref?.ownRow.supersededBy ?? null).toBeNull();
    expect(ref?.sha256).toBe(sha);
  });
});
