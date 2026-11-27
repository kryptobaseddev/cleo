/**
 * `cleo docs update` refusal fixes paste as one shell word per argument — T14668.
 *
 * A fix that interpolates a path or slug quotes it, so an absolute macOS path
 * under `Application Support` (or a slug with a space) reads back exactly when
 * pasted. The strict schema-mismatch fix names a command that resolves the
 * refusal (re-run without `--strict`), not a fetch.
 *
 * @task T14668
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-fix-quoting-'));
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

/** Write `bytes` to a file under a directory whose name contains a space. */
async function spacedFile(name: string, bytes: Buffer | string): Promise<string> {
  const dir = join(tempDir, 'Application Support');
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, bytes);
  return file;
}

describe('updateDocBySlug — refusal fixes quote interpolated values (T14668)', () => {
  it('quotes a --file path containing a space', async () => {
    const { updateDocBySlug } = await import('../docs-update.js');
    const file = await spacedFile('body.bin', Buffer.from([0xff, 0xfe, 0x00, 0xc3]));
    const res = await updateDocBySlug(tempDir, {
      slug: 'some-doc',
      file,
      baseVersionUid: 'ver_x',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('E_DOC_BASE_UNSUPPORTED');
    expect(res.error.fix).toBe(`cleo docs update some-doc --file '${file}'`);
  });

  it('quotes a slug containing a space', async () => {
    const { updateDocBySlug } = await import('../docs-update.js');
    const res = await updateDocBySlug(tempDir, { slug: 'no such doc', content: '# X\n' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('E_NOT_FOUND');
    expect(res.error.fix).toBe(`cleo docs add OWNER_ID FILE --slug 'no such doc'`);
  });

  it('names a resolving command for a strict schema mismatch', async () => {
    const { createAttachmentStore } = await import('../../store/attachment-store.js');
    const seed = '## Status\n\n## Date\n\n## Context\n\n## Decision\n\n## Consequences\n';
    await createAttachmentStore().put(
      Buffer.from(seed, 'utf-8'),
      { kind: 'blob', storageKey: '', mime: 'text/markdown', size: seed.length },
      'task',
      'T9999',
      'docs-update-fix-quoting-test',
      undefined,
      { slug: 'adr-0001-quoting', type: 'adr' },
    );
    const { updateDocBySlug } = await import('../docs-update.js');
    const file = await spacedFile('adr.md', '# ADR\n\nNo sections.\n');
    const res = await updateDocBySlug(tempDir, { slug: 'adr-0001-quoting', file, strict: true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('E_DOC_SCHEMA_MISMATCH');
    // Re-running without --strict writes the body; a fetch resolved nothing.
    expect(res.error.fix).toBe(`cleo docs update adr-0001-quoting --file '${file}'`);
  });
});
