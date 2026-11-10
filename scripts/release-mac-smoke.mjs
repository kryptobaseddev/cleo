#!/usr/bin/env node
/**
 * Release smoke on the owner's Mac (T14104, T14250): the BUILT CLI of one
 * commit, run against a fresh copy of real stores in a sandboxed HOME.
 *
 * Release never waits on GitHub macOS runners (the free plan runs five macOS
 * jobs at once, and the release preflight spent ~75 min queued on them).
 * macOS unit tests run nightly and on demand in macos-main.yml; this command
 * is the release-time check that the built CLI opens, migrates and writes a
 * real store, the failure v2026.10.10 shipped (orphan view + RENAME). Each
 * durability phase runs it before its stable cut (T14250): a non-zero exit
 * blocks the cut.
 *
 *   node scripts/release-mac-smoke.mjs [--sha <commit>] [--skip-build] [--out <dir>]
 *     [--cleo-home <dir>] [--project <dir>]... [--record <taskId>]
 *
 * 1. Refuses unless HEAD is `--sha` (default: HEAD) and the tree is clean, so
 *    the evidence names the exact commit that was built.
 * 2. Builds through `cleo run --wait --class full-build -- pnpm run build`.
 * 3. For each project (`--project`, repeatable; default: the checkout's owning
 *    project), snapshots its store, docs blobs and attachments and the global
 *    store into a sandbox: a READ-ONLY connection, `VACUUM INTO` a staged
 *    file, then a rename, as `cleo backup add` does, but outside both rotating
 *    backup windows. Never through the built CLI: an unreleased build must not
 *    open a real store (the T12687 guard refuses it, and a migration there is
 *    exactly the risk this smoke exists to catch). HOME, CLEO_HOME and every
 *    provider home then point under the sandbox (scripts/lib/sandbox-env.mjs),
 *    so the commands only open the copies. The copy's test commands are
 *    replaced by one that exits {@link DISABLED_TEST_EXIT}, so no step can
 *    start a test suite.
 * 4. Runs {@link SMOKE_STEPS} with the built CLI, keeping each step's stdout,
 *    stderr and exit code, and writes `results.json` (commands, stores, CLI
 *    version, result) + `SHA256SUMS`. `--record <taskId>` attaches
 *    `results.json` to that task with the INSTALLED cleo.
 *
 * Exit 0 only when every step passes. No vitest suite runs here.
 *
 * @task T14104
 * @task T14250
 * @epic T14099
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';
import { sandboxEnvironment } from './lib/sandbox-env.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Exit code of the copy's test command; a step that starts a suite fails with it. */
export const DISABLED_TEST_EXIT = 97;

/** stderr text that means the copy did not open or migrate cleanly, whatever the exit code. */
const STORE_FAILURE =
  /no such table|error in view|database disk image is malformed|migration\S* fail/i;

/**
 * A smoke step. `argv` may name `{var}` placeholders filled from earlier
 * steps' `save` pointers (dot paths into the stdout envelope); `check`
 * returns a failure message or null; `okExits` defaults to `[0]`.
 *
 * @typedef {{
 *   argv: string[],
 *   save?: Record<string, string>,
 *   check?: (envelope: {data?: object}) => string|null,
 *   okExits?: number[],
 *   timeoutMs?: number,
 * }} SmokeStep
 */

/**
 * Steps the smoke runs, in order: reads across every domain, then a session
 * and the write paths each durability phase changes (a cancel cascade, the
 * settled-children `done --plan`, a docs fetch, an admission report). The
 * write path is where a broken migration shows.
 *
 * @type {readonly SmokeStep[]}
 */
export const SMOKE_STEPS = Object.freeze([
  { argv: ['--version'], save: { cliVersion: 'data.version' } },
  { argv: ['session', 'status'] },
  { argv: ['briefing'] },
  { argv: ['current'] },
  { argv: ['next'] },
  { argv: ['list', '--limit', '5'] },
  { argv: ['find', 'release'] },
  // The newest doc with a slug is fetched below: blobs and attachments are copied.
  { argv: ['docs', 'list', '--limit', '20'], save: { docSlug: 'data.attachments.*.slug' } },
  { argv: ['memory', 'find', 'release'] },
  { argv: ['nexus', 'status'] },
  { argv: ['doctor'] },
  // The copy holds other agents' active sessions, hence --agent; the session
  // id it prints binds every later call (CLEO_SESSION_ID).
  {
    argv: [
      'session',
      'start',
      '--scope',
      'global',
      '--name',
      'release-mac-smoke',
      '--agent',
      'release-mac-smoke',
    ],
    save: { CLEO_SESSION_ID: 'data.id' },
  },
  // A saga is the one root the strict spine allows (T11811).
  {
    argv: ['add', 'release-mac-smoke probe', '--type', 'saga', '--acceptance', 'smoke write path'],
    save: { saga: 'data.created.0' },
  },
  // Cancel cascade: cancelling an epic cancels its open child.
  {
    argv: [
      'add',
      'smoke cascade epic',
      '--type',
      'epic',
      '--parent',
      '{saga}',
      '--acceptance',
      'smoke',
    ],
    save: { cascadeEpic: 'data.created.0' },
  },
  {
    argv: ['add', 'smoke cascade child', '--parent', '{cascadeEpic}', '--acceptance', 'smoke'],
    save: { cascadeChild: 'data.created.0' },
  },
  { argv: ['cancel', '{cascadeEpic}', '--children', 'cascade', '--reason', 'release smoke'] },
  {
    argv: ['show', '{cascadeChild}'],
    check: (e) =>
      e.data?.task?.status === 'cancelled'
        ? null
        : `cascade left the child ${e.data?.task?.status ?? 'unreadable'}`,
  },
  // done --plan on an epic whose only child is settled (cancelled): the
  // rollup counts it as settled, so no epic-rollup blocker remains (T14266),
  // while the undelivered child still needs its audited waiver, reported as
  // its own cancelled-child-waiver blocker (T14426).
  {
    argv: [
      'add',
      'smoke settled epic',
      '--type',
      'epic',
      '--parent',
      '{saga}',
      '--acceptance',
      'smoke',
    ],
    save: { settledEpic: 'data.created.0' },
  },
  {
    argv: ['add', 'smoke settled child', '--parent', '{settledEpic}', '--acceptance', 'smoke'],
    save: { settledChild: 'data.created.0' },
  },
  { argv: ['cancel', '{settledChild}', '--reason', 'release smoke'] },
  {
    argv: ['done', '{settledEpic}', '--plan'],
    check: (e) => {
      const blockers = e.data?.blockers ?? [];
      const rollup = blockers.find((b) => b.code === 'epic-rollup');
      if (rollup) return `settled child still blocks the epic: ${rollup.message}`;
      return blockers.some((b) => b.code === 'cancelled-child-waiver')
        ? null
        : 'the cancelled child was closed over without a cancelled-child-waiver blocker';
    },
  },
  {
    argv: ['docs', 'fetch', '{docSlug}'],
    check: (e) => (e.data ? null : 'docs fetch returned no document'),
  },
  // Admission: the report names the wait; 75 is a deferral, not a failure.
  {
    argv: ['run', '--wait', '--timeout', '120', '--class', 'build', '--', 'node', '-e', '0'],
    okExits: [0, 75],
  },
  // session end snapshots the 1+ GB store copy into its backup rotation.
  { argv: ['session', 'end', '--note', 'release-mac-smoke'], timeoutMs: 900_000 },
]);

/**
 * Parse argv.
 *
 * @param {string[]} argv - Arguments after the script path.
 * @returns {{sha: string|null, skipBuild: boolean, out: string|null, cleoHome: string|null, projects: string[], record: string|null}}
 */
export function parseArgs(argv) {
  const opts = {
    sha: null,
    skipBuild: false,
    out: null,
    cleoHome: null,
    projects: [],
    record: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sha') opts.sha = argv[++i] ?? null;
    else if (a === '--out') opts.out = argv[++i] ?? null;
    else if (a === '--cleo-home') opts.cleoHome = argv[++i] ?? null;
    else if (a === '--project') opts.projects.push(resolve(argv[++i] ?? '.'));
    else if (a === '--record') opts.record = argv[++i] ?? null;
    else if (a === '--skip-build') opts.skipBuild = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

/**
 * `VACUUM INTO` a staged file from a read-only connection, then rename it into
 * place; a failed copy leaves nothing behind.
 *
 * @param {string} src - Live SQLite store.
 * @param {string} dest - Snapshot path.
 */
export function snapshotStore(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const staged = `${dest}.tmp`;
  // Read-only: no checkpoint, no schema change; VACUUM INTO reads the WAL too.
  const db = new DatabaseSync(src, { readOnly: true }); // db-open-allowed: read-only snapshot source (T14104)
  try {
    db.exec(`VACUUM INTO '${staged.replace(/'/g, "''")}'`);
    renameSync(staged, dest);
  } catch (err) {
    rmSync(staged, { force: true });
    throw err;
  } finally {
    db.close();
  }
}

/**
 * Write the copy's `project-context.json` with both test commands replaced by
 * one that exits {@link DISABLED_TEST_EXIT}, so `done` and `verify` can never
 * start a suite from the sandbox.
 *
 * @param {string} src - The real project's `project-context.json` (may be missing).
 * @param {string} dest - The copy's `project-context.json`.
 */
export function neutralizeTesting(src, dest) {
  const ctx = existsSync(src) ? JSON.parse(readFileSync(src, 'utf8')) : {};
  const disabled = `node -e "process.exit(${DISABLED_TEST_EXIT})"`;
  ctx.testing = { ...ctx.testing, command: disabled, affectedCommand: disabled };
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, `${JSON.stringify(ctx, null, 2)}\n`);
}

/** Clone on APFS (instant, no extra space); plain copy elsewhere. */
function cloneFile(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to, constants.COPYFILE_FICLONE);
}

/**
 * Copy a project's `.cleo` state into the sandbox project: the stores by
 * read-only snapshot, the content-addressed files by clone, the identity and
 * config files as they are, the test commands neutralised.
 *
 * @param {string} projectCleo - The real project's `.cleo` directory.
 * @param {string} copyCleo - The sandbox project's `.cleo` directory.
 */
export function copyProjectState(projectCleo, copyCleo) {
  snapshotStore(join(projectCleo, 'cleo.db'), join(copyCleo, 'cleo.db'));
  for (const db of ['blobs/manifest.db', 'attachments/index.db']) {
    if (existsSync(join(projectCleo, db))) snapshotStore(join(projectCleo, db), join(copyCleo, db));
  }
  for (const dir of ['blobs/blobs', 'attachments/sha256']) {
    if (existsSync(join(projectCleo, dir))) {
      cpSync(join(projectCleo, dir), join(copyCleo, dir), {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
      });
    }
  }
  for (const name of ['config.json', 'project-info.json', 'project.json', 'project-id']) {
    const src = join(projectCleo, name);
    if (existsSync(src)) cloneFile(src, join(copyCleo, name));
  }
  neutralizeTesting(
    join(projectCleo, 'project-context.json'),
    join(copyCleo, 'project-context.json'),
  );
}

/** Read a dot path (`*` = first array element that has the rest) from a value. */
function pick(value, path) {
  const [head, ...rest] = path.split('.');
  if (value === null || value === undefined) return undefined;
  if (head === '*') {
    for (const item of Array.isArray(value) ? value : []) {
      const found = pick(item, rest.join('.'));
      if (found !== undefined && found !== null) return found;
    }
    return undefined;
  }
  return rest.length === 0 ? value[head] : pick(value[head], rest.join('.'));
}

function parseEnvelope(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Run the steps against one sandbox project, writing each step's stdout and
 * stderr under `out`.
 *
 * @param {{cli: string, env: NodeJS.ProcessEnv, cwd: string, out: string, steps?: readonly SmokeStep[]}} opts
 * @returns {{vars: Record<string, string>, results: Array<{argv: string[], exit: number|string, ok: boolean, error: string|null, ms: number}>}}
 */
export function runSteps({ cli, env, cwd, out, steps = SMOKE_STEPS }) {
  mkdirSync(out, { recursive: true });
  const vars = {};
  const results = [];
  for (const [i, step] of steps.entries()) {
    const missing = step.argv.flatMap((a) => [...a.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
    const unbound = missing.filter((v) => vars[v] === undefined);
    const argv = step.argv.map((a) => a.replace(/\{(\w+)\}/g, (_, v) => vars[v] ?? ''));
    if (unbound.length > 0) {
      results.push({
        argv: ['cleo', ...argv],
        exit: 'skipped',
        ok: false,
        error: `no ${unbound.join(', ')} from an earlier step`,
        ms: 0,
      });
      console.error(`FAIL cleo ${argv.join(' ')} (no ${unbound.join(', ')})`);
      continue;
    }
    const started = Date.now();
    const r = spawnSync(process.execPath, [cli, ...argv], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: step.timeoutMs ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const stem = String(i + 1).padStart(2, '0');
    writeFileSync(join(out, `${stem}.stdout`), r.stdout ?? '');
    writeFileSync(join(out, `${stem}.stderr`), r.stderr ?? '');
    const exit = r.status ?? (r.signal ? `signal ${r.signal}` : 'error');
    const envelope = parseEnvelope(r.stdout ?? '');
    let error = null;
    if (!(step.okExits ?? [0]).includes(exit)) error = `exit ${exit}`;
    else if (STORE_FAILURE.test(r.stderr ?? '')) error = (r.stderr.match(STORE_FAILURE) ?? [])[0];
    else if (envelope?.success === false)
      error = envelope.error?.message ?? 'envelope success:false';
    else if (step.check) error = step.check(envelope ?? {});
    if (error === null && envelope) {
      for (const [name, path] of Object.entries(step.save ?? {})) {
        const value = pick(envelope, path);
        if (value !== undefined && value !== null) vars[name] = String(value);
      }
    }
    if (vars.CLEO_SESSION_ID) env.CLEO_SESSION_ID = vars.CLEO_SESSION_ID;
    results.push({
      argv: ['cleo', ...argv],
      exit,
      ok: error === null,
      error,
      ms: Date.now() - started,
    });
    console.error(
      `${error === null ? 'ok  ' : 'FAIL'} cleo ${argv.join(' ')}${error ? ` (${error})` : ''}`,
    );
  }
  return { vars, results };
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Copy each project's stores into its own sandbox, run the steps with `cli`,
 * and write `results.json` + `SHA256SUMS` to `out`. Needs no build, platform
 * or git state, so the scripts tests drive it with fixture stores.
 *
 * @param {{cli: string, projects: string[], globalDb: string, out: string, sha?: string}} opts
 * @returns {{passed: boolean, receipt: object}}
 */
export function smokeStores({ cli, projects, globalDb, out, sha = null }) {
  mkdirSync(out, { recursive: true });
  const runs = [];
  for (const projectDir of projects) {
    const sandbox = mkdtempSync(join(tmpdir(), 'cleo-mac-smoke-'));
    try {
      const env = sandboxEnvironment(sandbox);
      // The copies may need a migration from this build; only sandbox stores are opened (T12687).
      env.CLEO_ALLOW_WORKTREE_BUILD_MIGRATIONS = '1';
      const projectCleo = join(projectDir, '.cleo');
      let run;
      try {
        copyProjectState(projectCleo, join(env.CLEO_ROOT, '.cleo'));
        snapshotStore(globalDb, join(env.CLEO_HOME, 'cleo.db'));
        run = runSteps({ cli, env, cwd: env.CLEO_ROOT, out: join(out, basename(projectDir)) });
      } catch (err) {
        run = {
          vars: {},
          results: [
            { argv: ['copy', projectCleo], exit: 'error', ok: false, error: String(err), ms: 0 },
          ],
        };
      }
      runs.push({
        project: projectDir,
        store: join(projectCleo, 'cleo.db'),
        storeBytes: existsSync(join(projectCleo, 'cleo.db'))
          ? statSync(join(projectCleo, 'cleo.db')).size
          : null,
        cliVersion: run.vars.cliVersion ?? null,
        passed: run.results.every((r) => r.ok),
        commands: run.results,
      });
    } finally {
      // The store copies are gigabytes; the evidence directory keeps the results.
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
  const passed = runs.length > 0 && runs.every((r) => r.passed);
  const receipt = {
    sha,
    cliVersion: runs.find((r) => r.cliVersion)?.cliVersion ?? null,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    globalStore: globalDb,
    result: passed ? 'pass' : 'fail',
    passed,
    projects: runs,
  };
  writeFileSync(join(out, 'results.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  const files = [
    'results.json',
    ...runs.flatMap((r) =>
      r.commands.flatMap((_, i) => {
        const stem = String(i + 1).padStart(2, '0');
        return [`${stem}.stdout`, `${stem}.stderr`].map((f) => join(basename(r.project), f));
      }),
    ),
  ].filter((f) => existsSync(join(out, f)));
  writeFileSync(
    join(out, 'SHA256SUMS'),
    files.map((f) => `${sha256(join(out, f))}  ${f}\n`).join(''),
  );
  return { passed, receipt };
}

/**
 * Run the smoke and write the evidence directory.
 *
 * @param {ReturnType<typeof parseArgs>} opts
 * @returns {number} Process exit code.
 */
export function runSmoke(opts) {
  if (process.platform !== 'darwin') {
    console.error('release-mac-smoke: run this on the owner’s Mac (darwin only).');
    return 2;
  }
  const head = git(['rev-parse', 'HEAD']);
  const sha = opts.sha ? git(['rev-parse', opts.sha]) : head;
  if (sha !== head) {
    console.error(
      `release-mac-smoke: HEAD is ${head}, not ${sha}. Check out the release commit first.`,
    );
    return 2;
  }
  if (git(['status', '--porcelain', '--untracked-files=no']) !== '') {
    console.error(
      'release-mac-smoke: the tree has uncommitted changes; the build would not be that commit.',
    );
    return 2;
  }
  if (!opts.skipBuild) {
    const build = spawnSync(
      'cleo',
      ['run', '--wait', '--class', 'full-build', '--', 'pnpm', 'run', 'build'],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    );
    if (build.status !== 0) {
      console.error(`release-mac-smoke: build exited ${build.status}.`);
      return build.status ?? 1;
    }
  }

  // The owning project: a worktree's git common dir names its main checkout.
  const projects =
    opts.projects.length > 0
      ? opts.projects
      : [dirname(git(['rev-parse', '--path-format=absolute', '--git-common-dir']))];
  const cleoHome =
    opts.cleoHome ??
    process.env.CLEO_HOME ??
    join(homedir(), 'Library', 'Application Support', 'cleo');
  const out = resolve(opts.out ?? join(REPO_ROOT, '.cleo', 'release-smoke', sha.slice(0, 12)));
  const { passed } = smokeStores({
    cli: join(REPO_ROOT, 'packages', 'cleo', 'dist', 'cli', 'index.js'),
    projects,
    globalDb: join(cleoHome, 'cleo.db'),
    out,
    sha,
  });
  console.error(
    passed
      ? `release-mac-smoke: PASSED for ${sha}; evidence in ${out}`
      : `release-mac-smoke: FAILED for ${sha}; do not cut stable. Evidence in ${out}`,
  );
  if (opts.record) {
    // The INSTALLED cleo records the receipt in the real store; the build under test never opens it.
    const rec = spawnSync(
      'cleo',
      [
        'docs',
        'add',
        opts.record,
        join(out, 'results.json'),
        '--labels',
        'release-smoke',
        '--desc',
        `release smoke ${sha.slice(0, 12)}: ${passed ? 'pass' : 'fail'}`,
      ],
      { cwd: REPO_ROOT, stdio: 'inherit' },
    );
    if (rec.status !== 0)
      console.error(`release-mac-smoke: recording on ${opts.record} exited ${rec.status}.`);
  }
  return passed ? 0 : 1;
}

if (isMain(import.meta.url)) {
  process.exit(runSmoke(parseArgs(process.argv.slice(2))));
}
