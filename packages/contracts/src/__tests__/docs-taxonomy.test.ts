/**
 * Tests for the canonical doc-kind taxonomy registry (T9788).
 *
 * Covers:
 *  - Built-in registry shape (every kind has the required metadata)
 *  - Backward-compatible enumeration (the 6 prior kinds still resolve)
 *  - Extension load — happy-path
 *  - Extension load — every invalid-config branch
 *  - validateSlug pass/fail for each `requiresEntityId` kind
 *  - validateSlug semantics for kinds without an entityIdPattern
 *
 * @epic T9787
 * @task T9788
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_DOC_KIND_VALUES,
  BUILTIN_DOC_KINDS,
  DocKindConfigError,
  DocKindRegistry,
} from '../docs-taxonomy.js';

/** Build a throwaway project root with a `.cleo/` dir for config-file tests. */
function newProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'docs-taxonomy-test-'));
  mkdirSync(join(root, '.cleo'), { recursive: true });
  return root;
}

/** Convenience — write a `.cleo/docs-config.json` to a project root. */
function writeConfig(root: string, body: unknown): void {
  writeFileSync(join(root, '.cleo', 'docs-config.json'), JSON.stringify(body), 'utf-8');
}

// ──────────────────────────────────────────────────────────────────────────
// BUILTIN_DOC_KINDS shape
// ──────────────────────────────────────────────────────────────────────────

describe('BUILTIN_DOC_KINDS — registry shape', () => {
  it('declares every built-in kind once with kebab-case ids', () => {
    const seen = new Set<string>();
    for (const meta of BUILTIN_DOC_KINDS) {
      expect(meta.kind).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(seen.has(meta.kind)).toBe(false);
      seen.add(meta.kind);
    }
    expect(seen.size).toBe(BUILTIN_DOC_KINDS.length);
  });

  it('attaches an entityIdPattern to every requiresEntityId entry', () => {
    for (const meta of BUILTIN_DOC_KINDS) {
      if (meta.requiresEntityId) {
        expect(meta.entityIdPattern).toBeInstanceOf(RegExp);
      }
    }
  });

  it('exposes every label, description, publishDir, and defaultOwnerKind', () => {
    for (const meta of BUILTIN_DOC_KINDS) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeGreaterThan(0);
      expect(meta.publishDir.length).toBeGreaterThan(0);
      expect(['task', 'session', 'observation', 'project']).toContain(meta.defaultOwnerKind);
    }
  });

  it('preserves backward compatibility with the prior 6-kind DOCS_TYPE_VALUES', () => {
    // The original closed set of kinds must remain registered so existing
    // CLI flags and stored attachments keep working.
    const legacyKinds = ['adr', 'spec', 'research', 'handoff', 'note', 'llm-readme'];
    for (const kind of legacyKinds) {
      expect(BUILTIN_DOC_KIND_VALUES).toContain(kind);
    }
  });

  it('introduces the four new kinds defined by the T9788 spec', () => {
    for (const kind of ['changeset', 'release-note', 'plan', 'rcasd']) {
      expect(BUILTIN_DOC_KIND_VALUES).toContain(kind);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// DocKindRegistry.load — built-ins only (no config file)
// ──────────────────────────────────────────────────────────────────────────

describe('DocKindRegistry.load — built-ins only', () => {
  let root: string;

  beforeEach(() => {
    root = newProjectRoot();
  });

  it('returns every built-in kind when no config file exists', () => {
    const registry = DocKindRegistry.load(root);
    const kinds = registry.list().map((d) => d.kind);
    expect(kinds).toEqual(BUILTIN_DOC_KIND_VALUES);
  });

  it('reports has() correctly for built-ins and rejects unknowns', () => {
    const registry = DocKindRegistry.load(root);
    expect(registry.has('adr')).toBe(true);
    expect(registry.has('rcasd')).toBe(true);
    expect(registry.has('wishlist')).toBe(false);
    expect(registry.has('')).toBe(false);
  });

  it('publishDirFor returns the registry-declared dir for every built-in', () => {
    const registry = DocKindRegistry.load(root);
    expect(registry.publishDirFor('adr')).toBe('docs/adr');
    expect(registry.publishDirFor('changeset')).toBe('.changeset');
    expect(registry.publishDirFor('rcasd')).toBe('.cleo/rcasd');
    expect(registry.publishDirFor('llm-readme')).toBe('.');
  });

  it('publishDirFor returns undefined for unknown kinds', () => {
    const registry = DocKindRegistry.load(root);
    expect(registry.publishDirFor('wishlist')).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// DocKindRegistry.load — with extensions
// ──────────────────────────────────────────────────────────────────────────

describe('DocKindRegistry.load — with valid extensions', () => {
  let root: string;

  beforeEach(() => {
    root = newProjectRoot();
  });

  it('appends extension kinds after the built-ins', () => {
    writeConfig(root, {
      extensions: [
        {
          kind: 'incident',
          label: 'Incident',
          description: 'Post-mortem record',
          defaultOwnerKind: 'task',
          publishDir: 'docs/incident',
          requiresEntityId: true,
          entityIdPattern: '^inc-\\d{4}-\\d{2}-\\d{2}-[a-z0-9-]+$',
        },
      ],
    });

    const registry = DocKindRegistry.load(root);
    const kinds = registry.list();
    expect(kinds.length).toBe(BUILTIN_DOC_KINDS.length + 1);
    expect(kinds[kinds.length - 1].kind).toBe('incident');
    expect(kinds[kinds.length - 1].isExtension).toBe(true);
    expect(kinds[kinds.length - 1].entityIdPattern).toBeInstanceOf(RegExp);
  });

  it('marks extensions with isExtension=true and leaves built-ins untouched', () => {
    writeConfig(root, {
      extensions: [
        {
          kind: 'retro',
          label: 'Retro',
          description: 'Retrospective note',
          defaultOwnerKind: 'session',
          publishDir: 'docs/retro',
          requiresEntityId: false,
        },
      ],
    });

    const registry = DocKindRegistry.load(root);
    const builtin = registry.get('adr');
    const ext = registry.get('retro');
    expect(builtin?.isExtension).toBeUndefined();
    expect(ext?.isExtension).toBe(true);
  });

  it('rejects an extension that shadows a built-in kind', () => {
    writeConfig(root, {
      extensions: [
        {
          kind: 'adr',
          label: 'CUSTOM ADR',
          description: 'shadow attempt',
          defaultOwnerKind: 'task',
          publishDir: 'docs/custom-adr',
          requiresEntityId: false,
        },
      ],
    });

    expect(() => DocKindRegistry.load(root)).toThrow(DocKindConfigError);
  });

  it('supports an empty extensions array', () => {
    writeConfig(root, { extensions: [] });
    const registry = DocKindRegistry.load(root);
    expect(registry.list().length).toBe(BUILTIN_DOC_KINDS.length);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// DocKindRegistry.load — invalid configs
// ──────────────────────────────────────────────────────────────────────────

describe('DocKindRegistry.load — invalid configs', () => {
  let root: string;

  beforeEach(() => {
    root = newProjectRoot();
  });

  it('throws DocKindConfigError on invalid JSON', () => {
    writeFileSync(join(root, '.cleo', 'docs-config.json'), '{ not json', 'utf-8');
    expect(() => DocKindRegistry.load(root)).toThrow(DocKindConfigError);
  });

  it('throws when the top-level value is an array', () => {
    writeFileSync(join(root, '.cleo', 'docs-config.json'), '[]', 'utf-8');
    expect(() => DocKindRegistry.load(root)).toThrow(/must be an object/);
  });

  it('throws when extensions is not an array', () => {
    writeConfig(root, { extensions: { kind: 'x' } });
    expect(() => DocKindRegistry.load(root)).toThrow(/'extensions' must be an array/);
  });

  it('throws when an extension entry is missing required fields', () => {
    writeConfig(root, {
      extensions: [{ kind: 'incident', label: 'I' /* missing description, etc. */ }],
    });
    expect(() => DocKindRegistry.load(root)).toThrow(DocKindConfigError);
  });

  it('throws when kind is not kebab-case', () => {
    writeConfig(root, {
      extensions: [
        {
          kind: 'BadKind',
          label: 'X',
          description: 'Y',
          defaultOwnerKind: 'task',
          publishDir: 'docs/x',
          requiresEntityId: false,
        },
      ],
    });
    expect(() => DocKindRegistry.load(root)).toThrow(/lowercase kebab-case/);
  });

  it('throws when defaultOwnerKind is unsupported', () => {
    writeConfig(root, {
      extensions: [
        {
          kind: 'incident',
          label: 'I',
          description: 'd',
          defaultOwnerKind: 'mystery',
          publishDir: 'docs/incident',
          requiresEntityId: false,
        },
      ],
    });
    expect(() => DocKindRegistry.load(root)).toThrow(/defaultOwnerKind/);
  });

  it('throws when requiresEntityId=true but entityIdPattern is missing', () => {
    writeConfig(root, {
      extensions: [
        {
          kind: 'incident',
          label: 'I',
          description: 'd',
          defaultOwnerKind: 'task',
          publishDir: 'docs/i',
          requiresEntityId: true,
        },
      ],
    });
    expect(() => DocKindRegistry.load(root)).toThrow(/entityIdPattern.*required/);
  });

  it('throws when entityIdPattern is malformed regex', () => {
    writeConfig(root, {
      extensions: [
        {
          kind: 'incident',
          label: 'I',
          description: 'd',
          defaultOwnerKind: 'task',
          publishDir: 'docs/i',
          requiresEntityId: true,
          entityIdPattern: '[oops',
        },
      ],
    });
    expect(() => DocKindRegistry.load(root)).toThrow(/invalid regex/);
  });

  it('throws when entityIdPattern exceeds the safe length limit', () => {
    const huge = 'a'.repeat(DocKindRegistry.SAFE_REGEX_LENGTH_LIMIT + 1);
    writeConfig(root, {
      extensions: [
        {
          kind: 'incident',
          label: 'I',
          description: 'd',
          defaultOwnerKind: 'task',
          publishDir: 'docs/i',
          requiresEntityId: true,
          entityIdPattern: huge,
        },
      ],
    });
    expect(() => DocKindRegistry.load(root)).toThrow(/exceeds/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// DocKindRegistry.builtinOnly + fromConfig
// ──────────────────────────────────────────────────────────────────────────

describe('DocKindRegistry.builtinOnly / fromConfig', () => {
  it('builtinOnly returns exactly the built-ins regardless of disk state', () => {
    const registry = DocKindRegistry.builtinOnly();
    expect(registry.list().length).toBe(BUILTIN_DOC_KINDS.length);
    expect(registry.list().every((d) => d.isExtension !== true)).toBe(true);
  });

  it('fromConfig(undefined) is equivalent to builtinOnly', () => {
    const a = DocKindRegistry.fromConfig(undefined);
    const b = DocKindRegistry.builtinOnly();
    expect(a.list().map((d) => d.kind)).toEqual(b.list().map((d) => d.kind));
  });

  it('fromConfig merges extensions like load() does', () => {
    const registry = DocKindRegistry.fromConfig({
      extensions: [
        {
          kind: 'incident',
          label: 'Incident',
          description: 'Post-mortem',
          defaultOwnerKind: 'task',
          publishDir: 'docs/incident',
          requiresEntityId: false,
        },
      ],
    });
    expect(registry.has('incident')).toBe(true);
    expect(registry.get('incident')?.isExtension).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// DocKindRegistry.validateSlug
// ──────────────────────────────────────────────────────────────────────────

describe('DocKindRegistry.validateSlug', () => {
  const registry = DocKindRegistry.builtinOnly();

  it('returns ok=true for kinds without requiresEntityId', () => {
    expect(registry.validateSlug('spec', 'anything-here').ok).toBe(true);
    expect(registry.validateSlug('note', 'free-form-1').ok).toBe(true);
    expect(registry.validateSlug('plan', '').ok).toBe(true);
  });

  it('accepts conforming slugs for ADR (adr-NNN-<rest>)', () => {
    expect(registry.validateSlug('adr', 'adr-001-intro').ok).toBe(true);
    expect(registry.validateSlug('adr', 'adr-9999-complex-rationale').ok).toBe(true);
  });

  it('rejects non-conforming ADR slugs with an example hint', () => {
    const result = registry.validateSlug('adr', 'random-name');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('does not match');
      expect(result.example).toBe('adr-001-intro');
    }
  });

  it('accepts conforming changeset slugs (t####-<rest>)', () => {
    expect(registry.validateSlug('changeset', 't9788-docs-taxonomy').ok).toBe(true);
    expect(registry.validateSlug('changeset', 't1-x').ok).toBe(true);
  });

  it('rejects malformed changeset slugs', () => {
    expect(registry.validateSlug('changeset', 'release-notes').ok).toBe(false);
    expect(registry.validateSlug('changeset', 'T9788-UPPERCASE').ok).toBe(false);
  });

  it('accepts conforming release-note slugs (v####.MM.N)', () => {
    expect(registry.validateSlug('release-note', 'v2026.5.93').ok).toBe(true);
    expect(registry.validateSlug('release-note', 'v2026.12.99-rc1').ok).toBe(true);
  });

  it('rejects malformed release-note slugs', () => {
    expect(registry.validateSlug('release-note', '2026.5.93').ok).toBe(false);
    expect(registry.validateSlug('release-note', 'v1.2').ok).toBe(false);
  });

  it('accepts conforming rcasd slugs (t#### or t####-<rest>)', () => {
    expect(registry.validateSlug('rcasd', 't9788').ok).toBe(true);
    expect(registry.validateSlug('rcasd', 't9788-investigation').ok).toBe(true);
  });

  it('reports unknown kinds with a useful error', () => {
    const result = registry.validateSlug('wishlist', 'anything');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unknown kind 'wishlist'");
    }
  });

  it('reports the defensive branch when entityIdPattern is missing on a require-entity entry', () => {
    // Construct a hand-crafted registry that bypasses the load-time guard.
    const broken = new DocKindRegistry([
      {
        kind: 'broken',
        label: 'Broken',
        description: 'pattern intentionally omitted',
        defaultOwnerKind: 'task',
        publishDir: 'docs/broken',
        requiresEntityId: true,
        // entityIdPattern intentionally omitted to exercise the defensive
        // branch in validateSlug.
      },
    ]);
    const result = broken.validateSlug('broken', 'anything');
    expect(result.ok).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// DocKindRegistry.get / has — extension precedence
// ──────────────────────────────────────────────────────────────────────────

describe('DocKindRegistry — built-ins beat extensions on collision', () => {
  it('first-write-wins semantics keep built-ins authoritative', () => {
    // The constructor uses first-write-wins; load() always passes builtins
    // first. This test exercises the constructor directly so any future
    // refactor can't regress the invariant silently.
    const registry = new DocKindRegistry([
      ...BUILTIN_DOC_KINDS,
      {
        kind: 'adr',
        label: 'shadow attempt',
        description: 'should never win',
        defaultOwnerKind: 'project',
        publishDir: 'docs/SHADOW',
        requiresEntityId: false,
        isExtension: true,
      },
    ]);
    const meta = registry.get('adr');
    expect(meta?.label).toBe('ADR');
    expect(meta?.publishDir).toBe('docs/adr');
  });
});

// keep one afterEach stub so vitest reports the suite cleanly even when
// tests share root state under the OS temp dir.
afterEach(() => {});
