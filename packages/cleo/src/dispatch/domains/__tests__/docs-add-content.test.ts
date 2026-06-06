/**
 * Integration test for `cleo docs add --content` inline authoring (T10965).
 *
 * Exercises the inline-content branch of the docs.add dispatch handler
 * end-to-end against a real tasks.db + manifest.db mirror in an isolated
 * temp `CLEO_DIR`. Asserts that an inline body:
 *   - persists as a content-addressed `blob` attachment,
 *   - round-trips byte-for-byte through the canonical DocsReadModel
 *     (so the manifest.db mirror is wired exactly as a file-sourced add),
 *   - rejects multi-source input and missing-source input.
 *
 * @task T10965
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocsHandler } from '../docs.js';

let tempDir: string;

describe('docs.add --content inline authoring (T10965)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-add-content-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  });

  afterEach(async () => {
    const { closeDb } = await import('@cleocode/core/internal');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('persists inline content as a blob and round-trips via the read model', async () => {
    const handler = new DocsHandler();
    const body = '# Inline Doc\n\nAuthored with --content, no file on disk.\n';

    const response = await handler.mutate('add', {
      ownerId: 'T960',
      content: body,
      slug: 'inline-doc',
      attachedBy: 'content-test',
    });

    expect(response.success).toBe(true);
    expect(response.error).toBeUndefined();

    const data = response.data as {
      attachmentId: string;
      sha256: string;
      kind: string;
      ownerId: string;
      slug?: string;
      refCount: number;
    };
    expect(data.kind).toBe('blob');
    expect(data.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.ownerId).toBe('T960');
    expect(data.slug).toBe('inline-doc');
    expect(data.refCount).toBeGreaterThanOrEqual(1);

    // Round-trip: the canonical read model must resolve the slug AND return
    // the exact bytes — proving the manifest.db mirror is wired like a
    // file-sourced add (not a tasks.db-only orphan).
    const { createDocsReadModel } = await import('@cleocode/core/internal');
    const model = createDocsReadModel();
    const decoded = await model.fetchDecoded('inline-doc');
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.content).toBe(body);
      expect(decoded.doc.sha256).toBe(data.sha256);
    }
  });

  it('reads body from a string and reports E_INVALID_INPUT when no source is given', async () => {
    const handler = new DocsHandler();
    const response = await handler.mutate('add', { ownerId: 'T961' });
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_INVALID_INPUT');
  });

  it('rejects combining --content with a file source', async () => {
    const handler = new DocsHandler();
    const response = await handler.mutate('add', {
      ownerId: 'T962',
      content: 'inline',
      file: '/tmp/does-not-need-to-exist.md',
    });
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_INVALID_INPUT');
    expect(response.error?.message).toContain('mutually exclusive');
  });

  it('rejects combining --content with a url source', async () => {
    const handler = new DocsHandler();
    const response = await handler.mutate('add', {
      ownerId: 'T963',
      content: 'inline',
      url: 'https://example.com/spec',
    });
    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('E_INVALID_INPUT');
  });

  it('accepts an empty inline body (valid zero-length doc)', async () => {
    const handler = new DocsHandler();
    const response = await handler.mutate('add', {
      ownerId: 'T964',
      content: '',
      slug: 'empty-doc',
    });
    expect(response.success).toBe(true);
    const data = response.data as { kind: string; slug?: string };
    expect(data.kind).toBe('blob');
    expect(data.slug).toBe('empty-doc');
  });
});
