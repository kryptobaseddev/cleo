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

import { DatabaseSync } from 'node:sqlite';
import type { GraphIndexAssessment, GraphIndexReferenceReport } from '@cleocode/contracts';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assessmentSummary, writeAssessment } from '../assessment-store.js';
import { readKnowledgeIndexAssessment, readKnowledgeIndexReferences } from '../knowledge.js';

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
