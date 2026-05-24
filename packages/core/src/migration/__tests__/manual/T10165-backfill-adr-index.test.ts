/**
 * T10165 — backfill of `.cleo/adrs/adr-index.jsonl` into the `attachments`
 * table provenance columns shipped by T10158.
 *
 * Verifies:
 *   1. `parseAdrIndexJsonl` skips header/comment + blank lines, surfaces
 *      malformed JSON as a warning rather than crashing, and accepts
 *      well-formed rows.
 *   2. `backfillAdrIndex` end-to-end on an isolated tempdir-backed `.cleo/`:
 *        a. inserts one `attachments` row per JSONL entry,
 *        b. populates lifecycle_status / summary / keywords / topics /
 *           related_tasks columns,
 *        c. wires supersedes / superseded_by FKs across two rows,
 *        d. is idempotent: a second run does not duplicate inserts and
 *           reports the rows as `unchanged`.
 *   3. The frozen JSONL header (`# DEPRECATED (T10165) …`) on the in-tree
 *      `.cleo/adrs/adr-index.jsonl` survives, and the file's data lines
 *      remain parseable by the same `parseAdrIndexJsonl` reader.
 *
 * @task T10165
 * @epic T10157 (C-DOCS-SSOT)
 * @saga T9855 (SG-TEMPLATE-CONFIG-SSOT)
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backfillAdrIndex, parseAdrIndexJsonl } from '../../manual/T10165-backfill-adr-index.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..', '..', '..', '..', '..');

let tempDir: string;

/**
 * Materialise a tempdir-backed project root containing one `.cleo/adrs/`
 * directory with the supplied ADR markdown bodies + the supplied JSONL
 * lines. Returns the absolute project root.
 */
function makeProject(jsonlLines: string[], files: Record<string, string>): string {
  const adrsDir = join(tempDir, '.cleo', 'adrs');
  mkdirSync(adrsDir, { recursive: true });
  writeFileSync(join(adrsDir, 'adr-index.jsonl'), `${jsonlLines.join('\n')}\n`, 'utf-8');
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(adrsDir, name), body, 'utf-8');
  }
  return tempDir;
}

describe('T10165 parseAdrIndexJsonl', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-t10165-parse-'));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns an empty array when the JSONL file is missing', () => {
    const warnings: string[] = [];
    const rows = parseAdrIndexJsonl(join(tempDir, 'nope.jsonl'), warnings);
    expect(rows).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('skips comment + blank lines without warnings', () => {
    const path = join(tempDir, 'idx.jsonl');
    writeFileSync(
      path,
      [
        '# header line one',
        '',
        '# header line two',
        '{"id":"ADR-001","file":".cleo/adrs/ADR-001-foo.md","title":"Foo"}',
        '',
      ].join('\n'),
      'utf-8',
    );
    const warnings: string[] = [];
    const rows = parseAdrIndexJsonl(path, warnings);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('ADR-001');
    expect(warnings).toEqual([]);
  });

  it('records a warning per malformed row without crashing', () => {
    const path = join(tempDir, 'bad.jsonl');
    writeFileSync(
      path,
      [
        '{not json}',
        '{"id":"ADR-002"}',
        '{"id":"ADR-003","file":".cleo/adrs/ADR-003-x.md","title":"OK"}',
      ].join('\n'),
      'utf-8',
    );
    const warnings: string[] = [];
    const rows = parseAdrIndexJsonl(path, warnings);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('ADR-003');
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toMatch(/malformed JSON/);
    expect(warnings[1]).toMatch(/missing id\/file/);
  });
});

describe('T10165 backfillAdrIndex end-to-end', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-t10165-backfill-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  });

  afterEach(async () => {
    const { closeDb } = await import('../../../store/sqlite.js');
    closeDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('inserts one attachments row per JSONL entry, populating provenance columns', async () => {
    const projectRoot = makeProject(
      [
        JSON.stringify({
          id: 'ADR-001',
          file: '.cleo/adrs/ADR-001-foo.md',
          title: 'ADR-001: Foo',
          status: 'accepted',
          summary: 'Foo bar baz.',
          keywords: ['foo', 'bar'],
          topics: ['admin'],
          relatedTasks: ['T10100', 'T10101'],
        }),
        JSON.stringify({
          id: 'ADR-002',
          file: '.cleo/adrs/ADR-002-bar.md',
          title: 'ADR-002: Bar',
          status: 'proposed',
          supersedes: 'ADR-001',
        }),
      ],
      {
        'ADR-001-foo.md': '# ADR-001\nBody bytes for foo.',
        'ADR-002-bar.md': '# ADR-002\nBody bytes for bar.',
      },
    );

    const result = await backfillAdrIndex(projectRoot, { dryRun: false });
    expect(result.inserted).toBe(2);
    expect(result.fileMissing).toBe(0);
    expect(result.unresolvedEdges).toBe(0);

    const { getDb } = await import('../../../store/sqlite.js');
    const { attachments } = await import('../../../store/schema/attachments.js');
    const { eq } = await import('drizzle-orm');

    const db = await getDb(projectRoot);
    const adr1 = await db.select().from(attachments).where(eq(attachments.slug, 'adr-001')).get();
    const adr2 = await db.select().from(attachments).where(eq(attachments.slug, 'adr-002')).get();

    expect(adr1).toBeDefined();
    expect(adr1?.type).toBe('adr');
    expect(adr1?.lifecycleStatus).toBe('accepted');
    expect(adr1?.summary).toBe('Foo bar baz.');
    expect(JSON.parse(adr1?.keywords ?? '[]')).toEqual(['foo', 'bar']);
    expect(JSON.parse(adr1?.topics ?? '[]')).toEqual(['admin']);
    expect(JSON.parse(adr1?.relatedTasks ?? '[]')).toEqual(['T10100', 'T10101']);

    expect(adr2).toBeDefined();
    expect(adr2?.type).toBe('adr');
    expect(adr2?.lifecycleStatus).toBe('proposed');
    expect(adr2?.supersedes).toBe(adr1?.id);
  });

  it('is idempotent — a second run reports rows as unchanged with zero inserts', async () => {
    const projectRoot = makeProject(
      [
        JSON.stringify({
          id: 'ADR-001',
          file: '.cleo/adrs/ADR-001-foo.md',
          title: 'ADR-001',
          status: 'accepted',
        }),
      ],
      { 'ADR-001-foo.md': 'first run' },
    );

    const first = await backfillAdrIndex(projectRoot, { dryRun: false });
    expect(first.inserted).toBe(1);
    expect(first.unchanged).toBe(0);

    const second = await backfillAdrIndex(projectRoot, { dryRun: false });
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.updated).toBe(0);
  });

  it('flags missing files as warnings without crashing', async () => {
    const projectRoot = makeProject(
      [
        JSON.stringify({
          id: 'ADR-099',
          file: '.cleo/adrs/ADR-099-missing.md',
          title: 'ADR-099',
          status: 'accepted',
        }),
      ],
      {},
    );

    const result = await backfillAdrIndex(projectRoot, { dryRun: false });
    expect(result.fileMissing).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.warnings.some((w) => w.includes('ADR-099'))).toBe(true);
  });

  it('reports unresolved supersedes edges without failing', async () => {
    const projectRoot = makeProject(
      [
        JSON.stringify({
          id: 'ADR-005',
          file: '.cleo/adrs/ADR-005-x.md',
          title: 'ADR-005',
          status: 'superseded',
          supersededBy: 'ADR-999',
        }),
      ],
      { 'ADR-005-x.md': 'content' },
    );

    const result = await backfillAdrIndex(projectRoot, { dryRun: false });
    expect(result.inserted).toBe(1);
    expect(result.unresolvedEdges).toBe(1);
    expect(result.warnings.some((w) => w.includes('ADR-999'))).toBe(true);
  });

  it('dry-run mode does not write any rows', async () => {
    const projectRoot = makeProject(
      [
        JSON.stringify({
          id: 'ADR-001',
          file: '.cleo/adrs/ADR-001-foo.md',
          title: 'ADR-001',
          status: 'accepted',
        }),
      ],
      { 'ADR-001-foo.md': 'dry-run content' },
    );

    const result = await backfillAdrIndex(projectRoot, { dryRun: true });
    expect(result.inserted).toBe(1);

    const { getDb } = await import('../../../store/sqlite.js');
    const { attachments } = await import('../../../store/schema/attachments.js');
    const db = await getDb(projectRoot);
    const rows = await db.select().from(attachments).all();
    expect(rows).toEqual([]);
  });
});

describe('T10165 in-tree adr-index.jsonl freeze invariants', () => {
  /**
   * The in-tree `.cleo/adrs/adr-index.jsonl` was rewritten by T10165 to:
   *   1. Lead with three `# DEPRECATED …` comment lines, and
   *   2. Preserve every legacy data row beneath them.
   *
   * This test pins both invariants so accidental deletion of the header or
   * silent corruption of a data row trips CI on the spot.
   */
  it('the live JSONL begins with a # DEPRECATED (T10165) header', () => {
    const path = join(REPO_ROOT, '.cleo', 'adrs', 'adr-index.jsonl');
    const raw = readFileSync(path, 'utf-8');
    const firstLine = raw.split('\n', 1)[0] ?? '';
    expect(firstLine).toMatch(/^# DEPRECATED \(T10165\)/);
  });

  it('every data line in the live JSONL parses back into a typed row', () => {
    const path = join(REPO_ROOT, '.cleo', 'adrs', 'adr-index.jsonl');
    const warnings: string[] = [];
    const rows = parseAdrIndexJsonl(path, warnings);
    // The migration preserved 73 historic rows — assert a non-empty lower
    // bound rather than an exact count so adding a new comment line does
    // not force a test update.
    expect(rows.length).toBeGreaterThan(50);
    // Every parsed row must carry a well-formed ADR id.
    for (const row of rows) {
      expect(row.id).toMatch(/^ADR-\d+/);
      expect(typeof row.file).toBe('string');
    }
    expect(warnings).toEqual([]);
  });
});
