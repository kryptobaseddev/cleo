/**
 * Tests for {@link readChangesetsSsotFirst} — SSoT-first changeset reader
 * with `.changeset/*.md` fallback for un-mirrored slugs.
 *
 * Covers:
 *  - SSoT-only: only blob exists → `meta.source === 'ssot'`.
 *  - File-only: only `.changeset/*.md` exists → `meta.source === 'file'`.
 *  - Both surfaces: SSoT wins (sha-dedup) → `meta.source === 'ssot'`.
 *  - Mixed inventory: returns BOTH file-fallback AND SSoT entries.
 *  - Deterministic order: results sorted by slug for diff-friendliness.
 *  - Malformed file in directory does not block SSoT-only reads.
 *
 * @epic T9793 (E-DOCS-CHANGESET-INTEGRATION)
 * @task T9793
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangesetEntry } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeChangesetEntry } from '../../changesets/writer.js';
import {
  changesetFileExists,
  readChangesetEntriesFileOnly,
  readChangesetEntriesSsotFirst,
  readChangesetsSsotFirst,
} from '../changesets-aggregator.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'cleo-ssot-first-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

/** Write a raw `.changeset/<slug>.md` directly without touching the SSoT. */
function writeFileOnly(slug: string, body: string): void {
  const dir = join(projectRoot, '.changeset');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${slug}.md`), body, 'utf-8');
}

/**
 * Render minimal frontmatter for a slug — mirrors the writer's output shape
 * so the parser accepts it.
 */
function renderMinimal(slug: string, tasks: string[], summary: string): string {
  return [
    '---',
    `id: ${slug}`,
    `tasks: [${tasks.join(', ')}]`,
    'kind: feat',
    `summary: ${summary}`,
    '---',
    '',
  ].join('\n');
}

describe('readChangesetsSsotFirst', () => {
  it('returns SSoT entry with meta.source === "ssot" when only SSoT has the slug', async () => {
    const entry: ChangesetEntry = {
      id: 't9793-ssot-only',
      tasks: ['T9793'],
      kind: 'feat',
      summary: 'Only in SSoT.',
    };
    const dual = await writeChangesetEntry(entry, { projectRoot });
    expect(dual.ok).toBe(true);
    // Simulate a SSoT-only world by deleting the file the dual-write produced.
    if (dual.ok) {
      rmSync(dual.result.filePath, { force: true });
    }
    // File MUST be gone now.
    expect(changesetFileExists(projectRoot, 't9793-ssot-only')).toBe(false);

    const aggregated = await readChangesetsSsotFirst(projectRoot);

    expect(aggregated.length).toBe(1);
    expect(aggregated[0]?.entry.id).toBe('t9793-ssot-only');
    expect(aggregated[0]?.meta.source).toBe('ssot');
  });

  it('returns file entry with meta.source === "file" when only the file exists', async () => {
    // No SSoT write here — only a raw file on disk.
    writeFileOnly('t9793-file-only', renderMinimal('t9793-file-only', ['T9793'], 'Only on disk.'));

    const aggregated = await readChangesetsSsotFirst(projectRoot);
    expect(aggregated.length).toBe(1);
    expect(aggregated[0]?.entry.id).toBe('t9793-file-only');
    expect(aggregated[0]?.meta.source).toBe('file');
  });

  it('prefers SSoT when both surfaces have the same slug', async () => {
    // Step 1 — dual write so BOTH surfaces have the slug with matching bytes.
    const entry: ChangesetEntry = {
      id: 't9793-both-surfaces',
      tasks: ['T9793'],
      kind: 'feat',
      summary: 'Lives in both surfaces.',
    };
    const dual = await writeChangesetEntry(entry, { projectRoot });
    expect(dual.ok).toBe(true);

    const aggregated = await readChangesetsSsotFirst(projectRoot);
    expect(aggregated.length).toBe(1);
    expect(aggregated[0]?.entry.id).toBe('t9793-both-surfaces');
    // The SSoT MUST win even when both surfaces are present.
    expect(aggregated[0]?.meta.source).toBe('ssot');
  });

  it('returns a mixed inventory: SSoT for mirrored slugs + file-fallback for the rest', async () => {
    // Slug A — both surfaces (dual write).
    const a: ChangesetEntry = {
      id: 't9793-a-mirrored',
      tasks: ['T9793'],
      kind: 'feat',
      summary: 'Mirrored to SSoT.',
    };
    const aOutcome = await writeChangesetEntry(a, { projectRoot });
    expect(aOutcome.ok).toBe(true);

    // Slug B — file only, never written to SSoT.
    writeFileOnly(
      't9793-b-file-only',
      renderMinimal('t9793-b-file-only', ['T9793'], 'Legacy file-only entry.'),
    );

    const aggregated = await readChangesetsSsotFirst(projectRoot);
    expect(aggregated.length).toBe(2);
    const bySlug = new Map(aggregated.map((a) => [a.entry.id, a.meta.source]));
    expect(bySlug.get('t9793-a-mirrored')).toBe('ssot');
    expect(bySlug.get('t9793-b-file-only')).toBe('file');
  });

  it('returns entries sorted by id for deterministic downstream rendering', async () => {
    writeFileOnly('t9793-z-late', renderMinimal('t9793-z-late', ['T9793'], 'Z.'));
    writeFileOnly('t9793-a-early', renderMinimal('t9793-a-early', ['T9793'], 'A.'));
    writeFileOnly('t9793-m-middle', renderMinimal('t9793-m-middle', ['T9793'], 'M.'));

    const aggregated = await readChangesetsSsotFirst(projectRoot);
    const ids = aggregated.map((a) => a.entry.id);
    expect(ids).toEqual(['t9793-a-early', 't9793-m-middle', 't9793-z-late']);
  });

  it('returns empty array when no .changeset directory and no SSoT entries', async () => {
    const aggregated = await readChangesetsSsotFirst(projectRoot);
    expect(aggregated).toEqual([]);
  });

  it('propagates parser failures (T10105 fail-loud)', async () => {
    // Write one valid file alongside one structurally-broken file. Per
    // T10105 (Saga T10099) the aggregator NO LONGER silently swallows
    // parse errors — they propagate so `cleo release plan` can abort
    // with `E_CHANGESET_YAML_INVALID` instead of dropping CHANGELOG
    // entries the way the v2026.5.100 ship did.
    writeFileOnly('t9793-valid', renderMinimal('t9793-valid', ['T9793'], 'Survives.'));
    writeFileOnly('t9793-broken', '--- this is not a valid YAML frontmatter document at all');

    await expect(readChangesetsSsotFirst(projectRoot)).rejects.toThrow();
  });
});

describe('readChangesetEntriesSsotFirst', () => {
  it('strips meta.source and returns only the entries array', async () => {
    const entry: ChangesetEntry = {
      id: 't9793-entries-only',
      tasks: ['T9793'],
      kind: 'feat',
      summary: 'Strip provenance.',
    };
    const dual = await writeChangesetEntry(entry, { projectRoot });
    expect(dual.ok).toBe(true);

    const plain = await readChangesetEntriesSsotFirst(projectRoot);
    expect(plain.length).toBe(1);
    expect(plain[0]?.id).toBe('t9793-entries-only');
    // The plain entry shape MUST NOT carry a `meta` field (it's a
    // ChangesetEntry, not an AggregatedChangesetEntry).
    expect('meta' in (plain[0] ?? {})).toBe(false);
  });
});

describe('readChangesetEntriesFileOnly (back-compat shim)', () => {
  it('matches the legacy parseChangesetDir behaviour when only files exist', () => {
    writeFileOnly(
      't9793-legacy',
      renderMinimal('t9793-legacy', ['T9793'], 'Legacy file-only path.'),
    );
    const entries = readChangesetEntriesFileOnly(projectRoot);
    expect(entries.length).toBe(1);
    expect(entries[0]?.id).toBe('t9793-legacy');
  });

  it('returns empty array when .changeset directory does not exist', () => {
    const entries = readChangesetEntriesFileOnly(projectRoot);
    expect(entries).toEqual([]);
  });
});
