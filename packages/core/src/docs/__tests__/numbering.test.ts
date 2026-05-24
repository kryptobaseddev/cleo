/**
 * Tests for the atomic ID-numbering utility (T10159 — absorbs T10153).
 *
 * Each test uses an isolated temporary `.cleo/` so the tasks.db singleton is
 * reset between runs (same pattern as slug-allocator.test.ts).
 *
 * @task T10159
 * @epic T10157
 * @saga T9855
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

/**
 * Seed an attachment row with the given `slug` so subsequent resolver calls
 * see it as occupied. Uses the canonical `createAttachmentStore` write path
 * so the row passes through the same schema + slug-pre-check that real
 * writes do.
 */
async function seedSlug(slug: string, content: string): Promise<void> {
  const { createAttachmentStore } = await import('../../store/attachment-store.js');
  const store = createAttachmentStore();
  await store.put(
    Buffer.from(content, 'utf-8'),
    { kind: 'blob', storageKey: '', mime: 'text/markdown', size: content.length },
    'task',
    'T9999',
    'numbering-test',
    undefined,
    { slug, type: 'adr' },
  );
}

describe('resolveNextDocNumber + applyAutoSlug (T10159)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-numbering-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
    const { _resetNumberingCache_TESTING_ONLY } = await import('../numbering.js');
    _resetNumberingCache_TESTING_ONLY();
  });

  afterEach(async () => {
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();
    const { _resetNumberingCache_TESTING_ONLY } = await import('../numbering.js');
    _resetNumberingCache_TESTING_ONLY();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('resolves the next ADR number to 1 when no ADR rows exist', async () => {
    const { resolveNextDocNumber } = await import('../numbering.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    const result = await resolveNextDocNumber('adr');
    expect(result.kind).toBe('adr');
    expect(result.sequence).toBe(1);
  });

  it('returns max+1 when prior ADR rows exist (single seed)', async () => {
    const { resolveNextDocNumber } = await import('../numbering.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    await seedSlug('adr-077-saga-first-class', 'adr seed 077');

    const result = await resolveNextDocNumber('adr');
    expect(result.sequence).toBe(78);
  });

  it('returns max+1 across a mixed corpus (3-digit + 4-digit)', async () => {
    const { resolveNextDocNumber } = await import('../numbering.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    await seedSlug('adr-001-first', 'a');
    await seedSlug('adr-050-mid', 'b');
    await seedSlug('adr-1234-far-future', 'c');

    const result = await resolveNextDocNumber('adr');
    expect(result.sequence).toBe(1235);
  });

  it('returns sequence:0 for non-numbered DocKinds (note)', async () => {
    const { resolveNextDocNumber } = await import('../numbering.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    const result = await resolveNextDocNumber('note');
    expect(result.kind).toBe('note');
    expect(result.sequence).toBe(0);
  });

  it('applyAutoSlug pads adr numbers to 3 digits', async () => {
    const { applyAutoSlug } = await import('../numbering.js');
    expect(applyAutoSlug('adr-AUTO-saga-fix', 78, 'adr')).toBe('adr-078-saga-fix');
    expect(applyAutoSlug('adr-AUTO-foo', 1, 'adr')).toBe('adr-001-foo');
  });

  it('applyAutoSlug widens past pad width for large N', async () => {
    const { applyAutoSlug } = await import('../numbering.js');
    expect(applyAutoSlug('adr-AUTO-overflow', 1235, 'adr')).toBe('adr-1235-overflow');
  });

  it('applyAutoSlug passes through unchanged when AUTO not present', async () => {
    const { applyAutoSlug } = await import('../numbering.js');
    expect(applyAutoSlug('adr-077-already-numbered', 99, 'adr')).toBe('adr-077-already-numbered');
  });

  it('applyAutoSlug does NOT pad when no kind hint is supplied (changeset shape)', async () => {
    const { applyAutoSlug } = await import('../numbering.js');
    expect(applyAutoSlug('t9999-AUTO-foo', 3)).toBe('t9999-3-foo');
  });

  it('parseSlugSequence extracts (kind, sequence, remainder) from a numbered adr slug', async () => {
    const { parseSlugSequence } = await import('../numbering.js');
    const parsed = parseSlugSequence('adr-078-saga-first-class');
    expect(parsed).not.toBeNull();
    if (parsed) {
      expect(parsed.kind).toBe('adr');
      expect(parsed.sequence).toBe(78);
      expect(parsed.remainder).toBe('saga-first-class');
    }
  });

  it('parseSlugSequence returns null for unprefixed slugs', async () => {
    const { parseSlugSequence } = await import('../numbering.js');
    expect(parseSlugSequence('foo')).toBeNull();
    expect(parseSlugSequence('not-an-adr')).toBeNull();
  });

  it('parseSlugSequence returns null for short-digit adr slugs (must be 3-4 digits)', async () => {
    const { parseSlugSequence } = await import('../numbering.js');
    expect(parseSlugSequence('adr-7-too-short')).toBeNull();
  });
});

describe('allocateAutoSlug — one-shot resolver (T10159)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-numbering-alloc-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  });

  afterEach(async () => {
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('rewrites adr-AUTO-foo to adr-NNN-foo using the kind-canonical pad width', async () => {
    const { allocateAutoSlug } = await import('../numbering.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    await seedSlug('adr-077-prior', 'seed');

    const result = await allocateAutoSlug('adr', 'adr-AUTO-saga-fix');
    expect(result).toBe('adr-078-saga-fix');
  });

  it('rewrites t<id>-AUTO-foo using a slug-derived descriptor (changeset shape)', async () => {
    const { allocateAutoSlug } = await import('../numbering.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    const result = await allocateAutoSlug('changeset', 't9999-AUTO-foo');
    // No prior t9999-N rows → starts at 1, no padding for slug-derived
    // descriptors.
    expect(result).toBe('t9999-1-foo');
  });

  it('returns the input unchanged when AUTO is absent', async () => {
    const { allocateAutoSlug } = await import('../numbering.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    const result = await allocateAutoSlug('adr', 'adr-123-explicit');
    expect(result).toBe('adr-123-explicit');
  });

  it('5 concurrent allocations return 5 DISTINCT sequence numbers (no duplicates)', async () => {
    const { allocateAutoSlug } = await import('../numbering.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    // Seed one ADR so the starting point is non-trivial.
    await seedSlug('adr-077-prior', 'seed');

    const slugs = await Promise.all([
      allocateAutoSlug('adr', 'adr-AUTO-a'),
      allocateAutoSlug('adr', 'adr-AUTO-b'),
      allocateAutoSlug('adr', 'adr-AUTO-c'),
      allocateAutoSlug('adr', 'adr-AUTO-d'),
      allocateAutoSlug('adr', 'adr-AUTO-e'),
    ]);

    // Extract the numeric portion of each result.
    const numbers = slugs
      .map((s) => /^adr-(\d{3,4})-/.exec(s)?.[1])
      .filter((d): d is string => d !== undefined)
      .map((d) => Number.parseInt(d, 10));

    expect(numbers).toHaveLength(5);
    expect(new Set(numbers).size).toBe(5);
    // Every allocation must yield a number STRICTLY GREATER than the seed.
    for (const n of numbers) {
      expect(n).toBeGreaterThan(77);
    }
  });
});
