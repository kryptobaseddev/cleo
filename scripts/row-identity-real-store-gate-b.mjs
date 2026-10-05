#!/usr/bin/env node
/**
 * Real-store Gate B for row identity (T12341 · T12749 · T13219 · T13220).
 *
 * T12749 keeps `CLEO_ROW_UID_FILL` off by default until Gate B of the CURRENT
 * recipe passes on the real stores and is recorded in the spec. This script
 * runs that Gate B on a BACKUP of one store. It never opens a live store: the
 * operator makes the backup with the installed CLI, in the project, through
 * the store's own chokepoint (`cleo backup add`, a `VACUUM INTO`), and passes
 * the backup file here. The harness copies it to `<work>/raw.db` first and
 * reads only copies.
 *
 * It builds five independent copies of `raw.db`, each in its own project
 * directory, and opens each through this build's runtime path
 * (`openDualScopeDb`) in a child process with a sandboxed HOME/CLEO_HOME and a
 * timeout:
 *
 * - `base`: fill OFF (the default). Every migration applies and the identity
 *   schema heals (DDL only); no identity value may be written.
 * - `post-utc`: fill ON, `TZ=UTC`.
 * - `post-utc-2`: fill ON, `TZ=UTC`, a second independent fill.
 * - `post-la`: fill ON, `TZ=America/Los_Angeles`.
 * - `scratch`: every identity column of every declared table set to NULL and
 *   the recipe marker removed BEFORE the open, then fill ON, `TZ=UTC`: what a
 *   device that never saw the old values derives.
 *
 * Each open is followed by a `VACUUM INTO` of the opened store; fingerprints
 * and identity statistics are taken on those quiescent files. The checks:
 *
 * 1. replay: `base` vs `post-utc` with `--omit-row-identity` must PASS (the
 *    fill changes no replicated value; Gate C dangling/invariant counts too);
 * 2. determinism: `post-utc` vs `post-utc-2`, identity hashed, must PASS;
 * 3. timezone: `post-utc` vs `post-la`, identity hashed, must PASS;
 * 4. control: `base` vs `post-utc` WITH identity hashed must FAIL, which
 *    proves the fingerprint sees the identity columns (else 2, 3, 5 are void);
 * 5. from scratch (T13219): `scratch` vs `post-utc`, identity hashed, must
 *    PASS, so every value already in the store (a pre-release fill included)
 *    equals what the current recipe derives from nothing. Skipped, with the
 *    reason recorded, when the store's identity has synced
 *    (`row_identity_synced`): its values are then authoritative as received;
 * 6. completeness (T13220): in `post-utc`, no row of ANY declared table lacks
 *    its uid, and no row of a minted table lacks its birth fingerprint (NULL
 *    stored reference facts are reported, not failed: a dangling reference
 *    legitimately keeps one);
 * 7. the fill-off open writes nothing (T13220): for every identity column of
 *    every declared table, the value digest of `base` equals that of `raw.db`.
 *
 * The recipe marker and the shared marker are recorded for `raw.db` and every
 * copy, so a refill (`cleared`) or a refusal (`refused`) is visible.
 *
 * Usage:
 *
 *   node scripts/row-identity-real-store-gate-b.mjs --label cleocode \
 *     --backup /sandbox/backups/cleocode/cleo-20261004-120000.db \
 *     [--project-id /path/to/project/.cleo/project-id | --project-id-stub] \
 *     --work /sandbox/gate-b --report /sandbox/gate-b/cleocode.json \
 *     [--timeout-ms 900000]
 *
 * `--project-id` copies a tracked `.cleo/project-id` file beside each copy
 * (the fingerprint binds it under its MAC). `--project-id-stub` writes a fixed
 * stub instead, for a store whose project has none (llmtxt). It needs a built
 * `packages/core/dist` (`pnpm run build`). Exit 0 when every check passes,
 * 1 otherwise.
 *
 * @task T12341
 * @task T12749
 * @task T13219
 * @task T13220
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite'; // db-open-allowed: sandbox copies only (raw.db, vacuumed copies, the scratch prep)
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BIRTH_FP_COLUMN,
  ROW_IDENTITY,
  rowIdentityColumns,
  UID_COLUMN,
} from '../packages/core/src/store/row-identity-registry.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIST = join(REPO, 'packages', 'core', 'dist');
const FINGERPRINT = join(REPO, 'scripts', 'fingerprint-store.mjs');
const COMPARE = join(REPO, 'scripts', 'compare-fingerprints.mjs');
/** A fixed v4 uuid used only when the source project has no project-id file. */
const PROJECT_ID_STUB = '00000000-0000-4000-8000-000000000001';
const META_TABLE = 'tasks_row_identity_meta';
const RECIPE_KEY = 'row_identity_recipe';
const SYNCED_KEY = 'row_identity_synced';

const { values } = parseArgs({
  options: {
    label: { type: 'string' },
    backup: { type: 'string' },
    'project-id': { type: 'string' },
    'project-id-stub': { type: 'boolean', default: false },
    work: { type: 'string' },
    report: { type: 'string' },
    'timeout-ms': { type: 'string', default: '900000' },
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
const timeoutMs = Number(values['timeout-ms']);

const label = values.label;
const work = resolve(values.work, label);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const home = join(work, 'home');
mkdirSync(home, { recursive: true });
const keyFile = join(work, 'compare.key');
writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });

// Every read below is of a copy: the operator's backup file is copied once.
const raw = join(work, 'raw.db');
copyFileSync(resolve(values.backup), raw);

/** The child that opens one copy through the runtime path, then VACUUMs it. */
const OPENER = `
const [coreDist, projectDir, out] = process.argv.slice(1);
const { openDualScopeDb } = await import(new URL('store/dual-scope-db.js', coreDist).href);
const { getDb } = await import(new URL('store/sqlite.js', coreDist).href);
const started = performance.now();
const handle = await openDualScopeDb('project', projectDir);
await getDb(projectDir);
const openMs = Math.round(performance.now() - started);
handle.db.$client.exec("VACUUM INTO '" + out.replaceAll("'", "''") + "'");
process.stdout.write(JSON.stringify({ openMs }));
process.exit(0);
`;

/** Whether `table` exists in `db`. */
function hasTable(db, table) {
  return (
    db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

/** Column names of `table`. */
function columnsOf(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA main.table_info("${table}")`)
      .all()
      .map((c) => String(c.name)),
  );
}

/** A value read from the identity meta table, or `null`. */
function readMeta(db, key) {
  if (!hasTable(db, META_TABLE)) return null;
  const row = db.prepare(`SELECT value FROM main.${META_TABLE} WHERE key = ?`).get(key);
  return row ? String(row.value) : null;
}

/**
 * Per declared table and identity column: row count, NULL count and a digest
 * of the values keyed by the row's primary key (or rowid). A column the store
 * lacks reads as NULL on every row, so a DDL-only heal leaves its digest equal.
 *
 * @param {string} file - A sandbox copy, opened read-only.
 */
function identityStats(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = {};
    for (const spec of ROW_IDENTITY.project) {
      if (!hasTable(db, spec.table)) continue;
      const cols = columnsOf(db, spec.table);
      const pk = db
        .prepare(`PRAGMA main.table_info("${spec.table}")`)
        .all()
        .filter((c) => Number(c.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((c) => `quote("${c.name}")`);
      const key = pk.length > 0 ? pk.join(" || '|' || ") : 'rowid';
      const order = pk.length > 0 ? pk.join(', ') : 'rowid';
      const rows = Number(db.prepare(`SELECT COUNT(*) AS n FROM main."${spec.table}"`).get().n);
      const columns = {};
      for (const column of rowIdentityColumns('project', spec.table)) {
        const present = cols.has(column);
        const value = present ? `quote("${column}")` : `'NULL'`;
        const nulls = present
          ? Number(
              db
                .prepare(`SELECT COUNT(*) AS n FROM main."${spec.table}" WHERE "${column}" IS NULL`)
                .get().n,
            )
          : rows;
        const hash = createHash('sha256');
        for (const r of db
          .prepare(`SELECT ${key} AS k, ${value} AS v FROM main."${spec.table}" ORDER BY ${order}`)
          .iterate()) {
          hash.update(`${r.k}\t${r.v}\n`);
        }
        columns[column] = { nulls, digest: hash.digest('hex') };
      }
      tables[spec.table] = { kind: spec.kind, rows, columns };
    }
    return { tables, recipe: readMeta(db, RECIPE_KEY), synced: readMeta(db, SYNCED_KEY) };
  } finally {
    db.close();
  }
}

/**
 * Set every identity column of every declared table to NULL and remove the
 * recipe marker, on a sandbox copy (the `scratch` preparation). Owned triggers
 * are suspended for the duration through `cleo_trigger_suspend`.
 *
 * @param {string} file - The copy to prepare.
 */
function nullIdentity(file) {
  const db = new DatabaseSync(file);
  try {
    const suspend = hasTable(db, 'cleo_trigger_suspend');
    if (suspend) db.exec("INSERT OR IGNORE INTO main.cleo_trigger_suspend (scope) VALUES ('all')");
    db.exec('BEGIN');
    for (const spec of ROW_IDENTITY.project) {
      if (!hasTable(db, spec.table)) continue;
      const cols = columnsOf(db, spec.table);
      const present = rowIdentityColumns('project', spec.table).filter((c) => cols.has(c));
      if (present.length === 0) continue;
      db.exec(`UPDATE main."${spec.table}" SET ${present.map((c) => `"${c}" = NULL`).join(', ')}`);
    }
    if (hasTable(db, META_TABLE)) {
      db.prepare(`DELETE FROM main.${META_TABLE} WHERE key = ?`).run(RECIPE_KEY);
    }
    db.exec('COMMIT');
    if (suspend) db.exec("DELETE FROM main.cleo_trigger_suspend WHERE scope = 'all'");
  } finally {
    db.close();
  }
}

/**
 * Lay out one copy, optionally prepare it, and open it.
 *
 * @param {string} name - Copy name.
 * @param {{ fill: boolean, tz: string, prepare?: (file: string) => void }} opts
 * @returns {{ name: string, file: string, openMs: number }}
 */
function openCopy(name, { fill, tz, prepare }) {
  const projectDir = join(work, name);
  const cleoDir = join(projectDir, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  copyFileSync(raw, join(cleoDir, 'cleo.db'));
  prepare?.(join(cleoDir, 'cleo.db'));
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
    { cwd: projectDir, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs },
  );
  if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM') {
    throw new Error(`open ${name} timed out after ${timeoutMs} ms`);
  }
  if (r.status !== 0) {
    throw new Error(`open ${name} failed (exit ${r.status}): ${(r.stderr ?? '').slice(-2000)}`);
  }
  // The fingerprint reads project-id beside the store file.
  copyFileSync(join(cleoDir, 'project-id'), join(work, 'project-id'));
  const line = r.stdout.trim().split('\n').pop();
  return { name, file: out, ...JSON.parse(line) };
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
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs },
  );
  return out;
}

/** Compare two fingerprints in replay mode. */
function replay(check, source, replica) {
  const r = spawnSync(
    process.execPath,
    [COMPARE, '--source', source, '--replica', replica, '--mode', 'replay', '--key-file', keyFile],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs },
  );
  const verdict = (r.stdout.trim().split('\n').pop() ?? '').trim();
  return {
    check,
    pass: r.status === 0,
    verdict,
    findings: r.stdout.split('\n').filter((l) => /^GATE /.test(l)),
  };
}

const checks = [];
const opens = {};
const stats = { raw: identityStats(raw) };
let failure = null;
try {
  const base = openCopy('base', { fill: false, tz: 'UTC' });
  const postUtc = openCopy('post-utc', { fill: true, tz: 'UTC' });
  const postUtc2 = openCopy('post-utc-2', { fill: true, tz: 'UTC' });
  const postLa = openCopy('post-la', { fill: true, tz: 'America/Los_Angeles' });
  const synced = stats.raw.synced !== null;
  const scratch = synced
    ? null
    : openCopy('scratch', { fill: true, tz: 'UTC', prepare: nullIdentity });
  for (const c of [base, postUtc, postUtc2, postLa, scratch]) {
    if (!c) continue;
    opens[c.name] = { openMs: c.openMs };
    stats[c.name] = identityStats(c.file);
  }

  checks.push(
    replay(
      'replay (fill-off vs fill-on, --omit-row-identity)',
      fingerprint(base, 'source', true),
      fingerprint(postUtc, 'replica', true),
    ),
  );
  checks.push(
    replay(
      'determinism (two fills, identity hashed)',
      fingerprint(postUtc, 'source', false),
      fingerprint(postUtc2, 'replica', false),
    ),
  );
  checks.push(
    replay(
      'timezone (UTC vs America/Los_Angeles, identity hashed)',
      fingerprint(postUtc, 'source', false),
      fingerprint(postLa, 'replica', false),
    ),
  );
  // Negative control: with identity hashed, the fill-off baseline must NOT
  // replay the filled copy. A PASS here would mean the fingerprint does not see
  // the identity columns, and checks 2, 3 and 5 would prove nothing.
  const control = replay(
    'control (fill-off vs fill-on, identity hashed, must FAIL)',
    fingerprint(base, 'source', false),
    fingerprint(postUtc, 'replica', false),
  );
  checks.push({
    ...control,
    pass: !control.pass,
    // The control's findings are the expected identity differences; keep the count only.
    findings: [`${control.findings.length} identity difference(s), as expected`],
  });
  if (scratch) {
    checks.push(
      replay(
        'from scratch (identity nulled + marker removed, then filled, vs post-utc; identity hashed)',
        fingerprint(scratch, 'source', false),
        fingerprint(postUtc, 'replica', false),
      ),
    );
  } else {
    checks.push({
      check: 'from scratch',
      pass: true,
      skipped: true,
      verdict: `skipped: the store's identity has synced (${SYNCED_KEY}=${stats.raw.synced}); its values are authoritative as received`,
      findings: [],
    });
  }

  // Completeness over every declared table (T13220).
  const missing = [];
  const refNulls = {};
  for (const [table, t] of Object.entries(stats['post-utc'].tables)) {
    if (t.columns[UID_COLUMN].nulls > 0)
      missing.push(`${table}.${UID_COLUMN}=${t.columns[UID_COLUMN].nulls}`);
    if (t.kind === 'minted' && t.columns[BIRTH_FP_COLUMN].nulls > 0) {
      missing.push(`${table}.${BIRTH_FP_COLUMN}=${t.columns[BIRTH_FP_COLUMN].nulls}`);
    }
    for (const [column, c] of Object.entries(t.columns)) {
      if (column !== UID_COLUMN && column !== BIRTH_FP_COLUMN && c.nulls > 0) {
        refNulls[`${table}.${column}`] = c.nulls;
      }
    }
  }
  checks.push({
    check: 'completeness (every declared table: no NULL uid; minted: no NULL birth_fp)',
    pass: missing.length === 0,
    verdict: missing.length === 0 ? 'complete' : `missing ${missing.join(', ')}`,
    findings:
      Object.keys(refNulls).length > 0
        ? [`NULL stored reference facts (reported, not failed): ${JSON.stringify(refNulls)}`]
        : [],
  });

  // The fill-off open writes nothing: value digests per column (T13220, LOW-1).
  const changed = [];
  for (const [table, t] of Object.entries(stats.raw.tables)) {
    for (const [column, c] of Object.entries(t.columns)) {
      const after = stats.base.tables[table]?.columns[column];
      if (!after || after.digest !== c.digest) changed.push(`${table}.${column}`);
    }
  }
  checks.push({
    check: 'fill-off open writes no identity value (per-column value digests equal raw.db)',
    pass: changed.length === 0,
    verdict: changed.length === 0 ? 'unchanged' : `changed ${changed.join(', ')}`,
    findings: [],
  });
} catch (err) {
  failure = err instanceof Error ? err.message : String(err);
  checks.push({ check: 'harness', pass: false, verdict: failure, findings: [] });
}

const markers = Object.fromEntries(
  Object.entries(stats).map(([name, s]) => [name, { recipe: s.recipe, synced: s.synced }]),
);
const report = {
  label,
  backup: resolve(values.backup),
  projectId: values['project-id'] ? 'file' : 'stub',
  build: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(),
  ranAt: new Date().toISOString(),
  opens,
  markers,
  tables: Object.fromEntries(
    Object.entries(stats.raw.tables).map(([table, t]) => [
      table,
      {
        rows: t.rows,
        nullsInBackup: Object.fromEntries(Object.entries(t.columns).map(([c, v]) => [c, v.nulls])),
        nullsAfterFill: Object.fromEntries(
          Object.entries(stats['post-utc']?.tables[table]?.columns ?? {}).map(([c, v]) => [
            c,
            v.nulls,
          ]),
        ),
      },
    ]),
  ),
  checks,
  pass: checks.every((c) => c.pass),
};
writeFileSync(resolve(values.report), `${JSON.stringify(report, null, 2)}\n`);
for (const c of checks) {
  process.stdout.write(
    `${c.skipped ? 'SKIP' : c.pass ? 'PASS' : 'FAIL'}  ${c.check}: ${c.verdict}\n`,
  );
  for (const f of c.findings ?? []) process.stdout.write(`      ${f}\n`);
}
process.stdout.write(`markers: ${JSON.stringify(markers)}\n`);
process.stdout.write(`${report.pass ? 'GATE B PASS' : 'GATE B FAIL'} ${label}\n`);
process.exit(report.pass ? 0 : 1);
