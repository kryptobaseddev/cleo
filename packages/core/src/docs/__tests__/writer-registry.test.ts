/**
 * Tests for the DocKind Writer Registry (T10366).
 *
 * The registry maps every `BuiltinDocKind` to exactly ONE writer descriptor.
 * Tests assert:
 *
 *   - Every `BUILTIN_DOC_KINDS` entry has a descriptor (coverage).
 *   - No DocKind has more than one descriptor (no multi-writer collision).
 *   - `for()` returns the correct verb + mode for representative kinds.
 *   - `for()` throws `E_INVALID_KIND` on unknown kind.
 *   - `validateNoCollisions()` returns `{ ok: true }` for the built-in map.
 *   - `write()` consults the slug allocator before the writer (foundation).
 *   - `.cleo/canon.yml` parity: every `ssot-first` descriptor matches a
 *     `canonicalHome: 'ssot-first'` kind in the canon registry, and vice
 *     versa.
 *
 * @task T10366
 * @epic T10290
 * @saga T10288
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BUILTIN_DOC_KIND_VALUES, type BuiltinDocKind } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadCanonRegistry } from '../../session/canon-lint.js';
import { WriterRegistry, WriterRegistryCollisionError } from '../writer-registry.js';

// Project root — used by the canon.yml parity test to load the canonical
// routing taxonomy. Walks up from this test file location to the repo root.
// __dirname-equivalent via `import.meta.url` would also work; resolving from
// process.cwd() is simpler and matches how vitest already runs.
const PROJECT_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

describe('WriterRegistry — coverage + uniqueness', () => {
  it('every BUILTIN_DOC_KINDS entry has exactly one descriptor', () => {
    const descriptors = WriterRegistry.list();
    const registeredKinds = new Set(descriptors.map((d) => d.kind));

    // Every builtin kind has a descriptor.
    for (const kind of BUILTIN_DOC_KIND_VALUES) {
      expect(registeredKinds.has(kind as BuiltinDocKind)).toBe(true);
    }

    // No descriptor references a non-builtin kind.
    const builtinSet = new Set(BUILTIN_DOC_KIND_VALUES);
    for (const desc of descriptors) {
      expect(builtinSet.has(desc.kind)).toBe(true);
    }

    // Descriptor count matches builtin count (no duplicates, no extras).
    expect(descriptors.length).toBe(BUILTIN_DOC_KIND_VALUES.length);
  });

  it('expects exactly 10 builtin DocKinds (T10366 snapshot)', () => {
    // Pin the count so a new kind addition forces a deliberate registry
    // update. When a kind is added to BUILTIN_DOC_KINDS, this assertion
    // fails AND the coverage assertion above fails — both must be updated
    // together.
    expect(BUILTIN_DOC_KIND_VALUES.length).toBe(10);
    expect(WriterRegistry.list().length).toBe(10);
  });

  it('hasCompleteCoverage returns true for the built-in map', () => {
    expect(WriterRegistry.hasCompleteCoverage()).toBe(true);
  });

  it('validateNoCollisions returns { ok: true } for the built-in map', () => {
    expect(WriterRegistry.validateNoCollisions()).toEqual({ ok: true });
  });
});

describe('WriterRegistry.for — per-kind descriptor shape', () => {
  it("returns a descriptor with mode 'ssot-first' for 'changeset'", () => {
    const desc = WriterRegistry.for('changeset');
    expect(desc.kind).toBe('changeset');
    expect(desc.mode).toBe('ssot-first');
    expect(desc.verb).toBe('changeset add');
    expect(desc.dispatchOp).toBe('changeset.add');
    expect(desc.coreFn).toBe('writeChangesetEntry');
    expect(desc.sourcePath).toBe('packages/core/src/changesets/writer.ts');
  });

  it("returns a descriptor with mode 'ssot' for 'adr'", () => {
    const desc = WriterRegistry.for('adr');
    expect(desc.kind).toBe('adr');
    expect(desc.mode).toBe('ssot');
    expect(desc.verb).toBe('docs add');
    expect(desc.dispatchOp).toBe('docs.add');
  });

  it("returns a 'system-managed' descriptor for 'llm-readme'", () => {
    const desc = WriterRegistry.for('llm-readme');
    expect(desc.mode).toBe('system-managed');
    expect(desc.verb).toBe('system-managed');
    expect(desc.coreFn).toBe('generateDocsLlmsTxt');
  });

  it("returns a 'system-managed' descriptor for 'release-note'", () => {
    const desc = WriterRegistry.for('release-note');
    expect(desc.mode).toBe('system-managed');
    expect(desc.verb).toBe('system-managed');
  });

  it('throws E_INVALID_KIND when the kind is not registered', () => {
    expect(() => WriterRegistry.for('not-a-real-kind' as BuiltinDocKind)).toThrow(/E_INVALID_KIND/);
  });
});

describe('WriterRegistry — canon.yml parity', () => {
  it('every ssot-first descriptor matches canon.yml canonicalHome', () => {
    const canon = loadCanonRegistry(PROJECT_ROOT);
    if (!canon) {
      throw new Error(
        `canon.yml not found at ${PROJECT_ROOT}/.cleo/canon.yml — ` + 'cannot run parity test',
      );
    }

    for (const desc of WriterRegistry.list()) {
      if (desc.mode !== 'ssot-first') continue;
      const canonEntry = canon.kinds[desc.kind];
      expect(canonEntry).toBeDefined();
      if (canonEntry) {
        expect(canonEntry.canonicalHome).toBe('ssot-first');
      }
    }
  });

  it('every ssot descriptor matches canon.yml canonicalHome (or maps to a system-managed routing)', () => {
    const canon = loadCanonRegistry(PROJECT_ROOT);
    if (!canon) {
      throw new Error(`canon.yml not found at ${PROJECT_ROOT}/.cleo/canon.yml`);
    }

    for (const desc of WriterRegistry.list()) {
      if (desc.mode !== 'ssot') continue;
      const canonEntry = canon.kinds[desc.kind];
      // ssot descriptors MUST exist in canon.yml — they are user-routed.
      expect(canonEntry).toBeDefined();
      if (canonEntry) {
        // canon.yml may classify it as ssot OR ssot-first — both are valid
        // "exists in canon" outcomes. The descriptor mode is the writer-side
        // routing decision; canon is the consumer-side gate.
        expect(['ssot', 'ssot-first']).toContain(canonEntry.canonicalHome);
      }
    }
  });

  it('every canon.yml ssot-first kind has a matching ssot-first descriptor (reverse parity)', () => {
    const canon = loadCanonRegistry(PROJECT_ROOT);
    if (!canon) {
      throw new Error(`canon.yml not found at ${PROJECT_ROOT}/.cleo/canon.yml`);
    }

    const ssotFirstDescriptorKinds = new Set(
      WriterRegistry.list()
        .filter((d) => d.mode === 'ssot-first')
        .map((d) => d.kind as string),
    );

    for (const [kind, entry] of Object.entries(canon.kinds)) {
      if (entry.canonicalHome === 'ssot-first') {
        expect(ssotFirstDescriptorKinds.has(kind)).toBe(true);
      }
    }
  });
});

describe('WriterRegistry.write — slug allocator handshake (foundation)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-writer-registry-'));
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
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns E_INVALID_KIND for an unknown kind WITHOUT calling the allocator', async () => {
    const result = await WriterRegistry.write({
      kind: 'unknown-kind' as BuiltinDocKind,
      slug: 'irrelevant',
      payload: { slug: 'irrelevant' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('E_INVALID_KIND');
    }
  });

  it('calls reserveSlug FIRST — returns E_NOT_IMPLEMENTED on success path (T10366 foundation)', async () => {
    // T10366 is the foundation only; actual writer delegation lands in
    // T10367 + T10368. The success path of `write()` therefore returns
    // E_NOT_IMPLEMENTED with the resolved descriptor so callers can prove
    // the registry was consulted and the slug was reserved.
    const result = await WriterRegistry.write({
      kind: 'changeset',
      slug: 't10366-foundation',
      payload: { slug: 't10366-foundation' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('E_NOT_IMPLEMENTED');
      const details = result.details as { descriptor?: { kind?: string }; normalizedSlug?: string };
      expect(details.descriptor?.kind).toBe('changeset');
      expect(details.normalizedSlug).toBe('t10366-foundation');
    }
  });

  it('short-circuits on E_SLUG_RESERVED — collision returns the allocator suggestions', async () => {
    const { reserveSlug } = await import('../slug-allocator.js');

    // Pre-reserve the slug so the registry's allocator call collides.
    const pre = await reserveSlug('changeset', 'pre-taken');
    expect(pre.ok).toBe(true);

    const result = await WriterRegistry.write({
      kind: 'changeset',
      slug: 'pre-taken',
      payload: { slug: 'pre-taken' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('E_SLUG_RESERVED');
      const details = result.details as { suggestions?: string[] };
      expect(details.suggestions).toHaveLength(3);
    }
  });
});

describe('WriterRegistryCollisionError', () => {
  it('carries the offending kind + count', () => {
    const err = new WriterRegistryCollisionError('changeset', 2);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WriterRegistryCollisionError');
    expect(err.kind).toBe('changeset');
    expect(err.message).toContain('changeset');
    expect(err.message).toContain('2');
  });
});

// ─── T10368: system-managed exemption map ─────────────────────────────────────

describe('WriterRegistry.listSystemManaged (T10368)', () => {
  it('returns at least the known second-writer hits from the E2 decomp planner', () => {
    const entries = WriterRegistry.listSystemManaged();
    const ids = new Set(entries.map((e) => e.id));

    // Each known second-writer call site MUST have an entry.
    expect(ids.has('release.plan-json')).toBe(true);
    expect(ids.has('release.changelog')).toBe(true);
    expect(ids.has('lifecycle.rcasd-migration')).toBe(true);
    expect(ids.has('lifecycle.stage-artifact')).toBe(true);
    expect(ids.has('sessions.handoff-markdown')).toBe(true);
    expect(ids.has('nexus.wiki-overview')).toBe(true);
    expect(ids.has('docs.publish-mirror')).toBe(true);
  });

  it('every entry carries an ADR pointer', () => {
    for (const entry of WriterRegistry.listSystemManaged()) {
      expect(entry.adrRef).toMatch(/ADR-\d+/);
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(entry.sourcePath).toContain('packages/');
      expect(entry.callsite).toContain('packages/');
    }
  });

  it('ids are unique', () => {
    const entries = WriterRegistry.listSystemManaged();
    const ids = entries.map((e) => e.id);
    const uniq = new Set(ids);
    expect(uniq.size).toBe(ids.length);
  });
});

describe('WriterRegistry.isSystemManaged (T10368)', () => {
  it('matches release.plan-json by exact path', () => {
    const hit = WriterRegistry.isSystemManaged('.cleo/release/v2026.5.103.plan.json');
    expect(hit).not.toBeNull();
    if (hit !== null) {
      expect(hit.id).toBe('release.plan-json');
    }
  });

  it('matches CHANGELOG.md', () => {
    const hit = WriterRegistry.isSystemManaged('CHANGELOG.md');
    expect(hit).not.toBeNull();
    if (hit !== null) {
      expect(hit.id).toBe('release.changelog');
      expect(hit.kind).toBe('release-note');
    }
  });

  it('matches RCASD migration glob', () => {
    const hit = WriterRegistry.isSystemManaged('.cleo/rcasd/T4881/research/install.md');
    expect(hit).not.toBeNull();
    if (hit !== null) {
      // Either of the two rcasd-keyed entries is acceptable. The migration
      // tool runs against the same on-disk layout that the stage artifact
      // composer produces, so glob overlap is expected; first-match-wins is
      // by design.
      expect(['lifecycle.rcasd-migration', 'lifecycle.stage-artifact']).toContain(hit.id);
    }
  });

  it('matches stage artifact paths', () => {
    const hit = WriterRegistry.isSystemManaged('.cleo/stages/research/T1234-research.md');
    expect(hit).not.toBeNull();
    if (hit !== null) {
      expect(hit.id).toBe('lifecycle.stage-artifact');
    }
  });

  it('returns null for an unregistered .md write', () => {
    const hit = WriterRegistry.isSystemManaged('packages/cleo/src/cli/some-random.md');
    expect(hit).toBeNull();
  });

  it('normalises Windows-style backslashes', () => {
    const hit = WriterRegistry.isSystemManaged('.cleo\\release\\v1.0.0.plan.json');
    expect(hit).not.toBeNull();
    if (hit !== null) {
      expect(hit.id).toBe('release.plan-json');
    }
  });
});

describe('WriterRegistry.findSystemManagedById (T10368)', () => {
  it('returns the entry for a known id', () => {
    const entry = WriterRegistry.findSystemManagedById('release.plan-json');
    expect(entry).not.toBeNull();
    if (entry !== null) {
      expect(entry.id).toBe('release.plan-json');
      expect(entry.relativePathGlob).toBe('.cleo/release/*.plan.json');
    }
  });

  it('returns null for an unknown id', () => {
    const entry = WriterRegistry.findSystemManagedById('does-not-exist');
    expect(entry).toBeNull();
  });
});
