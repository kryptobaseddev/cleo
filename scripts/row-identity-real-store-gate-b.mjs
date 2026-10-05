#!/usr/bin/env node
/**
 * Real-store Gate B for row identity (T12341 · T12749).
 *
 * T12749 keeps `CLEO_ROW_UID_FILL` off by default until Gate B of the CURRENT
 * recipe passes on the real stores and is recorded in the spec. This script
 * runs that Gate B on a BACKUP of one store. It never opens a live store: the
 * operator makes the backup with the installed CLI, in the project, through
 * the store's own chokepoint (`cleo backup add --destination <dir>`, a
 * `VACUUM INTO`), and passes the backup file here.
 *
 * For one backup it builds four independent copies under `--work`, each in
 * its own project directory, and opens each through this build's runtime path
 * (`openDualScopeDb`) in a child process with a sandboxed HOME/CLEO_HOME:
 *
 * - `base`: fill OFF (the default). Every migration applies, the identity
 *   schema heals (DDL only), and every identity column stays NULL.
 * - `post-utc`: fill ON, `TZ=UTC`.
 * - `post-utc-2`: fill ON, `TZ=UTC`, a second independent fill.
 * - `post-la`: fill ON, `TZ=America/Los_Angeles`.
 *
 * Each open is followed by a `VACUUM INTO` of the opened store, and the
 * fingerprints are taken on those quiescent files. The checks:
 *
 * 1. replay: `base` vs `post-utc` with `--omit-row-identity` must PASS, so the
 *    fill changes no replicated value;
 * 2. determinism: `post-utc` vs `post-utc-2`, identity hashed, must PASS;
 * 3. timezone: `post-utc` vs `post-la`, identity hashed, must PASS;
 * 4. control: `base` vs `post-utc` WITH identity hashed must FAIL, which
 *    proves the fingerprint sees the identity columns (else 2 and 3 are void);
 * 5. every task of `post-utc` has a uid and a birth fingerprint, and the
 *    fill-off `base` open wrote no identity value (its NULL counts equal the
 *    backup's own, read read-only from the backup copy). The dangling-reference and invariant counts of
 *    `base` and `post-utc` are compared by the comparator (Gate C) in check 1.
 *
 * Usage:
 *
 *   node scripts/row-identity-real-store-gate-b.mjs --label cleocode \
 *     --backup /sandbox/backups/cleocode/cleo-20261004-120000.db \
 *     [--project-id /path/to/project/.cleo/project-id | --project-id-stub] \
 *     --work /sandbox/gate-b --report /sandbox/gate-b/cleocode.json
 *
 * `--project-id` copies a tracked `.cleo/project-id` file beside each copy
 * (the fingerprint binds it under its MAC). `--project-id-stub` writes a fixed
 * stub instead, for a store whose project has none (llmtxt). It needs a built
 * `packages/core/dist` (`pnpm run build`). Exit 0 when every check passes,
 * 1 otherwise.
 *
 * @task T12341
 * @task T12749
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite'; // db-open-allowed: read-only count on a sandbox backup copy
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIST = join(REPO, 'packages', 'core', 'dist');
const FINGERPRINT = join(REPO, 'scripts', 'fingerprint-store.mjs');
const COMPARE = join(REPO, 'scripts', 'compare-fingerprints.mjs');
/** A fixed v4 uuid used only when the source project has no project-id file. */
const PROJECT_ID_STUB = '00000000-0000-4000-8000-000000000001';

const { values } = parseArgs({
  options: {
    label: { type: 'string' },
    backup: { type: 'string' },
    'project-id': { type: 'string' },
    'project-id-stub': { type: 'boolean', default: false },
    work: { type: 'string' },
    report: { type: 'string' },
  },
  strict: true,
});

for (const required of ['label', 'backup', 'work', 'report']) {
  if (!values[required]) {
    process.stderr.write(`row-identity-real-store-gate-b: --${required} is required\n`);
    process.exit(2);
  }
}
if (!values['project-id'] === !values['project-id-stub']) {
  process.stderr.write(
    'row-identity-real-store-gate-b: pass --project-id <file> or --project-id-stub\n',
  );
  process.exit(2);
}
if (!existsSync(join(CORE_DIST, 'store', 'dual-scope-db.js'))) {
  process.stderr.write(
    'row-identity-real-store-gate-b: build first (packages/core/dist missing)\n',
  );
  process.exit(2);
}

const label = values.label;
const work = resolve(values.work, label);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const home = join(work, 'home');
mkdirSync(home, { recursive: true });
const keyFile = join(work, 'compare.key');
writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });

/** The child that opens one copy through the runtime path, then VACUUMs it. */
const OPENER = `
const [coreDist, projectDir, out] = process.argv.slice(1);
const { openDualScopeDb } = await import(new URL('store/dual-scope-db.js', coreDist).href);
const { getDb } = await import(new URL('store/sqlite.js', coreDist).href);
const started = performance.now();
const handle = await openDualScopeDb('project', projectDir);
await getDb(projectDir);
const openMs = Math.round(performance.now() - started);
const native = handle.db.$client;
const q = (sql) => native.prepare(sql).get();
const counts = {
  tasks: q('SELECT COUNT(*) AS n FROM main.tasks_tasks').n,
  tasksNullUid: q('SELECT COUNT(*) AS n FROM main.tasks_tasks WHERE uid IS NULL').n,
  tasksNullBirthFp: q('SELECT COUNT(*) AS n FROM main.tasks_tasks WHERE birth_fp IS NULL').n,
};
native.exec("VACUUM INTO '" + out.replaceAll("'", "''") + "'");
process.stdout.write(JSON.stringify({ openMs, counts }));
process.exit(0);
`;

/**
 * Lay out one copy and open it.
 *
 * @param {string} name - Copy name.
 * @param {{ fill: boolean, tz: string }} opts - Fill flag and timezone.
 * @returns {{ name: string, file: string, openMs: number, counts: Record<string, number> }}
 */
function openCopy(name, { fill, tz }) {
  const projectDir = join(work, name);
  const cleoDir = join(projectDir, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  copyFileSync(resolve(values.backup), join(cleoDir, 'cleo.db'));
  if (values['project-id'])
    copyFileSync(resolve(values['project-id']), join(cleoDir, 'project-id'));
  else writeFileSync(join(cleoDir, 'project-id'), `${PROJECT_ID_STUB}\n`);
  const out = join(work, `${name}.db`);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    CLEO_HOME: join(home, '.cleo'),
    TZ: tz,
    CLEO_ROW_UID_FILL: fill ? '1' : '0',
    // The copy is a sandbox file this build may migrate (T12687 guard).
    CLEO_ALLOW_WORKTREE_BUILD_MIGRATIONS: '1',
    CLEO_LOG_LEVEL: 'silent',
  };
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', OPENER, pathToFileURL(`${CORE_DIST}/`).href, projectDir, out],
    { cwd: projectDir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    throw new Error(`open ${name} failed (exit ${r.status}): ${r.stderr.slice(-2000)}`);
  }
  // The fingerprint reads project-id beside the store file.
  copyFileSync(join(cleoDir, 'project-id'), join(work, 'project-id'));
  const line = r.stdout.trim().split('\n').pop();
  return { name, file: out, ...JSON.parse(line) };
}

/**
 * Identity NULL counts of the backup itself, read-only (no migration, no open
 * pass). A column the backup lacks counts every row as NULL.
 *
 * @param {string} file - The backup file (a sandbox copy).
 * @returns {{ tasks: number, tasksNullUid: number, tasksNullBirthFp: number }}
 */
function rawIdentityCounts(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const cols = new Set(
      db
        .prepare('PRAGMA main.table_info(tasks_tasks)')
        .all()
        .map((c) => String(c.name)),
    );
    const n = (sql) => Number(db.prepare(sql).get().n);
    const tasks = n('SELECT COUNT(*) AS n FROM main.tasks_tasks');
    return {
      tasks,
      tasksNullUid: cols.has('uid')
        ? n('SELECT COUNT(*) AS n FROM main.tasks_tasks WHERE uid IS NULL')
        : tasks,
      tasksNullBirthFp: cols.has('birth_fp')
        ? n('SELECT COUNT(*) AS n FROM main.tasks_tasks WHERE birth_fp IS NULL')
        : tasks,
    };
  } finally {
    db.close();
  }
}

/** Fingerprint one quiescent copy. */
function fingerprint(copy, role, omitIdentity) {
  const out = join(work, 'fp', `${copy.name}${omitIdentity ? '.omit' : ''}.${role}.json`);
  mkdirSync(dirname(out), { recursive: true });
  execFileSync(
    process.execPath,
    [
      FINGERPRINT,
      '--db',
      copy.file,
      '--label',
      `${label}-${copy.name}`,
      '--out',
      out,
      '--role',
      role,
      '--key-file',
      keyFile,
      ...(omitIdentity ? ['--omit-row-identity'] : []),
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out;
}

/** Compare two fingerprints in replay mode. */
function replay(check, source, replica) {
  const r = spawnSync(
    process.execPath,
    [COMPARE, '--source', source, '--replica', replica, '--mode', 'replay', '--key-file', keyFile],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const verdict = (r.stdout.trim().split('\n').pop() ?? '').trim();
  return {
    check,
    pass: r.status === 0,
    verdict,
    findings: r.stdout.split('\n').filter((l) => /^GATE /.test(l)),
  };
}

const base = openCopy('base', { fill: false, tz: 'UTC' });
const postUtc = openCopy('post-utc', { fill: true, tz: 'UTC' });
const postUtc2 = openCopy('post-utc-2', { fill: true, tz: 'UTC' });
const postLa = openCopy('post-la', { fill: true, tz: 'America/Los_Angeles' });

const checks = [
  replay(
    'replay (fill-off vs fill-on, --omit-row-identity)',
    fingerprint(base, 'source', true),
    fingerprint(postUtc, 'replica', true),
  ),
  replay(
    'determinism (two fills, identity hashed)',
    fingerprint(postUtc, 'source', false),
    fingerprint(postUtc2, 'replica', false),
  ),
  replay(
    'timezone (UTC vs America/Los_Angeles, identity hashed)',
    fingerprint(postUtc, 'source', false),
    fingerprint(postLa, 'replica', false),
  ),
];
// Negative control: with identity hashed, the fill-off baseline must NOT
// replay the filled copy. A PASS here would mean the fingerprint does not see
// the identity columns, and checks 2 and 3 would prove nothing.
const control = replay(
  'control (fill-off vs fill-on, identity hashed, must FAIL)',
  fingerprint(base, 'source', false),
  fingerprint(postUtc, 'replica', false),
);
checks.push({ ...control, pass: !control.pass });
const filled = postUtc.counts.tasksNullUid === 0 && postUtc.counts.tasksNullBirthFp === 0;
// The fill-off open must write no identity value: the backup's own NULL counts
// survive it unchanged. (A store a pre-release build once filled, like live
// cleocode, starts with values; a store that never had the fill starts all NULL.)
const raw = rawIdentityCounts(resolve(values.backup));
const baseline =
  base.counts.tasksNullUid === raw.tasksNullUid &&
  base.counts.tasksNullBirthFp === raw.tasksNullBirthFp;
checks.push({
  check: 'fill completeness (no NULL uid or birth_fp on tasks after the fill-on open)',
  pass: filled,
  verdict: JSON.stringify(postUtc.counts),
});
checks.push({
  check: 'fill-off open writes no identity value (NULL counts equal the backup)',
  pass: baseline,
  verdict: JSON.stringify({ backup: raw, base: base.counts }),
});

const report = {
  label,
  backup: resolve(values.backup),
  projectId: values['project-id'] ? 'file' : 'stub',
  build: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
  ranAt: new Date().toISOString(),
  opens: Object.fromEntries(
    [base, postUtc, postUtc2, postLa].map((c) => [c.name, { openMs: c.openMs, counts: c.counts }]),
  ),
  checks,
  pass: checks.every((c) => c.pass),
};
writeFileSync(resolve(values.report), `${JSON.stringify(report, null, 2)}\n`);
for (const c of checks)
  process.stdout.write(`${c.pass ? 'PASS' : 'FAIL'}  ${c.check}: ${c.verdict}\n`);
process.stdout.write(`${report.pass ? 'GATE B PASS' : 'GATE B FAIL'} ${label}\n`);
process.exit(report.pass ? 0 : 1);
