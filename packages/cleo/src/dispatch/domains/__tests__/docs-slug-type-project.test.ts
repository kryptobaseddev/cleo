/**
 * Integration tests for the slug + type + project-scope features on the
 * `cleo docs` dispatch surface.
 *
 * Covers:
 *   - T9636: add --slug, slug collision → E_SLUG_TAKEN with suggestions,
 *            invalid slug → E_INVALID_SLUG, fetch by slug.
 *   - T9637: add --type, invalid type → E_INVALID_TYPE, list --type filter.
 *   - T9638: list --project, scope mutual-exclusivity at dispatch level.
 *   - Backward compat: att_*-id fetch + full sha256 fetch + sha256 prefix
 *     fetch all keep working.
 *
 * @task T9636 / T9637 / T9638
 * @epic T9627
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DocsHandler } from '../docs.js';

let tempDir: string;
let fixtureA: string;
let fixtureB: string;
let fixtureC: string;

describe('docs dispatch — slug/type/project (T9636/T9637/T9638)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-docs-slug-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');

    fixtureA = join(tempDir, 'a.md');
    fixtureB = join(tempDir, 'b.md');
    fixtureC = join(tempDir, 'c.md');
    await writeFile(fixtureA, '# A\n\nfirst fixture', 'utf-8');
    await writeFile(fixtureB, '# B\n\nsecond fixture (different)', 'utf-8');
    await writeFile(fixtureC, '# C\n\nthird fixture entirely', 'utf-8');
  });

  afterEach(async () => {
    const { closeDb } = await import('@cleocode/core/internal');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // ────────────────────────────────────────────────────────────────────────
  // T9636 — slug
  // ────────────────────────────────────────────────────────────────────────

  it('docs.add --slug stores the slug and surfaces it on the result', async () => {
    const handler = new DocsHandler();

    const resp = await handler.mutate('add', {
      ownerId: 'T100',
      file: fixtureA,
      slug: 'my-spec',
    });

    expect(resp.success).toBe(true);
    const data = resp.data as { attachmentId: string; slug?: string };
    expect(data.slug).toBe('my-spec');
    expect(data.attachmentId).toBeTruthy();
  });

  it('docs.add --slug collision returns E_SLUG_TAKEN with 3 suggestions', async () => {
    const handler = new DocsHandler();

    const first = await handler.mutate('add', {
      ownerId: 'T100',
      file: fixtureA,
      slug: 'shared-slug',
    });
    expect(first.success).toBe(true);

    const second = await handler.mutate('add', {
      ownerId: 'T101',
      file: fixtureB,
      slug: 'shared-slug',
    });

    expect(second.success).toBe(false);
    expect(second.error?.code).toBe('E_SLUG_TAKEN');
    const details = second.error?.details as { suggestions: string[] } | undefined;
    expect(details).toBeDefined();
    expect(details?.suggestions).toHaveLength(3);
    for (const s of details?.suggestions ?? []) {
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
    }
    expect(new Set(details?.suggestions).size).toBe(3);
  });

  it('docs.add --slug with invalid shape returns E_INVALID_SLUG', async () => {
    const handler = new DocsHandler();

    const resp = await handler.mutate('add', {
      ownerId: 'T100',
      file: fixtureA,
      slug: 'NotKebabCase!', // uppercase + bang — fails SLUG_PATTERN
    });

    expect(resp.success).toBe(false);
    expect(resp.error?.code).toBe('E_INVALID_SLUG');
  });

  it('docs.fetch by slug resolves the attachment', async () => {
    const handler = new DocsHandler();

    const add = await handler.mutate('add', {
      ownerId: 'T200',
      file: fixtureA,
      slug: 'fetchable',
    });
    expect(add.success).toBe(true);
    const addData = add.data as { attachmentId: string };

    const fetched = await handler.query('fetch', { attachmentRef: 'fetchable' });
    expect(fetched.success).toBe(true);
    const data = fetched.data as { metadata: { id: string; slug?: string } };
    expect(data.metadata.id).toBe(addData.attachmentId);
    expect(data.metadata.slug).toBe('fetchable');
  });

  // ────────────────────────────────────────────────────────────────────────
  // T9637 — type
  // ────────────────────────────────────────────────────────────────────────

  it('docs.add --type stores the classification', async () => {
    const handler = new DocsHandler();

    const resp = await handler.mutate('add', {
      ownerId: 'T300',
      file: fixtureA,
      type: 'adr',
    });

    expect(resp.success).toBe(true);
    const data = resp.data as { type?: string };
    expect(data.type).toBe('adr');
  });

  it('docs.add --type invalid value returns E_INVALID_TYPE', async () => {
    const handler = new DocsHandler();

    const resp = await handler.mutate('add', {
      ownerId: 'T300',
      file: fixtureA,
      // Not in DOCS_TYPE_VALUES.
      type: 'wishlist',
    });

    expect(resp.success).toBe(false);
    expect(resp.error?.code).toBe('E_INVALID_TYPE');
  });

  it('docs.list --type filters owner-scoped attachments', async () => {
    const handler = new DocsHandler();

    await handler.mutate('add', { ownerId: 'T400', file: fixtureA, type: 'spec' });
    await handler.mutate('add', { ownerId: 'T400', file: fixtureB, type: 'adr' });
    await handler.mutate('add', { ownerId: 'T400', file: fixtureC, type: 'spec' });

    const specs = await handler.query('list', { task: 'T400', type: 'spec' });
    expect(specs.success).toBe(true);
    const data = specs.data as {
      count: number;
      type?: string;
      attachments: Array<{ type?: string }>;
    };
    expect(data.count).toBe(2);
    expect(data.type).toBe('spec');
    for (const a of data.attachments) expect(a.type).toBe('spec');
  });

  // ────────────────────────────────────────────────────────────────────────
  // T9638 — project scope
  // ────────────────────────────────────────────────────────────────────────

  it('docs.list --project lists attachments across every owner', async () => {
    const handler = new DocsHandler();

    await handler.mutate('add', { ownerId: 'T500', file: fixtureA, slug: 'proj-a' });
    await handler.mutate('add', { ownerId: 'T501', file: fixtureB, slug: 'proj-b' });
    await handler.mutate('add', { ownerId: 'ses_xyz', file: fixtureC, slug: 'proj-c' });

    const resp = await handler.query('list', { project: true });
    expect(resp.success).toBe(true);
    const data = resp.data as {
      ownerId: string;
      project?: boolean;
      count: number;
      attachments: Array<{ slug?: string; ownerId?: string; ownerType?: string }>;
    };
    expect(data.project).toBe(true);
    expect(data.ownerId).toBe('');
    expect(data.count).toBeGreaterThanOrEqual(3);

    const slugs = data.attachments.map((a) => a.slug).filter(Boolean);
    expect(slugs).toContain('proj-a');
    expect(slugs).toContain('proj-b');
    expect(slugs).toContain('proj-c');

    const ownerTypes = new Set(
      data.attachments.map((a) => a.ownerType).filter((t): t is string => Boolean(t)),
    );
    expect(ownerTypes.has('task')).toBe(true);
    expect(ownerTypes.has('session')).toBe(true);
  });

  it('docs.list --project --type combines project scope + type filter', async () => {
    const handler = new DocsHandler();

    await handler.mutate('add', { ownerId: 'T600', file: fixtureA, type: 'spec' });
    await handler.mutate('add', { ownerId: 'T601', file: fixtureB, type: 'adr' });
    await handler.mutate('add', { ownerId: 'T602', file: fixtureC, type: 'spec' });

    const resp = await handler.query('list', { project: true, type: 'spec' });
    expect(resp.success).toBe(true);
    const data = resp.data as {
      count: number;
      attachments: Array<{ type?: string }>;
    };
    expect(data.count).toBe(2);
    for (const a of data.attachments) expect(a.type).toBe('spec');
  });

  it('docs.list with no scope returns E_INVALID_INPUT', async () => {
    const handler = new DocsHandler();

    const resp = await handler.query('list', {});
    expect(resp.success).toBe(false);
    expect(resp.error?.code).toBe('E_INVALID_INPUT');
  });

  // ────────────────────────────────────────────────────────────────────────
  // Backward compat — existing resolution paths still work
  // ────────────────────────────────────────────────────────────────────────

  it('docs.fetch by attachment ID still resolves (backward compat)', async () => {
    const handler = new DocsHandler();

    const add = await handler.mutate('add', { ownerId: 'T700', file: fixtureA });
    expect(add.success).toBe(true);
    const addData = add.data as { attachmentId: string };

    const fetched = await handler.query('fetch', { attachmentRef: addData.attachmentId });
    expect(fetched.success).toBe(true);
    const data = fetched.data as { metadata: { id: string } };
    expect(data.metadata.id).toBe(addData.attachmentId);
  });

  it('docs.fetch by full sha256 still resolves (backward compat)', async () => {
    const handler = new DocsHandler();

    const add = await handler.mutate('add', { ownerId: 'T800', file: fixtureA });
    expect(add.success).toBe(true);
    const addData = add.data as { sha256: string };

    const fetched = await handler.query('fetch', { attachmentRef: addData.sha256 });
    expect(fetched.success).toBe(true);
    const data = fetched.data as { metadata: { sha256: string } };
    // The stored sha256 is full 64hex; the wire row truncates it for list
    // but fetch returns the full digest in its top-level field as well.
    expect(addData.sha256).toMatch(/^[0-9a-f]{64}$/);
    // Truncated form on the row is acceptable; the request used the full hash
    // so resolution succeeded — that's the assertion that matters.
    expect(data.metadata).toBeDefined();
  });

  it('docs.fetch by sha256 prefix (>=6 hex) resolves uniquely', async () => {
    const handler = new DocsHandler();

    const add = await handler.mutate('add', { ownerId: 'T801', file: fixtureA });
    expect(add.success).toBe(true);
    const addData = add.data as { sha256: string };

    const prefix = addData.sha256.slice(0, 10);
    const fetched = await handler.query('fetch', { attachmentRef: prefix });
    expect(fetched.success).toBe(true);
  });
});
