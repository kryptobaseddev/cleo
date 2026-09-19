/** Independent ownership, cancellation and durability oracles for the existing job store. */
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundJobManager, DurableJobStore } from '../background-jobs.js';
import { migrateSanitized } from '../migration-manager.js';
import { getDb, resetDbState } from '../sqlite.js';

const migrationName = '20260919180000_t12263-job-ownership-fences';
const migration = readFileSync(
  new URL(`../../../migrations/drizzle-tasks/${migrationName}/migration.sql`, import.meta.url),
  'utf8',
);
const pendingMigrationName = '20260919184500_t12265-durable-pending-proposals';
const pendingMigration = readFileSync(
  new URL(
    `../../../migrations/drizzle-tasks/${pendingMigrationName}/migration.sql`,
    import.meta.url,
  ),
  'utf8',
);
const baseSchema = `CREATE TABLE background_jobs (
  id TEXT PRIMARY KEY, operation TEXT NOT NULL, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, completed_at INTEGER, result TEXT, error TEXT,
  progress INTEGER, heartbeat_at INTEGER NOT NULL, claimed_by TEXT
)`;
const execute = promisify(execFile);
let root: string;
let path: string;
let native: DatabaseSync;
let db: ReturnType<typeof drizzle>;
let bundleRoot: string;
const managers: BackgroundJobManager[] = [];
const request = {
  projectId: 'project-A',
  idempotencyKey: 'repair-key',
  proposalJson: '{"revision":"one"}',
};

beforeAll(() => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'cleo-job-process-'));
  symlinkSync(
    fileURLToPath(new URL('../../../node_modules', import.meta.url)),
    join(bundleRoot, 'node_modules'),
    'dir',
  );
  buildSync({
    entryPoints: [fileURLToPath(new URL('../background-jobs.ts', import.meta.url))],
    outfile: join(bundleRoot, 'jobs.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  writeFileSync(
    join(bundleRoot, 'client.mjs'),
    `
    import { DatabaseSync } from 'node:sqlite';
    import { drizzle } from 'drizzle-orm/node-sqlite';
    import { DurableJobStore } from './jobs.mjs';
    const native = new DatabaseSync(process.argv[2]);
    native.exec('PRAGMA busy_timeout=3000');
    const store = new DurableJobStore(drizzle({client:native}));
    let result;
    try {
      result = process.argv[3] === 'claim' ? {grant:store.claim('job',Date.now())} : {job:store.get('job')};
    } catch (error) { result = {code:error.code,message:error.message}; }
    native.close(); process.stdout.write(JSON.stringify(result));
  `,
  );
});
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-job-store-'));
  path = join(root, 'fixture.db');
  native = new DatabaseSync(path);
  native.exec(baseSchema);
  native.exec(migration);
  native.exec(pendingMigration);
  db = drizzle({ client: native });
});
afterEach(() => {
  for (const manager of managers.splice(0)) manager.destroy();
  vi.useRealTimers();
  vi.restoreAllMocks();
  native.close();
  resetDbState();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
function manager() {
  const value = new BackgroundJobManager(db);
  managers.push(value);
  return value;
}
function readProcess() {
  return JSON.parse(
    execFileSync(process.execPath, [join(bundleRoot, 'client.mjs'), path, 'read'], {
      encoding: 'utf8',
      timeout: 10_000,
    }),
  );
}
function flushed() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe('persisted job ownership', () => {
  it('preserves live work when another client or process opens the store', () => {
    const first = new DurableJobStore(db);
    first.insert('job', 'inspect', Date.now());
    const before = first.get('job');
    expect(new DurableJobStore(db).get('job')).toEqual(before);
    expect(readProcess().job).toEqual(before);
    expect(before?.status).toBe('running');
    expect(before?.ownership).toBe('current');
  });

  it('refuses sync writes inside an unrelated transaction without rolling it back', () => {
    const store = new DurableJobStore(db);
    store.insert('job', 'inspect', Date.now());
    native.exec('BEGIN IMMEDIATE');
    native.prepare('UPDATE background_jobs SET progress=7 WHERE id=?').run('job');
    expect(() => store.complete('job', { saved: true }, Date.now())).toThrow('another caller owns');
    expect(native.prepare('SELECT progress FROM background_jobs').get()?.progress).toBe(7);
    native.exec('ROLLBACK');
    expect(readProcess().job.status).toBe('running');
    expect(readProcess().job.progress).toBeUndefined();
  });

  it('allows only expired reclaim and rejects every write from the earlier owner', () => {
    const first = new DurableJobStore(db);
    const second = new DurableJobStore(db);
    first.insert('job', 'inspect', Date.now());
    first.checkpoint('job', '{"next":3}', Date.now());
    expect(() => second.claim('job', Date.now())).toThrow('Only explicitly expired');
    native.exec("UPDATE background_jobs SET lease_expires_at=0 WHERE id='job'");
    const lease = second.claim('job', Date.now());
    expect(lease.epoch).toBe(2);
    expect(second.get('job')).toMatchObject({
      attempts: 2,
      checkpointJson: '{"next":3}',
      ownership: 'current',
    });
    for (const write of [
      () => first.complete('job', { wrong: true }, Date.now()),
      () => first.fail('job', 'wrong', Date.now()),
      () => first.progress('job', 90, Date.now()),
      () => first.checkpoint('job', '{"wrong":true}', Date.now()),
      () => first.heartbeat('job', Date.now()),
      () => first.cancel('job', Date.now()),
    ])
      expect(write).toThrow('not owned');
    second.complete('job', { verified: true }, Date.now());
    expect(readProcess().job).toMatchObject({
      status: 'complete',
      result: { verified: true },
      attempts: 2,
      checkpointJson: '{"next":3}',
    });
  });

  it('does not permit a stale caller to rewrite a returned grant into the new owner', () => {
    const first = new DurableJobStore(db);
    const old = first.insert('job', 'inspect', Date.now());
    expect(old).not.toBeNull();
    native.exec("UPDATE background_jobs SET lease_expires_at=0 WHERE id='job'");
    const current = new DurableJobStore(db).claim('job', Date.now());
    expect(() => Object.assign(old, current)).toThrow();
    expect(() => first.complete('job', { forged: true }, Date.now())).toThrow('not owned');
    expect(readProcess().job.status).toBe('running');
  });

  it('has one winning claimant across independent writer processes', async () => {
    const store = new DurableJobStore(db);
    store.insert('job', 'inspect', Date.now());
    native.exec("UPDATE background_jobs SET lease_expires_at=0 WHERE id='job'");
    const results = await Promise.all(
      [0, 1].map(() =>
        execute(process.execPath, [join(bundleRoot, 'client.mjs'), path, 'claim'], {
          timeout: 10_000,
        }),
      ),
    );
    const claims = results.map((result) => JSON.parse(result.stdout));
    expect(claims.filter((result) => result.grant)).toHaveLength(1);
    expect(claims.filter((result) => result.code === 'E_JOB_NOT_RECLAIMABLE')).toHaveLength(1);
    expect(readProcess().job.attempts).toBe(2);
    expect(() => store.complete('job', {}, Date.now())).toThrow('not owned');
  });

  it('does not infer missing legacy leases as expired or remove historical rows', () => {
    native
      .prepare(
        'INSERT INTO background_jobs(id,operation,status,started_at,heartbeat_at) VALUES(?,?,?,?,?)',
      )
      .run('job', 'legacy', 'running', 1234, 1234);
    const store = new DurableJobStore(db);
    expect(store.get('job')).toMatchObject({
      projectId: null,
      ownerId: null,
      attempts: 0,
      ownership: 'legacy-unknown',
      startedAt: new Date(1234).toISOString(),
    });
    expect(() => store.claim('job', Date.now())).toThrow('Only explicitly expired');
    expect(store.purgeOlderThan(Date.now())).toBe(0);
    expect(store.get('job')).toBeDefined();
  });

  it('rolls back a refused result or checkpoint without falsifying completion', () => {
    const store = new DurableJobStore(db);
    store.insert('job', 'inspect', Date.now());
    store.checkpoint('job', '{"before":true}', Date.now());
    native.exec(
      "CREATE TRIGGER fail_job_write BEFORE UPDATE ON background_jobs BEGIN SELECT RAISE(ABORT,'fixture job fault'); END",
    );
    expect(() => store.complete('job', { wrong: true }, Date.now())).toThrow();
    expect(() => store.checkpoint('job', '{"wrong":true}', Date.now())).toThrow();
    expect(readProcess().job).toMatchObject({
      status: 'running',
      checkpointJson: '{"before":true}',
    });
    expect(readProcess().job.result).toBeUndefined();
  });

  it('coalesces matching proposal bytes and refuses changed retry inputs across scoped clients', () => {
    const first = new DurableJobStore(db);
    const second = new DurableJobStore(db);
    expect(first.insert('one', 'repair', Date.now(), request)?.jobId).toBe('one');
    expect(second.insert('two', 'repair', Date.now(), request)).toBeNull();
    expect(() =>
      second.insert('two', 'repair', Date.now(), {
        ...request,
        proposalJson: '{"revision":"two"}',
      }),
    ).toThrow('different immutable');
    expect(
      second.insert('two', 'repair', Date.now(), { ...request, projectId: 'project-B' })?.jobId,
    ).toBe('two');
    expect(second.insert('three', 'other', Date.now(), request)?.jobId).toBe('three');
    expect(new DurableJobStore(db, { projectId: 'project-A' }).list()).toHaveLength(2);
    expect(() =>
      new DurableJobStore(db, { projectId: 'project-B' }).insert(
        'four',
        'repair',
        Date.now(),
        request,
      ),
    ).toThrow('differs from the store scope');
  });

  it('rejects unsupported lifecycle filters instead of reporting an empty healthy population', () => {
    expect(() => new DurableJobStore(db).list('unsupported')).toThrow('Unsupported job status');
  });

  it('discloses malformed persisted result data as a diagnostic failure', () => {
    const store = new DurableJobStore(db);
    store.insert('job', 'inspect', Date.now());
    store.complete('job', {}, Date.now());
    native.exec("UPDATE background_jobs SET result='invalid-json' WHERE id='job'");
    expect(store.get('job')?.diagnosticError).toBe('Stored job result is not valid JSON');
  });
});

describe('existing executor facade', () => {
  it('does not fail another managers work during destroy', async () => {
    const first = manager();
    const second = manager();
    const pending = Promise.withResolvers<object>();
    const id = await first.startJob('inspect', () => pending.promise);
    second.destroy();
    expect(first.getJob(id)?.status).toBe('running');
    pending.resolve({ saved: true });
    await flushed();
    expect(first.getJob(id)?.status).toBe('complete');
  });

  it('does not invoke a repeated submission twice', async () => {
    const first = manager();
    const second = manager();
    const execute = vi.fn(async () => ({ saved: true }));
    const id = await first.startJob('repair', execute, request);
    expect(await second.startJob('repair', execute, request)).toBe(id);
    await flushed();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(first.getJob(id)?.status).toBe('complete');
    expect(first.cleanup()).toBe(0);
    expect(first.getJob(id)).toBeDefined();
  });

  it('applies the running limit to new scoped submissions while allowing an identical retry', async () => {
    const first = new BackgroundJobManager(db, { maxJobs: 1 });
    const second = new BackgroundJobManager(db, { maxJobs: 1 });
    managers.push(first, second);
    const pending = Promise.withResolvers<object>();
    const id = await first.startJob('repair', () => pending.promise, request);
    expect(await second.startJob('repair', async () => ({}), request)).toBe(id);
    await expect(
      second.startJob('repair', async () => ({}), { ...request, idempotencyKey: 'other' }),
    ).rejects.toThrow('Maximum concurrent');
    pending.resolve({ saved: true });
    await flushed();
  });

  it('persists a remote cancellation request before an executor acknowledges abort', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const first = manager();
    const second = manager();
    const id = await first.startJob('inspect', ({ signal, checkpoint }) => {
      checkpoint('{"visited":1}');
      return new Promise<never>((_resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('cancelled', 'AbortError')),
          { once: true },
        ),
      );
    });
    expect(second.cancelJob(id)).toBe(true);
    expect(second.getJob(id)).toMatchObject({ status: 'running', checkpointJson: '{"visited":1}' });
    expect(second.getJob(id)?.cancellationRequestedAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    await flushed();
    expect(first.getJob(id)?.status).toBe('cancelled');
  });

  it('reports actual completion when cancellation arrives after executor work committed', async () => {
    const first = manager();
    const pending = Promise.withResolvers<{ committed: boolean }>();
    const id = await first.startJob('repair', () => pending.promise);
    expect(first.cancelJob(id)).toBe(true);
    expect(first.getJob(id)?.status).toBe('running');
    pending.resolve({ committed: true });
    await flushed();
    expect(first.getJob(id)).toMatchObject({ status: 'complete', result: { committed: true } });
    expect(first.cancelJob(id)).toBe(false);
  });
});

it('discovers and journals the additive migration through a fresh canonical project open', async () => {
  const project = join(root, 'project');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(project, '.cleo'), { recursive: true });
  mkdirSync(join(project, '.git'));
  vi.stubEnv('CLEO_DIR', join(project, '.cleo'));
  vi.stubEnv('CLEO_ROOT', project);
  const canonical = await getDb(project);
  const store = new DurableJobStore(canonical, { projectId: 'canonical-project' });
  store.insert('job', 'inspect', Date.now());
  store.complete('job', { verified: true }, Date.now());
  expect(store.get('job')).toMatchObject({ status: 'complete', projectId: 'canonical-project' });
  const inspection = new DatabaseSync(join(project, '.cleo', 'cleo.db'), { readOnly: true });
  try {
    expect(
      inspection
        .prepare('SELECT name FROM main.__drizzle_migrations WHERE name=?')
        .get(migrationName),
    ).toBeDefined();
    expect(
      inspection
        .prepare('SELECT name FROM main.__drizzle_migrations WHERE name=?')
        .get(pendingMigrationName),
    ).toBeDefined();
    expect(
      inspection.prepare('SELECT COUNT(*) AS n FROM main.tasks_background_jobs').get()?.n,
    ).toBe(0);
  } finally {
    inspection.close();
  }
});

it('upgrades populated active rows through the migration runner without touching either history encoding', () => {
  const history = new DatabaseSync(join(root, 'history.db'));
  const folder = join(root, 'migrations');
  mkdirSync(join(folder, migrationName), { recursive: true });
  writeFileSync(join(folder, migrationName, 'migration.sql'), migration);
  mkdirSync(join(folder, pendingMigrationName), { recursive: true });
  writeFileSync(join(folder, pendingMigrationName, 'migration.sql'), pendingMigration);
  try {
    history.exec(baseSchema);
    history.exec(
      'CREATE TABLE tasks_background_jobs(id TEXT PRIMARY KEY, started_at TEXT, result TEXT)',
    );
    history
      .prepare(
        'INSERT INTO background_jobs(id,operation,status,started_at,heartbeat_at,result,claimed_by) VALUES(?,?,?,?,?,?,?)',
      )
      .run('same-id', '歷史', 'complete', 1234, 2345, '{"literal":"a|b"}', 'original-agent');
    history
      .prepare('INSERT INTO tasks_background_jobs VALUES(?,?,?)')
      .run('same-id', '2026-01-02T03:04:05.000Z', 'canonical historical evidence');
    const legacySelect =
      'SELECT id,operation,status,started_at,completed_at,result,error,progress,heartbeat_at,claimed_by FROM background_jobs';
    const beforeLegacy = history.prepare(legacySelect).all();
    const beforeCanonical = history.prepare('SELECT * FROM tasks_background_jobs').all();
    const handle = drizzle({ client: history });
    migrateSanitized(handle, { migrationsFolder: folder });
    migrateSanitized(handle, { migrationsFolder: folder });
    expect(history.prepare(legacySelect).all()).toEqual(beforeLegacy);
    expect(history.prepare('SELECT * FROM tasks_background_jobs').all()).toEqual(beforeCanonical);
    expect(
      history
        .prepare(
          'SELECT owner_id,lease_expires_at,fencing_epoch,attempts,proposal_json FROM background_jobs',
        )
        .get(),
    ).toEqual({
      owner_id: null,
      lease_expires_at: null,
      fencing_epoch: 0,
      attempts: 0,
      proposal_json: null,
    });
    expect(history.prepare('SELECT COUNT(*) AS n FROM main.__drizzle_migrations').get()?.n).toBe(2);
  } finally {
    history.close();
  }
});
