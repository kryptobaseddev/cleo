/**
 * The release real-store smoke (T14104, T14250) against fixture stores and a
 * stub CLI: it snapshots each store into a sandbox, neutralises the copy's
 * test commands, runs every step, and fails (exit 1) when the copy does not
 * open or migrate.
 *
 * The stub stands in for the built CLI so the script's own logic is tested in
 * the scripts job, which has no build; the release step runs the real CLI.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DISABLED_TEST_EXIT, neutralizeTesting, smokeStores } from '../release-mac-smoke.mjs';

/**
 * A stub CLI answering the smoke's steps with LAFS-shaped envelopes. It reads
 * every view of the copied store first, as a real open does, so a view over a
 * dropped table fails the way v2026.10.10 did.
 */
const STUB_CLI = `
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const ok = (data) => out({ success: true, data });
const db = new DatabaseSync(path.join(process.cwd(), '.cleo', 'cleo.db'));
try {
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'view'").all()) {
    db.prepare('SELECT * FROM ' + name).all();
  }
} catch (err) {
  process.stderr.write(String(err.message) + '\\n');
  process.exit(1);
}
const cmd = args.slice(0, 2).join(' ');
const counter = path.join(process.cwd(), 'ids');
const next = () => {
  const n = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
  fs.writeFileSync(counter, String(n));
  return 'T' + (2100 + n);
};
if (args[0] === '--version') ok({ version: '0.0.0-stub' });
else if (cmd === 'session start') ok({ id: 'ses_stub' });
else if (args[0] === 'add') ok({ created: [next()] });
else if (args[0] === 'show') ok({ task: { id: args[1], status: 'cancelled' } });
else if (args[0] === 'done') {
  const ctx = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.cleo', 'project-context.json'), 'utf8'));
  if (!ctx.testing.command.includes('exit(${DISABLED_TEST_EXIT})')) process.exit(3);
  ok({ taskId: args[1], blockers: [{ code: 'cancelled-child-waiver', message: 'waive it' }] });
} else if (cmd === 'docs list') ok({ attachments: [{ id: 'a1' }, { id: 'a2', slug: 'smoke-doc' }] });
else if (cmd === 'docs fetch') {
  if (!fs.existsSync(path.join(process.cwd(), '.cleo', 'blobs', 'blobs', 'doc'))) process.exit(4);
  ok({ slug: args[2] });
} else ok({ argv: args, session: process.env.CLEO_SESSION_ID ?? null });
`;

describe('release-mac-smoke (T14250)', () => {
  let root;
  let cli;
  let globalDb;

  /** A project whose store holds `sql`, with a docs blob and a real test command. */
  const project = (name, sql) => {
    const dir = join(root, name);
    mkdirSync(join(dir, '.cleo', 'blobs', 'blobs'), { recursive: true });
    const db = new DatabaseSync(join(dir, '.cleo', 'cleo.db'));
    db.exec(sql);
    db.close();
    writeFileSync(join(dir, '.cleo', 'blobs', 'blobs', 'doc'), 'doc body');
    writeFileSync(
      join(dir, '.cleo', 'project-context.json'),
      JSON.stringify({ testing: { command: 'pnpm run test', affectedCommand: 'vitest run' } }),
    );
    return dir;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'release-mac-smoke-test-'));
    cli = join(root, 'stub-cli.cjs');
    writeFileSync(cli, STUB_CLI);
    globalDb = join(root, 'global.db');
    const db = new DatabaseSync(globalDb);
    db.exec('CREATE TABLE g (id INTEGER)');
    db.close();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('passes on a healthy store copy and records commands, store and CLI version', () => {
    const healthy = project(
      'healthy',
      'CREATE TABLE t (id INTEGER); CREATE VIEW v AS SELECT * FROM t;',
    );
    const out = join(root, 'out');
    const { passed, receipt } = smokeStores({
      cli,
      projects: [healthy],
      globalDb,
      out,
      sha: 'abc',
    });

    expect(passed).toBe(true);
    expect(receipt.result).toBe('pass');
    expect(receipt.cliVersion).toBe('0.0.0-stub');
    const run = receipt.projects[0];
    expect(run.store).toBe(join(healthy, '.cleo', 'cleo.db'));
    const argvs = run.commands.map((c) => c.argv.slice(1, 3).join(' '));
    expect(argvs).toEqual(
      expect.arrayContaining(['cancel T2102', 'done T2104', 'docs fetch', 'run --wait']),
    );
    // The session the smoke started binds the later steps.
    expect(readFileSync(join(out, 'healthy', '24.stdout'), 'utf8')).toContain('ses_stub');
    expect(JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')).passed).toBe(true);
    expect(readFileSync(join(out, 'SHA256SUMS'), 'utf8')).toContain('healthy/01.stdout');
    // The real store's test commands are untouched; only the copy is neutralised.
    const real = JSON.parse(readFileSync(join(healthy, '.cleo', 'project-context.json'), 'utf8'));
    expect(real.testing.command).toBe('pnpm run test');
  });

  it('fails (exit 1) when the copy cannot open or migrate', () => {
    const broken = project(
      'broken',
      'CREATE TABLE release_manifests (id INTEGER); CREATE VIEW releases_view AS SELECT * FROM release_manifests; DROP TABLE release_manifests;',
    );
    const out = join(root, 'out');
    const { passed, receipt } = smokeStores({ cli, projects: [broken], globalDb, out });

    expect(passed).toBe(false);
    expect(receipt.result).toBe('fail');
    const opened = receipt.projects[0].commands.find(
      (c) => c.argv.join(' ') === 'cleo session status',
    );
    expect(opened?.ok).toBe(false);
    expect(readFileSync(join(out, 'broken', '02.stderr'), 'utf8')).toMatch(/no such table/);
  });

  it('fails when any one project of several fails', () => {
    const healthy = project('healthy', 'CREATE TABLE t (id INTEGER);');
    const missing = join(root, 'no-store');
    const { passed, receipt } = smokeStores({
      cli,
      projects: [healthy, missing],
      globalDb,
      out: join(root, 'out'),
    });
    expect(receipt.projects.map((p) => p.passed)).toEqual([true, false]);
    expect(passed).toBe(false);
  });

  it('neutralizeTesting replaces both test commands with one that exits non-zero', () => {
    const dest = join(root, 'ctx', 'project-context.json');
    neutralizeTesting(join(root, 'absent.json'), dest);
    const testing = JSON.parse(readFileSync(dest, 'utf8')).testing;
    expect(testing.command).toContain(`process.exit(${DISABLED_TEST_EXIT})`);
    expect(testing.affectedCommand).toBe(testing.command);
    expect(existsSync(dest)).toBe(true);
  });
});
