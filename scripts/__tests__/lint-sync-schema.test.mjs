/**
 * Tests for `scripts/lint-sync-schema.mjs` (gate 36; T12819, T12827).
 *
 * @task T12819
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  clauseFor,
  fkParents,
  migrationViolations,
  ownedTriggers,
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
