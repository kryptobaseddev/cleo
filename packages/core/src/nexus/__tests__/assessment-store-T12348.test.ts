/**
 * T12348 — the assessment summary is stored apart from its reference list, and
 * `getIndexStats` answers from SQL aggregates.
 *
 * - A publication writes the summary (`referenceCount`) and the list together.
 * - `readKnowledgeIndexAssessment` returns the summary; the list is read only
 *   through `readKnowledgeIndexReferences`.
 * - Re-recording a summary keeps that generation's list.
 * - A historical value with inline `references` stays readable, unchanged.
 * - `getIndexStats` reports the same counts it did when it loaded every row,
 *   and `staleScan: false` skips the per-file re-hash.
 *
 * @task T12348
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { GraphIndexAssessment, GraphIndexReferenceReport } from '@cleocode/contracts';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assessmentSummary,
  decodeStoredReferences,
  encodeStoredReferences,
  parseStoredReferences,
  writeAssessment,
} from '../assessment-store.js';
import {
  readKnowledgeIndexAssessment,
  readKnowledgeIndexReferencePage,
  readKnowledgeIndexReferences,
} from '../knowledge.js';

vi.mock('../../store/nexus-sqlite.js', async () => ({
  getNexusDb: vi.fn(async () => drizzle({ client: native })),
  getNexusNativeDb: vi.fn(() => native),
  nexusSchema: await import('../../store/schema/cleo-project/nexus-graph.js'),
}));

let native: DatabaseSync;

beforeEach(() => {
  native = new DatabaseSync(':memory:');
  native.exec(`
    CREATE TABLE nexus_nodes (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL,
      name TEXT, file_path TEXT, start_line INTEGER, end_line INTEGER,
      language TEXT, is_exported INTEGER NOT NULL, parent_id TEXT,
      parameters_json TEXT, return_type TEXT, doc_summary TEXT,
      community_id TEXT, meta_json TEXT, is_external INTEGER DEFAULT 0,
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE nexus_relations (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
      type TEXT NOT NULL, confidence REAL NOT NULL, reason TEXT, step INTEGER,
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE _nexus_meta (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER DEFAULT 0
    );
  `);
});

afterEach(() => native.close());

const reference = (sourceId: string): GraphIndexReferenceReport => ({
  kind: 'external',
  filePath: 'a.ts',
  sourceId,
  targetName: 'resolve',
  relationship: 'calls',
  reason: 'Explicit import node:path has no resolved repository binding',
  candidateIds: [],
});

const fullAssessment = (): GraphIndexAssessment => ({
  sourceRoot: '/fixture',
  assessedRevision: 'rev',
  assessedAt: '2026-09-24',
  files: [{ path: 'a.ts', status: 'analyzed' }],
  references: [reference('a.ts::one'), reference('a.ts::two')],
});

const meta = (key: string): string | undefined =>
  (
    native.prepare('SELECT value FROM _nexus_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
  )?.value;

describe('assessment summary and reference list (T12348)', () => {
  it('stores the summary and the list separately and reads each on its own', async () => {
    const assessment = fullAssessment();
    writeAssessment(drizzle({ client: native }), assessment);

    expect(JSON.parse(meta('graph_assessment') ?? 'null')).toEqual({
      sourceRoot: '/fixture',
      assessedRevision: 'rev',
      assessedAt: '2026-09-24',
      files: [{ path: 'a.ts', status: 'analyzed' }],
      referenceCount: 2,
    });
    expect(await readKnowledgeIndexAssessment()).toEqual(assessmentSummary(assessment));
    expect(await readKnowledgeIndexReferences()).toEqual(assessment.references);
  });

  it('keeps the stored list when only the summary is re-recorded', async () => {
    const assessment = fullAssessment();
    const db = drizzle({ client: native });
    const summary = writeAssessment(db, assessment);
    writeAssessment(db, { ...summary, assessedRevision: 'rev-2' });

    expect((await readKnowledgeIndexAssessment())?.assessedRevision).toBe('rev-2');
    expect(await readKnowledgeIndexReferences()).toEqual(assessment.references);
  });

  it('removes a stale list when a generation has no references at all', async () => {
    const db = drizzle({ client: native });
    writeAssessment(db, fullAssessment());
    const { references: _references, ...withoutReferences } = fullAssessment();
    writeAssessment(db, withoutReferences);

    expect(meta('graph_assessment_references')).toBeUndefined();
    expect(await readKnowledgeIndexReferences()).toEqual([]);
  });

  it('reads a historical inline assessment as stored', async () => {
    const assessment = fullAssessment();
    native
      .prepare("INSERT INTO _nexus_meta (key, value) VALUES ('graph_assessment', ?)")
      .run(JSON.stringify(assessment));

    expect(await readKnowledgeIndexAssessment()).toEqual(assessment);
    expect(await readKnowledgeIndexReferences()).toEqual(assessment.references);
  });

  it('stores the list compressed and still reads a plain-text list', async () => {
    const assessment = fullAssessment();
    writeAssessment(drizzle({ client: native }), assessment);
    const stored = native
      .prepare("SELECT value FROM _nexus_meta WHERE key = 'graph_assessment_references'")
      .get()?.value;
    expect(stored).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(decodeStoredReferences(stored))).toEqual(assessment.references);

    // A list written before compression is read as stored.
    native
      .prepare("UPDATE _nexus_meta SET value = ? WHERE key = 'graph_assessment_references'")
      .run(JSON.stringify(assessment.references));
    expect(await readKnowledgeIndexReferences()).toEqual(assessment.references);
    expect(() => decodeStoredReferences(42)).toThrow('neither text nor a compressed list');
  });

  // T13326: 846 151 references from a 5 357-file repository exceed V8's
  // maximum string length as ONE JSON.stringify, so publication failed with
  // "Invalid string length". The encoder must stringify references one at a
  // time, and the reader must not rebuild the whole list as one string.
  it('encodes the list without stringifying it whole, and reads it back line by line', () => {
    const references = Array.from({ length: 10_000 }, (_, index) => reference(`a.ts::fn${index}`));
    const stringify = vi.spyOn(JSON, 'stringify');
    let encoded: Uint8Array;
    try {
      encoded = encodeStoredReferences(references);
      expect(stringify.mock.calls.some(([value]) => Array.isArray(value))).toBe(false);
    } finally {
      stringify.mockRestore();
    }
    const bufferToString = vi.spyOn(Buffer.prototype, 'toString');
    try {
      expect(parseStoredReferences(encoded)).toEqual(references);
      const longest = Math.max(
        ...bufferToString.mock.results.map((result) => String(result.value).length),
      );
      expect(longest).toBeLessThan(1_000);
    } finally {
      bufferToString.mockRestore();
    }
    // Still one JSON array, so a whole-text reader of a list that fits agrees.
    expect(JSON.parse(gunzipSync(encoded).toString('utf8'))).toEqual(references);
    expect(parseStoredReferences(encodeStoredReferences([]))).toEqual([]);
  });

  it('reads lists written before the line-per-reference form', () => {
    const references = fullAssessment().references ?? [];
    const compact = JSON.stringify(references);
    expect(parseStoredReferences(gzipSync(compact))).toEqual(references);
    expect(parseStoredReferences(compact)).toEqual(references);
    expect(() => parseStoredReferences(42)).toThrow('neither text nor a compressed list');
    expect(() => parseStoredReferences('{"not":"a list"}')).toThrow('not a list');
  });

  // T13330: status pages the list; the whole list is never held at once.
  describe('readKnowledgeIndexReferencePage', () => {
    const kinds = ['external', 'unresolved', 'dynamic'] as const;
    const many = (): GraphIndexReferenceReport[] =>
      Array.from({ length: 10_000 }, (_, index) => ({
        ...reference(`a.ts::fn${index}`),
        kind: kinds[index % kinds.length] ?? 'external',
      }));

    it('streams the stored list into one page plus whole-list totals', async () => {
      const references = many();
      writeAssessment(drizzle({ client: native }), { ...fullAssessment(), references });
      const parse = vi.spyOn(JSON, 'parse');
      const bufferToString = vi.spyOn(Buffer.prototype, 'toString');
      let result: Awaited<ReturnType<typeof readKnowledgeIndexReferencePage>>;
      try {
        result = await readKnowledgeIndexReferencePage(undefined, { limit: 20, offset: 0 });
        const longestParsed = Math.max(
          0,
          ...parse.mock.calls
            .map(([text]) => text)
            .filter((text) => text.includes('a.ts::fn'))
            .map((text) => text.length),
        );
        expect(longestParsed).toBeLessThan(1_000);
        const longestDecoded = Math.max(
          ...bufferToString.mock.results.map((entry) => String(entry.value).length),
        );
        expect(longestDecoded).toBeLessThan(1_000);
      } finally {
        parse.mockRestore();
        bufferToString.mockRestore();
      }
      expect(result?.page).toMatchObject({ offset: 0, limit: 20, total: 10_000, returned: 20 });
      expect(result?.page.nextOffset).toBe(20);
      expect(result?.page.rows).toEqual(references.slice(0, 20));
      expect(result?.byKind).toEqual({
        'unmodeled-source': 0,
        ambiguous: 0,
        external: 3_334,
        dynamic: 3_333,
        shadowed: 0,
        unresolved: 3_333,
      });
      expect(result?.bytes).toBe(Buffer.byteLength(JSON.stringify(references), 'utf8'));
    });

    it('filters by kind, offsets into the filter, and ends with a null nextOffset', async () => {
      const references = many();
      writeAssessment(drizzle({ client: native }), { ...fullAssessment(), references });
      const dynamic = references.filter((entry) => entry.kind === 'dynamic');
      const result = await readKnowledgeIndexReferencePage(undefined, {
        limit: 5_000,
        offset: 3_000,
        kind: 'dynamic',
      });
      expect(result?.page).toMatchObject({ kind: 'dynamic', total: 3_333, returned: 333 });
      expect(result?.page.nextOffset).toBeNull();
      expect(result?.page.rows).toEqual(dynamic.slice(3_000));
    });

    it('pages lists written before the line-per-reference form', async () => {
      const assessment = fullAssessment();
      writeAssessment(drizzle({ client: native }), assessment);
      const compact = JSON.stringify(assessment.references);
      for (const stored of [gzipSync(compact), compact]) {
        native
          .prepare("UPDATE _nexus_meta SET value = ? WHERE key = 'graph_assessment_references'")
          .run(stored);
        const result = await readKnowledgeIndexReferencePage(undefined, { limit: 1, offset: 1 });
        expect(result?.page.rows).toEqual(assessment.references?.slice(1));
        expect(result?.page.nextOffset).toBeNull();
      }
    });

    it('pages a list far larger than the reader heap, keeping only the page', () => {
      // 300 000 references (~75 MB of JSON) paged by a process capped at 32 MiB,
      // through the same stream and fold the status reader uses: only a reader
      // that drops each reference after counting it survives.
      const directory = mkdtempSync(join(tmpdir(), 'nexus-references-stream-'));
      try {
        writeFileSync(
          join(directory, 'entry.ts'),
          `export { streamStoredReferences } from ${JSON.stringify(fileURLToPath(new URL('../assessment-store.ts', import.meta.url)))};
          export { pageReferences } from ${JSON.stringify(fileURLToPath(new URL('../assessment-projection.ts', import.meta.url)))};`,
        );
        buildSync({
          entryPoints: [join(directory, 'entry.ts')],
          outfile: join(directory, 'store.mjs'),
          bundle: true,
          platform: 'node',
          format: 'esm',
        });
        writeFileSync(
          join(directory, 'probe.mjs'),
          `
          import assert from 'node:assert/strict';
          import { gzipSync } from 'node:zlib';
          import { pageReferences, streamStoredReferences } from './store.mjs';
          // Built member by member, in the stored format, so the writer holds no list either.
          const members = [];
          let text = '[';
          for (let index = 0; index < 300000; index++) {
            text += (index === 0 ? '\\n' : ',\\n') + JSON.stringify({ kind: index % 2 ? 'external' : 'unresolved', filePath: 'a.ts', sourceId: 'a.ts::fn' + index, targetName: 'target' + index, relationship: 'calls', reason: 'x'.repeat(120), candidateIds: [] });
            if ((index + 1) % 4096 === 0) { members.push(gzipSync(text)); text = ''; }
          }
          members.push(gzipSync(text + '\\n]'));
          const blob = Buffer.concat(members);
          const result = await pageReferences(streamStoredReferences(blob), { limit: 20, offset: 299970 }, {
            kind: (item) => item.kind,
            row: (item) => item,
          });
          assert.equal(result.count, 300000);
          assert.equal(result.byKind.external + result.byKind.unresolved, 300000);
          assert.equal(result.page.returned, 20);
          assert.equal(result.page.rows[19].sourceId, 'a.ts::fn299989');
          assert.equal(result.page.nextOffset, 299990);
          `,
        );
        execFileSync(process.execPath, ['--max-old-space-size=32', join(directory, 'probe.mjs')], {
          timeout: 60_000,
          env: { PATH: process.env['PATH'], HOME: directory, TMPDIR: directory },
          stdio: 'pipe',
        });
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    it('refuses a stored list that disagrees with the recorded count', async () => {
      writeAssessment(drizzle({ client: native }), fullAssessment());
      native
        .prepare("UPDATE _nexus_meta SET value = ? WHERE key = 'graph_assessment_references'")
        .run(encodeStoredReferences([reference('a.ts::one')]));
      await expect(
        readKnowledgeIndexReferencePage(undefined, { limit: 20, offset: 0 }),
      ).rejects.toThrow('disagree with the assessment reference count');
    });
  });

  it('refuses a list that disagrees with the recorded count', async () => {
    writeAssessment(drizzle({ client: native }), fullAssessment());
    native
      .prepare("UPDATE _nexus_meta SET value = ? WHERE key = 'graph_assessment_references'")
      .run(JSON.stringify([reference('a.ts::one')]));

    await expect(readKnowledgeIndexReferences()).rejects.toThrow('disagree');
  });
});

describe('getIndexStats from SQL aggregates (T12348)', () => {
  it('reports the counts the row-loading version reported', async () => {
    native.exec(`
      INSERT INTO nexus_nodes (id, kind, label, file_path, is_exported, meta_json, indexed_at) VALUES
        ('f1', 'file', 'a.ts', 'a.ts', 0, '{"contentHash":"h1"}', '2026-09-01'),
        ('f1b', 'file', 'a.ts', 'a.ts', 0, '{"contentHash":"h1"}', '2026-09-02'),
        ('f2', 'file', 'b.ts', 'b.ts', 0, NULL, '2026-09-03'),
        ('s1', 'function', 'one', 'a.ts', 1, NULL, '2026-09-05'),
        ('x1', 'file', 'nowhere', NULL, 0, NULL, '');
      INSERT INTO nexus_relations (id, source_id, target_id, type, confidence, indexed_at) VALUES
        ('r1', 's1', 'f1', 'calls', 1, '2026-09-05'),
        ('r2', 's1', 'f2', 'calls', 1, '2026-09-05');
    `);
    const { getIndexStats } = await import('@cleocode/nexus/pipeline');
    const { nexusSchema } = await import('../../store/nexus-sqlite.js');
    const tables = {
      nexusNodes: nexusSchema.nexusNodes,
      nexusRelations: nexusSchema.nexusRelations,
    };
    const db = drizzle({ client: native });

    const skipped = await getIndexStats('p', '/nonexistent-T12348', db, tables, {
      staleScan: false,
    });
    expect(skipped).toEqual({
      indexed: true,
      nodeCount: 5,
      relationCount: 2,
      fileCount: 2,
      lastIndexedAt: '2026-09-05',
      staleFileCount: -1,
    });
    // Default still re-hashes every indexed file: both are missing here.
    const scanned = await getIndexStats('p', '/nonexistent-T12348', db, tables);
    expect(scanned.staleFileCount).toBe(2);
  });
});
