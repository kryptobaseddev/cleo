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
import { PROSE_ONLY, SANCTIONED, stripComments, writeSites } from '../lint-no-raw-table-writes.mjs';

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
