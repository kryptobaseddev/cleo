/**
 * Tests for the display-alias storage subsystem (T11875).
 *
 * Three concerns, mirroring the acceptance criteria:
 *   1. `setDisplayAlias` happy path — assigns / clears the stored alias.
 *   2. `setDisplayAlias` uniqueness — rejects a number already owned by another
 *      `type='adr'` doc; non-adr kinds may reuse numbers freely.
 *   3. `resolveDisplayNumber` precedence — the stored alias wins over the
 *      slug-derived number; falls back to slug-derived when null.
 *
 * Each test uses an isolated temporary `.cleo/` so the tasks.db singleton resets
 * between runs (same pattern as numbering.test.ts / slug-allocator.test.ts).
 *
 * @task T11875
 * @epic T11781
 * @saga T11778
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

/**
 * Seed an attachment row with the given `slug` + `type` so subsequent
 * set-alias / resolver calls see it as a real persisted doc. Uses the canonical
 * `createAttachmentStore` write path so the row passes the same schema + slug
 * pre-check that production writes do.
 */
async function seedSlug(slug: string, type: string, content: string): Promise<void> {
  const { createAttachmentStore } = await import('../../store/attachment-store.js');
  const store = createAttachmentStore();
  await store.put(
    Buffer.from(content, 'utf-8'),
    { kind: 'blob', storageKey: '', mime: 'text/markdown', size: content.length },
    'task',
    'T9999',
    'display-alias-test',
    undefined,
    { slug, type },
  );
}

/** Read back the stored `display_alias` for a slug via the attachment store. */
async function readAlias(slug: string): Promise<number | null> {
  const { createAttachmentStore } = await import('../../store/attachment-store.js');
  const store = createAttachmentStore();
  const row = await store.findBySlug(slug, tempDir);
  return row?.displayAlias ?? null;
}

describe('setDisplayAlias (T11875)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-display-alias-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  });

  afterEach(async () => {
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('assigns a display alias to an existing ADR slug (happy path)', async () => {
    const { setDisplayAlias } = await import('../display-alias.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    await seedSlug('adr-051-override-patterns', 'adr', 'override patterns body');

    const result = await setDisplayAlias(tempDir, {
      slug: 'adr-051-override-patterns',
      displayAlias: 91,
    });

    expect(result.slug).toBe('adr-051-override-patterns');
    expect(result.displayAlias).toBe(91);
    expect(result.previousAlias).toBeNull();
    expect(result.type).toBe('adr');
    // Persisted to the column.
    expect(await readAlias('adr-051-override-patterns')).toBe(91);
  });

  it('clears an existing alias when displayAlias=null (revert to slug-derived)', async () => {
    const { setDisplayAlias } = await import('../display-alias.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    await seedSlug('adr-051-worktree-extension', 'adr', 'worktree ext body');
    await setDisplayAlias(tempDir, { slug: 'adr-051-worktree-extension', displayAlias: 92 });
    expect(await readAlias('adr-051-worktree-extension')).toBe(92);

    const cleared = await setDisplayAlias(tempDir, {
      slug: 'adr-051-worktree-extension',
      displayAlias: null,
    });
    expect(cleared.previousAlias).toBe(92);
    expect(cleared.displayAlias).toBeNull();
    expect(await readAlias('adr-051-worktree-extension')).toBeNull();
  });

  it('rejects a number already assigned to another ADR (uniqueness)', async () => {
    const { setDisplayAlias, SET_ALIAS_TAKEN_CODE } = await import('../display-alias.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    await seedSlug('adr-051-override-patterns', 'adr', 'a');
    await seedSlug('adr-051-worktree-extension', 'adr', 'b');

    await setDisplayAlias(tempDir, { slug: 'adr-051-override-patterns', displayAlias: 91 });

    await expect(
      setDisplayAlias(tempDir, { slug: 'adr-051-worktree-extension', displayAlias: 91 }),
    ).rejects.toMatchObject({
      details: { code: SET_ALIAS_TAKEN_CODE },
    });

    // The losing doc must remain unaliased (transaction rolled back).
    expect(await readAlias('adr-051-worktree-extension')).toBeNull();
  });

  it('allows re-assigning the SAME number to the SAME doc (no self-conflict)', async () => {
    const { setDisplayAlias } = await import('../display-alias.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    await seedSlug('adr-068-cleo-database-charter', 'adr', 'charter');
    await setDisplayAlias(tempDir, { slug: 'adr-068-cleo-database-charter', displayAlias: 68 });

    const again = await setDisplayAlias(tempDir, {
      slug: 'adr-068-cleo-database-charter',
      displayAlias: 68,
    });
    expect(again.displayAlias).toBe(68);
    expect(again.previousAlias).toBe(68);
  });

  it('does NOT enforce uniqueness across non-adr kinds (specs may reuse numbers)', async () => {
    const { setDisplayAlias } = await import('../display-alias.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    await seedSlug('spec-051-alpha', 'spec', 'a');
    await seedSlug('spec-051-beta', 'spec', 'b');

    await setDisplayAlias(tempDir, { slug: 'spec-051-alpha', displayAlias: 51 });
    // Same number on another spec is allowed — uniqueness is adr-scoped.
    const ok = await setDisplayAlias(tempDir, { slug: 'spec-051-beta', displayAlias: 51 });
    expect(ok.displayAlias).toBe(51);
  });

  it('rejects an unknown slug with E_NOT_FOUND', async () => {
    const { setDisplayAlias } = await import('../display-alias.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    await expect(
      setDisplayAlias(tempDir, { slug: 'adr-999-does-not-exist', displayAlias: 5 }),
    ).rejects.toThrow(/does not match any attachment row/);
  });

  it('rejects a non-positive / non-integer alias number', async () => {
    const { setDisplayAlias } = await import('../display-alias.js');
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();

    await seedSlug('adr-070-three-tier-orchestration', 'adr', 'x');

    await expect(
      setDisplayAlias(tempDir, { slug: 'adr-070-three-tier-orchestration', displayAlias: 0 }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      setDisplayAlias(tempDir, { slug: 'adr-070-three-tier-orchestration', displayAlias: 1.5 }),
    ).rejects.toThrow(/positive integer/);
  });
});

describe('resolveDisplayNumber — precedence (T11875)', () => {
  it('prefers the stored alias over the slug-derived number', async () => {
    const { resolveDisplayNumber } = await import('../numbering.js');
    // Slug derives 051, but the stored alias is 091 — alias wins.
    expect(resolveDisplayNumber('adr-051-override-patterns', 91)).toBe(91);
  });

  it('falls back to the slug-derived number when the alias is null', async () => {
    const { resolveDisplayNumber } = await import('../numbering.js');
    expect(resolveDisplayNumber('adr-051-override-patterns', null)).toBe(51);
    expect(resolveDisplayNumber('adr-051-override-patterns', undefined)).toBe(51);
  });

  it('returns null when neither alias nor slug yields a number', async () => {
    const { resolveDisplayNumber } = await import('../numbering.js');
    expect(resolveDisplayNumber('note-some-handoff', null)).toBeNull();
    expect(resolveDisplayNumber(null, null)).toBeNull();
    expect(resolveDisplayNumber(undefined, undefined)).toBeNull();
  });

  it('ignores a non-positive / non-integer stored alias and falls back to slug', async () => {
    const { resolveDisplayNumber } = await import('../numbering.js');
    expect(resolveDisplayNumber('adr-051-override-patterns', 0)).toBe(51);
    expect(resolveDisplayNumber('adr-051-override-patterns', -3)).toBe(51);
    expect(resolveDisplayNumber('adr-051-override-patterns', 1.5)).toBe(51);
  });
});
