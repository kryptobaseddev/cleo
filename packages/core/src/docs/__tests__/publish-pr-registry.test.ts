/**
 * Tests for the publish-pr taxonomy bridge added by T9788.
 *
 * `publishDirForType` used to hard-code `docs/<type>` and back its lookup
 * against an inlined `KNOWN_DOC_TYPES` set. After T9788 both derive from
 * the canonical {@link DocKindRegistry} — these tests assert the bridge
 * behaviour without booting the full publish-pr flow.
 *
 * Coverage:
 *  - publishDirForType maps every built-in kind to the registry-declared dir
 *  - publishDirForType falls back to docs/note for unknown / nullish input
 *  - knownDocTypesForProject merges built-ins + project extensions
 *  - knownDocTypesForProject falls back to built-ins when the config is invalid
 *  - KNOWN_DOC_TYPES (legacy export) still contains every built-in kind id
 *
 * @epic T9787
 * @task T9788
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_DOC_KINDS } from '@cleocode/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { KNOWN_DOC_TYPES, knownDocTypesForProject, publishDirForType } from '../publish-pr.js';

/** Build a throwaway project root with a `.cleo/` dir for config-file tests. */
function newProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'publish-pr-registry-test-'));
  mkdirSync(join(root, '.cleo'), { recursive: true });
  return root;
}

describe('publishDirForType — registry-backed lookup (T9788)', () => {
  it('maps every built-in kind to the registry-declared dir', () => {
    for (const meta of BUILTIN_DOC_KINDS) {
      expect(publishDirForType(meta.kind)).toBe(meta.publishDir);
    }
  });

  it('falls back to docs/note for unknown kinds', () => {
    expect(publishDirForType('wishlist')).toBe('docs/note');
    expect(publishDirForType('totally-fake-kind-xyz')).toBe('docs/note');
  });

  it('falls back to docs/note for nullish input', () => {
    expect(publishDirForType(undefined)).toBe('docs/note');
    expect(publishDirForType(null)).toBe('docs/note');
    expect(publishDirForType('')).toBe('docs/note');
  });

  it('reports the bespoke publish-dir for the four new T9788 kinds', () => {
    expect(publishDirForType('changeset')).toBe('.changeset');
    expect(publishDirForType('release-note')).toBe('docs/release');
    expect(publishDirForType('rcasd')).toBe('.cleo/rcasd');
    expect(publishDirForType('plan')).toBe('docs/plan');
  });

  it('picks up project extensions when projectRoot is supplied', () => {
    const root = newProjectRoot();
    writeFileSync(
      join(root, '.cleo', 'docs-config.json'),
      JSON.stringify({
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
      }),
      'utf-8',
    );

    expect(publishDirForType('incident', root)).toBe('docs/incident');
    // Without projectRoot the same kind falls back since the extension
    // is invisible to the built-in-only registry.
    expect(publishDirForType('incident')).toBe('docs/note');
  });

  it('handles a malformed config without throwing', () => {
    const root = newProjectRoot();
    writeFileSync(join(root, '.cleo', 'docs-config.json'), '{ not-json', 'utf-8');
    // Even with a broken config, every built-in kind continues to resolve.
    expect(publishDirForType('adr', root)).toBe('docs/adr');
  });
});

describe('knownDocTypesForProject — merge built-ins with extensions (T9788)', () => {
  let root: string;

  beforeEach(() => {
    root = newProjectRoot();
  });

  it('returns every built-in kind when no config file exists', () => {
    const types = knownDocTypesForProject(root);
    for (const meta of BUILTIN_DOC_KINDS) {
      expect(types.has(meta.kind)).toBe(true);
    }
  });

  it('merges extensions into the resulting set', () => {
    writeFileSync(
      join(root, '.cleo', 'docs-config.json'),
      JSON.stringify({
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
      }),
      'utf-8',
    );
    const types = knownDocTypesForProject(root);
    expect(types.has('incident')).toBe(true);
    expect(types.has('adr')).toBe(true);
  });

  it('falls back to built-ins-only on malformed config', () => {
    writeFileSync(join(root, '.cleo', 'docs-config.json'), '{ broken', 'utf-8');
    const types = knownDocTypesForProject(root);
    for (const meta of BUILTIN_DOC_KINDS) {
      expect(types.has(meta.kind)).toBe(true);
    }
  });
});

describe('KNOWN_DOC_TYPES — legacy export still contains every built-in (T9788)', () => {
  it('contains the prior 6-kind closed set', () => {
    for (const kind of ['adr', 'spec', 'research', 'handoff', 'note', 'llm-readme']) {
      expect(KNOWN_DOC_TYPES.has(kind)).toBe(true);
    }
  });

  it('also contains the four new T9788 kinds', () => {
    for (const kind of ['changeset', 'release-note', 'plan', 'rcasd']) {
      expect(KNOWN_DOC_TYPES.has(kind)).toBe(true);
    }
  });

  it('does not contain unknown kinds', () => {
    expect(KNOWN_DOC_TYPES.has('wishlist')).toBe(false);
  });
});
