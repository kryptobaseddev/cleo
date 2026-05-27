/**
 * Tests for the ConfigManifest contract (T9876 / Saga T9855 / ADR-076).
 *
 * Covers:
 * - Schema round-trip for each of the 4 built-in entries.
 * - Merge-precedence invariant (project > global > defaults).
 * - Metadata-scope isolation (NOT in the merge chain).
 * - {@link DriftDetection} exhaustiveness via a `never` fallback switch.
 *
 * @task T9876
 */

import { describe, expect, it } from 'vitest';
import {
  CLEO_CONFIG_MANIFEST,
  CONFIG_MANIFEST_ENTRIES,
  type ConfigManifestEntry,
  type ConfigScope,
  configManifestEntrySchema,
  type DriftDetection,
  GLOBAL_CLEO_CONFIG_MANIFEST,
  PROJECT_CONTEXT_MANIFEST,
  PROJECT_INFO_MANIFEST,
} from '../manifest.js';

describe('ConfigManifest built-in entries', () => {
  const builtins: ReadonlyArray<readonly [string, ConfigManifestEntry]> = [
    ['PROJECT_INFO_MANIFEST', PROJECT_INFO_MANIFEST],
    ['PROJECT_CONTEXT_MANIFEST', PROJECT_CONTEXT_MANIFEST],
    ['CLEO_CONFIG_MANIFEST', CLEO_CONFIG_MANIFEST],
    ['GLOBAL_CLEO_CONFIG_MANIFEST', GLOBAL_CLEO_CONFIG_MANIFEST],
  ];

  for (const [name, entry] of builtins) {
    it(`${name} validates against configManifestEntrySchema`, () => {
      const parsed = configManifestEntrySchema.parse(entry);
      expect(parsed.id).toBe(entry.id);
      expect(parsed.scope).toBe(entry.scope);
      expect(parsed.path).toBe(entry.path);
      expect(parsed.mergePrecedence).toBe(entry.mergePrecedence);
      expect(parsed.driftDetection).toBe(entry.driftDetection);
    });
  }

  it('CONFIG_MANIFEST_ENTRIES contains all 4 built-in entries', () => {
    const ids = CONFIG_MANIFEST_ENTRIES.map((e) => e.id).sort();
    expect(ids).toEqual([
      'cleo-config-global',
      'cleo-config-project',
      'project-context',
      'project-info',
    ]);
  });

  it('CONFIG_MANIFEST_ENTRIES is frozen', () => {
    expect(Object.isFrozen(CONFIG_MANIFEST_ENTRIES)).toBe(true);
  });
});

describe('Merge-precedence invariant (project > global > defaults)', () => {
  it('project precedence > global precedence (higher wins)', () => {
    expect(CLEO_CONFIG_MANIFEST.mergePrecedence).toBeGreaterThan(
      GLOBAL_CLEO_CONFIG_MANIFEST.mergePrecedence,
    );
  });

  it('canonical precedence values: project=20, global=10, metadata=0', () => {
    expect(CLEO_CONFIG_MANIFEST.mergePrecedence).toBe(20);
    expect(GLOBAL_CLEO_CONFIG_MANIFEST.mergePrecedence).toBe(10);
    expect(PROJECT_INFO_MANIFEST.mergePrecedence).toBe(0);
    expect(PROJECT_CONTEXT_MANIFEST.mergePrecedence).toBe(0);
  });

  it('cascade-resolver sort order yields global then project (project wins)', () => {
    const cascadeEntries = CONFIG_MANIFEST_ENTRIES.filter(
      (e): e is ConfigManifestEntry & { scope: ConfigScope } =>
        e.scope === 'global' || e.scope === 'project',
    )
      .slice() // copy before sort — array is frozen
      .sort((a, b) => a.mergePrecedence - b.mergePrecedence);

    expect(cascadeEntries.map((e) => e.scope)).toEqual(['global', 'project']);
  });
});

describe('Metadata-scope isolation', () => {
  it('metadata entries are NOT in the cascade merge chain', () => {
    const cascadeScopes = CONFIG_MANIFEST_ENTRIES.filter((e) => e.scope !== 'metadata').map(
      (e) => e.scope,
    );
    expect(cascadeScopes).toEqual(expect.arrayContaining(['global', 'project']));
    expect(cascadeScopes).not.toContain('metadata');
  });

  it('all metadata entries have mergePrecedence 0 (separate channel)', () => {
    const metadataEntries = CONFIG_MANIFEST_ENTRIES.filter((e) => e.scope === 'metadata');
    expect(metadataEntries.length).toBeGreaterThan(0);
    for (const e of metadataEntries) {
      expect(e.mergePrecedence).toBe(0);
    }
  });
});

describe('DriftDetection exhaustiveness (type-level)', () => {
  it('switch over DriftDetection covers all variants with never fallback', () => {
    const describe_ = (d: DriftDetection): string => {
      switch (d) {
        case 'schema-validate':
          return 'schema-validate';
        case 'staleness-gate':
          return 'staleness-gate';
        case 'value-diff':
          return 'value-diff';
        case 'none':
          return 'none';
        default: {
          // If a new variant is added without updating this switch, TS will
          // refuse to assign it to `never` at compile time.
          const _exhaustive: never = d;
          return _exhaustive;
        }
      }
    };

    expect(describe_('schema-validate')).toBe('schema-validate');
    expect(describe_('staleness-gate')).toBe('staleness-gate');
    expect(describe_('value-diff')).toBe('value-diff');
    expect(describe_('none')).toBe('none');
  });
});

describe('configManifestEntrySchema rejects invalid input', () => {
  it('rejects empty id', () => {
    const result = configManifestEntrySchema.safeParse({
      id: '',
      scope: 'project',
      path: '.cleo/config.json',
      mergePrecedence: 20,
      driftDetection: 'schema-validate',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown scope', () => {
    const result = configManifestEntrySchema.safeParse({
      id: 'x',
      scope: 'workspace',
      path: '.cleo/x.json',
      mergePrecedence: 0,
      driftDetection: 'none',
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative mergePrecedence', () => {
    const result = configManifestEntrySchema.safeParse({
      id: 'x',
      scope: 'project',
      path: '.cleo/x.json',
      mergePrecedence: -1,
      driftDetection: 'none',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown driftDetection variant', () => {
    const result = configManifestEntrySchema.safeParse({
      id: 'x',
      scope: 'project',
      path: '.cleo/x.json',
      mergePrecedence: 0,
      driftDetection: 'sha-compare',
    });
    expect(result.success).toBe(false);
  });
});
