/**
 * Tests for `scripts/lint-no-raw-table-writes.mjs` (T12332, arch gate 28).
 *
 * The comment stripper must be string-aware (a string holding `/*` never
 * blanks code), and the write matcher must catch lower-case and multi-line
 * statements.
 *
 * @task T12332
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  fkActionParents,
  PROSE_ONLY,
  replaceAllowed,
  replaceSites,
  SANCTIONED,
  scanReplace,
  stripComments,
  writeSites,
} from '../lint-no-raw-table-writes.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'lint-no-raw-table-writes.mjs');
const TABLES = new Set(['tasks', 'tasks_tasks', 'brain_observations']);
const sites = (src, lang = 'js') => writeSites(stripComments(src, lang), TABLES);

describe('stripComments', () => {
  it('keeps length and newlines, so line numbers survive', () => {
    const src = 'a /* x\ny */ b // z\nc';
    const out = stripComments(src);
    expect(out).toHaveLength(src.length);
    expect(out.split('\n')).toHaveLength(3);
    expect(out).not.toMatch(/[xyz]/);
  });

  it('a string holding /* or // does not blank the code after it', () => {
    const src = [
      "const glob = 'src/**/*.ts';",
      'db.exec("INSERT INTO tasks_tasks (id) VALUES (1)");',
      "const url = 'https://x'; db.exec(`DELETE FROM tasks WHERE id = 1`);",
      '// done */',
    ].join('\n');
    expect(sites(src)).toEqual([
      { line: 2, table: 'tasks_tasks' },
      { line: 3, table: 'tasks' },
    ]);
  });

  it('a regex literal holding /* does not open a comment', () => {
    const src = 'const re = /\\/\\*/g;\nrun("UPDATE tasks SET x = 1");';
    expect(sites(src)).toEqual([{ line: 2, table: 'tasks' }]);
  });

  it('template expressions nest; comments inside them are blanked', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source text under test
    const src = 'q(`${a /* INSERT INTO tasks */}INSERT INTO tasks_tasks ${`${b}`}`);';
    expect(sites(src)).toEqual([{ line: 1, table: 'tasks_tasks' }]);
  });

  it('really commented-out writes do not count', () => {
    expect(sites('// INSERT INTO tasks\n/* UPDATE tasks */')).toEqual([]);
  });

  it('rust: nested block comments, raw strings and lifetimes', () => {
    const src = [
      "fn f<'a>(x: &'a str) {",
      '  /* outer /* inner */ still comment: INSERT INTO tasks */',
      '  conn.execute(r#"DELETE FROM tasks_tasks WHERE x = "/*""#, [])?;',
      "  let c = '\"';",
      '  conn.execute("UPDATE tasks SET y = 1", [])?;',
      '}',
    ].join('\n');
    expect(sites(src, 'rs')).toEqual([
      { line: 3, table: 'tasks_tasks' },
      { line: 5, table: 'tasks' },
    ]);
  });
});

describe('writeSites', () => {
  it('is case-insensitive', () => {
    expect(sites("db.exec('insert into brain_observations (id) values (1)')")).toEqual([
      { line: 1, table: 'brain_observations' },
    ]);
    expect(sites("db.exec('Delete From tasks')")).toEqual([{ line: 1, table: 'tasks' }]);
  });

  it('tolerates a multi-line statement', () => {
    const src = 'db.exec(`\n  insert or replace\n    into\n  "tasks_tasks" (id) values (1)`);';
    expect(sites(src)).toEqual([{ line: 2, table: 'tasks_tasks' }]);
  });

  it('matches whole names and schema-qualified names', () => {
    expect(sites("x('UPDATE tasks_tasks SET a = 1')")).toEqual([{ line: 1, table: 'tasks_tasks' }]);
    expect(sites("x('INSERT INTO main.tasks VALUES (1)')")).toEqual([{ line: 1, table: 'tasks' }]);
  });

  it('does not see a Drizzle builder call or a dynamic name (known blind spot)', () => {
    expect(sites('db.update(tasks).set({ a: 1 }); db.delete(tasks);')).toEqual([]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source text under test
    expect(sites('db.exec(`INSERT INTO ${table} VALUES (1)`);')).toEqual([]);
  });
});

describe('REPLACE ban (T12787)', () => {
  const reps = (src, lang = 'js') => replaceSites(stripComments(src, lang));

  it('finds INSERT OR REPLACE and REPLACE INTO, any case, multi-line, qualified', () => {
    expect(reps("db.exec('insert or replace into p (id) values (1)')")).toEqual([
      { line: 1, table: 'p' },
    ]);
    expect(reps('x(`\n  REPLACE\n  INTO main."Parent" (id) VALUES (1)`)')).toEqual([
      { line: 2, table: 'parent' },
    ]);
  });

  it('finds UPDATE OR REPLACE and DDL ON CONFLICT REPLACE, but not an UPSERT', () => {
    expect(reps("db.exec('UPDATE OR REPLACE main.p SET id = 2 WHERE id = 1')")).toEqual([
      { line: 1, table: 'p' },
    ]);
    expect(
      reps('db.exec(`CREATE TABLE p (\n  id TEXT PRIMARY KEY ON CONFLICT REPLACE,\n  k TEXT)`)'),
    ).toEqual([{ line: 2, table: null }]);
    expect(reps("db.exec('CREATE TABLE p (k TEXT, UNIQUE (k) on  conflict  replace)')")).toEqual([
      { line: 1, table: null },
    ]);
    expect(
      reps("db.exec('INSERT INTO p (id) VALUES (1) ON CONFLICT(id) DO UPDATE SET id = 1')"),
    ).toEqual([]);
    expect(reps("db.exec('INSERT INTO p (id) VALUES (1) ON CONFLICT DO NOTHING')")).toEqual([]);
  });

  it('reports a dynamic target as null, and ignores comments and .replace()', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source text under test
    expect(reps('db.exec(`INSERT OR REPLACE INTO main.${ident(t)} SELECT 1`);')).toEqual([
      { line: 1, table: null },
    ]);
    expect(reps("// INSERT OR REPLACE INTO p\ns.replace(/a/, 'b'); s.replace('x', y);")).toEqual(
      [],
    );
    expect(
      reps("db.exec('INSERT INTO p (id) VALUES (1) ON CONFLICT(id) DO UPDATE SET id = 1')"),
    ).toEqual([]);
  });

  it('honours a `// replace-allowed: <reason>` marker on the line or the line above', () => {
    const lines = [
      'a',
      '  // replace-allowed: vec0 virtual table',
      "  .prepare('INSERT OR REPLACE INTO v (id) VALUES (?)')",
      "db.exec('REPLACE INTO v VALUES (1)'); // replace-allowed: vec0",
      '// replace-allowed:',
      "db.exec('REPLACE INTO v VALUES (1)');",
    ];
    expect(replaceAllowed(lines, 3)).toBe(true);
    expect(replaceAllowed(lines, 4)).toBe(true);
    expect(replaceAllowed(lines, 6)).toBe(false); // a reason is required
    expect(replaceAllowed(lines, 1)).toBe(false);
  });

  it('fkActionParents keeps only ON DELETE CASCADE / SET NULL / SET DEFAULT parents', () => {
    const sql = [
      'CREATE TABLE c1 (pid TEXT REFERENCES `task_acceptance_criteria`(`id`) ON DELETE CASCADE);',
      'CREATE TABLE c2 (a TEXT, FOREIGN KEY (`a`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null);',
      'CREATE TABLE c3 (b TEXT REFERENCES keep_me(id) ON DELETE RESTRICT);',
      'CREATE TABLE c4 (b TEXT REFERENCES plain(id));',
      'CREATE TABLE c5 (b TEXT REFERENCES "dflt" (id) ON UPDATE CASCADE ON DELETE SET DEFAULT DEFERRABLE INITIALLY DEFERRED);',
    ].join('\n');
    expect([...fkActionParents(sql)].sort()).toEqual(['dflt', 'task_acceptance_criteria', 'tasks']);
  });

  it('the real repository has no un-opted REPLACE and no opt-out on an FK-action parent', () => {
    expect(scanReplace()).toEqual([]);
  });
});

describe('lint-no-raw-table-writes on the real repository', () => {
  it('every exempt path exists', () => {
    for (const f of [...SANCTIONED, ...PROSE_ONLY.keys()]) {
      expect(existsSync(join(REPO, f)), f).toBe(true);
    }
  });

  it('passes --check against the committed baseline', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: REPO, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  });
});
