/**
 * Tests for the central slug allocator chokepoint (T10392).
 *
 * Each test uses an isolated temporary `.cleo/` so the tasks.db singleton is
 * reset between runs (same pattern as attachment-slug-type.test.ts).
 *
 * @task T10392
 * @epic T10289
 * @saga T10288
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

describe('reserveSlug (central allocator chokepoint)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-slug-alloc-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');

    const { _resetSlugAllocatorState_TESTING_ONLY } = await import('../slug-allocator.js');
    _resetSlugAllocatorState_TESTING_ONLY();
  });

  afterEach(async () => {
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();
    const { _resetSlugAllocatorState_TESTING_ONLY } = await import('../slug-allocator.js');
    _resetSlugAllocatorState_TESTING_ONLY();
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_STRICT_SLUG_ALLOCATOR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reserves a free slug and returns ok with normalised slug', async () => {
    const { reserveSlug } = await import('../slug-allocator.js');

    const result = await reserveSlug('changeset', 'foo');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalizedSlug).toBe('foo');
    }
  });

  it('returns E_SLUG_RESERVED with 3 suggestions when slug is in-process reserved', async () => {
    const { reserveSlug } = await import('../slug-allocator.js');

    const first = await reserveSlug('changeset', 'shared');
    expect(first.ok).toBe(true);

    const second = await reserveSlug('changeset', 'shared');
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('E_SLUG_RESERVED');
      expect(second.suggestions).toHaveLength(3);
      for (const s of second.suggestions) {
        expect(typeof s).toBe('string');
        expect(s.length).toBeGreaterThan(0);
      }
      // Suggestions must be distinct.
      expect(new Set(second.suggestions).size).toBe(3);
    }
  });

  it('returns E_SLUG_RESERVED when slug exists in DB but not in reserved set', async () => {
    const { reserveSlug } = await import('../slug-allocator.js');
    const { createAttachmentStore } = await import('../../store/attachment-store.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    // Seed the DB with a slug WITHOUT going through the allocator (simulates
    // a row left over from a previous CLI invocation in a different process).
    const store = createAttachmentStore();
    await store.put(
      Buffer.from('seed content', 'utf-8'),
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: 12 },
      'task',
      'T001',
      'test',
      undefined,
      { slug: 'db-occupied' },
    );

    const result = await reserveSlug('changeset', 'db-occupied');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('E_SLUG_RESERVED');
      expect(result.suggestions).toHaveLength(3);
    }
  });

  it('normalises mixed-case + non-kebab input to canonical kebab-case', async () => {
    const { reserveSlug, normalizeSlug } = await import('../slug-allocator.js');

    expect(normalizeSlug('Foo-Bar')).toBe('foo-bar');
    expect(normalizeSlug('My  Doc.Title')).toBe('my-doc-title');
    expect(normalizeSlug('  --leading-trailing--  ')).toBe('leading-trailing');

    const result = await reserveSlug('research', 'Foo-Bar');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalizedSlug).toBe('foo-bar');
    }

    // Second call with a different casing of the SAME normalised form must collide.
    const second = await reserveSlug('research', 'FOO-BAR');
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('E_SLUG_RESERVED');
    }
  });

  it('serialises concurrent contention — exactly one OK, the rest E_SLUG_RESERVED', async () => {
    const { reserveSlug } = await import('../slug-allocator.js');

    const results = await Promise.all([
      reserveSlug('changeset', 'concurrent'),
      reserveSlug('changeset', 'concurrent'),
      reserveSlug('changeset', 'concurrent'),
    ]);

    const okCount = results.filter((r) => r.ok).length;
    const errCount = results.filter((r) => !r.ok).length;

    expect(okCount).toBe(1);
    expect(errCount).toBe(2);

    for (const r of results) {
      if (!r.ok) {
        expect(r.code).toBe('E_SLUG_RESERVED');
        expect(r.suggestions).toHaveLength(3);
      }
    }
  });

  it('treats slugs as a GLOBAL namespace across DocKinds (per E1.5 decision T10390)', async () => {
    const { reserveSlug } = await import('../slug-allocator.js');

    const first = await reserveSlug('changeset', 'cross-kind');
    expect(first.ok).toBe(true);

    // Different kind, same slug — must collide because the namespace is global.
    const second = await reserveSlug('research', 'cross-kind');
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('E_SLUG_RESERVED');
    }
  });

  it('releaseReservedSlug allows a subsequent reservation to succeed (abort path)', async () => {
    const { reserveSlug, releaseReservedSlug } = await import('../slug-allocator.js');

    const first = await reserveSlug('changeset', 'aborted');
    expect(first.ok).toBe(true);

    // Caller decides not to proceed and explicitly releases.
    releaseReservedSlug('aborted');

    // Next reservation must succeed.
    const second = await reserveSlug('changeset', 'aborted');
    expect(second.ok).toBe(true);
  });

  it('isSlugReserved reflects the reservation state', async () => {
    const { reserveSlug, isSlugReserved, releaseReservedSlug } = await import(
      '../slug-allocator.js'
    );

    expect(isSlugReserved('checkstate')).toBe(false);

    const result = await reserveSlug('changeset', 'checkstate');
    expect(result.ok).toBe(true);
    expect(isSlugReserved('checkstate')).toBe(true);

    releaseReservedSlug('checkstate');
    expect(isSlugReserved('checkstate')).toBe(false);
  });
});

describe('attachmentStore.put runtime assert (T10392 chokepoint enforcement)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-slug-assert-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
    process.env['CLEO_STRICT_SLUG_ALLOCATOR'] = '1';

    const { _resetSlugAllocatorState_TESTING_ONLY } = await import('../slug-allocator.js');
    _resetSlugAllocatorState_TESTING_ONLY();
  });

  afterEach(async () => {
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();
    const { _resetSlugAllocatorState_TESTING_ONLY } = await import('../slug-allocator.js');
    _resetSlugAllocatorState_TESTING_ONLY();
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_STRICT_SLUG_ALLOCATOR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('put({ slug }) without prior reserveSlug throws SlugNotReservedByAllocatorError', async () => {
    const { createAttachmentStore, SlugNotReservedByAllocatorError } = await import(
      '../../store/attachment-store.js'
    );
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('chokepoint test', 'utf-8');

    await expect(
      store.put(
        bytes,
        { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
        'task',
        'T001',
        'test',
        undefined,
        { slug: 'unreserved' },
      ),
    ).rejects.toBeInstanceOf(SlugNotReservedByAllocatorError);
  });

  it('put({ slug }) AFTER reserveSlug succeeds and consumes the reservation', async () => {
    const { createAttachmentStore } = await import('../../store/attachment-store.js');
    const { reserveSlug, isSlugReserved } = await import('../slug-allocator.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    const reserved = await reserveSlug('changeset', 'happy-path');
    expect(reserved.ok).toBe(true);
    expect(isSlugReserved('happy-path')).toBe(true);

    const store = createAttachmentStore();
    const bytes = Buffer.from('happy path bytes', 'utf-8');
    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T001',
      'test',
      undefined,
      { slug: 'happy-path' },
    );

    expect(meta.id).toBeTruthy();
    // Reservation should have been consumed by put().
    expect(isSlugReserved('happy-path')).toBe(false);
  });

  it('put() without a slug never trips the allocator assert (slugless callers unaffected)', async () => {
    const { createAttachmentStore } = await import('../../store/attachment-store.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    const store = createAttachmentStore();
    const bytes = Buffer.from('no slug here', 'utf-8');

    // No `extras` argument — must succeed even with strict mode on.
    const meta = await store.put(
      bytes,
      { kind: 'blob', storageKey: '', mime: 'text/plain', size: bytes.length },
      'task',
      'T002',
      'test',
    );
    expect(meta.id).toBeTruthy();
  });
});
