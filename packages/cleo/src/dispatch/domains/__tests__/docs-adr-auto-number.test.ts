/**
 * Integration tests for the `cleo docs add --type adr` auto-numbering flow.
 *
 * Covers T10360 acceptance criteria:
 *   (a) Sequential allocation: first ADR gets `adr-001-foo-bar`, second
 *       gets `adr-002-...`, ... — verifies the highest-number probe.
 *   (b) Explicit `--slug` bypasses the auto-allocator (back-compat).
 *   (c) `--type adr` without `--title` AND without `--slug` returns
 *       `E_VALIDATION` from the dispatch layer.
 *   (d) Concurrent allocations don't collide (Promise.all × N with the
 *       same title produces N distinct slugs).
 *   (e) `E_ADR_NUMBER_EXHAUSTED` when the allocator's reservation step
 *       fails {@link MAX_ADR_ALLOCATION_ATTEMPTS} times in a row (using
 *       a fault-injected `reserveSlugImpl`).
 *
 * @task T10360 (closes T10153)
 * @epic T10291 (E3-DOCS-CLI-HARDENING)
 * @saga T10288 (SG-DOCS-INTEGRITY)
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
let fixtureD: string;

describe('docs dispatch — ADR auto-numbering (T10360 / closes T10153)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-adr-auto-num-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');

    fixtureA = join(tempDir, 'a.md');
    fixtureB = join(tempDir, 'b.md');
    fixtureC = join(tempDir, 'c.md');
    fixtureD = join(tempDir, 'd.md');
    await writeFile(fixtureA, '# A\n\nadr fixture A', 'utf-8');
    await writeFile(fixtureB, '# B\n\nadr fixture B (different bytes)', 'utf-8');
    await writeFile(fixtureC, '# C\n\nadr fixture C (other bytes)', 'utf-8');
    await writeFile(fixtureD, '# D\n\nadr fixture D (yet other bytes)', 'utf-8');

    // Clear the in-process slug-allocator state so successive tests in
    // the same vitest worker don't leak reservations to each other.
    const { _resetSlugAllocatorState_TESTING_ONLY } = await import('@cleocode/core/internal');
    _resetSlugAllocatorState_TESTING_ONLY();
  });

  afterEach(async () => {
    const { closeDb, _resetSlugAllocatorState_TESTING_ONLY } = await import(
      '@cleocode/core/internal'
    );
    closeDb();
    _resetSlugAllocatorState_TESTING_ONLY();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // ────────────────────────────────────────────────────────────────────────
  // (a) Sequential allocation
  // ────────────────────────────────────────────────────────────────────────

  it('docs.add --type adr --title auto-allocates adr-001 then adr-002', async () => {
    const handler = new DocsHandler();

    const first = await handler.mutate('add', {
      ownerId: 'T1000',
      file: fixtureA,
      type: 'adr',
      title: 'Adopt Drizzle v1 beta',
    });
    expect(first.success).toBe(true);
    const firstData = first.data as { slug?: string; adrNumber?: number; type?: string };
    expect(firstData.type).toBe('adr');
    expect(firstData.slug).toBe('adr-001-adopt-drizzle-v1-beta');
    expect(firstData.adrNumber).toBe(1);

    const second = await handler.mutate('add', {
      ownerId: 'T1001',
      file: fixtureB,
      type: 'adr',
      title: 'Cleo Persona Lock',
    });
    expect(second.success).toBe(true);
    const secondData = second.data as { slug?: string; adrNumber?: number };
    expect(secondData.slug).toBe('adr-002-cleo-persona-lock');
    expect(secondData.adrNumber).toBe(2);
  });

  it('auto-allocator picks the next number after the highest existing ADR slug', async () => {
    const handler = new DocsHandler();

    // Pre-seed with an explicit ADR slug at 42 — the next auto-allocated
    // slug must land on 43, not 1.
    const seed = await handler.mutate('add', {
      ownerId: 'T1100',
      file: fixtureA,
      type: 'adr',
      slug: 'adr-042-seeded-decision',
    });
    expect(seed.success).toBe(true);

    const auto = await handler.mutate('add', {
      ownerId: 'T1101',
      file: fixtureB,
      type: 'adr',
      title: 'Next After Seed',
    });
    expect(auto.success).toBe(true);
    const data = auto.data as { slug?: string; adrNumber?: number };
    expect(data.adrNumber).toBe(43);
    expect(data.slug).toBe('adr-043-next-after-seed');
  });

  // ────────────────────────────────────────────────────────────────────────
  // (b) Explicit --slug bypasses auto-numbering
  // ────────────────────────────────────────────────────────────────────────

  it('docs.add --type adr --slug bypasses the allocator (back-compat)', async () => {
    const handler = new DocsHandler();

    const resp = await handler.mutate('add', {
      ownerId: 'T1200',
      file: fixtureA,
      type: 'adr',
      slug: 'adr-099-explicit-slug',
      // Title is ignored when slug is explicit.
      title: 'This Title Is Ignored',
    });
    expect(resp.success).toBe(true);
    const data = resp.data as { slug?: string; adrNumber?: number };
    expect(data.slug).toBe('adr-099-explicit-slug');
    // No adrNumber is set when the slug was caller-provided.
    expect(data.adrNumber).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────────────
  // (c) Missing title rejection
  // ────────────────────────────────────────────────────────────────────────

  it('docs.add --type adr without --slug AND without --title returns E_VALIDATION', async () => {
    const handler = new DocsHandler();

    const resp = await handler.mutate('add', {
      ownerId: 'T1300',
      file: fixtureA,
      type: 'adr',
    });
    expect(resp.success).toBe(false);
    expect(resp.error?.code).toBe('E_VALIDATION');
    expect(resp.error?.message).toMatch(/title/i);
  });

  it('docs.add --type adr with whitespace-only --title returns E_VALIDATION', async () => {
    const handler = new DocsHandler();

    const resp = await handler.mutate('add', {
      ownerId: 'T1300',
      file: fixtureA,
      type: 'adr',
      title: '   ',
    });
    expect(resp.success).toBe(false);
    expect(resp.error?.code).toBe('E_VALIDATION');
  });

  // ────────────────────────────────────────────────────────────────────────
  // (d) Concurrent allocations don't collide
  // ────────────────────────────────────────────────────────────────────────

  it('concurrent docs.add calls with same title produce distinct slugs', async () => {
    const handler = new DocsHandler();

    // We need 4 separate fixtures so each put writes distinct bytes (the
    // attachment store de-dupes blobs by sha256 — same content would
    // surface as the SAME attachment id even with distinct slugs).
    const fixtures = [fixtureA, fixtureB, fixtureC, fixtureD];
    const responses = await Promise.all(
      fixtures.map((file, i) =>
        handler.mutate('add', {
          ownerId: `T140${i}`,
          file,
          type: 'adr',
          title: 'Concurrent Allocation',
        }),
      ),
    );

    for (const r of responses) {
      expect(r.success).toBe(true);
    }
    const slugs = responses.map((r) => (r.data as { slug?: string }).slug);
    const numbers = responses.map((r) => (r.data as { adrNumber?: number }).adrNumber);
    // Slugs must be distinct.
    expect(new Set(slugs).size).toBe(fixtures.length);
    // Numbers must be distinct.
    expect(new Set(numbers).size).toBe(fixtures.length);
    // Every slug matches the expected pattern.
    for (const s of slugs) {
      expect(s).toMatch(/^adr-\d{3,}-concurrent-allocation$/);
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // (e) E_ADR_NUMBER_EXHAUSTED on persistent reservation failures
  // ────────────────────────────────────────────────────────────────────────

  it('allocateAdrSlug surfaces E_ADR_NUMBER_EXHAUSTED after 5 reservation failures', async () => {
    // Drive the core allocator directly with a stub reserveSlug that always
    // returns E_SLUG_RESERVED — exercises the retry-cap branch without
    // racing the real allocator.
    const { allocateAdrSlug, MAX_ADR_ALLOCATION_ATTEMPTS } = await import(
      '@cleocode/core/internal'
    );

    let attempts = 0;
    const failingReserve = async () => {
      attempts++;
      return {
        ok: false as const,
        code: 'E_SLUG_RESERVED' as const,
        suggestions: ['adr-001-x-1', 'adr-001-x-2', 'adr-001-x-3'] as const,
      };
    };

    const result = await allocateAdrSlug('Always Fails', {
      reserveSlugImpl: failingReserve as never,
      startNumberOverride: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('E_ADR_NUMBER_EXHAUSTED');
    }
    expect(attempts).toBe(MAX_ADR_ALLOCATION_ATTEMPTS);
  });
});
