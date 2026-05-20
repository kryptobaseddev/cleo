/**
 * Tests for slug + type + project-scope listing on the attachment store.
 *
 * Each test uses an isolated temporary `.cleo/` so the tasks.db singleton is
 * reset between runs (same pattern as attachment-store.test.ts).
 *
 * @task T9636 (slug + collision)
 * @task T9637 (type taxonomy)
 * @task T9638 (project-scoped listing)
 * @epic T9627
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

describe('AttachmentStore slug + type + project-scope', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-att-slug-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  });

  afterEach(async () => {
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // ────────────────────────────────────────────────────────────────────────
  // T9636 — slug column + uniqueness + collision suggestions
  // ────────────────────────────────────────────────────────────────────────

  it('put with --slug stores the slug and findBySlug resolves it', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('hello world', 'utf-8');

    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T001',
      'test',
      undefined,
      { slug: 'my-doc' },
    );

    expect(meta.id).toBeTruthy();

    const bySlug = await store.findBySlug('my-doc');
    expect(bySlug).not.toBeNull();
    expect(bySlug?.slug).toBe('my-doc');
    expect(bySlug?.metadata.id).toBe(meta.id);

    const extras = await store.getExtras(meta.id);
    expect(extras?.slug).toBe('my-doc');
    expect(extras?.type).toBeNull();
  });

  it('put with duplicate slug throws SlugCollisionError carrying 3 suggestions', async () => {
    const { createAttachmentStore, SlugCollisionError } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();

    await store.put(
      Buffer.from('first', 'utf-8'),
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: 5 },
      'task',
      'T001',
      'test',
      undefined,
      { slug: 'shared' },
    );

    // Different content (different sha256) trying to claim the same slug.
    await expect(
      store.put(
        Buffer.from('second', 'utf-8'),
        { kind: 'blob', storageKey: '', mime: 'text/plain', size: 6 },
        'task',
        'T002',
        'test',
        undefined,
        { slug: 'shared' },
      ),
    ).rejects.toBeInstanceOf(SlugCollisionError);

    try {
      await store.put(
        Buffer.from('third', 'utf-8'),
        { kind: 'blob', storageKey: '', mime: 'text/plain', size: 5 },
        'task',
        'T003',
        'test',
        undefined,
        { slug: 'shared' },
      );
      throw new Error('expected SlugCollisionError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SlugCollisionError);
      const sce = err as InstanceType<typeof SlugCollisionError>;
      expect(sce.slug).toBe('shared');
      expect(sce.suggestions).toHaveLength(3);
      // Suggestions must be strings, non-empty, and distinct.
      const unique = new Set(sce.suggestions);
      expect(unique.size).toBe(3);
      for (const s of sce.suggestions) {
        expect(typeof s).toBe('string');
        expect(s.length).toBeGreaterThan(0);
      }
    }
  });

  it('put with the same slug on the same blob is a no-op (idempotent)', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('same content', 'utf-8');

    const first = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T001',
      'test',
      undefined,
      { slug: 'doc' },
    );

    // Same bytes + same slug from a different owner — should NOT throw.
    const second = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T002',
      'test',
      undefined,
      { slug: 'doc' },
    );

    expect(second.id).toBe(first.id);
    expect(second.sha256).toBe(first.sha256);
  });

  // ────────────────────────────────────────────────────────────────────────
  // T9637 — type taxonomy column
  // ────────────────────────────────────────────────────────────────────────

  it('put with --type stores the type and getExtras retrieves it', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('adr-content', 'utf-8');

    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T001',
      'test',
      undefined,
      { type: 'adr' },
    );

    const extras = await store.getExtras(meta.id);
    expect(extras?.type).toBe('adr');
    expect(extras?.slug).toBeNull();
  });

  it('put with both --slug and --type stores both columns', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('spec', 'utf-8');

    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T001',
      'test',
      undefined,
      { slug: 'my-spec', type: 'spec' },
    );

    const extras = await store.getExtras(meta.id);
    expect(extras?.slug).toBe('my-spec');
    expect(extras?.type).toBe('spec');
  });

  // ────────────────────────────────────────────────────────────────────────
  // T9638 — listAllInProject + type filter
  // ────────────────────────────────────────────────────────────────────────

  it('listAllInProject unions every owner ref with slug + type + ownerType', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();

    await store.put(
      Buffer.from('a', 'utf-8'),
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: 1 },
      'task',
      'T001',
      'test',
      undefined,
      { slug: 'doc-a', type: 'spec' },
    );
    await store.put(
      Buffer.from('b', 'utf-8'),
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: 1 },
      'session',
      'ses_xyz',
      'test',
      undefined,
      { slug: 'doc-b', type: 'adr' },
    );
    await store.put(
      Buffer.from('c', 'utf-8'),
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: 1 },
      'task',
      'T002',
      'test',
      undefined,
      { type: 'note' },
    );

    const all = await store.listAllInProject();
    expect(all.length).toBeGreaterThanOrEqual(3);

    const slugs = all.map((r) => r.slug).filter((s): s is string => Boolean(s));
    expect(slugs).toContain('doc-a');
    expect(slugs).toContain('doc-b');

    const types = all.map((r) => r.type).filter((t): t is string => Boolean(t));
    expect(types).toContain('spec');
    expect(types).toContain('adr');
    expect(types).toContain('note');

    const ownerTypes = new Set(all.map((r) => r.ownerType));
    expect(ownerTypes.has('task')).toBe(true);
    expect(ownerTypes.has('session')).toBe(true);
  });

  it('listAllInProject filters by type', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();

    await store.put(
      Buffer.from('1', 'utf-8'),
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: 1 },
      'task',
      'T001',
      'test',
      undefined,
      { type: 'spec' },
    );
    await store.put(
      Buffer.from('2', 'utf-8'),
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: 1 },
      'task',
      'T002',
      'test',
      undefined,
      { type: 'adr' },
    );
    await store.put(
      Buffer.from('3', 'utf-8'),
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: 1 },
      'task',
      'T003',
      'test',
      undefined,
      { type: 'spec' },
    );

    const specs = await store.listAllInProject(undefined, { type: 'spec' });
    expect(specs.length).toBe(2);
    for (const row of specs) {
      expect(row.type).toBe('spec');
    }

    const adrs = await store.listAllInProject(undefined, { type: 'adr' });
    expect(adrs.length).toBe(1);
    expect(adrs[0]?.type).toBe('adr');
  });

  // ────────────────────────────────────────────────────────────────────────
  // Backward compat — existing rows without slug/type continue to work
  // ────────────────────────────────────────────────────────────────────────

  it('put without slug/type leaves both columns NULL', async () => {
    const { createAttachmentStore } = await import('../attachment-store.js');
    const { closeDb } = await import('../sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('legacy', 'utf-8');

    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T001',
    );

    const extras = await store.getExtras(meta.id);
    expect(extras?.slug).toBeNull();
    expect(extras?.type).toBeNull();

    // Existing att_id fetch path unchanged.
    const fetched = await store.getMetadata(meta.id);
    expect(fetched?.id).toBe(meta.id);
  });
});
