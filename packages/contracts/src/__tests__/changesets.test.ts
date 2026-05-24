/**
 * Tests for CLEO changeset contracts and parser compatibility.
 *
 * @task T10480
 * @epic T9759
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChangesetEntrySchema } from '../changesets.js';

type ParseChangesetFile = (path: string) => unknown;

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cleo-changesets-contract-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeChangeset(filename: string, content: string): string {
  const path = join(tempDir, filename);
  writeFileSync(path, content, 'utf8');
  return path;
}

async function loadParseChangesetFile(): Promise<ParseChangesetFile> {
  const parserUrl = new URL('../../../core/src/changesets/parser.ts', import.meta.url).href;
  const parser = (await import(parserUrl)) as { parseChangesetFile: ParseChangesetFile };
  return parser.parseChangesetFile;
}

describe('ChangesetEntrySchema release-note metadata', () => {
  it('accepts legacy changesets without releaseNotes unchanged', () => {
    const legacy = {
      id: 'T10480',
      tasks: ['T10480'],
      kind: 'fix',
      summary: 'Legacy changesets still parse.',
    };

    const parsed = ChangesetEntrySchema.parse(legacy);

    expect(parsed).toEqual(legacy);
    expect(parsed.releaseNotes).toBeUndefined();
  });

  it('accepts deterministic zero-token release-note metadata', () => {
    const entry = ChangesetEntrySchema.parse({
      id: 't10480-release-notes',
      tasks: ['T10480', 'T9759'],
      kind: 'feat',
      summary: 'Add structured release-note metadata.',
      releaseNotes: {
        section: 'added',
        audience: ['operators', 'developers'],
        scope: 'package',
        targets: ['@cleocode/contracts', '@cleocode/core'],
        impact: 'Release tooling can render richer notes from author-provided facts.',
        migration: 'No migration required for legacy changesets.',
        operatorNotes: 'No LLM, API token, or network call is required.',
        includeInChangelog: true,
      },
    });

    expect(entry.releaseNotes).toEqual({
      section: 'added',
      audience: ['operators', 'developers'],
      scope: 'package',
      targets: ['@cleocode/contracts', '@cleocode/core'],
      impact: 'Release tooling can render richer notes from author-provided facts.',
      migration: 'No migration required for legacy changesets.',
      operatorNotes: 'No LLM, API token, or network call is required.',
      includeInChangelog: true,
    });
  });

  it('rejects malformed release-note metadata loudly', () => {
    const result = ChangesetEntrySchema.safeParse({
      id: 't10480-bad-release-notes',
      tasks: ['T10480'],
      kind: 'feat',
      summary: 'Bad metadata.',
      releaseNotes: {
        section: 'feature',
      },
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(['releaseNotes', 'section']);
  });
});

describe('parseChangesetFile release-note metadata compatibility', () => {
  it('parses legacy markdown changesets unchanged', async () => {
    const parseChangesetFile = await loadParseChangesetFile();
    const file = writeChangeset(
      'T10480.md',
      `---
id: T10480
tasks: [T10480]
kind: fix
summary: Legacy markdown changesets still parse unchanged.
---

Body notes survive.
`,
    );

    expect(parseChangesetFile(file)).toEqual({
      id: 'T10480',
      tasks: ['T10480'],
      kind: 'fix',
      summary: 'Legacy markdown changesets still parse unchanged.',
      notes: 'Body notes survive.',
    });
  });

  it('parses new release-note metadata from markdown frontmatter', async () => {
    const parseChangesetFile = await loadParseChangesetFile();
    const file = writeChangeset(
      't10480-new-metadata.md',
      `---
id: t10480-new-metadata
tasks: [T10480]
kind: feat
summary: Parse release-note metadata.
releaseNotes:
  section: changed
  audience: [operators]
  scope: package
  targets: ['@cleocode/core']
  impact: Deterministic release notes get structured context.
  includeInChangelog: true
---
`,
    );

    expect(parseChangesetFile(file)).toMatchObject({
      releaseNotes: {
        section: 'changed',
        audience: ['operators'],
        scope: 'package',
        targets: ['@cleocode/core'],
        impact: 'Deterministic release notes get structured context.',
        includeInChangelog: true,
      },
    });
  });

  it('fails malformed release-note metadata with file and line context', async () => {
    const parseChangesetFile = await loadParseChangesetFile();
    const file = writeChangeset(
      't10480-bad-metadata.md',
      `---
id: t10480-bad-metadata
tasks: [T10480]
kind: feat
summary: Bad release-note metadata.
releaseNotes:
  section: feature
---
`,
    );

    expect(() => parseChangesetFile(file)).toThrow(
      new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:7[\\s\\S]*releaseNotes\\.section`),
    );
  });
});
