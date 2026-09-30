/**
 * Tests for `scripts/lint-no-raw-table-writes.mjs` (T12332, arch gate 28).
 *
 * The comment stripper must be string-aware (a string holding `/*` never
 * blanks code), and the write matcher must catch lower-case and multi-line
 * statements.
 *
 * Exemptions are keyed per (file, table) and expire when the table's class
 * becomes portable; staged-snapshot sites are marked per site (T12343 S0).
 *
 * @task T12332
 * @task T12343
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  applyExemptions,
  bindMarkers,
  EXEMPT,
  enclosingFunction,
  fkActionParents,
  isSyncTable,
  PROSE_ONLY,
  registryClasses,
  replaceAllowed,
  replaceSites,
  SANCTIONED,
  STAGED_SNAPSHOT,
  scanReplace,
  stagedMarkers,
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

const REGISTRY_SRC = `
const PROJECT_TABLES: Readonly<Record<string, TableRegistryEntry>> = {
  _writer_leases: { class: 'local-only', status: 'draft', source: 'x' },
  brain_weight_history: {
    class: 'portable-personal',
    status: 'resolved',
    columns: [{ column: 'x', class: 'local-only', reason: 'r' }],
  },
  tasks: {
    class: 'local-only',
    status: 'frozen-legacy',
  },
  tasks_tasks: {
    class: 'portable-project',
    status: 'resolved',
  },
};

const GLOBAL_TABLES: Readonly<Record<string, TableRegistryEntry>> = {
  nexus_schema_meta: { class: 'local-only', status: 'draft', source: 'draft §3' },
  _writer_leases: { class: 'local-only', status: 'draft', source: 'draft §3' },
};
`;

describe('registryClasses / isSyncTable', () => {
  const classes = registryClasses(REGISTRY_SRC);

  it('reads the entry class and status, both scopes, one-line or multi-line', () => {
    expect(classes.get('_writer_leases')).toEqual([
      { scope: 'project', class: 'local-only', status: 'draft' },
      { scope: 'global', class: 'local-only', status: 'draft' },
    ]);
    // A column override's class never shadows the table's.
    expect(classes.get('brain_weight_history')).toEqual([
      { scope: 'project', class: 'portable-personal', status: 'resolved' },
    ]);
  });

  it('portable syncs; local-only, derived and frozen twins do not', () => {
    expect(isSyncTable(classes.get('tasks_tasks'))).toBe(true);
    expect(isSyncTable(classes.get('brain_weight_history'))).toBe(true);
    expect(isSyncTable(classes.get('_writer_leases'))).toBe(false);
    expect(isSyncTable(classes.get('tasks'))).toBe(false);
    expect(isSyncTable(undefined)).toBe(false);
  });
});

describe('applyExemptions', () => {
  const classes = registryClasses(REGISTRY_SRC);
  const site = (file, table, line = 1) => ({ file, table, line });

  it('exempts a non-sync (file, table) with the exact count, and baselines the rest', () => {
    const r = applyExemptions(
      [
        site('a.ts', '_writer_leases'),
        site('a.ts', '_writer_leases', 2),
        site('a.ts', 'tasks_tasks'),
      ],
      classes,
      { 'a.ts': { _writer_leases: { count: 2, reason: 'lease' } } },
      {},
    );
    expect(r.errors).toEqual([]);
    expect(r.exemptSites).toBe(2);
    expect(r.residual).toEqual([site('a.ts', 'tasks_tasks')]);
  });

  it('keys on (file, table): the same table in another file is not exempt', () => {
    const r = applyExemptions(
      [site('b.ts', '_writer_leases')],
      classes,
      { 'a.ts': { _writer_leases: { count: 0, reason: 'lease' } } },
      {},
    );
    expect(r.residual).toEqual([site('b.ts', '_writer_leases')]);
  });

  it('an entry EXPIRES when its table becomes portable', () => {
    const r = applyExemptions(
      [site('a.ts', 'brain_weight_history')],
      classes,
      { 'a.ts': { brain_weight_history: { count: 1, reason: 'was local-only' } } },
      {},
    );
    expect(r.errors.join('\n')).toMatch(
      /EXPIRED, the table now syncs \(project portable-personal\)/,
    );
  });

  it('fails when the count moves either way, or the reason is empty', () => {
    const up = applyExemptions(
      [site('a.ts', '_writer_leases'), site('a.ts', '_writer_leases', 2)],
      classes,
      { 'a.ts': { _writer_leases: { count: 1, reason: 'lease' } } },
      {},
    );
    expect(up.errors.join('\n')).toMatch(/1 site\(s\) exempt, 2 found. A new raw write/);
    const down = applyExemptions(
      [],
      classes,
      { 'a.ts': { _writer_leases: { count: 1, reason: '' } } },
      {},
    );
    expect(down.errors.join('\n')).toMatch(/no reason/);
    expect(down.errors.join('\n')).toMatch(/1 site\(s\) exempt, 0 found. Lower the count/);
  });

  it('a marked staged-snapshot site needs its (file, table, function) entry and the right function', () => {
    const marked = (fn, enclosing) => ({
      ...site('c.ts', 'tasks_tasks'),
      marker: { fn, enclosing },
    });
    const staged = { 'c.ts': { tasks_tasks: { redact: { count: 1, reason: 'snapshot' } } } };
    const ok = applyExemptions([marked('redact', 'redact')], classes, {}, staged);
    expect(ok.errors).toEqual([]);
    expect(ok.stagedSites).toBe(1);
    expect(ok.residual).toEqual([]);
    const wrongFn = applyExemptions([marked('redact', 'unseal')], classes, {}, staged);
    expect(wrongFn.errors.join('\n')).toMatch(/marker names redact, but the write is in unseal/);
    const noEntry = applyExemptions([marked('other', 'other')], classes, {}, staged);
    expect(noEntry.errors.join('\n')).toMatch(/marker for other has no STAGED_SNAPSHOT entry/);
    expect(noEntry.errors.join('\n')).toMatch(/1 marked site\(s\) expected, 0 found/);
  });
});

describe('staged-snapshot markers', () => {
  const TABLES = new Set(['tasks_tasks']);
  const bind = (src) => {
    const code = stripComments(src);
    return bindMarkers(writeSites(code, TABLES), stagedMarkers(src, code), code);
  };

  it('binds a marker to the write below it and records the enclosing named function', () => {
    const src = [
      'export function redact(p) {',
      '  withDb(p, (db) => {',
      '    // gate-28: staged-snapshot redact',
      '    db.prepare(',
      "      'UPDATE tasks_tasks SET x = NULL',",
      '    ).run();',
      "    db.prepare('UPDATE tasks_tasks SET y = 1').run();",
      '  });',
      '}',
    ].join('\n');
    const { sites, stray } = bind(src);
    expect(stray).toEqual([]);
    expect(sites).toEqual([
      { line: 5, table: 'tasks_tasks', marker: { fn: 'redact', enclosing: 'redact' } },
      { line: 7, table: 'tasks_tasks' },
    ]);
  });

  it('a marker inside a string is not a marker; a marker over no write is stray', () => {
    const src = [
      "const s = '// gate-28: staged-snapshot f';",
      "run('UPDATE tasks_tasks SET x = 1');",
      '// gate-28: staged-snapshot g',
      '',
      '',
      '',
      "run('UPDATE tasks_tasks SET x = 2');",
    ].join('\n');
    const { sites, stray } = bind(src);
    expect(sites.every((s) => !s.marker)).toBe(true);
    expect(stray).toEqual([{ line: 3, fn: 'g' }]);
  });

  it('enclosingFunction reads function, arrow const and Rust fn declarations', () => {
    expect(enclosingFunction('function a() {\n  x;\n}', 2)).toBe('a');
    expect(enclosingFunction('const b = async (db) => {\n  x;\n};', 2)).toBe('b');
    expect(enclosingFunction('pub fn c(conn: &Connection) {\n  x;\n}', 2)).toBe('c');
    expect(enclosingFunction('x;', 1)).toBeUndefined();
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
  it('every EXEMPT and STAGED_SNAPSHOT file exists and every entry has a reason', () => {
    for (const [file, tables] of Object.entries(EXEMPT)) {
      expect(existsSync(join(REPO, file)), file).toBe(true);
      for (const [t, e] of Object.entries(tables)) expect(e.reason, `${file} ${t}`).toBeTruthy();
    }
    for (const [file, tables] of Object.entries(STAGED_SNAPSHOT)) {
      expect(existsSync(join(REPO, file)), file).toBe(true);
      for (const fns of Object.values(tables)) {
        for (const [fn, e] of Object.entries(fns)) expect(e.reason, `${file} ${fn}`).toBeTruthy();
      }
    }
  });

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
