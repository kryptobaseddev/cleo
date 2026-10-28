#!/usr/bin/env node
/**
 * Release smoke on the owner's Mac (T14104): the BUILT CLI of one commit,
 * run against a fresh copy of the real stores in a sandboxed HOME.
 *
 * Release never waits on GitHub macOS runners (the free plan runs five macOS
 * jobs at once, and the release preflight spent ~75 min queued on them).
 * macOS unit tests run nightly and on demand in macos-main.yml; this command
 * is the release-time check that the built CLI opens, migrates and writes a
 * real store on macOS, the failure v2026.10.10 shipped (orphan view + RENAME).
 *
 *   node scripts/release-mac-smoke.mjs [--sha <commit>] [--skip-build] [--out <dir>] [--cleo-home <dir>]
 *
 * 1. Refuses unless HEAD is `--sha` (default: HEAD) and the tree is clean, so
 *    the evidence names the exact commit that was built.
 * 2. Builds through `cleo run --wait --class full-build -- pnpm run build`.
 * 3. Snapshots the real project store (the checkout's owning project) and the
 *    global store into the sandbox: a READ-ONLY connection, `VACUUM INTO` a
 *    staged file, then a rename, as `cleo backup add` does, but outside both
 *    rotating backup windows. Never through the built CLI: an unreleased
 *    build must not open a real store (the T12687 guard refuses it, and a
 *    migration there is exactly the risk this smoke exists to catch). HOME,
 *    CLEO_HOME and every provider home then point under the sandbox
 *    (scripts/lib/sandbox-env.mjs), so the commands only open the copies.
 * 4. Runs {@link SMOKE_COMMANDS} with the built CLI, keeping each command's
 *    stdout, stderr and exit code, and writes `results.json` + `SHA256SUMS`.
 *
 * Exit 0 only when every command exits 0. No vitest suite runs here.
 *
 * @task T14104
 * @epic T14099
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';
import { sandboxEnvironment } from './lib/sandbox-env.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * CLI calls the smoke runs, in order: reads across every domain, then a
 * session, a task write and a session end (the write path is where a broken
 * migration shows).
 */
export const SMOKE_COMMANDS = Object.freeze([
  ['--version'],
  ['session', 'status'],
  ['briefing'],
  ['current'],
  ['next'],
  ['list', '--limit', '5'],
  ['find', 'release'],
  ['docs', 'list'],
  ['memory', 'find', 'release'],
  ['nexus', 'status'],
  ['doctor'],
  // The copy holds other agents' active sessions, hence --agent; the session
  // id it prints binds the next two calls (CLEO_SESSION_ID).
  [
    'session',
    'start',
    '--scope',
    'global',
    '--name',
    'release-mac-smoke',
    '--agent',
    'release-mac-smoke',
  ],
  // A saga is the one root the strict spine allows (T11811).
  ['add', 'release-mac-smoke probe', '--type', 'saga', '--acceptance', 'smoke write path'],
  ['session', 'end', '--note', 'release-mac-smoke'],
]);

/**
 * Parse argv.
 *
 * @param {string[]} argv - Arguments after the script path.
 * @returns {{sha: string|null, skipBuild: boolean, out: string|null, cleoHome: string|null}}
 */
export function parseArgs(argv) {
  const opts = { sha: null, skipBuild: false, out: null, cleoHome: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sha') opts.sha = argv[++i] ?? null;
    else if (a === '--out') opts.out = argv[++i] ?? null;
    else if (a === '--cleo-home') opts.cleoHome = argv[++i] ?? null;
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
 * The real stores this checkout belongs to: the owning project's `.cleo/`
 * (a worktree's git common dir names its main checkout) and the global store
 * (`--cleo-home`, `$CLEO_HOME`, else the macOS default).
 *
 * @param {string|null} cleoHome - Override for the global store's directory.
 * @returns {{projectCleo: string, globalDb: string}}
 */
function realStores(cleoHome) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const projectCleo = join(dirname(common), '.cleo');
  const home =
    cleoHome ?? process.env.CLEO_HOME ?? join(homedir(), 'Library', 'Application Support', 'cleo');
  return { projectCleo, globalDb: join(home, 'cleo.db') };
}

/** Clone on APFS (instant, no extra space); plain copy elsewhere. */
function cloneFile(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to, constants.COPYFILE_FICLONE);
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Run the smoke and write the evidence directory.
 *
 * @param {{sha: string|null, skipBuild: boolean, out: string|null, cleoHome: string|null}} opts
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

  const sandbox = mkdtempSync(join(tmpdir(), 'cleo-mac-smoke-'));
  const env = sandboxEnvironment(sandbox);
  // The copies may need a migration from this build; only sandbox stores are opened (T12687).
  env.CLEO_ALLOW_WORKTREE_BUILD_MIGRATIONS = '1';
  const cli = join(REPO_ROOT, 'packages', 'cleo', 'dist', 'cli', 'index.js');
  const real = realStores(opts.cleoHome);
  const project = env.CLEO_ROOT;
  snapshotStore(join(real.projectCleo, 'cleo.db'), join(project, '.cleo', 'cleo.db'));
  snapshotStore(real.globalDb, join(env.CLEO_HOME, 'cleo.db'));
  for (const name of ['config.json', 'project-info.json']) {
    const src = join(real.projectCleo, name);
    if (existsSync(src)) cloneFile(src, join(project, '.cleo', name));
  }
  cloneFile(join(REPO_ROOT, '.cleo', 'project.json'), join(project, '.cleo', 'project.json'));

  const out = resolve(opts.out ?? join(REPO_ROOT, '.cleo', 'release-smoke', sha.slice(0, 12)));
  mkdirSync(out, { recursive: true });
  const results = [];
  for (const [i, argv] of SMOKE_COMMANDS.entries()) {
    const started = Date.now();
    const r = spawnSync(process.execPath, [cli, ...argv], {
      cwd: project,
      env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const stem = String(i + 1).padStart(2, '0');
    writeFileSync(join(out, `${stem}.stdout`), r.stdout ?? '');
    writeFileSync(join(out, `${stem}.stderr`), r.stderr ?? '');
    const exit = r.status ?? (r.signal ? `signal ${r.signal}` : 'error');
    if (argv[0] === 'session' && argv[1] === 'start' && exit === 0) {
      env.CLEO_SESSION_ID = JSON.parse(r.stdout).data.id;
    }
    results.push({ argv: ['cleo', ...argv], exit, ms: Date.now() - started });
    console.error(`${exit === 0 ? 'ok  ' : 'FAIL'} cleo ${argv.join(' ')} (exit ${exit})`);
  }
  const passed = results.every((r) => r.exit === 0);
  writeFileSync(
    join(out, 'results.json'),
    `${JSON.stringify(
      {
        sha,
        platform: `${process.platform}-${process.arch}`,
        node: process.version,
        stores: real,
        sandbox,
        passed,
        commands: results,
      },
      null,
      2,
    )}\n`,
  );
  const files = [
    'results.json',
    ...results.flatMap((_, i) => {
      const stem = String(i + 1).padStart(2, '0');
      return [`${stem}.stdout`, `${stem}.stderr`];
    }),
  ];
  writeFileSync(
    join(out, 'SHA256SUMS'),
    files.map((f) => `${sha256(join(out, f))}  ${f}\n`).join(''),
  );
  console.error(
    `release-mac-smoke: ${passed ? 'PASSED' : 'FAILED'} for ${sha}; evidence in ${out}`,
  );
  return passed ? 0 : 1;
}

if (isMain(import.meta.url)) {
  process.exit(runSmoke(parseArgs(process.argv.slice(2))));
}
