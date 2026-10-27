/**
 * `cleo docs update --file <x.md>` keeps the MIME type `docs add` infers
 * (T13918). It stored application/octet-stream, so the readback switched from
 * `content` to `bytesBase64` and a caller reading `content` failed (Axiom,
 * mbx 01M5MPSH8DF5RX8B0A3RC8AZT9).
 *
 * @task T13918
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-update-mime-'));
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

describe('docs update --file keeps the add-time MIME type (T13918)', () => {
  it('a .md update stays text/markdown, so it reads back as content like the add did', async () => {
    const { createAttachmentStore } = await import('../../store/attachment-store.js');
    const { docsUpdateMimeFromPath, updateDocBySlug } = await import('../docs-update.js');
    const { isTextMime } = await import('../fetch-result.js');
    const added = '# Plan\n\nFirst.\n';
    await createAttachmentStore().put(
      Buffer.from(added, 'utf-8'),
      {
        kind: 'blob',
        storageKey: '',
        mime: docsUpdateMimeFromPath('plan.md'),
        size: added.length,
      },
      'task',
      'T9999',
      'docs-update-mime-test',
      undefined,
      { slug: 't13918-plan', type: 'note' },
    );
    const file = join(tempDir, 'plan.md');
    await writeFile(file, '# Plan\n\nSecond.\n');

    const res = await updateDocBySlug(tempDir, { slug: 't13918-plan', file });
    expect(res.ok, JSON.stringify(res)).toBe(true);

    const row = await createAttachmentStore().findBySlug('t13918-plan', tempDir);
    const attachment = row?.metadata.attachment as { mime?: string; storageKey?: string };
    expect(attachment.mime).toBe('text/markdown');
    expect(attachment.storageKey).toMatch(/\.md$/);
    expect(isTextMime(attachment.mime ?? null)).toBe(true);
  });
});
