#!/usr/bin/env node

/**
 * stage-a-exit-gate.mjs — restore-and-compare gate for portable bundles (T12328).
 *
 * Losslessness only counts once a round trip has been verified. For each
 * store, this script:
 *
 *   1. exports the project with `cleo backup export --scope project`. This
 *      reads the real store only: the on-open legacy migration is switched off
 *      and CLEO_HOME / CLEO_CONFIG_HOME point at temp dirs, so no global state
 *      is written.
 *   2. imports the bundle into a clean root at a DIFFERENT path, with a temp
 *      HOME / CLEO_HOME / CLEO_CONFIG_HOME, and requires `data.lossless ===
 *      true`. That means every table re-counts to the manifest and every
 *      entry not rewritten by relocation is byte-identical.
 *   3. checks that `projectId` in the restored `project-info.json` equals the
 *      source's.
 *   4. for stores whose data lives only in legacy files, runs
 *      `cleo doctor superseded-store --reconcile` on the RESTORED copy, then
 *      checks that tasks_tasks / brain_observations equal the restored legacy
 *      counts (tasks.db `tasks`, brain.db `brain_observations`).
 *   5. records whether `cleo list` works on the restored copy. This is
 *      informational: claude-todo has an open list defect (T12346), so counts
 *      are the assertion.
 *
 * It prints ONE JSON summary to stdout and exits 1 when any check fails, and 2
 * on bad usage. Real stores are never written.
 *
 * Usage:
 *   node scripts/stage-a-exit-gate.mjs [--store name=/abs/root]... [--reconcile name]...
 *        [--work <dir>] [--cli <path-to-cleo.js>] [--keep]
 *
 * With no --store, the four Stage A stores are used (axiom-analytics, cleocode,
 * llmtxt, claude-todo), with --reconcile for llmtxt and claude-todo.
 *
 * @task T12328
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
/** @type {{ DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => { prepare: (sql: string) => { get: () => unknown }, close: () => void } }} */
const { DatabaseSync } = require('node:sqlite');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The four real stores the Stage A exit gate runs against. */
export const DEFAULT_STORES = [
  { name: 'axiom-analytics', root: '/mnt/projects/axiom-analytics', reconcile: false },
  { name: 'cleocode', root: '/mnt/projects/cleocode', reconcile: false },
  { name: 'llmtxt', root: '/mnt/projects/llmtxt', reconcile: true },
  { name: 'claude-todo', root: '/mnt/projects/claude-todo', reconcile: true },
];

/**
 * Parse CLI arguments.
 *
 * @param {string[]} argv - Arguments after the script path.
 * @returns {{ stores: Array<{name: string, root: string, reconcile: boolean}>, work: string, cli: string, keep: boolean }}
 * @throws {Error} On malformed arguments.
 */
export function parseArgs(argv) {
  /** @type {Array<{name: string, root: string, reconcile: boolean}>} */
  const stores = [];
  const reconcile = new Set();
  let work = path.join(os.homedir(), '.temp', `stage-a-gate-${Date.now()}`);
  let cli = path.join(REPO_ROOT, 'packages', 'cleo', 'bin', 'cleo.js');
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--store') {
      const v = next();
      const eq = v.indexOf('=');
      if (eq <= 0) throw new Error(`--store expects name=/abs/root, got "${v}"`);
      stores.push({ name: v.slice(0, eq), root: path.resolve(v.slice(eq + 1)), reconcile: false });
    } else if (a === '--reconcile') reconcile.add(next());
    else if (a === '--work') work = path.resolve(next());
    else if (a === '--cli') cli = path.resolve(next());
    else if (a === '--keep') keep = true;
    else throw new Error(`unknown argument ${a}`);
  }
  const chosen = stores.length > 0 ? stores : DEFAULT_STORES.map((s) => ({ ...s }));
  if (stores.length > 0) for (const s of chosen) s.reconcile = reconcile.has(s.name);
  return { stores: chosen, work, cli, keep };
}

/**
 * Run the CLI and parse its single LAFS envelope.
 *
 * @param {string} cli - Path to cleo.js.
 * @param {string[]} args - CLI arguments.
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} opts - Working dir and environment.
 * @returns {{ rc: number, envelope: any, stdout: string, stderrTail: string, durationMs: number }}
 */
export function runCli(cli, args, opts) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: opts.cwd,
    env: opts.env,
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
  });
  let envelope = null;
  const out = (r.stdout ?? '').trim();
  if (out.includes('{')) {
    try {
      envelope = JSON.parse(out.slice(out.indexOf('{')));
    } catch {
      envelope = { unparsed: out.slice(0, 2000) };
    }
  }
  return {
    rc: r.status ?? -1,
    envelope,
    stdout: out,
    stderrTail: (r.stderr ?? '').slice(-1500),
    durationMs: Date.now() - started,
  };
}

/**
 * Count rows in one table of a restored (temp) database, read-only.
 *
 * @param {string} dbPath - Database file.
 * @param {string} table - Table name.
 * @returns {number | null} Row count, or null when the file/table is absent.
 */
export function countTable(dbPath, table) {
  if (!fs.existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true }); // db-open-allowed: read-only count of a restored temp copy (T12328 gate)
  try {
    const row = /** @type {{ n: number }} */ (
      db.prepare(`SELECT COUNT(*) AS n FROM "${table.replace(/"/g, '""')}"`).get()
    );
    return Number(row.n);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Read `projectId` from a root's `.cleo/project-info.json`.
 *
 * @param {string} root - Project root.
 * @returns {string | null} The projectId, or null when absent.
 */
export function readProjectId(root) {
  try {
    const info = JSON.parse(
      fs.readFileSync(path.join(root, '.cleo', 'project-info.json'), 'utf-8'),
    );
    return typeof info.projectId === 'string' ? info.projectId : null;
  } catch {
    return null;
  }
}

/**
 * Evaluate one store's collected results into a list of failures.
 * Pure: every decision the gate makes is here, so it is unit-testable.
 *
 * @param {any} r - Collected per-store results.
 * @returns {string[]} Failure messages (empty = pass).
 */
export function evaluateStore(r) {
  const failures = [];
  if (r.export.rc !== 0) failures.push(`export exited ${r.export.rc}`);
  if (r.import.rc !== 0) failures.push(`import exited ${r.import.rc}`);
  if (r.import.lossless !== true) failures.push('import did not report lossless:true');
  if (r.projectId.source !== r.projectId.restored) {
    failures.push(`projectId changed: ${r.projectId.source} -> ${r.projectId.restored}`);
  }
  if (r.reconcile) {
    if (r.reconcile.rc !== 0) failures.push(`reconcile exited ${r.reconcile.rc}`);
    for (const key of ['tasks', 'observations']) {
      const c = r.reconcile[key];
      if (c.expected === null || c.actual !== c.expected) {
        failures.push(`${key} after reconcile: expected ${c.expected}, got ${c.actual}`);
      }
    }
  }
  return failures;
}

/**
 * Run the gate against one store.
 *
 * @param {{name: string, root: string, reconcile: boolean}} store - Store to test.
 * @param {{ work: string, cli: string }} ctx - Work dir and CLI.
 * @returns {any} Per-store results including `failures` and `ok`.
 */
export function runStore(store, ctx) {
  const dir = path.join(ctx.work, store.name);
  const tempHome = path.join(dir, 'home');
  const bundle = path.join(dir, `${store.name}.cleobundle.tar.gz`);
  const target = path.join(dir, 'relocated', store.name);
  fs.mkdirSync(path.join(dir, 'cwd'), { recursive: true });
  fs.mkdirSync(tempHome, { recursive: true });

  // Export reads the real store: keep the on-open legacy migration OFF, and
  // point every global location at temp so nothing global is written.
  const exportEnv = {
    ...process.env,
    CLEO_HOME: path.join(dir, 'export-cleo-home'),
    CLEO_CONFIG_HOME: path.join(dir, 'export-cleo-config'),
    CLEO_DISABLE_EXODUS_ON_OPEN: '1',
  };
  // The store under test is chosen by cwd alone; an inherited override would redirect it.
  delete exportEnv.CLEO_DIR;
  delete exportEnv.CLEO_ROOT;
  const exp = runCli(
    ctx.cli,
    ['backup', 'export', store.name, '--scope', 'project', '--out', bundle],
    {
      cwd: store.root,
      env: exportEnv,
    },
  );

  // Everything after the export touches only the relocated copy.
  const isolatedEnv = { ...process.env, HOME: tempHome };
  delete isolatedEnv.CLEO_DISABLE_EXODUS_ON_OPEN;
  delete isolatedEnv.CLEO_ROOT;
  delete isolatedEnv.CLEO_DIR;
  isolatedEnv.CLEO_HOME = path.join(dir, 'cleo-home');
  isolatedEnv.CLEO_CONFIG_HOME = path.join(dir, 'cleo-config');

  const imp =
    exp.rc === 0
      ? runCli(ctx.cli, ['backup', 'import', bundle, '--target', target], {
          cwd: path.join(dir, 'cwd'),
          env: isolatedEnv,
        })
      : { rc: -1, envelope: null, stdout: '', stderrTail: 'skipped: export failed', durationMs: 0 };
  const data = imp.envelope?.data ?? imp.envelope?.error?.details ?? null;
  const section = data?.sections?.find((s) => s.kind === 'project') ?? null;

  const cleoDb = path.join(target, '.cleo', 'cleo.db');
  const result = {
    name: store.name,
    source: store.root,
    relocatedTo: target,
    export: {
      rc: exp.rc,
      size: exp.envelope?.data?.size ?? null,
      durationMs: exp.durationMs,
      unmigratedLegacyData:
        exp.envelope?.data?.sections?.[0]?.unmigratedLegacyData?.detected ?? null,
      error: exp.rc === 0 ? undefined : (exp.envelope?.error ?? exp.stderrTail),
    },
    import: {
      rc: imp.rc,
      durationMs: imp.durationMs,
      lossless: data?.lossless ?? null,
      tablesCompared: section?.tablesCompared ?? null,
      countMismatches: section?.mismatches?.length ?? null,
      hashesCompared: section?.hashesCompared ?? null,
      hashMismatches: section?.hashMismatches?.length ?? null,
      hashSkipped: section?.hashSkipped ?? null,
      keyCounts: section?.keyCounts ?? null,
      registry: section?.registry?.status ?? null,
      error: imp.rc === 0 ? undefined : (imp.envelope?.error?.message ?? imp.stderrTail),
    },
    projectId: { source: readProjectId(store.root), restored: readProjectId(target) },
    /** @type {any} */
    reconcile: null,
    list: /** @type {any} */ (null),
  };

  if (store.reconcile && imp.rc === 0) {
    const expectedTasks = countTable(path.join(target, '.cleo', 'tasks.db'), 'tasks');
    const expectedObs = countTable(path.join(target, '.cleo', 'brain.db'), 'brain_observations');
    const before = {
      tasks: countTable(cleoDb, 'tasks_tasks'),
      observations: countTable(cleoDb, 'brain_observations'),
    };
    const rec = runCli(ctx.cli, ['doctor', 'superseded-store', '--reconcile', '--json'], {
      cwd: target,
      env: isolatedEnv,
    });
    result.reconcile = {
      rc: rec.rc,
      durationMs: rec.durationMs,
      before,
      tasks: { expected: expectedTasks, actual: countTable(cleoDb, 'tasks_tasks') },
      observations: {
        expected: expectedObs,
        actual: countTable(cleoDb, 'brain_observations'),
      },
      error: rec.rc === 0 ? undefined : (rec.envelope?.error?.message ?? rec.stderrTail),
    };
  }

  if (imp.rc === 0) {
    const list = runCli(ctx.cli, ['list', '--limit', '0', '--output', 'count'], {
      cwd: target,
      env: isolatedEnv,
    });
    const count = Number(list.stdout);
    result.list = {
      rc: list.rc,
      count: list.rc === 0 && Number.isFinite(count) && list.stdout !== '' ? count : null,
      error: list.rc === 0 ? undefined : list.stderrTail.slice(-400),
      note: 'informational only (claude-todo list defect T12346); counts are the assertion',
    };
  }

  const failures = evaluateStore(result);
  return { ...result, ok: failures.length === 0, failures };
}

/**
 * Run the gate.
 *
 * @param {string[]} argv - Arguments after the script path.
 * @returns {number} Process exit code.
 */
export function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, usageError: String(err) })}\n`);
    return 2;
  }
  if (!fs.existsSync(opts.cli)) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, usageError: `CLI not built: ${opts.cli} (run pnpm run build)` })}\n`,
    );
    return 2;
  }
  fs.mkdirSync(opts.work, { recursive: true });
  const startedAt = new Date().toISOString();
  const stores = opts.stores.map((s) => runStore(s, opts));
  const ok = stores.every((s) => s.ok);
  const summary = {
    ok,
    startedAt,
    finishedAt: new Date().toISOString(),
    cli: opts.cli,
    work: opts.work,
    stores,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!opts.keep) fs.rmSync(opts.work, { recursive: true, force: true });
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
