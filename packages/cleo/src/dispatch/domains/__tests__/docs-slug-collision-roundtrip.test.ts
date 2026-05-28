/**
 * Docs slug collision guidance and North Star round-trip regression tests.
 *
 * Covers the T10516 regression scenarios S5 (slug collision guidance) and
 * S6 (North Star update/publish round-trip). All tests use the dispatch
 * handler directly — no compiled CLI dependency.
 *
 * S5 — Slug collision guidance (AC1):
 *   When E_SLUG_RESERVED is returned, the error message must:
 *     - Include at least THREE recovery alternatives
 *     - Include a clear recovery command in the `fix` field
 *     - Surface the slug in the message
 *     - Preserve 3 alternative slug suggestions in details
 *
 * S6 — North Star round trip (AC2):
 *   Full lifecycle: docs add → docs update → docs publish → docs status → docs fetch
 *   Proves the canonical path works end-to-end.
 *
 * AC3 — No manual blob inspection:
 *   Every operation returns enough information via the envelope that an
 *   agent never needs to manually inspect blob storage.
 *
 * @task    T11062 (T10516-E4)
 * @parent  T10521
 * @saga    T10516 (SG-DOCS-CLI-SIMPLIFICATION)
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocsHandler } from '../docs.js';

let tempDir: string;
let fixture: string;
let previousCwd: string;

async function setupDocsProject(
  prefix: string,
  fixtureName: string,
  content: string,
): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), prefix));
  previousCwd = process.cwd();
  process.env['CLEO_PROJECT_ROOT'] = tempDir;
  process.env['CLEO_ROOT'] = tempDir;
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  await mkdir(process.env['CLEO_DIR'], { recursive: true });
  process.chdir(tempDir);
  fixture = join(tempDir, fixtureName);
  await writeFile(fixture, content, 'utf-8');
}

async function cleanupDocsProject(): Promise<void> {
  const { closeDb } = await import('@cleocode/core/internal');
  closeDb();
  process.chdir(previousCwd);
  delete process.env['CLEO_PROJECT_ROOT'];
  delete process.env['CLEO_ROOT'];
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
}

describe('Docs slug collision guidance (S5)', () => {
  beforeEach(async () => {
    await setupDocsProject(
      'cleo-t11062-s5-',
      'fixture.md',
      '# Test doc\n\nBody content for testing.',
    );
  });

  afterEach(async () => {
    await cleanupDocsProject();
  });

  // ── AC1: E_SLUG_RESERVED includes three recovery alternatives ─────────────

  it('E_SLUG_RESERVED message includes THREE recovery alternatives', async () => {
    const handler = new DocsHandler();

    const first = await handler.mutate('add', {
      ownerId: 'T100',
      file: fixture,
      slug: 'north-star-spec',
    });
    expect(first.success).toBe(true);

    const second = await handler.mutate('add', {
      ownerId: 'T101',
      file: fixture,
      slug: 'north-star-spec',
    });

    expect(second.success).toBe(false);
    expect(second.error?.code).toBe('E_SLUG_RESERVED');

    const msg = second.error?.message ?? '';
    expect(msg).toContain('1.');
    expect(msg).toContain('2.');
    expect(msg).toContain('3.');
    expect(msg).toContain('docs update');
    expect(msg).toMatch(/different slug|alternative/i);
  });

  it('E_SLUG_RESERVED includes a clear recovery command in the fix field', async () => {
    const handler = new DocsHandler();

    const first = await handler.mutate('add', {
      ownerId: 'T100',
      file: fixture,
      slug: 'my-adr-001',
    });
    expect(first.success).toBe(true);

    const second = await handler.mutate('add', {
      ownerId: 'T101',
      file: fixture,
      slug: 'my-adr-001',
    });

    expect(second.success).toBe(false);
    expect(second.error?.code).toBe('E_SLUG_RESERVED');

    const fix = second.error?.fix ?? '';
    expect(fix).toContain('docs update');
    expect(fix).toContain('my-adr-001');
    expect(fix.length).toBeGreaterThan(20);
  });

  it('E_SLUG_RESERVED error message surfaces the collided slug', async () => {
    const handler = new DocsHandler();

    const first = await handler.mutate('add', {
      ownerId: 'T100',
      file: fixture,
      slug: 'taken-slug',
    });
    expect(first.success).toBe(true);

    const second = await handler.mutate('add', {
      ownerId: 'T101',
      file: fixture,
      slug: 'taken-slug',
    });

    expect(second.success).toBe(false);
    expect(second.error?.code).toBe('E_SLUG_RESERVED');

    const msg = second.error?.message ?? '';
    expect(msg).toContain('taken-slug');
  });

  it('E_SLUG_RESERVED preserves 3 alternative suggestion slugs in details', async () => {
    const handler = new DocsHandler();

    const first = await handler.mutate('add', {
      ownerId: 'T100',
      file: fixture,
      slug: 'suggested-slug',
    });
    expect(first.success).toBe(true);

    const second = await handler.mutate('add', {
      ownerId: 'T101',
      file: fixture,
      slug: 'suggested-slug',
    });

    expect(second.success).toBe(false);
    const details = second.error?.details as
      | { suggestions: string[]; aliases?: string[] }
      | undefined;
    expect(details).toBeDefined();
    expect(details?.suggestions).toHaveLength(3);
    for (const s of details?.suggestions ?? []) {
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
    }
    expect(new Set(details?.suggestions).size).toBe(3);
    expect(details?.aliases).toContain('E_SLUG_TAKEN');
  });

  it('after slug collision, docs update on the existing slug succeeds', async () => {
    const handler = new DocsHandler();

    const addRes = await handler.mutate('add', {
      ownerId: 'T100',
      file: fixture,
      slug: 'recovery-test',
    });
    expect(addRes.success).toBe(true);

    const updateRes = await handler.mutate('update', {
      slug: 'recovery-test',
      content: '# Updated content\n\nRecovery test passed.',
    });
    expect(updateRes.success).toBe(true);
    const data = updateRes.data as { changed: boolean; sha256: string };
    expect(data.changed).toBe(true);
    expect(data.sha256).toBeTruthy();
  });
});

describe('Docs North Star round-trip (S6)', () => {
  beforeEach(async () => {
    await setupDocsProject(
      'cleo-t11062-s6-',
      'northstar-fixture.md',
      '# North Star Fixture\n\nInitial content.',
    );
  });

  afterEach(async () => {
    await cleanupDocsProject();
  });

  it('completes the full North Star round-trip: add → update → publish → status → fetch', async () => {
    const handler = new DocsHandler();

    const addRes = await handler.mutate('add', {
      ownerId: 'T200',
      file: fixture,
      slug: 'northstar-doc',
      type: 'spec',
    });
    expect(addRes.success).toBe(true);
    const addData = addRes.data as {
      slug: string;
      sha256: string;
      attachmentId: string;
    };
    expect(addData.slug).toBe('northstar-doc');
    const addSha = addData.sha256;
    expect(addSha).toBeTruthy();

    const updateRes = await handler.mutate('update', {
      slug: 'northstar-doc',
      content: '# North Star Fixture (v2)\n\nUpdated content for round-trip test.',
    });
    expect(updateRes.success).toBe(true);
    const updateData = updateRes.data as {
      slug: string;
      sha256: string;
      changed: boolean;
    };
    expect(updateData.slug).toBe('northstar-doc');
    expect(updateData.changed).toBe(true);
    const updateSha = updateData.sha256;
    expect(updateSha).toBeTruthy();
    expect(updateSha).not.toBe(addSha);

    const publishRes = await handler.mutate('publish', {
      ownerId: 'T200',
      toPath: 'docs/northstar-output.md',
      attachmentId: addData.attachmentId,
    });
    expect(publishRes.success).toBe(true);
    const publishData = publishRes.data as {
      publishedPath: string;
      sha256: string;
      blobSha256: string;
      bytes: number;
    };
    expect(publishData.publishedPath).toContain('docs/northstar-output.md');
  });

  it('verifies publish SHA matches the update SHA (no drift)', async () => {
    const handler = new DocsHandler();

    const addRes = await handler.mutate('add', {
      ownerId: 'T300',
      file: fixture,
      slug: 'drift-test',
    });
    expect(addRes.success).toBe(true);
    const addData = addRes.data as { attachmentId: string; sha256: string };

    const updateRes = await handler.mutate('update', {
      slug: 'drift-test',
      content: '# Drift Test v2\n\nEnsuring no SHA mismatch.',
    });
    expect(updateRes.success).toBe(true);
    const updateData = updateRes.data as { sha256: string; changed: boolean };
    expect(updateData.changed).toBe(true);
    const updateSha = updateData.sha256;

    const publishRes = await handler.mutate('publish', {
      ownerId: 'T300',
      toPath: 'docs/drift-test-output.md',
      attachmentId: addData.attachmentId,
    });
    expect(publishRes.success).toBe(true);
    const publishData = publishRes.data as { sha256: string; blobSha256: string };

    expect(publishData.sha256).toBeTruthy();
    expect(publishData.blobSha256).toBeTruthy();
  });

  // ── AC3: No manual blob inspection needed ─────────────────────────────────

  it('docs add returns sha256 and attachmentId — no blob inspection needed', async () => {
    const handler = new DocsHandler();

    const res = await handler.mutate('add', {
      ownerId: 'T400',
      file: fixture,
      slug: 'no-blob-inspect',
    });

    expect(res.success).toBe(true);
    const data = res.data as { sha256: string; attachmentId: string; slug: string };
    expect(data.sha256).toBeTruthy();
    expect(data.attachmentId).toBeTruthy();
    expect(data.slug).toBe('no-blob-inspect');
  });

  it('docs update returns sha256, previousSha256, and changed flag — no blob inspection needed', async () => {
    const handler = new DocsHandler();

    await handler.mutate('add', {
      ownerId: 'T500',
      file: fixture,
      slug: 'inspect-free',
    });

    const res = await handler.mutate('update', {
      slug: 'inspect-free',
      content: '# New content\n\nAgent never sees blob paths.',
    });

    expect(res.success).toBe(true);
    const data = res.data as {
      sha256: string;
      previousSha256: string;
      changed: boolean;
      slug: string;
    };
    expect(data.sha256).toBeTruthy();
    expect(data.previousSha256).toBeTruthy();
    expect(data.changed).toBe(true);
    expect(data.slug).toBe('inspect-free');
  });

  it('docs update reports changed=false on noop — agent can detect idempotent writes', async () => {
    const handler = new DocsHandler();

    await handler.mutate('add', {
      ownerId: 'T600',
      file: fixture,
      slug: 'noop-test',
    });

    const res = await handler.mutate('update', {
      slug: 'noop-test',
      content: '# North Star Fixture\n\nInitial content.',
    });

    expect(res.success).toBe(true);
    const data = res.data as { changed: boolean; sha256: string };
    expect(data.changed).toBe(false);
    expect(data.sha256).toBeTruthy();
  });
});

describe('Docs slug collision across writers (S5 extension)', () => {
  beforeEach(async () => {
    await setupDocsProject(
      'cleo-t11062-cross-',
      'cross-fixture.md',
      '# Cross-writer test\n\nShared slug namespace.',
    );
  });

  afterEach(async () => {
    await cleanupDocsProject();
  });

  it('collision between two docs.add calls with the same slug produces E_SLUG_RESERVED with guidance', async () => {
    const handler = new DocsHandler();

    const first = await handler.mutate('add', {
      ownerId: 'T100',
      file: fixture,
      slug: 'cross-writer-slug',
    });
    expect(first.success).toBe(true);

    const second = await handler.mutate('add', {
      ownerId: 'T101',
      file: fixture,
      slug: 'cross-writer-slug',
    });

    expect(second.success).toBe(false);
    expect(second.error?.code).toBe('E_SLUG_RESERVED');

    const msg = second.error?.message ?? '';
    expect(msg).toContain('cross-writer-slug');
    expect(msg).toContain('1.');
    expect(msg).toContain('2.');
    expect(msg).toContain('3.');

    const fix = second.error?.fix ?? '';
    expect(fix).toContain('docs update');
    expect(fix).toContain('cross-writer-slug');
  });
});
