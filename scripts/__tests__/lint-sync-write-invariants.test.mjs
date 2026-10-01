/**
 * Tests for `scripts/lint-sync-write-invariants.mjs` (T12881, arch gate 38):
 * the fifteen self-test cases of spec t12859-sync-write-validator-inventory
 * §3.6.7, each on a throwaway fixture tree, plus the repository itself.
 *
 * @task T12881
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkRegistry,
  checkSites,
  closureHelpers,
  compareBaseline,
  readMigrationSql,
  scanTree,
  siteKey,
} from '../lint-sync-write-invariants.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'lint-sync-write-invariants.mjs');

const SYNC = new Set(['tasks_tasks', 'brain_page_edges', 'tasks_sessions']);
const CLASSIFIED = new Set([...SYNC, '_writer_queue']);
const REGISTERED = {
  id: 'task.status.absorbing',
  class: 'monotonic-merge-rule',
  tables: ['tasks_tasks'],
  sites: [],
  mergeRule: { table: 'tasks_tasks', columns: ['status'] },
  reason: 'fixture',
};

let roots = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

/** Write a fixture tree; keys are repo-relative paths. */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'sync-gate-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** Scan a fixture tree and return the site verdicts. */
function sitesOf(files, registry = [REGISTERED]) {
  const root = tree(files);
  const scan = scanTree({ root, syncTables: SYNC });
  const { untagged, problems } = checkSites(scan.sites, new Set(registry.map((e) => e.id)));
  const { added } = compareBaseline(untagged, {});
  return { scan, untagged, problems, added };
}

/** Run registry closure over a fixture tree. */
function closureOf(registry, files = {}) {
  const root = tree({ 'packages/core/src/placeholder.ts': 'export const x = 1;\n', ...files });
  const scan = scanTree({ root, syncTables: SYNC });
  const { exportsOf, callersOf, runtimeSql } = closureHelpers(root, scan);
  return checkRegistry({
    registry,
    classified: CLASSIFIED,
    migrationSql: readMigrationSql(root, ['packages/core/migrations']),
    runtimeSql,
    exportsOf,
    callersOf,
  });
}

const UPDATE_TASK = `
import { CleoError, ExitCode } from './errors.js';
export function setStatus(db, id, status) {
  if (!status) {
__TAG__
    throw new CleoError(ExitCode.VALIDATION_ERROR, 'status required');
  }
  db.prepare('UPDATE tasks_tasks SET status = ? WHERE id = ?').run(status, id);
}
`;
const withTag = (tag) => ({
  'packages/core/src/set-status.ts': UPDATE_TASK.replace('__TAG__', tag),
});

describe('rejection sites (§3.6.7 cases 1-8)', () => {
  it('1: an untagged throw in a module that updates tasks_tasks fails', () => {
    const { added, scan } = sitesOf(withTag(''));
    expect(scan.writePath.has('packages/core/src/set-status.ts')).toBe(true);
    expect(added).toEqual([
      expect.stringContaining('set-status.ts :: setStatus :: ExitCode.VALIDATION_ERROR'),
    ]);
  });

  it('2: the same site tagged with a registered id passes', () => {
    const { added, problems } = sitesOf(withTag('    // @sync-invariant task.status.absorbing'));
    expect(added).toEqual([]);
    expect(problems).toEqual([]);
  });

  it('3: a tag with an unknown id fails as dangling', () => {
    const { added, problems } = sitesOf(withTag('    // @sync-invariant task.status.nope'));
    expect(added).toEqual([]);
    expect(problems).toEqual([
      expect.stringContaining('dangling tag @sync-invariant task.status.nope'),
    ]);
  });

  it('4: none:input-shape with an empty reason fails', () => {
    expect(sitesOf(withTag('    // @sync-invariant none:input-shape')).problems).toEqual([
      expect.stringContaining('none:input-shape needs a reason'),
    ]);
    expect(
      sitesOf(withTag('    // @sync-invariant none:input-shape status is a CLI argument')).problems,
    ).toEqual([]);
  });

  it('5: an untagged throw in a module writing only a local-only table passes', () => {
    const { scan, added } = sitesOf({
      'packages/core/src/queue.ts': `export function enqueue(db, job) {
  if (!job) throw new Error('x');
  db.prepare('INSERT INTO _writer_queue (job) VALUES (?)').run(job);
}
`,
    });
    expect(scan.writePath.size).toBe(0);
    expect(added).toEqual([]);
  });

  it('6: an untagged engineError reachable from a mutate op (through a barrel) fails', () => {
    const { scan, added } = sitesOf({
      'packages/cleo/src/dispatch/domains/things.ts': `import { checkThing } from '@cleocode/core';
export const handler = {
  async query() { return null; },
  async mutate(op, params) { return checkThing(params); },
};
`,
      'packages/core/src/index.ts':
        "export { checkThing } from './things/check.js';\nexport { other } from './other.js';\n",
      'packages/core/src/things/check.ts': `import { engineError } from '../engine.js';
export function checkThing(p) {
  if (!p) return engineError('E_FOO', 'missing');
  return p;
}
`,
      'packages/core/src/other.ts': `export function other() { throw new Error('not reached'); }\n`,
      'packages/core/src/engine.ts':
        'export function engineError(code, msg) { return { code, msg }; }\n',
    });
    expect(scan.reachable.has('packages/core/src/things/check.ts')).toBe(true);
    // The barrel's other export is not pulled in by a named import of checkThing.
    expect(scan.reachable.has('packages/core/src/other.ts')).toBe(false);
    expect(added).toEqual([expect.stringContaining('things/check.ts :: checkThing :: E_FOO')]);
  });

  it('7: an untagged SQL counter (weight = weight + 1) fails', () => {
    const { added } = sitesOf({
      'packages/core/src/edges.ts': `export function bump(db, from, to) {
  db.prepare('UPDATE brain_page_edges SET weight = weight + 1 WHERE from_id = ? AND to_id = ?').run(from, to);
}
`,
    });
    expect(added).toEqual([expect.stringContaining('edges.ts :: bump :: silent:counter')]);
  });

  it('8: an untagged cascade (reads children, updates the parent) fails; tagged passes', () => {
    const cascade = (tag) => ({
      'packages/core/src/rollup.ts': `${tag}
export function rollUp(db, parentId) {
  const kids = db.prepare('SELECT status FROM tasks_tasks WHERE parent_id = ?').all(parentId);
  if (kids.every((k) => k.status === 'done'))
    db.prepare("UPDATE tasks_tasks SET status = 'done' WHERE id = ?").run(parentId);
}
`,
    });
    expect(sitesOf(cascade('')).added).toEqual([
      expect.stringContaining('rollup.ts :: rollUp :: silent:cascade'),
    ]);
    const tagged = sitesOf(cascade('// @sync-side-effect task.status.absorbing'));
    expect(tagged.added).toEqual([]);
    expect(tagged.problems).toEqual([]);
  });
});

describe('registry closure (§3.6.7 cases 9-13, 15)', () => {
  const triggerEntry = (name) => ({
    id: 'task.parent.no-cycle',
    class: 'trigger-covered',
    tables: ['tasks_tasks'],
    sites: [],
    triggers: [name],
    reason: 'fixture',
  });
  const MIGRATION = {
    'packages/core/migrations/drizzle-tasks/0001/migration.sql':
      'CREATE TRIGGER IF NOT EXISTS tasks_tasks_parent_cycle_guard_insert BEFORE INSERT ON tasks_tasks BEGIN SELECT 1; END;\n',
  };

  it('a trigger a migration creates passes', () => {
    expect(closureOf([triggerEntry('tasks_tasks_parent_cycle_guard_insert')], MIGRATION)).toEqual(
      [],
    );
  });

  it('9: a trigger-covered entry naming a trigger no migration creates fails', () => {
    expect(closureOf([triggerEntry('tasks_tasks_missing_guard')], MIGRATION)).toEqual([
      expect.stringContaining('tasks_tasks_missing_guard is created by no migration'),
    ]);
  });

  it('10: a UNIQUE index created only in runtime code fails', () => {
    const problems = closureOf([triggerEntry('uniq_docs_attachments_slug')], {
      ...MIGRATION,
      'packages/core/src/collapse.ts':
        "export function collapse(db) { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_docs_attachments_slug ON docs_attachments(slug)'); }\n",
    });
    expect(problems).toEqual([expect.stringContaining('created only in runtime code')]);
  });

  it('11: a post-apply-check whose function is not exported, or whose footprint is empty, fails', () => {
    const pac = (check) => ({
      id: 'task.tree.shape',
      class: 'post-apply-check',
      tables: ['tasks_tasks'],
      sites: [],
      check,
      reason: 'fixture',
    });
    const files = {
      'packages/core/src/store/sync/checks.ts':
        'function checkTreeShape() { return []; }\nexport function used() { return checkTreeShape(); }\n',
    };
    expect(
      closureOf(
        [
          pac({
            module: 'packages/core/src/store/sync/checks.ts',
            functionName: 'checkTreeShape',
            footprint: ['rows'],
          }),
        ],
        files,
      ),
    ).toEqual([expect.stringContaining('checkTreeShape is not exported')]);
    expect(
      closureOf(
        [
          pac({
            module: 'packages/core/src/store/sync/checks.ts',
            functionName: 'used',
            footprint: [],
          }),
        ],
        files,
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining('needs a non-empty footprint')]));
  });

  it('12: a post-apply-check reading non-synced config without pinnedPolicy fails', () => {
    const entry = {
      id: 'task.done.evidence',
      class: 'post-apply-check',
      tables: ['tasks_tasks'],
      sites: [],
      check: { footprint: ['done rows'] },
      readsNonSynced: ['config:lifecycle.mode'],
      pending: { task: 'T12344', reason: 'fixture' },
      reason: 'fixture',
    };
    expect(closureOf([entry])).toEqual([expect.stringContaining('without pinnedPolicy')]);
    expect(closureOf([{ ...entry, pinnedPolicy: true }])).toEqual([]);
  });

  it('13: a runtimeGate with no non-test caller is a dead gate', () => {
    const entry = {
      id: 'saga.no-depends',
      class: 'post-apply-check',
      tables: ['tasks_tasks'],
      sites: [],
      check: { footprint: ['saga rows'] },
      pending: { task: 'T12344', reason: 'fixture' },
      runtimeGate: {
        module: 'packages/core/src/sagas/enforcement.ts',
        functionName: 'assertSagaInvariantI3',
      },
      reason: 'fixture',
    };
    const gate = {
      'packages/core/src/sagas/enforcement.ts': 'export function assertSagaInvariantI3() {}\n',
      'packages/core/src/sagas/index.ts':
        "export { assertSagaInvariantI3 } from './enforcement.js';\n",
    };
    expect(closureOf([entry], gate)).toEqual([expect.stringContaining('dead gate')]);
    const called = {
      ...gate,
      'packages/core/src/sagas/add.ts':
        "import { assertSagaInvariantI3 } from './enforcement.js';\nexport function add() { assertSagaInvariantI3(); }\n",
    };
    expect(closureOf([entry], called)).toEqual([]);
  });

  it('15: an entry whose tables[] names an unclassified table fails', () => {
    expect(closureOf([{ ...REGISTERED, tables: ['tasks_tasks', 'tasks_mystery'] }])).toEqual([
      expect.stringContaining('table tasks_mystery is not classified by Gate A'),
    ]);
  });
});

describe('baseline (§3.6.7 case 14 and the ratchet)', () => {
  const site = { file: 'packages/core/src/a.ts', symbol: 'f', code: 'Error' };

  it('a baselined untagged site passes; a second one with the same key fails', () => {
    const baseline = { [siteKey(site)]: 1 };
    expect(compareBaseline([site], baseline)).toMatchObject({ added: [], stale: [] });
    expect(compareBaseline([site, site], baseline).added).toEqual([
      expect.stringContaining('2 untagged, baseline 1'),
    ]);
  });

  it('14: a baseline site removed from code but still in the baseline fails as stale', () => {
    const baseline = { [siteKey(site)]: 1, 'packages/core/src/gone.ts :: g :: Error': 1 };
    expect(compareBaseline([site], baseline).stale).toEqual([
      expect.stringContaining('gone.ts :: g :: Error (baseline 1, now 0)'),
    ]);
  });
});

describe('the repository', () => {
  it('passes the gate against its committed baseline', () => {
    const run = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: REPO, encoding: 'utf8' });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('lint-sync-write-invariants: OK');
  }, 180_000);
});
