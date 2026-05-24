/**
 * Contract tests for the TemplateManifest schema.
 *
 * Asserts:
 *
 * 1. A valid entry for every {@link TemplateKind} parses successfully.
 * 2. An entry with an unknown `kind` is rejected.
 * 3. An entry missing `installPath` is rejected.
 * 4. The {@link PlaceholderSpec} `source` field is exhaustively typed —
 *    every member of {@link PLACEHOLDER_SOURCES} parses, and a bogus
 *    source value is rejected.
 *
 * @task T9875
 * @epic T9874
 * @saga T9855
 */

import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_SOURCES,
  PlaceholderSpecSchema,
  TEMPLATE_KINDS,
  type TemplateKind,
  type TemplateManifestEntry,
  TemplateManifestEntrySchema,
} from '../manifest.js';

/**
 * Build a valid baseline entry parameterized by `kind` so each
 * assertion below stays minimal.
 */
function baseEntry(kind: TemplateKind): TemplateManifestEntry {
  return {
    id: `sample-${kind}`,
    kind,
    sourcePath: `packages/core/templates/${kind}s/sample.tmpl`,
    installPath: `.cleo/${kind}s/sample`,
    substitution: 'regex-tmpl',
    placeholders: [
      {
        name: 'NODE_VERSION',
        source: 'project-context',
        sourcePath: 'engines.node',
        defaultValue: 24,
      },
    ],
    updateStrategy: 'overwrite-on-bump',
  };
}

describe('TemplateManifestEntrySchema (T9875)', () => {
  it('accepts a valid entry for every TemplateKind', () => {
    for (const kind of TEMPLATE_KINDS) {
      const entry = baseEntry(kind);
      const parsed = TemplateManifestEntrySchema.parse(entry);
      expect(parsed.kind, `kind '${kind}' must round-trip`).toBe(kind);
      expect(parsed.installPath).toBe(entry.installPath);
    }
  });

  it('rejects an entry with an unknown kind', () => {
    const bogus = {
      ...baseEntry('workflow'),
      kind: 'not-a-real-kind',
    };
    const result = TemplateManifestEntrySchema.safeParse(bogus);
    expect(result.success).toBe(false);
  });

  it('rejects an entry missing installPath', () => {
    const { installPath: _drop, ...rest } = baseEntry('config');
    const result = TemplateManifestEntrySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('accepts an entry whose placeholders array is empty', () => {
    const entry = { ...baseEntry('doc'), placeholders: [] };
    const result = TemplateManifestEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('accepts a defaultValue of every supported literal type and null', () => {
    const types = [
      { defaultValue: 'string-default' },
      { defaultValue: 42 },
      { defaultValue: true },
      { defaultValue: null },
      {},
    ] as const;
    for (const extra of types) {
      const result = PlaceholderSpecSchema.safeParse({
        name: 'X',
        source: 'literal',
        sourcePath: 'X',
        ...extra,
      });
      expect(result.success, `defaultValue case ${JSON.stringify(extra)} must parse`).toBe(true);
    }
  });
});

describe('PlaceholderSpecSchema source enum (T9875)', () => {
  it('exhaustively accepts every member of PLACEHOLDER_SOURCES', () => {
    for (const source of PLACEHOLDER_SOURCES) {
      const result = PlaceholderSpecSchema.safeParse({
        name: 'PLACEHOLDER',
        source,
        sourcePath: 'some.path',
      });
      expect(result.success, `source '${source}' must parse`).toBe(true);
    }
  });

  it('rejects an unknown source value', () => {
    const result = PlaceholderSpecSchema.safeParse({
      name: 'PLACEHOLDER',
      source: 'not-a-source',
      sourcePath: 'some.path',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty name', () => {
    const result = PlaceholderSpecSchema.safeParse({
      name: '',
      source: 'project-context',
      sourcePath: 'some.path',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty sourcePath', () => {
    const result = PlaceholderSpecSchema.safeParse({
      name: 'X',
      source: 'project-context',
      sourcePath: '',
    });
    expect(result.success).toBe(false);
  });
});
