/** Regression coverage for staged Nexus graph replacement and recovery. */
import { DatabaseSync } from 'node:sqlite';
import type { GraphPublicationRows } from '@cleocode/contracts';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { publishNexusGraph } from '../analyze-orchestrator.js';

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
    CREATE VIRTUAL TABLE nexus_symbols_fts USING fts5(name);
    INSERT INTO nexus_nodes (id, kind, label, is_exported, indexed_at)
      VALUES ('old', 'function', 'old', 1, '2026-01-01');
    INSERT INTO nexus_relations (id, source_id, target_id, type, confidence, indexed_at)
      VALUES ('old-edge', 'old', 'old', 'calls', 1, '2026-01-01');
    INSERT INTO nexus_symbols_fts (name) VALUES ('old');
  `);
});

afterEach(() => native.close());

/** A complete replacement generation using the shared publication contract. */
function replacement(): GraphPublicationRows {
  return {
    nodes: [
      {
        id: 'new',
        kind: 'function',
        label: 'new',
        name: 'new',
        filePath: 'new.ts',
        startLine: 1,
        endLine: 2,
        language: 'typescript',
        isExported: true,
        parentId: null,
        parametersJson: null,
        returnType: null,
        docSummary: null,
        communityId: null,
        metaJson: null,
        indexedAt: '2026-09-18',
      },
    ],
    relations: [
      {
        id: 'new-edge',
        sourceId: 'new',
        targetId: 'new',
        type: 'calls',
        confidence: 1,
        reason: null,
        step: null,
        indexedAt: '2026-09-18',
      },
    ],
  };
}

describe('publishNexusGraph', () => {
  it('replaces a complete generation and removes orphaned FTS rows', () => {
    publishNexusGraph(drizzle({ client: native }), replacement(), null);
    expect(native.prepare('SELECT id FROM nexus_nodes').all()).toEqual([{ id: 'new' }]);
    expect(native.prepare('SELECT id FROM nexus_relations').all()).toEqual([{ id: 'new-edge' }]);
    expect(native.prepare('SELECT name FROM nexus_symbols_fts').all()).toEqual([]);
    expect(
      native.prepare("SELECT value FROM _nexus_meta WHERE key = 'graph_generation'").get(),
    ).toBeDefined();
  });

  it('stores source scope and freshness with the same committed generation', () => {
    const rows = replacement();
    rows.assessment = {
      sourceRoot: '/project',
      assessedRevision: 'revision',
      assessedAt: '2026-09-18',
      includedRepositories: ['app'],
      files: [{ path: 'app/main.ts', status: 'analyzed', mtimeMs: 123, size: 42 }],
    };
    publishNexusGraph(drizzle({ client: native }), rows, null);
    expect(
      native.prepare("SELECT value FROM _nexus_meta WHERE key = 'graph_assessment'").get(),
    ).toEqual({ value: JSON.stringify(rows.assessment) });
  });

  it('restores nodes, edges, and FTS when publication fails after node insertion', () => {
    native.exec(`CREATE TRIGGER fail_relation BEFORE INSERT ON nexus_relations
      BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END;`);
    expect(() => publishNexusGraph(drizzle({ client: native }), replacement(), null)).toThrow();
    expect(native.prepare('SELECT id FROM nexus_nodes').all()).toEqual([{ id: 'old' }]);
    expect(native.prepare('SELECT id FROM nexus_relations').all()).toEqual([{ id: 'old-edge' }]);
    expect(native.prepare('SELECT name FROM nexus_symbols_fts').all()).toEqual([{ name: 'old' }]);
    expect(native.prepare('SELECT * FROM _nexus_meta').all()).toEqual([]);
  });

  it('rejects a stale concurrent publication without replacing the winning graph', () => {
    const db = drizzle({ client: native });
    publishNexusGraph(db, replacement(), null);
    const stale = replacement();
    stale.nodes[0]!.id = 'stale';
    expect(() => publishNexusGraph(db, stale, null)).toThrow('changed during indexing');
    expect(native.prepare('SELECT id FROM nexus_nodes').all()).toEqual([{ id: 'new' }]);
  });
});
