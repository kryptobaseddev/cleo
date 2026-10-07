/**
 * Tests for `scripts/lint-sync-schema.mjs` (gate 36; T12819, T12827).
 *
 * @task T12819
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clauseFor,
  fkParents,
  migrationViolations,
  ownedTriggers,
  releaseCheck,
  releaseCommit,
  releasedFileEdits,
  sourceViolations,
} from '../lint-sync-schema.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'lint-sync-schema.mjs');
const OWNED = new Map([
  ['g1', 'guard'],
  ['s1', 'side-effect'],
]);
const PARENTS = fkParents('CREATE TABLE c (pid TEXT REFERENCES p(id), k TEXT REFERENCES q(code));');
const rules = (vs) => vs.map((v) => v.rule);

describe('source rules', () => {
  it('rule 1: nothing drops cleo_trigger_suspend', () => {
    expect(
      rules(
        sourceViolations('packages/x.ts', "db.exec('DROP TABLE IF EXISTS cleo_trigger_suspend')"),
      ),
    ).toEqual([1]);
    expect(
      rules(
        sourceViolations(
          'packages/m/migrations/a/migration.sql',
          'DROP TABLE `cleo_trigger_suspend`;',
        ),
      ),
    ).toEqual([1]);
    expect(sourceViolations('packages/x.ts', '// DROP TABLE cleo_trigger_suspend (prose)')).toEqual(
      [],
    );
  });

  it('rule 2: only machinery.ts drops _sync_* tables', () => {
    expect(rules(sourceViolations('packages/x.ts', 'exec("DROP TABLE _sync_capture")'))).toEqual([
      2,
    ]);
    expect(
      sourceViolations(
        'packages/core/src/store/sync/machinery.ts',
        'exec("DROP TABLE _sync_capture")',
      ),
    ).toEqual([]);
  });

  it('rule 3: no migration SQL mentions _sync_cap_', () => {
    expect(
      rules(
        sourceViolations(
          'packages/core/migrations/d/x/migration.sql',
          'DROP TRIGGER _sync_cap_t_i;',
        ),
      ),
    ).toEqual([3]);
  });
});

describe('forward migration rules', () => {
  it('rule 4: an owned trigger needs the clause for its class', () => {
    const bad = 'CREATE TRIGGER `g1` BEFORE INSERT ON t BEGIN SELECT 1; END;';
    const good = `CREATE TRIGGER g1 BEFORE INSERT ON t WHEN ${clauseFor('guard')} BEGIN SELECT 1; END;`;
    const wrongScope = `CREATE TRIGGER s1 AFTER INSERT ON t WHEN ${clauseFor('guard')} BEGIN SELECT 1; END;`;
    expect(rules(migrationViolations('f', bad, OWNED, PARENTS))).toEqual([4]);
    expect(migrationViolations('f', good, OWNED, PARENTS)).toEqual([]);
    expect(rules(migrationViolations('f', wrongScope, OWNED, PARENTS))).toEqual([4]);
    expect(
      migrationViolations(
        'f',
        'CREATE TRIGGER other AFTER INSERT ON t BEGIN SELECT 1; END;',
        OWNED,
        PARENTS,
      ),
    ).toEqual([]);
  });

  it('rule 5: no non-deterministic function in DML; DDL defaults and trigger bodies are exempt', () => {
    expect(
      rules(migrationViolations('f', "UPDATE t SET at = datetime('now');", OWNED, PARENTS)),
    ).toEqual([5]);
    expect(
      rules(migrationViolations('f', 'INSERT INTO t (x) VALUES (random());', OWNED, PARENTS)),
    ).toEqual([5]);
    expect(
      migrationViolations(
        'f',
        "CREATE TABLE t (at TEXT DEFAULT (datetime('now')));",
        OWNED,
        PARENTS,
      ),
    ).toEqual([]);
    expect(
      migrationViolations(
        'f',
        "CREATE TRIGGER x AFTER INSERT ON t BEGIN UPDATE t SET at = datetime('now'); END;",
        OWNED,
        PARENTS,
      ),
    ).toEqual([]);
  });

  it('rule 6: a rebuild file may not delete from or re-key an FK parent', () => {
    const rebuild = 'CREATE TABLE `__new_c` (id TEXT);\n--> statement-breakpoint\n';
    expect(
      rules(migrationViolations('f', `${rebuild}DELETE FROM p WHERE id = 'x';`, OWNED, PARENTS)),
    ).toEqual([6]);
    expect(
      rules(
        migrationViolations(
          'f',
          `${rebuild}UPDATE q SET code = 'n' WHERE code = 'o';`,
          OWNED,
          PARENTS,
        ),
      ),
    ).toEqual([6]);
    expect(migrationViolations('f', `${rebuild}UPDATE q SET label = 'n';`, OWNED, PARENTS)).toEqual(
      [],
    );
    // Without a rebuild, foreign keys stay on and the DELETE cascades: allowed.
    expect(migrationViolations('f', "DELETE FROM p WHERE id = 'x';", OWNED, PARENTS)).toEqual([]);
  });
});

describe('rule 7: released means present at the merge-base (T13294)', () => {
  let root = '';
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = '';
  });
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();
  const rel = (name) => `packages/core/migrations/${name}/migration.sql`;
  const write = (name, sql) => {
    mkdirSync(join(root, 'packages/core/migrations', name), { recursive: true });
    writeFileSync(join(root, rel(name)), sql);
  };
  const commit = (msg) => {
    git('add', '-A');
    git('commit', '-q', '-m', msg);
  };
  /** The migration files in the working tree, as the gate lists them. */
  const files = (...names) => names.map((name) => ({ abs: join(root, rel(name)), rel: rel(name) }));
  /** main has m1; the branch is cut; main then gains m2. HEAD is the branch. */
  function branchCutBeforeM2() {
    root = mkdtempSync(join(tmpdir(), 'lint-sync-schema-'));
    git('init', '-q', '-b', 'main');
    write('20260101000000_m1', 'CREATE TABLE a (id TEXT);\n');
    commit('m1');
    git('checkout', '-q', '-b', 'feature');
    git('checkout', '-q', 'main');
    write('20260102000000_m2', 'CREATE TABLE b (id TEXT);\n');
    commit('m2');
    git('checkout', '-q', 'feature');
  }

  it('a branch cut before a new base migration passes; against the base tip it would not', () => {
    branchCutBeforeM2();
    const at = releaseCommit('main', root);
    expect(at).toBe(git('rev-parse', 'feature'));
    expect(releasedFileEdits(at, files('20260101000000_m1'), root)).toEqual([]);
    // The defect: the base tip calls the newer migration deleted.
    expect(releasedFileEdits('main', files('20260101000000_m1'), root)).toEqual([
      expect.objectContaining({ file: rel('20260102000000_m2'), rule: 7 }),
    ]);
    // As the gate runs it.
    const check = releaseCheck('main', files('20260101000000_m1'), root);
    expect(check.violations).toEqual([]);
    expect(check.note).toContain(`merge-base ${at?.slice(0, 12)} of HEAD and main`);
  });

  it('deleting or editing a migration released at the merge-base still fails', () => {
    branchCutBeforeM2();
    write('20260103000000_m3', 'CREATE TABLE c (id TEXT);\n');
    const at = releaseCommit('main', root);
    expect(releasedFileEdits(at, files('20260103000000_m3'), root)).toEqual([
      expect.objectContaining({ file: rel('20260101000000_m1'), rule: 7 }),
    ]);
    expect(releaseCheck('main', files('20260103000000_m3'), root).violations).toHaveLength(1);
    write('20260101000000_m1', 'CREATE TABLE a (id TEXT, x TEXT);\n');
    const edited = releasedFileEdits(at, files('20260101000000_m1'), root);
    expect(edited).toHaveLength(1);
    expect(edited[0]?.message).toContain('released migration edited');
  });

  it('a merge of the base brings its migrations in: the merge-base moves to the base tip', () => {
    branchCutBeforeM2();
    git('merge', '-q', '--no-edit', 'main');
    expect(releaseCommit('main', root)).toBe(git('rev-parse', 'main'));
    expect(
      releasedFileEdits(
        releaseCommit('main', root),
        files('20260101000000_m1', '20260102000000_m2'),
        root,
      ),
    ).toEqual([]);
  });

  it('no shared history (a shallow clone) gives no merge-base, and the gate fails loudly (T13310)', () => {
    branchCutBeforeM2();
    git('checkout', '-q', '--orphan', 'lonely');
    git('commit', '-q', '-m', 'orphan');
    expect(releaseCommit('main', root)).toBeNull();
    // No fallback to another comparison: one violation that names the fix,
    // even when every file would match the base tip.
    const check = releaseCheck('main', files('20260101000000_m1', '20260102000000_m2'), root);
    expect(check.violations).toEqual([
      expect.objectContaining({ file: '(history)', rule: 7 }),
    ]);
    expect(check.violations[0]?.message).toContain('no merge-base of HEAD and main');
    expect(check.violations[0]?.message).toContain('git fetch --unshallow');
  });
});

describe('on the real repository', () => {
  it('reads OWNED_TRIGGERS from the classes module', () => {
    const owned = ownedTriggers(
      readFileSync(join(REPO, 'packages/core/src/store/sync/trigger-classes.ts'), 'utf8'),
    );
    expect(owned.get('tasks_tasks_lease_iso_insert')).toBe('guard');
    expect(owned.get('trg_tasks_session_handoff_mirror')).toBe('side-effect');
  });

  it('passes --check', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: REPO, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  });
});
