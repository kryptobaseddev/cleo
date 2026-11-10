/**
 * Tests for the bounded SQL extractor (T14383): schema objects, triggers,
 * constraints, migration statements and cross-file table references.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GraphIndexFileReport } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { extractSql, linkSqlReferences } from '../pipeline/extractors/sql-extractor.js';
import { walkRepositoryPaths } from '../pipeline/filesystem-walker.js';
import { buildImportResolutionContext } from '../pipeline/import-processor.js';
import { createKnowledgeGraph } from '../pipeline/knowledge-graph.js';
import { runParseLoop } from '../pipeline/parse-loop.js';
import { createSymbolTable } from '../pipeline/symbol-table.js';

const SCHEMA = `-- schema fixture; a ; in a comment never splits
CREATE TABLE IF NOT EXISTS "users" (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  note TEXT DEFAULT 'a;b',
  age INTEGER CHECK (age >= 0)
);
/* block comment;
   spanning lines */
CREATE TABLE posts (
  id INTEGER NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT,
  CONSTRAINT posts_pk PRIMARY KEY (id),
  CONSTRAINT posts_title UNIQUE (author_id, title),
  CHECK (length(title) > 0)
);
CREATE UNIQUE INDEX idx_posts_author ON posts (author_id DESC, title);
CREATE VIEW recent_posts AS SELECT p.id, u.email FROM posts p JOIN users u ON u.id = p.author_id;
CREATE TRIGGER posts_audit AFTER UPDATE OF title ON posts
BEGIN
  INSERT INTO audit_log(post_id, state) VALUES (new.id, CASE WHEN new.title IS NULL THEN 'x' ELSE 'y' END);
  UPDATE users SET age = age WHERE id = new.author_id;
END;
CREATE TABLE audit_log (
  post_id INTEGER,
  state TEXT,
  FOREIGN KEY (post_id) REFERENCES posts (id)
);
INSERT INTO users(id, email) VALUES (1, 'a@b');
CREATE VIRTUAL TABLE posts_fts USING fts5(title, body, content='posts', tokenize='porter');
CREATE TRIGGER posts_fts_ai AFTER INSERT ON posts BEGIN INSERT INTO posts_fts(rowid, title) VALUES (new.rowid, new.title); END;
-- A trigger may share a table's name; the SQL kind keeps both nodes.
CREATE TRIGGER users AFTER DELETE ON users BEGIN DELETE FROM posts WHERE author_id = old.id; END;
`;

const MIGRATION = `ALTER TABLE users ADD COLUMN name TEXT;
ALTER TABLE posts ADD CONSTRAINT fk_editor FOREIGN KEY (editor_id) REFERENCES users(id);
ALTER TABLE audit_log RENAME TO audit_events;
CREATE INDEX idx_events_post ON audit_events(post_id);
DROP VIEW IF EXISTS recent_posts;
DROP TRIGGER IF EXISTS posts_audit;
DROP TABLE IF EXISTS legacy_table;
`;

describe('extractSql (T14383)', () => {
  const schema = extractSql('db/schema.sql', SCHEMA);
  // First node per name: the table `users`, not the trigger of the same name.
  const byName = new Map([...schema.nodes].reverse().map((node) => [node.name, node]));

  it('extracts tables, views, indexes and triggers as nodes with their SQL kind', () => {
    expect(schema.nodes.map((node) => [node.name, node.meta?.['sqlKind'], node.kind])).toEqual([
      ['users', 'table', 'record'],
      ['posts', 'table', 'record'],
      ['idx_posts_author', 'index', 'property'],
      ['recent_posts', 'view', 'record'],
      ['posts_audit', 'trigger', 'function'],
      ['audit_log', 'table', 'record'],
      ['posts_fts', 'table', 'record'],
      ['posts_fts_ai', 'trigger', 'function'],
      ['users', 'trigger', 'function'],
    ]);
    for (const node of schema.nodes) {
      expect(node.id).toBe(`db/schema.sql::${node.meta?.['sqlKind']}:${node.name}`);
      expect(node.language).toBe('sql');
      expect(node.exported).toBe(false);
    }
    expect(byName.get('users')).toMatchObject({ startLine: 2, endLine: 7 });
    expect(byName.get('posts_audit')).toMatchObject({ startLine: 20, endLine: 24 });
    expect(byName.get('users')?.meta?.['columns']).toEqual(['id', 'email', 'note', 'age']);
    expect(byName.get('idx_posts_author')?.meta).toMatchObject({
      table: 'posts',
      columns: ['author_id', 'title'],
      unique: true,
    });
    expect(byName.get('posts_audit')?.meta).toMatchObject({
      table: 'posts',
      event: 'AFTER UPDATE OF title',
    });
  });

  it('records inline and table-level constraints on the table node', () => {
    expect(byName.get('users')?.meta?.['constraints']).toEqual([
      { type: 'primary-key', columns: ['id'] },
      { type: 'unique', columns: ['email'] },
      { type: 'check', columns: ['age'] },
    ]);
    expect(byName.get('posts')?.meta?.['constraints']).toEqual([
      {
        type: 'foreign-key',
        columns: ['author_id'],
        references: { table: 'users', columns: ['id'] },
      },
      { type: 'primary-key', name: 'posts_pk', columns: ['id'] },
      { type: 'unique', name: 'posts_title', columns: ['author_id', 'title'] },
      { type: 'check', columns: [] },
    ]);
  });

  it('collects foreign key, index, view and trigger references; DML and routines are not schema', () => {
    expect(schema.references).toEqual(
      expect.arrayContaining([
        {
          source: 'db/schema.sql::table:posts',
          target: 'users',
          type: 'accesses',
          reason: 'foreign key references',
        },
        {
          source: 'db/schema.sql::table:audit_log',
          target: 'posts',
          type: 'accesses',
          reason: 'foreign key references',
        },
        {
          source: 'db/schema.sql::index:idx_posts_author',
          target: 'posts',
          type: 'accesses',
          reason: 'index on table',
        },
        {
          source: 'db/schema.sql::view:recent_posts',
          target: 'posts',
          type: 'queries',
          reason: 'view selects from',
        },
        {
          source: 'db/schema.sql::view:recent_posts',
          target: 'users',
          type: 'queries',
          reason: 'view selects from',
        },
        {
          source: 'db/schema.sql::trigger:posts_audit',
          target: 'posts',
          type: 'accesses',
          reason: 'trigger fires on table',
        },
        {
          source: 'db/schema.sql::trigger:posts_audit',
          target: 'audit_log',
          type: 'queries',
          reason: 'trigger body reads or writes',
        },
        {
          source: 'db/schema.sql::trigger:posts_audit',
          target: 'users',
          type: 'queries',
          reason: 'trigger body reads or writes',
        },
      ]),
    );
    // The INSERT is DML, not an unrecognized statement.
    expect(schema.unrecognizedStatements).toBe(0);
    expect(schema.problems).toEqual([]);
  });

  it('extracts a CREATE VIRTUAL TABLE as a table so its triggers link to it', () => {
    expect(byName.get('posts_fts')?.meta).toEqual({
      sqlKind: 'table',
      virtual: true,
      module: 'fts5',
      columns: ['title', 'body'],
    });
    const graph = createKnowledgeGraph();
    for (const node of schema.nodes) graph.addNode(node);
    linkSqlReferences([schema], graph);
    const edges = graph.relations.map((rel) => `${rel.source} -${rel.type}-> ${rel.target}`);
    expect(edges).toContain(
      'db/schema.sql::trigger:posts_fts_ai -queries-> db/schema.sql::table:posts_fts',
    );
  });

  it('keeps a trigger and a table of the same name as two nodes', () => {
    const users = schema.nodes.filter((node) => node.name === 'users');
    expect(users.map((node) => node.id)).toEqual([
      'db/schema.sql::table:users',
      'db/schema.sql::trigger:users',
    ]);
    expect(schema.references).toContainEqual({
      source: 'db/schema.sql::trigger:users',
      target: 'users',
      type: 'accesses',
      reason: 'trigger fires on table',
    });
  });

  it('reads Postgres E-strings with backslash escapes and MySQL END IF inside a trigger', () => {
    const sql = extractSql(
      'pg.sql',
      [
        "CREATE TABLE a (x TEXT DEFAULT E'it\\'s; fine');",
        'CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW BEGIN',
        '  IF NEW.x IS NULL THEN SET NEW.x = 1; END IF;',
        'END;',
        'CREATE TABLE b (id INTEGER);',
      ].join('\n'),
    );
    expect(sql.nodes.map((node) => node.id)).toEqual([
      'pg.sql::table:a',
      'pg.sql::trigger:t',
      'pg.sql::table:b',
    ]);
    expect(sql.problems).toEqual([]);
  });

  it.each([
    [
      'an unterminated quote',
      "CREATE TABLE a (x TEXT DEFAULT 'oops);\nCREATE TABLE b (id INTEGER);\nCREATE TABLE c (id INTEGER);",
      /unterminated ' quote opened on line 1/,
    ],
    [
      'an unterminated block',
      'CREATE TABLE b (id INTEGER);\nCREATE TRIGGER t AFTER INSERT ON b BEGIN DELETE FROM b;',
      /BEGIN or CASE block\(s\) still open/,
    ],
    [
      'an unclassified statement',
      'CREATE TABLE b (id INTEGER);\nCREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;',
      /1 statement\(s\) matched no recognized SQL form/,
    ],
  ])('reports %s as a problem', (_case, source, problem) => {
    expect(extractSql('bad.sql', source).problems).toEqual([expect.stringMatching(problem)]);
  });

  it('records ALTER and DROP migration statements as file references', () => {
    const migration = extractSql('db/002.sql', MIGRATION);
    expect(migration.renames).toEqual([{ from: 'audit_log', to: 'audit_events' }]);
    expect(migration.references.filter((ref) => ref.source === 'db/002.sql')).toEqual([
      {
        source: 'db/002.sql',
        target: 'users',
        type: 'accesses',
        reason: 'migration: ALTER TABLE ADD COLUMN',
      },
      {
        source: 'db/002.sql',
        target: 'posts',
        type: 'accesses',
        reason: 'migration: ALTER TABLE ADD CONSTRAINT',
      },
      {
        source: 'db/002.sql',
        target: 'users',
        type: 'accesses',
        reason: 'migration: foreign key references',
      },
      {
        source: 'db/002.sql',
        target: 'audit_log',
        type: 'accesses',
        reason: 'migration: ALTER TABLE RENAME TO',
      },
      {
        source: 'db/002.sql',
        target: 'recent_posts',
        type: 'accesses',
        reason: 'migration: DROP VIEW',
      },
      {
        source: 'db/002.sql',
        target: 'legacy_table',
        type: 'accesses',
        reason: 'migration: DROP TABLE',
      },
    ]);
    expect(migration.unrecognizedStatements).toBe(0);
  });

  it('links references across files, follows renames and counts unresolved names', () => {
    const graph = createKnowledgeGraph();
    const migration = extractSql('db/002.sql', MIGRATION);
    for (const node of [...schema.nodes, ...migration.nodes]) graph.addNode(node);
    const result = linkSqlReferences([schema, migration], graph);
    const edges = graph.relations.map((rel) => `${rel.source} -${rel.type}-> ${rel.target}`);
    expect(edges).toEqual(
      expect.arrayContaining([
        'db/schema.sql::table:posts -accesses-> db/schema.sql::table:users',
        'db/schema.sql::trigger:posts_audit -queries-> db/schema.sql::table:audit_log',
        'db/002.sql -accesses-> db/schema.sql::table:posts',
        // The renamed table resolves under its new name.
        'db/002.sql::index:idx_events_post -accesses-> db/schema.sql::table:audit_log',
      ]),
    );
    const sameFile = graph.relations.find((rel) => rel.source === 'db/schema.sql::table:posts');
    expect(sameFile).toMatchObject({ confidence: 0.95, confidenceLabel: 'EXTRACTED' });
    const crossFile = graph.relations.find((rel) => rel.source === 'db/002.sql');
    expect(crossFile).toMatchObject({ confidence: 0.9 });
    // legacy_table is created by no indexed SQL file.
    expect(result.unresolved).toBe(1);
    expect(result.linked).toBe(schema.references.length + migration.references.length - 1);
  });
});

describe('SQL files in the parse loop (T14383)', () => {
  it('marks a partially read SQL file unsupported and completes no sql-* capability', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-sql-'));
    try {
      writeFileSync(
        join(directory, 'broken.sql'),
        "CREATE TABLE a (x TEXT DEFAULT 'oops);\nCREATE TABLE b (id INTEGER);\nCREATE TABLE c (id INTEGER);",
      );
      const reports: GraphIndexFileReport[] = [];
      await runParseLoop(
        await walkRepositoryPaths(directory),
        createKnowledgeGraph(),
        createSymbolTable(),
        buildImportResolutionContext(['broken.sql']),
        directory,
        { onFileReport: (report) => reports.push(report) },
      );
      expect(reports[0]).toMatchObject({
        path: 'broken.sql',
        status: 'unsupported',
        reason: expect.stringMatching(/^Partial SQL extraction: unterminated ' quote/),
        capabilities: { role: 'sql', completed: ['file-evidence'] },
      });
      expect(reports[0]?.capabilities?.limitations).toEqual(
        expect.arrayContaining([expect.stringMatching(/^Partial SQL extraction/)]),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('adds SQL nodes, defines and reference edges, and completes every requested SQL capability', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-sql-'));
    try {
      writeFileSync(join(directory, 'schema.sql'), SCHEMA);
      writeFileSync(join(directory, 'migration.sql'), MIGRATION);
      const graph = createKnowledgeGraph();
      const reports: GraphIndexFileReport[] = [];
      await runParseLoop(
        await walkRepositoryPaths(directory),
        graph,
        createSymbolTable(),
        buildImportResolutionContext(['schema.sql', 'migration.sql']),
        directory,
        { onFileReport: (report) => reports.push(report) },
      );
      const schema = reports.find((report) => report.path === 'schema.sql');
      expect(schema).toMatchObject({
        status: 'analyzed',
        capabilities: {
          role: 'sql',
          requested: [
            'file-evidence',
            'sql-schema-objects',
            'sql-migrations',
            'sql-triggers',
            'sql-constraints',
          ],
          completed: [
            'file-evidence',
            'sql-schema-objects',
            'sql-migrations',
            'sql-triggers',
            'sql-constraints',
          ],
        },
      });
      expect(schema?.reason).toBeUndefined();
      expect(schema?.capabilities?.limitations).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/literal SQL table references inside executable sources/i),
          expect.stringMatching(/dynamic SQL.*unresolved/i),
        ]),
      );
      expect(graph.nodes.get('schema.sql::table:posts')?.meta?.['sqlKind']).toBe('table');
      expect(graph.nodes.get('migration.sql::index:idx_events_post')?.meta?.['sqlKind']).toBe(
        'index',
      );
      const edges = graph.relations.map((rel) => `${rel.source} -${rel.type}-> ${rel.target}`);
      expect(edges).toEqual(
        expect.arrayContaining([
          'schema.sql -defines-> schema.sql::table:posts',
          'schema.sql -defines-> schema.sql::trigger:posts_audit',
          'schema.sql::table:posts -accesses-> schema.sql::table:users',
          'migration.sql -accesses-> schema.sql::table:users',
        ]),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
