/**
 * Tests for scripts/row-identity-real-store-gate-b.mjs (T13219 · T13220): a
 * fixture store passes every check end to end, a store holding values the
 * current recipe would not derive fails the from-scratch check, and each
 * check's judgement fails on the input it exists to catch.
 *
 * Fixture stores are made through this build's runtime path in a child
 * process with a sandboxed HOME, then copied out with `VACUUM INTO`, the way
 * an operator's `cleo backup add` makes the backup the gate reads. Needs a
 * built `packages/core/dist` (the Scripts Tests CI job builds first).
 *
 * @task T13219
 * @task T13220
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite'; // db-open-allowed: test fixture copies only
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { ROW_IDENTITY_RECIPE } from '../../packages/core/src/store/row-identity.ts';
import {
  completenessCheck,
  controlCheck,
  fillOffCheck,
  fingerprint,
  identityStats,
  nullIdentity,
  replay,
} from '../row-identity-real-store-gate-b.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO, 'scripts', 'row-identity-real-store-gate-b.mjs');
const CORE_DIST = pathToFileURL(`${join(REPO, 'packages', 'core', 'dist')}/`).href;
const STUB_ID = '00000000-0000-4000-8000-000000000001';
const root = mkdtempSync(join(tmpdir(), 'gate-b-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Opens a fresh project store with fill off (as the gate's own opener does), seeds two tasks, runs `prepare`, and VACUUMs it out. */
const MAKER = `
const [coreDist, projectDir, out, prepare] = process.argv.slice(1);
const { openDualScopeDb } = await import(new URL('store/dual-scope-db.js', coreDist).href);
const { getDb } = await import(new URL('store/sqlite.js', coreDist).href);
const handle = await openDualScopeDb('project', projectDir, { syncMode: 'off' });
await getDb(projectDir);
const db = handle.db.$client;
db.exec("INSERT INTO tasks_tasks (id, title, type) VALUES ('T001', 'first', 'epic'), ('T002', 'second', 'task')");
db.exec("UPDATE tasks_tasks SET parent_id = 'T001' WHERE id = 'T002'");
if (prepare) db.exec(prepare);
db.exec("VACUUM INTO '" + out.replaceAll("'", "''") + "'");
process.exit(0);
`;

let made = 0;
/** A backup of a fixture store; `prepare` is SQL run on it before the copy. */
function backup(prepare = '') {
  const dir = join(root, `store-${made++}`);
  const project = join(dir, 'project');
  mkdirSync(join(project, '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  writeFileSync(join(project, '.cleo', 'project-id'), `${STUB_ID}\n`);
  const out = join(dir, 'backup.db');
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', MAKER, CORE_DIST, project, out, prepare],
    {
      cwd: project,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: join(dir, 'home'),
        CLEO_HOME: join(dir, 'home', '.cleo'),
        CLEO_ROW_UID_FILL: '0',
        CLEO_ALLOW_WORKTREE_BUILD_MIGRATIONS: '1',
        CLEO_LOG_LEVEL: 'silent',
      },
      timeout: 120_000,
    },
  );
  expect(r.status, r.stderr).toBe(0);
  return out;
}

/** Run the gate on `file`; returns its exit status and report. */
function gate(file, label) {
  const work = join(root, `work-${label}`);
  const report = join(root, `${label}.json`);
  const r = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--label',
      label,
      '--backup',
      file,
      '--project-id-stub',
      '--work',
      work,
      '--report',
      report,
      '--timeout-ms',
      '120000',
    ],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: join(root, 'home') },
      timeout: 600_000,
    },
  );
  return {
    status: r.status,
    out: r.stdout + r.stderr,
    report: JSON.parse(readFileSync(report, 'utf8')),
  };
}

const byName = (report, prefix) => report.checks.find((c) => c.check.startsWith(prefix));

describe('row-identity real-store Gate B, end to end', () => {
  it('passes every check on a store the current recipe fills from nothing', () => {
    const { status, out, report } = gate(backup(), 'clean');
    expect(status, out).toBe(0);
    expect(report.pass).toBe(true);
    expect(report.checks.map((c) => c.pass)).toEqual([true, true, true, true, true, true, true]);
    expect(byName(report, 'from scratch').skipped).toBeUndefined();
    expect(out).toMatch(/GATE B PASS clean/);
  }, 600_000);

  it('fails the from-scratch check on a store holding a value the current recipe would not derive (T13219)', () => {
    // The recipe marker claims the stored values are the current recipe's, so
    // the fill keeps them; only a from-nothing derivation exposes the stray value.
    const bogus = backup(
      "UPDATE tasks_tasks SET uid = 'bogus-uid-not-derived' WHERE id = 'T001'; " +
        `INSERT INTO tasks_row_identity_meta (key, value) VALUES ('row_identity_recipe', '${ROW_IDENTITY_RECIPE}')`,
    );
    const { status, out, report } = gate(bogus, 'bogus');
    expect(status, out).toBe(1);
    expect(byName(report, 'from scratch')).toMatchObject({ pass: false });
    expect(byName(report, 'determinism')).toMatchObject({ pass: true });
    expect(out).toMatch(/GATE B FAIL bogus/);
  }, 600_000);

  it('skips the from-scratch check, with the reason, once the store identity has synced', () => {
    const synced = backup(
      "INSERT INTO tasks_row_identity_meta (key, value) VALUES ('row_identity_synced', 'send')",
    );
    const { report } = gate(synced, 'synced');
    expect(byName(report, 'from scratch')).toMatchObject({
      pass: true,
      skipped: true,
      verdict: expect.stringMatching(/identity has synced/),
    });
  }, 600_000);

  it('refuses usage without a backup or a project id', () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--label', 'x', '--work', root, '--report', 'r'],
      {
        encoding: 'utf8',
      },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--backup is required/);
  });
});

describe('each check fails on what it exists to catch', () => {
  it('replay (checks 1, 2, 3, 5) fails when the two stores differ and passes when they match', () => {
    const dir = join(root, 'replay');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'project-id'), `${STUB_ID}\n`);
    const a = join(dir, 'a.db');
    const b = join(dir, 'b.db');
    copyFileSync(backup(), a);
    copyFileSync(a, b);
    const ctx = {
      label: 'replay',
      outDir: join(dir, 'fp'),
      keyFile: join(dir, 'k'),
      timeoutMs: 120_000,
    };
    writeFileSync(ctx.keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
    const same = replay(
      'same',
      fingerprint({ name: 'a', file: a }, 'source', true, ctx),
      fingerprint({ name: 'b', file: b }, 'replica', true, ctx),
      ctx,
    );
    expect(same.pass, same.verdict).toBe(true);
    const db = new DatabaseSync(b);
    db.exec("UPDATE tasks_tasks SET title = 'changed' WHERE id = 'T002'");
    db.close();
    const differ = replay(
      'differ',
      fingerprint({ name: 'a', file: a }, 'source', true, ctx),
      fingerprint({ name: 'b2', file: b }, 'replica', true, ctx),
      ctx,
    );
    expect(differ.pass).toBe(false);
  }, 300_000);

  it('control (check 4) passes only when its replay failed', () => {
    const failed = { check: 'c', pass: false, verdict: 'FAIL', findings: ['GATE x', 'GATE y'] };
    expect(controlCheck(failed)).toMatchObject({
      pass: true,
      findings: ['2 identity difference(s), as expected'],
    });
    expect(controlCheck({ ...failed, pass: true, findings: [] }).pass).toBe(false);
  });

  const stats = (columns, kind = 'minted') => ({
    tables: { tasks_tasks: { kind, rows: 2, columns } },
  });

  it('completeness (check 6) fails on a NULL uid or a minted NULL birth_fp, and only reports a NULL reference', () => {
    const full = { uid: { nulls: 0, digest: 'a' }, birth_fp: { nulls: 0, digest: 'b' } };
    expect(completenessCheck(stats(full)).pass).toBe(true);
    expect(completenessCheck(stats({ ...full, uid: { nulls: 1, digest: 'a' } }))).toMatchObject({
      pass: false,
      verdict: 'missing tasks_tasks.uid=1',
    });
    expect(completenessCheck(stats({ ...full, birth_fp: { nulls: 2, digest: 'b' } })).pass).toBe(
      false,
    );
    const ref = completenessCheck(stats({ ...full, parent_uid: { nulls: 1, digest: 'c' } }));
    expect(ref.pass).toBe(true);
    expect(ref.findings[0]).toMatch(/tasks_tasks\.parent_uid.*1/);
  });

  it('fill-off (check 7) fails when the fill-off open changed or dropped an identity column', () => {
    const raw = stats({ uid: { nulls: 2, digest: 'x' } });
    expect(fillOffCheck(raw, raw).pass).toBe(true);
    expect(fillOffCheck(raw, stats({ uid: { nulls: 0, digest: 'y' } }))).toMatchObject({
      pass: false,
      verdict: 'changed tasks_tasks.uid',
    });
    expect(fillOffCheck(raw, { tables: {} }).pass).toBe(false);
  });

  it('identityStats and nullIdentity read and clear identity on a migrated copy, and refuse without trigger suspension', () => {
    const dir = join(root, 'stats');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'filled.db');
    copyFileSync(backup("UPDATE tasks_tasks SET uid = 'u-' || id"), file);
    const before = identityStats(file);
    expect(before.tables.tasks_tasks.columns.uid.nulls).toBe(0);
    nullIdentity(file);
    expect(identityStats(file).tables.tasks_tasks.columns.uid.nulls).toBe(2);
    const bare = join(dir, 'bare.db');
    const db = new DatabaseSync(bare);
    db.exec('CREATE TABLE t (x)');
    db.close();
    expect(() => nullIdentity(bare)).toThrow(/cleo_trigger_suspend is missing/);
  }, 300_000);
});
