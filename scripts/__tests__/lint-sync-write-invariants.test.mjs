/**
 * Tests for `scripts/lint-sync-write-invariants.mjs` (T12881, arch gate 38):
 * the fifteen self-test cases of spec t12859-sync-write-validator-inventory
 * §3.6.7, each on a throwaway fixture tree, the #1768 review fixes (H1
 * shrink-only against the base, H2 net-zero refactors, H3 factory-built
 * rejections, M1-M3 and the cheap lows), each red/green, plus the repository
 * itself.
 *
 * @task T12881
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkRegistry,
  checkSites,
  closureHelpers,
  compareBaseline,
  countKeys,
  main,
  parseArgs,
  readMigrationSql,
  scanTree,
  siteKey,
  taskProblems,
  unjustifiedRaises,
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
  const { untagged, problems } = checkSites(scan.sites, registry);
  const { added } = compareBaseline(countKeys(untagged), {});
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
    expect(added).toEqual([expect.stringContaining('set-status.ts :: ExitCode.VALIDATION_ERROR')]);
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
      'packages/cleo/src/dispatch/domains/things.ts': `import { checkThing, listThings } from '@cleocode/core';
const handlers = {
  list: async (p) => listThings(p),
  add: async (p) => checkThing(p),
};
export const handler = {
  async query(op, params) { return handlers[op](params); },
  async mutate(op, params) { return handlers[op](params); },
  getSupportedOperations() { return { query: ['list'], mutate: ['add'] }; },
};
`,
      'packages/core/src/things/list.ts': `export function listThings() { throw new Error('query only'); }\n`,
      'packages/core/src/index.ts':
        "export { checkThing } from './things/check.js';\nexport { other } from './other.js';\nexport { listThings } from './things/list.js';\n",
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
    // M2: a handler only a query op names is not on the mutate path.
    expect(scan.reachable.has('packages/core/src/things/list.ts')).toBe(false);
    expect(added).toEqual([expect.stringContaining('things/check.ts :: E_FOO')]);
  });

  it('7: an untagged SQL counter (weight = weight + 1) fails', () => {
    const { added } = sitesOf({
      'packages/core/src/edges.ts': `export function bump(db, from, to) {
  db.prepare('UPDATE brain_page_edges SET weight = weight + 1 WHERE from_id = ? AND to_id = ?').run(from, to);
}
`,
    });
    expect(added).toEqual([expect.stringContaining('edges.ts :: silent:counter')]);
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
      expect.stringContaining('rollup.ts :: silent:cascade'),
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

  it('keys are file :: code; a baselined untagged site passes, a second one fails', () => {
    expect(siteKey(site)).toBe('packages/core/src/a.ts :: Error');
    const baseline = { [siteKey(site)]: 1 };
    expect(compareBaseline(countKeys([site]), baseline)).toMatchObject({ added: [], stale: [] });
    expect(compareBaseline(countKeys([site, site]), baseline).added).toEqual([
      expect.stringContaining('2 untagged, baseline 1'),
    ]);
  });

  it('14: a baseline site removed from code but still in the baseline fails as stale', () => {
    const baseline = { [siteKey(site)]: 1, 'packages/core/src/gone.ts :: Error': 1 };
    expect(compareBaseline(countKeys([site]), baseline).stale).toEqual([
      expect.stringContaining('gone.ts :: Error (baseline 1, now 0)'),
    ]);
  });

  it('M1: in PR mode only keys of changed files are judged stale', () => {
    const baseline = { [siteKey(site)]: 1, 'packages/core/src/gone.ts :: Error': 1 };
    const opts = { staleFiles: new Set(['packages/core/src/a.ts']) };
    expect(compareBaseline(countKeys([site]), baseline, opts).stale).toEqual([]);
  });

  it('H1: a raise is unjustified unless audited with a task or net-zero for its code', () => {
    const base = { 'f.ts :: Error': 1 };
    const next = { 'f.ts :: Error': 2, 'g.ts :: E_X': 1 };
    expect(unjustifiedRaises(next, base)).toEqual([
      'f.ts :: Error (1 -> 2)',
      'g.ts :: E_X (0 -> 1)',
    ]);
    expect(
      unjustifiedRaises(next, base, {
        audited: { 'f.ts :: Error': 'T1 reviewed', 'g.ts :: E_X': 'no task' },
      }),
    ).toEqual(['g.ts :: E_X (0 -> 1)']);
    expect(unjustifiedRaises(next, base, { netDelta: { Error: 0, E_X: 0 } })).toEqual([]);
    expect(unjustifiedRaises(next, null)).toEqual([]);
  });
});

describe('factory-built rejections (H3)', () => {
  it('counts throw f(…) with the callee as the code, and return new XError in a factory', () => {
    const { added } = sitesOf({
      'packages/core/src/store/deps.ts': `function dependencyCycleError(edge, cycle) {
  return new CleoError(ExitCode.DEPENDENCY_CYCLE, 'cycle');
}
const taskClaimedError = (id) => new TaskClaimedError(id);
export function addDep(db, edge, cycle) {
  if (cycle) throw dependencyCycleError(edge, cycle);
  if (!edge) throw taskClaimedError(edge);
  db.prepare('INSERT INTO tasks_tasks (id) VALUES (?)').run(edge);
}
export function notAFactory() { return new Map(); }
`,
    });
    expect(added).toEqual([
      expect.stringContaining('deps.ts :: ExitCode.DEPENDENCY_CYCLE'),
      expect.stringContaining('deps.ts :: TaskClaimedError'),
      expect.stringContaining('deps.ts :: dependencyCycleError'),
      expect.stringContaining('deps.ts :: taskClaimedError'),
    ]);

    // Green: the same throws, tagged.
    const tagged = sitesOf({
      'packages/core/src/store/deps.ts': `export function addDep(db, edge, cycle) {
  // @sync-invariant task.status.absorbing
  if (cycle) throw dependencyCycleError(edge, cycle);
  db.prepare('INSERT INTO tasks_tasks (id) VALUES (?)').run(edge);
}
`,
    });
    expect(tagged.added).toEqual([]);
    expect(tagged.problems).toEqual([]);
  });
});

describe('scope (M2) and tags (lows)', () => {
  it('Array.from(<table symbol>) is not a read and logger.appendLog is not a write', () => {
    const { scan } = sitesOf({
      'packages/core/src/schema.ts': "export const tasks = sqliteTable('tasks_tasks', {});\n",
      'packages/core/src/x.ts': `import { tasks } from './schema.js';
export function f(logger) {
  const all = Array.from(tasks);
  logger.appendLog('x');
  if (!all) throw new Error('x');
}
`,
    });
    expect(scan.writePath.has('packages/core/src/x.ts')).toBe(false);
    const accessor = sitesOf({
      'packages/core/src/y.ts': `export function g(accessor) {
  if (!accessor) throw new Error('x');
  return accessor.appendLog('x');
}
`,
    });
    expect(accessor.scan.writePath.has('packages/core/src/y.ts')).toBe(true);
  });

  it('a tag must name an entry covering a table the site writes', () => {
    const brainEntry = { ...REGISTERED, id: 'brain.edge.weight', tables: ['brain_page_edges'] };
    const { problems } = sitesOf(withTag('    // @sync-invariant brain.edge.weight'), [
      REGISTERED,
      brainEntry,
    ]);
    expect(problems).toEqual([
      expect.stringContaining(
        'tag brain.edge.weight covers brain_page_edges but the site writes tasks_tasks',
      ),
    ]);
  });

  it("a nested site is not tagged by its enclosing statement's comment", () => {
    const { added } = sitesOf({
      'packages/core/src/z.ts': `export function h(db, ok) {
  // @sync-invariant task.status.absorbing
  const v = ok
    ? 1
    : (() => {
        throw new Error('nested');
      })();
  db.prepare('UPDATE tasks_tasks SET status = ? WHERE id = ?').run(v, 1);
}
`,
    });
    expect(added).toEqual([expect.stringContaining('z.ts :: Error')]);
  });

  it('a module-level silent site is taggable', () => {
    const files = (tag) => ({
      'packages/core/src/top.ts': `const db = open();
${tag}
db.prepare('UPDATE brain_page_edges SET weight = weight + 1').run();
`,
    });
    const brainEntry = { ...REGISTERED, id: 'brain.edge.weight', tables: ['brain_page_edges'] };
    expect(sitesOf(files(''), [brainEntry]).added).toEqual([
      expect.stringContaining('top.ts :: silent:counter'),
    ]);
    const tagged = sitesOf(files('// @sync-side-effect brain.edge.weight'), [brainEntry]);
    expect(tagged.added).toEqual([]);
    expect(tagged.problems).toEqual([]);
  });
});

describe('pending tasks (M3)', () => {
  it('fails on a missing or closed task, passes open ones', () => {
    const statusOf = (t) =>
      ({ T1: { status: 'pending' }, T2: { status: 'done' }, T3: { error: 'not found' } })[t];
    expect(taskProblems(['T1', 'T2', 'T3', 'T1'], statusOf)).toEqual([
      'task T2 is done: it must be open',
      'task T3: not found',
    ]);
  });

  it('parseArgs refuses unknown flags and an empty --base', () => {
    expect(parseArgs(['--check', '--base', 'origin/main', '--verify-tasks'])).toMatchObject({
      mode: 'check',
      base: 'origin/main',
      verifyTasks: true,
    });
    expect(parseArgs(['--base='])).toEqual({ error: '--base needs a git ref' });
    expect(parseArgs(['--bogus'])).toEqual({ error: 'unknown argument --bogus' });
  });
});

/**
 * PR mode end to end (H1, H2): a temp git repo, main() against a base commit.
 */
describe('PR mode against a base ref (H1, H2)', () => {
  const INPUTS = { registry: [REGISTERED], syncTables: SYNC, classified: CLASSIFIED };
  const BASELINE = 'scripts/.lint-sync-write-invariants-baseline.json';

  function repo(files) {
    const root = tree(files);
    const git = (...args) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();
    git('init', '-q');
    return { root, git };
  }
  const write = (root, files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  };
  async function run(root, argv) {
    const out = [];
    const so = process.stdout.write;
    const se = process.stderr.write;
    process.stdout.write = (c) => out.push(String(c)) > 0;
    process.stderr.write = (c) => out.push(String(c)) > 0;
    try {
      return { code: await main(argv, { root, inputs: INPUTS }), text: out.join('') };
    } finally {
      process.stdout.write = so;
      process.stderr.write = se;
    }
  }
  const writer = (name, extra = '') => `export function ${name}(db, id) {
  if (!id) throw new Error('id');${extra}
  db.prepare('UPDATE tasks_tasks SET status = 1 WHERE id = ?').run(id);
}
`;
  /** A base commit with one write-path module and its seeded baseline. */
  async function seeded(files) {
    const r = repo(files);
    // Sources are listed with git ls-files, so they must be tracked.
    r.git('add', '-A');
    expect((await run(r.root, ['--update-baseline', '--seed'])).code).toBe(0);
    r.git('add', '-A');
    r.git('commit', '-qm', 'base');
    return { ...r, base: r.git('rev-parse', 'HEAD') };
  }

  it('H1 red/green: a raised baseline fails against the base unless audited', async () => {
    const r = await seeded({ 'packages/core/src/a.ts': writer('a') });
    write(r.root, {
      'packages/core/src/a.ts': writer('a', "\n  if (id === 2) throw new Error('two');"),
    });
    // The shrink-only rewrite refuses the new site, even against the base.
    expect((await run(r.root, ['--update-baseline', '--base', r.base])).code).toBe(1);
    // Forced through with --seed, PR mode catches the raise.
    expect((await run(r.root, ['--update-baseline', '--seed'])).code).toBe(0);
    r.git('add', '-A');
    const red = await run(r.root, ['--check', '--base', r.base]);
    expect(red.code).toBe(1);
    expect(red.text).toContain('baseline raised against');
    expect(red.text).toContain('packages/core/src/a.ts :: Error (1 -> 2)');
    // Green: the same raise, audited with a task.
    const doc = JSON.parse(readFileSync(join(r.root, BASELINE), 'utf8'));
    doc.audited = { 'packages/core/src/a.ts :: Error': 'T12946 reviewed: known legacy check' };
    writeFileSync(join(r.root, BASELINE), JSON.stringify(doc));
    const green = await run(r.root, ['--check', '--base', r.base]);
    expect(green.text).not.toContain('FAIL');
    expect(green.code).toBe(0);
  });

  it('H2: renaming the function that holds a site costs nothing', async () => {
    const r = await seeded({ 'packages/core/src/a.ts': writer('completeTask') });
    write(r.root, { 'packages/core/src/a.ts': writer('completeTaskRenamed') });
    r.git('add', '-A');
    expect((await run(r.root, ['--check'])).code).toBe(0);
    expect((await run(r.root, ['--check', '--base', r.base])).code).toBe(0);
  });

  it('H2: moving a throwing helper to another file nets to zero against the base', async () => {
    const helper = "export function need(id) { if (!id) throw new Error('need'); }\n";
    const r = await seeded({
      'packages/core/src/a.ts': `${helper}${writer('a')}`,
      'packages/core/src/b.ts': writer('b'),
    });
    write(r.root, {
      'packages/core/src/a.ts': writer('a'),
      'packages/core/src/b.ts': `${helper}${writer('b')}`,
    });
    r.git('add', '-A');
    // Red without a base: b.ts gained a site its baseline key lacks.
    expect((await run(r.root, ['--check'])).code).toBe(1);
    // Green: the rewrite against the base accepts the move, and PR mode passes.
    expect((await run(r.root, ['--update-baseline', '--base', r.base])).code).toBe(0);
    r.git('add', '-A');
    const pr = await run(r.root, ['--check', '--base', r.base]);
    expect(pr.text).not.toContain('FAIL');
    expect(pr.code).toBe(0);
  });

  it('H2: a new import that makes a module reachable nets to zero against the base', async () => {
    const domain = (imports, call) => `${imports}
export const handler = {
  async mutate(op, params) { return ${call}; },
  getSupportedOperations() { return { query: [], mutate: ['add'] }; },
};
`;
    const r = await seeded({
      'packages/cleo/src/dispatch/domains/d.ts': domain('', 'null'),
      'packages/core/src/helper.ts':
        "export function helper(p) { if (!p) throw new Error('p'); return p; }\n",
    });
    write(r.root, {
      'packages/cleo/src/dispatch/domains/d.ts': domain(
        "import { helper } from '../../../../core/src/helper.js';",
        'helper(params)',
      ),
    });
    r.git('add', '-A');
    expect((await run(r.root, ['--check'])).code).toBe(1);
    expect((await run(r.root, ['--update-baseline', '--base', r.base])).code).toBe(0);
    r.git('add', '-A');
    const pr = await run(r.root, ['--check', '--base', r.base]);
    expect(pr.text).not.toContain('FAIL');
    expect(pr.code).toBe(0);
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
