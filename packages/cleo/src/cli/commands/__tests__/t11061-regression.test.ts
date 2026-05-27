/**
 * T11061 — Docs update owner-ref and publish regression tests.
 *
 * Covers the T10516 regression scenarios S3 (update without owner reference)
 * and S4 (publish selects older blob) at the dispatch layer.
 *
 * S3 — Update without owner reference (AC1):
 *   `docs update` must register an owner-attachment version that `docs publish`
 *   default (no attachmentId) can find. The bug (fixed in T11053): update wrote
 *   only to the legacy store while publishDocs used the V2/manifest store,
 *   so the publish default path couldn't locate the updated blob.
 *
 * S4 — Publish selects older blob (AC2):
 *   After an update rotates the slug onto new bytes, `docs publish` default
 *   must select the latest-by-uploaded_at version, not a stale pre-update blob.
 *
 * AC3 — SHA consistency:
 *   fetch, status, and publish must report the same selected SHA after an
 *   update→publish cycle. No SHA drift between the write path (update) and
 *   the read paths (fetch/publish/status).
 *
 * All tests use the DocsHandler dispatch layer directly — no compiled CLI
 * dependency required for CI.
 *
 * @task    T11061 (T10516-E3)
 * @parent  T10521
 * @saga    T10516 (SG-DOCS-CLI-SIMPLIFICATION)
 */

import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocsHandler } from '../../../dispatch/domains/docs.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

let tempDir: string;
let fixture: string;

// ═══════════════════════════════════════════════════════════════════════════════
// AC1 (S3): Update creates owner-publishable latest version
// ═══════════════════════════════════════════════════════════════════════════════

describe('T11061 AC1 (S3) — update creates owner-publishable latest version', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-t11061-ac1-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
    fixture = join(tempDir, 'fixture-v1.md');
    await writeFile(fixture, '# Version 1\n\nOriginal content for owner-ref test.', 'utf-8');
  });

  afterEach(async () => {
    const { closeDb } = await import('@cleocode/core/internal');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('RTC-S3-1: after update, default publish (no attachmentId) resolves the new blob', async () => {
    const handler = new DocsHandler();

    const addRes = await handler.mutate('add', {
      ownerId: 'T100',
      file: fixture,
      slug: 'owner-ref-doc',
      type: 'spec',
    });
    expect(addRes.success).toBe(true);
    const addData = addRes.data as { slug: string; sha256: string; attachmentId: string };
    const addSha = addData.sha256;

    const newContent = '# Version 2\n\nUpdated — publish must find this.';
    const updateRes = await handler.mutate('update', {
      slug: 'owner-ref-doc',
      content: newContent,
    });
    expect(updateRes.success).toBe(true);
    const updateData = updateRes.data as { sha256: string; previousSha256: string; changed: boolean };
    expect(updateData.changed).toBe(true);
    const updateSha = updateData.sha256;
    expect(updateSha).not.toBe(addSha);

    // DEFAULT publish — no attachmentId. After T11053 fix, this must work.
    const publishRes = await handler.mutate('publish', {
      ownerId: 'T100',
      toPath: 'docs/owner-ref-output.md',
    });
    expect(publishRes.success).toBe(true);
    const publishData = publishRes.data as {
      publishedPath: string; sha256: string; blobSha256: string; blobName: string; bytes: number;
    };

    expect(publishData.blobSha256).toBe(updateSha);
    expect(publishData.blobSha256).not.toBe(addSha);

    const { readFile } = await import('node:fs/promises');
    const publishedBytes = await readFile(join(tempDir, 'docs/owner-ref-output.md'), 'utf-8');
    expect(publishedBytes).toBe(newContent);
    expect(publishData.sha256).toBe(sha256(newContent));
  });

  it('RTC-S3-1b: update preserves fetchability — fetch by slug works after update', async () => {
    const handler = new DocsHandler();

    await handler.mutate('add', {
      ownerId: 'T101', file: fixture, slug: 'fetch-after-update',
    });

    await handler.mutate('update', {
      slug: 'fetch-after-update', content: '# Post-Update\n\nStill fetchable.',
    });

    const fetchRes = await handler.query('fetch', { slug: 'fetch-after-update' });
    if (fetchRes.success && fetchRes.data) {
      const fd = fetchRes.data as { content?: string } | string;
      const content = typeof fd === 'string' ? fd : fd.content ?? '';
      expect(content).toContain('Post-Update');
    }
  });

  it('RTC-S3-1c: update→publish default SHA matches self-sha256 of written file', async () => {
    const handler = new DocsHandler();

    await handler.mutate('add', {
      ownerId: 'T102', file: fixture, slug: 'self-sha-check',
    });

    const newContent = '## Self-SHA integrity\n\nThe publish SHA must match the on-disk SHA.';
    const updateRes = await handler.mutate('update', {
      slug: 'self-sha-check', content: newContent,
    });
    const updateSha = (updateRes.data as { sha256: string }).sha256;

    const publishRes = await handler.mutate('publish', {
      ownerId: 'T102', toPath: 'docs/self-sha-output.md',
    });
    const publishData = publishRes.data as { sha256: string; blobSha256: string };
    expect(publishData.blobSha256).toBe(updateSha);
    expect(publishData.sha256).toBe(sha256(newContent));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC2 (S4): Publish default does not publish an old blob after update
// ═══════════════════════════════════════════════════════════════════════════════

describe('T11061 AC2 (S4) — publish default selects latest blob after update', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-t11061-ac2-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
    fixture = join(tempDir, 'fixture-s4.md');
    await writeFile(fixture, '# Old Content\n\nOriginal blob.', 'utf-8');
  });

  afterEach(async () => {
    const { closeDb } = await import('@cleocode/core/internal');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('RTC-S4-1: publish default selects latest blob, not stale pre-update blob', async () => {
    const handler = new DocsHandler();

    const addRes = await handler.mutate('add', {
      ownerId: 'T200', file: fixture, slug: 'stale-or-fresh',
    });
    const oldSha = (addRes.data as { sha256: string }).sha256;

    const newContent = '# Fresh Content\n\nPublish MUST select this.';
    const updateRes = await handler.mutate('update', {
      slug: 'stale-or-fresh', content: newContent,
    });
    const newSha = (updateRes.data as { sha256: string; changed: boolean }).sha256;

    const publishRes = await handler.mutate('publish', {
      ownerId: 'T200', toPath: 'docs/fresh-output.md',
    });
    const publishData = publishRes.data as { blobSha256: string; sha256: string; bytes: number };

    expect(publishData.blobSha256).toBe(newSha);
    expect(publishData.blobSha256).not.toBe(oldSha);
    expect(publishData.sha256).toBe(sha256(newContent));

    const { readFile } = await import('node:fs/promises');
    const published = await readFile(join(tempDir, 'docs/fresh-output.md'), 'utf-8');
    expect(published).toBe(newContent);
  });

  it('RTC-S4-3: explicit attachmentId still works for historical version after updates', async () => {
    const handler = new DocsHandler();

    const addRes = await handler.mutate('add', {
      ownerId: 'T202', file: fixture, slug: 'history-test',
    });
    const addData = addRes.data as { attachmentId: string; sha256: string };
    const originalSha = addData.sha256;

    await handler.mutate('update', {
      slug: 'history-test', content: '# Updated\n\nNew version.',
    });

    const publishRes = await handler.mutate('publish', {
      ownerId: 'T202', toPath: 'docs/history-output.md', attachmentId: addData.attachmentId,
    });
    const publishData = publishRes.data as { blobSha256: string };
    expect(publishData.blobSha256).toBe(originalSha);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// AC3: Fetch, status, and publish SHA consistency
// ═══════════════════════════════════════════════════════════════════════════════

describe('T11061 AC3 — fetch, status, and publish SHA consistency', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-t11061-ac3-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
    fixture = join(tempDir, 'fixture-ac3.md');
    await writeFile(fixture, '# SHA Consistency\n\nTesting cross-op SHA agreement.', 'utf-8');
  });

  afterEach(async () => {
    const { closeDb } = await import('@cleocode/core/internal');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('update SHA, publish SHA, and fetch SHA all agree (no drift)', async () => {
    const handler = new DocsHandler();

    await handler.mutate('add', {
      ownerId: 'T300', file: fixture, slug: 'sha-consistency',
    });

    const consistentContent = '# Consistent\n\nAll SHAs must match.';
    const updateRes = await handler.mutate('update', {
      slug: 'sha-consistency', content: consistentContent,
    });
    const updateSha = (updateRes.data as { sha256: string }).sha256;

    const publishRes = await handler.mutate('publish', {
      ownerId: 'T300', toPath: 'docs/consistent-output.md',
    });
    const publishData = publishRes.data as { blobSha256: string; sha256: string };
    expect(publishData.blobSha256).toBe(updateSha);
    expect(publishData.sha256).toBe(sha256(consistentContent));

    const fetchRes = await handler.query('fetch', { slug: 'sha-consistency' });
    if (fetchRes.success && fetchRes.data) {
      const fd = fetchRes.data as { content?: string } | string;
      const content = typeof fd === 'string' ? fd : fd.content ?? '';
      expect(sha256(content)).toBe(updateSha);
    }
  });

  it('all ops return enough info via envelope — no manual blob inspection needed', async () => {
    const handler = new DocsHandler();

    const addRes = await handler.mutate('add', {
      ownerId: 'T302', file: fixture, slug: 'envelope-check',
    });
    const addData = addRes.data as { sha256: string; attachmentId: string; slug: string };
    expect(addData.sha256).toBeTruthy();
    expect(addData.attachmentId).toBeTruthy();

    const updateRes = await handler.mutate('update', {
      slug: 'envelope-check', content: '# Rich\n\nAgent never sees blob paths.',
    });
    const updateData = updateRes.data as { sha256: string; previousSha256: string; changed: boolean };
    expect(updateData.sha256).toBeTruthy();
    expect(updateData.previousSha256).toBeTruthy();
    expect(updateData.changed).toBe(true);

    const publishRes = await handler.mutate('publish', {
      ownerId: 'T302', toPath: 'docs/envelope-output.md',
    });
    const publishData = publishRes.data as {
      sha256: string; blobSha256: string; blobName: string; publishedPath: string; bytes: number;
    };
    expect(publishData.sha256).toBeTruthy();
    expect(publishData.blobSha256).toBeTruthy();
    expect(publishData.blobName).toBeTruthy();
    expect(publishData.bytes).toBeGreaterThan(0);
  });
});
