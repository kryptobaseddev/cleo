/** Independent ownership, cancellation and durability oracles for the existing job store. */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertOperationWriteFence,
  type BackgroundJob,
  BackgroundJobManager,
  DurableJobStore,
} from '../background-jobs.js';
import { bindOperationWriteFence, createOperationExecutionContext } from '../background-ops.js';
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
  buildSync({
    entryPoints: [fileURLToPath(new URL('../background-ops.ts', import.meta.url))],
    outfile: join(bundleRoot, 'ops.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
  });
  writeFileSync(
    join(bundleRoot, 'client.mjs'),
    `
    import { DatabaseSync } from 'node:sqlite';
    import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-sqlite';
    import { DurableJobStore } from './jobs.mjs';
    import { createOperationExecutionContext } from './ops.mjs';
    const native = new DatabaseSync(process.argv[2]);
    native.exec('PRAGMA busy_timeout=3000');
    const store = new DurableJobStore(drizzle({client:native}), ['retry','page'].includes(process.argv[3]) ? {projectId:'project-A',actor:'fixture'} : {});
    let result;
    try {
      if (process.argv[3] === 'page') {
        const query=JSON.parse(process.argv[5]);
        const context=createOperationExecutionContext({projectId:'project-A',projectRoot:process.argv[4],
          actor:'fixture',operation:query.operation,idempotencyKey:'inventory'});
        try {result=store.listPage(query,context);} finally {context.close();}
      } else if (process.argv[3] === 'retry') {
        const context = createOperationExecutionContext({projectId:'project-A',projectRoot:process.argv[4],
          actor:'fixture',operation:'docs.projection',idempotencyKey:'repair-key'});
        try { result={grant:store.retryAtomically('job',Date.now(),context,previous=>{
          const row=JSON.parse(previous);native.prepare('INSERT INTO retry_history(id,value) VALUES (?,?)').run(row.id+':'+row.fencingEpoch,previous);
          return JSON.stringify({retained:row.id+':'+row.fencingEpoch});
        })}; } finally {context.close();}
      }
      else if (process.argv[3] === 'claim') result = {grant:store.claim('job',Date.now())};
      else if (process.argv[3] === 'defer') result = {job:store.defer('writer-'+process.pid,'docs.projection',Date.now(),JSON.parse(process.argv[4]))};
      else if (process.argv[3] === 'resume') {
        store.claim('job',Date.now());
        const proposalJson = store.get('job').proposalJson;
        store.complete('job',{verifiedProposal:proposalJson},Date.now());
        result = {job:store.get('job')};
      } else result = {job:store.get('job')};
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
  native.exec('PRAGMA foreign_keys=ON');
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

describe('authentic durable pending work (T12265)', () => {
  it('persists original Unicode/whitespace bytes before any executor claim and resumes in a fresh process', () => {
    const store = new DurableJobStore(db, { projectId: 'project-A', actor: 'foreground' });
    const proposalJson = '{\n  "root": "/isolated/A", "text": "界 | quoted union"\n}\n';
    const pending = store.defer('job', 'docs.projection', Date.now(), { ...request, proposalJson });
    expect(pending).toMatchObject({
      status: 'pending',
      ownership: 'unclaimed',
      attempts: 0,
      fencingEpoch: 0,
      ownerId: null,
      leaseExpiresAt: null,
      claimedBy: 'foreground',
    });
    expect(readProcess().job).toMatchObject({
      proposalJson,
      proposalHash: createHash('sha256').update(proposalJson).digest('hex'),
      status: 'pending',
      attempts: 0,
    });
    const result = JSON.parse(
      execFileSync(process.execPath, [join(bundleRoot, 'client.mjs'), path, 'resume'], {
        encoding: 'utf8',
        timeout: 10_000,
      }),
    );
    expect(result.job).toMatchObject({
      status: 'complete',
      attempts: 1,
      fencingEpoch: 1,
      result: { verifiedProposal: proposalJson },
    });
    expect(readProcess().job).toMatchObject({
      status: 'complete',
      result: { verifiedProposal: proposalJson },
    });
    expect(() => store.complete('job', {}, Date.now())).toThrow(/owned/);
  });

  it('coalesces concurrent independent-process submissions into one durable pending identity', async () => {
    const args = [join(bundleRoot, 'client.mjs'), path, 'defer', JSON.stringify(request)];
    const results = await Promise.all([
      execute(process.execPath, args, { timeout: 10_000 }),
      execute(process.execPath, args, { timeout: 10_000 }),
    ]);
    const first = JSON.parse(results[0].stdout).job;
    const second = JSON.parse(results[1].stdout).job;
    expect(first.id).toBe(second.id);
    expect(first.status).toBe('pending');
    expect(second.attempts).toBe(0);
    expect(native.prepare('SELECT COUNT(*) AS n FROM background_jobs').get()?.n).toBe(1);
  });

  it('allows one independent-process claimant for authentic pending work', async () => {
    const store = new DurableJobStore(db);
    store.defer('job', 'docs.projection', Date.now(), request);
    const results = await Promise.all([
      execute(process.execPath, [join(bundleRoot, 'client.mjs'), path, 'claim'], {
        timeout: 10_000,
      }),
      execute(process.execPath, [join(bundleRoot, 'client.mjs'), path, 'claim'], {
        timeout: 10_000,
      }),
    ]);
    const parsed = results.map((result) => JSON.parse(result.stdout));
    expect(parsed.filter((result) => result.grant)).toHaveLength(1);
    expect(parsed.filter((result) => result.code === 'E_JOB_NOT_RECLAIMABLE')).toHaveLength(1);
    expect(readProcess().job).toMatchObject({ status: 'running', attempts: 1, fencingEpoch: 1 });
  });

  it('preserves scoped repeats and refuses changed inputs without modifying the original', () => {
    const store = new DurableJobStore(db);
    const original = store.defer('job', 'docs.projection', Date.now(), request);
    expect(store.defer('ignored-id', 'docs.projection', Date.now(), request)).toEqual(original);
    expect(() =>
      store.defer('other', 'docs.projection', Date.now(), {
        ...request,
        proposalJson: '{"changed":true}',
      }),
    ).toThrow(/different immutable/);
    expect(
      store.defer('project-B', 'docs.projection', Date.now(), {
        ...request,
        projectId: 'project-B',
      }).id,
    ).toBe('project-B');
    expect(store.defer('other-op', 'other.projection', Date.now(), request).id).toBe('other-op');
    expect(readProcess().job).toEqual(original);
    expect(new DurableJobStore(db, { projectId: 'project-B' }).get('job')).toBeUndefined();
    expect(() =>
      new DurableJobStore(db, { projectId: 'project-B' }).defer(
        'mismatch',
        'docs.projection',
        Date.now(),
        request,
      ),
    ).toThrow(/differs/);
  });

  it('rolls back submission state, payload and hash together on an injected insertion failure', () => {
    const store = new DurableJobStore(db);
    native.exec(
      "CREATE TRIGGER fail_pending AFTER INSERT ON background_jobs WHEN NEW.status='pending' BEGIN SELECT RAISE(ABORT,'pending insert failed'); END",
    );
    expect(() => store.defer('job', 'docs.projection', Date.now(), request)).toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({ message: 'pending insert failed' }),
      }),
    );
    expect(readProcess().job).toBeUndefined();
    expect(native.prepare('SELECT COUNT(*) AS n FROM background_jobs').get()?.n).toBe(0);
    native.exec('DROP TRIGGER fail_pending');
    expect(store.defer('job', 'docs.projection', Date.now(), request).status).toBe('pending');
  });

  it('rolls back claim state and grant when an update fails', () => {
    const store = new DurableJobStore(db);
    const pending = store.defer('job', 'docs.projection', Date.now(), request);
    native.exec(
      "CREATE TRIGGER fail_claim AFTER UPDATE ON background_jobs WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT,'claim failed'); END",
    );
    expect(() => store.claim('job', Date.now())).toThrow(
      expect.objectContaining({ cause: expect.objectContaining({ message: 'claim failed' }) }),
    );
    expect(readProcess().job).toEqual(pending);
    expect(() => store.complete('job', {}, Date.now())).toThrow(/owned/);
    native.exec('DROP TRIGGER fail_claim');
    expect(store.claim('job', Date.now()).epoch).toBe(1);
  });

  it('refuses submission inside an unrelated native transaction without rolling it back', () => {
    const store = new DurableJobStore(db);
    native.exec('BEGIN');
    expect(() => store.defer('job', 'docs.projection', Date.now(), request)).toThrow(
      /another caller/,
    );
    native.exec('ROLLBACK');
    expect(readProcess().job).toBeUndefined();
  });

  it.each([
    'missing',
    'malformed',
    'hash-mismatch',
    'ownership',
  ] as const)('retains %s pending evidence and refuses automatic reconstruction or claim', (defect) => {
    const store = new DurableJobStore(db);
    store.defer('job', 'docs.projection', Date.now(), request);
    if (defect === 'missing')
      native.exec("UPDATE background_jobs SET proposal_json=NULL WHERE id='job'");
    if (defect === 'malformed')
      native.exec("UPDATE background_jobs SET proposal_json='{' WHERE id='job'");
    if (defect === 'hash-mismatch')
      native.exec("UPDATE background_jobs SET proposal_json='{}' WHERE id='job'");
    if (defect === 'ownership') native.exec("UPDATE background_jobs SET attempts=1 WHERE id='job'");
    const before = native.prepare('SELECT * FROM background_jobs').get();
    expect(store.get('job')).toMatchObject({
      ownership: 'legacy-unknown',
      diagnosticError: expect.any(String),
    });
    expect(() => store.claim('job', Date.now())).toThrow(/proposal|ownership/);
    expect(native.prepare('SELECT * FROM background_jobs').get()).toEqual(before);
    if (defect === 'missing') {
      expect(
        store.defer('ignored', 'docs.projection', Date.now(), request).proposalJson,
      ).toBeNull();
      expect(native.prepare('SELECT * FROM background_jobs').get()).toEqual(before);
    }
  });

  it('records cancellation before execution and refuses later claims', () => {
    const store = new DurableJobStore(db);
    store.defer('job', 'docs.projection', Date.now(), request);
    expect(store.requestCancel('job', Date.now())).toBe(true);
    expect(readProcess().job).toMatchObject({ status: 'cancelled', attempts: 0, ownerId: null });
    expect(() => store.claim('job', Date.now())).toThrow(/claimed/);
  });

  it('does not launch pending retries and runs only an explicit manager resume', async () => {
    const owner = manager();
    const id = owner.deferJob('docs.projection', request);
    const executor = vi.fn(async () => ({ projected: true }));
    expect(await owner.startJob('docs.projection', executor, request)).toBe(id);
    expect(executor).not.toHaveBeenCalled();
    expect(owner.getJob(id)?.status).toBe('pending');
    await owner.resumeJob(id, executor);
    await flushed();
    expect(executor).toHaveBeenCalledTimes(1);
    expect(owner.getJob(id)).toMatchObject({
      status: 'complete',
      attempts: 1,
      result: { projected: true },
    });
    expect(owner.deferJob('docs.projection', request)).toBe(id);
    await expect(owner.resumeJob(id, executor)).rejects.toThrow(/claimed/);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('enforces the same running capacity atomically when pending work is claimed', async () => {
    const owner = new BackgroundJobManager(db, { projectId: 'project-A', maxJobs: 1 });
    managers.push(owner);
    const work = Promise.withResolvers<void>();
    const running = await owner.startJob('held', () => work.promise);
    const pending = owner.deferJob('docs.projection', request);
    const executor = vi.fn(async () => 'done');
    await expect(owner.resumeJob(pending, executor)).rejects.toThrow(/Maximum concurrent/);
    expect(owner.getJob(pending)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(executor).not.toHaveBeenCalled();
    work.resolve();
    await flushed();
    expect(owner.getJob(running)?.status).toBe('complete');
    await owner.resumeJob(pending, executor);
    await flushed();
    expect(owner.getJob(pending)?.status).toBe('complete');
  });
});

describe('shared invocation budget for pending submission, claim and cancellation', () => {
  it.each([
    'running',
    'complete',
  ] as const)('preserves %s effects when requesting scoped cancellation', (status) => {
    const store = new DurableJobStore(db, { projectId: request.projectId });
    store.defer('bounded-job', 'docs.projection', Date.now(), request);
    store.claim('bounded-job', Date.now());
    if (status === 'complete') store.complete('bounded-job', { committed: true }, Date.now());
    const context = createOperationExecutionContext({
      projectId: request.projectId,
      projectRoot: root,
      actor: 'fixture',
      operation: 'docs.projection',
      idempotencyKey: request.idempotencyKey,
    });
    try {
      expect(store.requestCancel('bounded-job', Date.now(), context)).toBe(status === 'running');
      expect(store.get('bounded-job')?.status).toBe(status);
      if (status === 'running')
        expect(store.get('bounded-job')?.cancellationRequestedAt).toEqual(expect.any(Number));
      else expect(store.get('bounded-job')?.result).toEqual({ committed: true });
    } finally {
      context.close();
    }
  });

  it.each([
    'defer',
    'claim',
    'cancel',
  ] as const)('bounds actual writer contention during %s without committing new ownership', async (phase) => {
    const store = new DurableJobStore(db, { projectId: request.projectId });
    if (phase !== 'defer') store.defer('bounded-job', 'docs.projection', Date.now(), request);
    native.exec('PRAGMA busy_timeout=3000');
    const child = execFile(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { DatabaseSync } from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');process.stdout.write('locked');setTimeout(()=>{db.exec('ROLLBACK');db.close()},500);",
        path,
      ],
      { timeout: 5000 },
    );
    const finished = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Writer exit ${code}`)),
      );
    });
    if (!child.stdout) throw new Error('Missing writer readiness stream');
    await new Promise<void>((resolve, reject) => {
      child.stdout?.once('data', () => resolve());
      child.once('error', reject);
    });
    const context = createOperationExecutionContext(
      {
        projectId: request.projectId,
        projectRoot: root,
        actor: 'fixture',
        operation: 'docs.projection',
        idempotencyKey: request.idempotencyKey,
      },
      { budgetMs: 30 },
    );
    const startedAt = Date.now();
    try {
      expect(() =>
        phase === 'claim'
          ? store.claim('bounded-job', Date.now(), undefined, context)
          : phase === 'cancel'
            ? store.requestCancel('bounded-job', Date.now(), context)
            : store.defer('bounded-job', 'docs.projection', Date.now(), request, context),
      ).toThrow();
      expect(Date.now() - startedAt).toBeLessThan(300);
      expect(native.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(3000);
      if (phase !== 'defer')
        expect(store.get('bounded-job')).toMatchObject({ status: 'pending', attempts: 0 });
      else expect(store.get('bounded-job')).toBeUndefined();
    } finally {
      context.close();
      await finished;
    }
  });

  it.each([
    'defer',
    'claim',
    'cancel',
  ] as const)('refuses expired %s before any BEGIN and retains the original deadline', (phase) => {
    const store = new DurableJobStore(db, { projectId: request.projectId });
    if (phase !== 'defer') store.defer('bounded-job', 'docs.projection', Date.now(), request);
    const context = createOperationExecutionContext(
      {
        projectId: request.projectId,
        projectRoot: root,
        actor: 'fixture',
        operation: 'docs.projection',
        idempotencyKey: request.idempotencyKey,
      },
      { budgetMs: 0 },
    );
    const run = vi.spyOn(db, 'run');
    try {
      expect(() =>
        phase === 'claim'
          ? store.claim('bounded-job', Date.now(), undefined, context)
          : phase === 'cancel'
            ? store.requestCancel('bounded-job', Date.now(), context)
            : store.defer('bounded-job', 'docs.projection', Date.now(), request, context),
      ).toThrow();
      expect(run).not.toHaveBeenCalled();
      if (phase !== 'defer')
        expect(store.get('bounded-job')).toMatchObject({ status: 'pending', attempts: 0 });
      else expect(store.get('bounded-job')).toBeUndefined();
    } finally {
      context.close();
    }
  });

  it.each([
    'defer',
    'claim',
    'cancel',
  ] as const)('rolls back %s when cancellation or deadline arrives before commit', (phase) => {
    native.exec('PRAGMA busy_timeout=3000');
    for (const stop of ['cancel', 'deadline'] as const) {
      const id = `bounded-${stop}`;
      const submission = { ...request, idempotencyKey: id };
      const store = new DurableJobStore(db, { projectId: request.projectId });
      if (phase !== 'defer') store.defer(id, 'docs.projection', Date.now(), submission);
      const context = createOperationExecutionContext({
        projectId: request.projectId,
        projectRoot: root,
        actor: 'fixture',
        operation: 'docs.projection',
        idempotencyKey: id,
      });
      native.function('stop_invocation', () => {
        if (stop === 'cancel') context.close();
        else {
          vi.useFakeTimers();
          vi.setSystemTime(context.deadlineAt + 1);
        }
        return 0;
      });
      native.exec(
        `CREATE TEMP TRIGGER stop_invocation_trigger AFTER ${phase === 'claim' ? 'UPDATE OF owner_id' : phase === 'cancel' ? 'UPDATE OF cancellation_requested_at' : 'INSERT'} ON background_jobs BEGIN SELECT stop_invocation(); END`,
      );
      try {
        expect(() =>
          phase === 'claim'
            ? store.claim(id, Date.now(), undefined, context)
            : phase === 'cancel'
              ? store.requestCancel(id, Date.now(), context)
              : store.defer(id, 'docs.projection', Date.now(), submission, context),
        ).toThrow();
        if (phase !== 'defer')
          expect(store.get(id)).toMatchObject({ status: 'pending', attempts: 0 });
        else expect(store.get(id)).toBeUndefined();
        expect(native.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(3000);
      } finally {
        context.close();
        vi.useRealTimers();
        native.exec('DROP TRIGGER stop_invocation_trigger');
      }
    }
  });

  it.each([
    'defer',
    'claim',
    'cancel',
  ] as const)('reports committed %s despite cancellation observed after commit', (phase) => {
    const store = new DurableJobStore(db, { projectId: request.projectId });
    if (phase !== 'defer') store.defer('bounded-job', 'docs.projection', Date.now(), request);
    const context = createOperationExecutionContext({
      projectId: request.projectId,
      projectRoot: root,
      actor: 'fixture',
      operation: 'docs.projection',
      idempotencyKey: request.idempotencyKey,
    });
    const run = db.run.bind(db);
    vi.spyOn(db, 'run').mockImplementation((query) => {
      const result = run(query);
      const fresh = new DatabaseSync(path, { readOnly: true });
      try {
        if (
          fresh.prepare("SELECT status FROM background_jobs WHERE id='bounded-job'").get()
            ?.status ===
          (phase === 'claim' ? 'running' : phase === 'cancel' ? 'cancelled' : 'pending')
        )
          context.close();
      } finally {
        fresh.close();
      }
      return result;
    });
    try {
      const result =
        phase === 'claim'
          ? store.claim('bounded-job', Date.now(), undefined, context)
          : phase === 'cancel'
            ? store.requestCancel('bounded-job', Date.now(), context)
            : store.defer('bounded-job', 'docs.projection', Date.now(), request, context);
      expect(result).toBeDefined();
      expect(context.signal.aborted).toBe(true);
      expect(store.get('bounded-job')).toMatchObject({
        status: phase === 'claim' ? 'running' : phase === 'cancel' ? 'cancelled' : 'pending',
        attempts: phase === 'claim' ? 1 : 0,
      });
    } finally {
      context.close();
    }
  });

  it.each([
    'defer',
    'claim',
    'cancel',
  ] as const)('rejects a mismatched %s invocation without borrowing its identity', (phase) => {
    const store = new DurableJobStore(db, { projectId: request.projectId });
    if (phase !== 'defer') store.defer('bounded-job', 'docs.projection', Date.now(), request);
    const context = createOperationExecutionContext({
      projectId: 'other-project',
      projectRoot: root,
      actor: 'fixture',
      operation: 'docs.projection',
      idempotencyKey: request.idempotencyKey,
    });
    try {
      expect(() =>
        phase === 'claim'
          ? store.claim('bounded-job', Date.now(), undefined, context)
          : phase === 'cancel'
            ? store.requestCancel('bounded-job', Date.now(), context)
            : store.defer('bounded-job', 'docs.projection', Date.now(), request, context),
      ).toThrow('Invocation differs');
      if (phase !== 'defer')
        expect(store.get('bounded-job')).toMatchObject({ status: 'pending', attempts: 0 });
      else expect(store.get('bounded-job')).toBeUndefined();
    } finally {
      context.close();
    }
  });
});

describe('explicit terminal retry composition', () => {
  function terminal(status: 'failed' | 'cancelled' | 'interrupted' = 'failed') {
    native.exec(
      'PRAGMA foreign_keys=ON; CREATE TABLE retry_history(id TEXT PRIMARY KEY,value TEXT NOT NULL)',
    );
    const store = new DurableJobStore(db, { projectId: request.projectId, actor: 'fixture' });
    store.defer('job', 'docs.projection', Date.now(), request);
    store.claim('job', Date.now());
    store.checkpoint('job', '{"stage":"verified input"}', Date.now());
    if (status === 'failed') store.fail('job', 'Original observed failure', Date.now());
    else {
      store.requestCancel('job', Date.now());
      if (status === 'interrupted')
        native.exec("UPDATE background_jobs SET lease_expires_at=0 WHERE id='job'");
      else store.cancel('job', Date.now());
    }
    return store;
  }
  function invocation(budgetMs = 2000) {
    return createOperationExecutionContext(
      {
        projectId: request.projectId,
        projectRoot: root,
        actor: 'fixture',
        operation: 'docs.projection',
        idempotencyKey: request.idempotencyKey,
      },
      { budgetMs },
    );
  }
  function retain(previous: string) {
    native.prepare('INSERT INTO retry_history(id,value) VALUES (?,?)').run('job:1', previous);
    return '{"retained":"job:1"}';
  }

  it.each([
    'failed',
    'cancelled',
    'interrupted',
  ] as const)('retains the complete %s attempt before a fresh fenced claim', (status) => {
    const store = terminal(status);
    const old = store.get('job')!;
    const context = invocation();
    try {
      const lease = store.retryAtomically('job', Date.now(), context, retain);
      expect(lease.epoch).toBe(old.fencingEpoch + 1);
      expect(store.get('job')).toMatchObject({
        status: 'running',
        attempts: 2,
        checkpointJson: old.checkpointJson,
        cancellationRequestedAt: null,
      });
      const fresh = new DatabaseSync(path, { readOnly: true });
      try {
        const prior = JSON.parse(
          String(fresh.prepare('SELECT value FROM retry_history').get()?.value),
        );
        expect(prior).toMatchObject({
          id: 'job',
          status: status === 'interrupted' ? 'running' : status,
          attempts: 1,
          fencingEpoch: 1,
          ownerId: old.ownerId,
          checkpointJson: old.checkpointJson,
          proposalJson: request.proposalJson,
          proposalHash: old.proposalHash,
          cancellationRequestedAt: old.cancellationRequestedAt,
          error: old.error ?? null,
          completedAt: old.completedAt ? Date.parse(old.completedAt) : null,
        });
        expect(
          fresh
            .prepare(
              "SELECT attempts,status,result,error,completed_at FROM background_jobs WHERE id='job'",
            )
            .get(),
        ).toMatchObject({
          attempts: 2,
          status: 'running',
          result: null,
          error: null,
          completed_at: null,
        });
      } finally {
        fresh.close();
      }
    } finally {
      context.close();
    }
  });

  it.each([
    'history',
    'claim',
    'stale-source',
    'cancel',
    'promise',
    'changed-job',
  ] as const)('rolls back both retained outcome and new ownership on %s fault', (fault) => {
    const store = terminal();
    const old = store.get('job');
    const context = invocation();
    if (fault === 'claim')
      native.exec(
        "CREATE TEMP TRIGGER reject_retry BEFORE UPDATE OF owner_id ON background_jobs BEGIN SELECT RAISE(ABORT,'claim fault'); END",
      );
    if (fault === 'history')
      native.exec(
        "CREATE TEMP TRIGGER reject_history BEFORE INSERT ON retry_history BEGIN SELECT RAISE(ABORT,'history fault'); END",
      );
    try {
      expect(() =>
        Reflect.apply(store.retryAtomically, store, [
          'job',
          Date.now(),
          context,
          (previous: string) => {
            const result = retain(previous);
            if (fault === 'stale-source')
              throw new Error('Independent domain precondition changed');
            if (fault === 'cancel') context.close();
            if (fault === 'changed-job')
              native.exec("UPDATE background_jobs SET proposal_json='{}' WHERE id='job'");
            return fault === 'promise' ? Promise.resolve(result) : result;
          },
        ]),
      ).toThrow();
      expect(store.get('job')).toEqual(old);
      expect(native.prepare('SELECT * FROM retry_history').all()).toEqual([]);
    } finally {
      context.close();
    }
  });

  it('refuses expired attempts instead of renewing their deadline', () => {
    const store = terminal();
    const context = invocation(0);
    const retained = vi.fn(retain);
    try {
      expect(() => store.retryAtomically('job', Date.now(), context, retained)).toThrow();
      expect(retained).not.toHaveBeenCalled();
      expect(store.get('job')?.status).toBe('failed');
    } finally {
      context.close();
    }
  });

  it('fences the previous owner after retaining an uncertain interrupted attempt', () => {
    const oldOwner = terminal('interrupted');
    const before = oldOwner.get('job')!;
    const next = new DurableJobStore(db, { projectId: request.projectId, actor: 'resuming-agent' });
    const context = invocation();
    try {
      const grant = next.retryAtomically('job', Date.now(), context, retain);
      expect(grant.ownerId).not.toBe(before.ownerId);
      expect(() => oldOwner.complete('job', { late: true }, Date.now())).toThrow();
      const retained = JSON.parse(
        String(native.prepare('SELECT value FROM retry_history').get()?.value),
      );
      expect(retained).toMatchObject({
        status: 'running',
        error: null,
        completedAt: null,
        ownerId: before.ownerId,
        checkpointJson: before.checkpointJson,
        cancellationRequestedAt: before.cancellationRequestedAt,
      });
      expect(next.get('job')).toMatchObject({
        status: 'running',
        fencingEpoch: 2,
        cancellationRequestedAt: null,
      });
    } finally {
      context.close();
    }
  });

  it.each([
    'history',
    'claim',
  ] as const)('preserves interrupted ownership and checkpoint on recovery %s fault', (fault) => {
    const store = terminal('interrupted');
    const before = store.get('job');
    const context = invocation();
    native.exec(
      fault === 'history'
        ? "CREATE TEMP TRIGGER refuse_history BEFORE INSERT ON retry_history BEGIN SELECT RAISE(ABORT,'history fault'); END"
        : "CREATE TEMP TRIGGER refuse_claim BEFORE UPDATE OF owner_id ON background_jobs BEGIN SELECT RAISE(ABORT,'claim fault'); END",
    );
    try {
      expect(() => store.retryAtomically('job', Date.now(), context, retain)).toThrow();
      expect(store.get('job')).toEqual(before);
      expect(native.prepare('SELECT * FROM retry_history').all()).toEqual([]);
    } finally {
      context.close();
    }
  });

  it('refuses already committed work without appending retry history or reapplying effects', () => {
    const store = terminal();
    const context = invocation();
    store.retryAtomically('job', Date.now(), context, retain);
    store.complete('job', { committed: 'original effect' }, Date.now());
    const retained = vi.fn(retain);
    const before = store.get('job');
    try {
      expect(() => store.retryAtomically('job', Date.now(), context, retained)).toThrow(
        'committed effects cannot be reopened',
      );
      expect(retained).not.toHaveBeenCalled();
      expect(store.get('job')).toEqual(before);
      expect(native.prepare('SELECT * FROM retry_history').all()).toHaveLength(1);
    } finally {
      context.close();
    }
  });

  it('returns the committed new claim when cancellation is observed after retry commit', () => {
    const store = terminal();
    const context = invocation();
    const run = db.run.bind(db);
    vi.spyOn(db, 'run').mockImplementation((query) => {
      const result = run(query);
      const fresh = new DatabaseSync(path, { readOnly: true });
      try {
        if (
          fresh.prepare("SELECT status FROM background_jobs WHERE id='job'").get()?.status ===
          'running'
        )
          context.close();
      } finally {
        fresh.close();
      }
      return result;
    });
    try {
      const grant = store.retryAtomically('job', Date.now(), context, retain);
      expect(grant.epoch).toBe(2);
      expect(context.signal.aborted).toBe(true);
      expect(store.get('job')?.status).toBe('running');
      expect(native.prepare('SELECT * FROM retry_history').all()).toHaveLength(1);
    } finally {
      context.close();
    }
  });

  it.each([
    'failed',
    'interrupted',
  ] as const)('lets exactly one independent resume process claim the %s attempt', async (status) => {
    terminal(status);
    const results = await Promise.all([
      execute(process.execPath, [join(bundleRoot, 'client.mjs'), path, 'retry', root], {
        timeout: 10000,
      }),
      execute(process.execPath, [join(bundleRoot, 'client.mjs'), path, 'retry', root], {
        timeout: 10000,
      }),
    ]);
    const outcomes = results.map((result) => JSON.parse(result.stdout));
    expect(outcomes.filter((result) => result.grant)).toHaveLength(1);
    expect(outcomes.filter((result) => result.code === 'E_JOB_NOT_RECLAIMABLE')).toHaveLength(1);
    expect(native.prepare('SELECT * FROM retry_history').all()).toHaveLength(1);
    expect(
      native
        .prepare("SELECT status,attempts,fencing_epoch FROM background_jobs WHERE id='job'")
        .get(),
    ).toMatchObject({ status: 'running', attempts: 2, fencing_epoch: 2 });
  });
});

describe('domain writes fenced by persisted job authority', () => {
  function prepare() {
    const store = new DurableJobStore(db, { projectId: request.projectId, actor: 'fixture' });
    const job = store.defer('guarded-job', 'docs.projection', Date.now(), request);
    const lease = store.claim(job.id, Date.now());
    const context = createOperationExecutionContext(
      {
        projectId: request.projectId,
        projectRoot: root,
        actor: 'fixture',
        operation: 'docs.projection',
        idempotencyKey: request.idempotencyKey,
      },
      {
        writeFence: {
          dbPath: path,
          proposalHash: createHash('sha256').update(request.proposalJson).digest('hex'),
          lease,
        },
      },
    );
    native.exec('CREATE TABLE guarded_domain (id TEXT PRIMARY KEY)');
    return { store, context };
  }

  it.each([
    'owned',
    'stale',
    'mismatched',
  ] as const)('permits cancelled claim bookkeeping only with %s persisted authority', (kind) => {
    const context = createOperationExecutionContext({
      projectId: request.projectId,
      projectRoot: root,
      actor: 'fixture',
      operation: 'docs.projection',
      idempotencyKey: request.idempotencyKey,
    });
    const store = new DurableJobStore(db, { projectId: request.projectId, actor: 'fixture' });
    const job = store.defer('outcome-binding-job', 'docs.projection', Date.now(), request);
    const originalClaim = store.claim.bind(store);
    vi.spyOn(store, 'claim').mockImplementation((...args) => {
      const lease = originalClaim(...args);
      context.close();
      return lease;
    });
    const lease = store.claim(job.id, Date.now());
    if (kind === 'stale') native.exec('UPDATE background_jobs SET fencing_epoch=fencing_epoch+1');
    const execution = bindOperationWriteFence(
      context,
      {
        lease,
        dbPath: path,
        proposalHash:
          kind === 'mismatched'
            ? 'f'.repeat(64)
            : createHash('sha256').update(request.proposalJson).digest('hex'),
      },
      true,
    );
    const domain = vi.fn(() => '{}');
    expect(() => store.completeAtomically(execution, domain)).toThrow();
    expect(() => assertOperationWriteFence(native, execution)).toThrow();
    expect(domain).not.toHaveBeenCalled();
    const metadata = vi.fn(() => '{"observed":"cancelled"}');
    const result = store.finalizeAtomically(
      execution,
      { status: 'cancelled', message: 'Cancellation observed during claim' },
      metadata,
    );
    if (kind === 'owned') {
      expect(result).toMatchObject({ state: 'finalized' });
      expect(metadata).toHaveBeenCalledTimes(1);
      expect(store.get(job.id)?.status).toBe('cancelled');
    } else {
      expect(result).toMatchObject({ state: 'pending-finalization' });
      expect(metadata).not.toHaveBeenCalled();
      expect(store.get(job.id)?.status).toBe('running');
    }
    expect(execution.deadlineAt).toBe(context.deadlineAt);
    expect(execution.signal).toBe(context.signal);
  });

  it.each([
    'failed',
    'cancelled',
  ] as const)('commits observed %s metadata with the terminal row and preserves the domain', (status) => {
    const { store, context } = prepare();
    expect(native.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    native.exec(
      "CREATE TABLE attempt_events (id TEXT PRIMARY KEY, job_id TEXT NOT NULL DEFAULT 'guarded-job' REFERENCES background_jobs(id))",
    );
    native.exec('PRAGMA busy_timeout=700');
    if (status === 'cancelled') context.close();
    try {
      const result = store.finalizeAtomically(
        context,
        { status, message: 'observed fixture outcome' },
        () => {
          native.exec("INSERT INTO attempt_events(id) VALUES ('observed')");
          return '{"event":"observed"}';
        },
      );
      expect(result).toMatchObject({
        state: 'finalized',
        resultJson: '{"event":"observed"}',
        deadlineExceeded: false,
      });
      expect(native.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(700);
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(process.argv[1],{readOnly:true}); process.stdout.write(JSON.stringify({job:db.prepare('SELECT status,result FROM background_jobs').get(),events:db.prepare('SELECT * FROM attempt_events').all(),domain:db.prepare('SELECT * FROM guarded_domain').all()})); db.close();",
          path,
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      expect(JSON.parse(output)).toEqual({
        job: { status, result: '{"event":"observed"}' },
        events: [{ id: 'observed', job_id: 'guarded-job' }],
        domain: [],
      });
    } finally {
      context.close();
    }
  });

  it('does not begin finalization or call bookkeeping after the original deadline', () => {
    const { store, context } = prepare();
    const bookkeeping = vi.fn(() => '{}');
    native.exec('PRAGMA busy_timeout=700');
    vi.useFakeTimers();
    vi.setSystemTime(context.deadlineAt + 1);
    const run = vi.spyOn(db, 'run');
    expect(
      store.finalizeAtomically(
        context,
        { status: 'failed', message: 'observed failure' },
        bookkeeping,
      ),
    ).toMatchObject({ state: 'pending-finalization', deadlineExceeded: true });
    expect(bookkeeping).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(native.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(700);
    expect(store.get('guarded-job')?.status).toBe('running');
    context.close();
  });

  it.each([
    'receipt',
    'job',
    'promise',
    'deadline',
    'fence',
  ] as const)('keeps receipt and terminal state atomic on %s bookkeeping fault', (fault) => {
    const { store, context } = prepare();
    native.exec(
      "CREATE TABLE attempt_events (id TEXT PRIMARY KEY, job_id TEXT NOT NULL DEFAULT 'guarded-job' REFERENCES background_jobs(id))",
    );
    native.exec('PRAGMA busy_timeout=700');
    if (fault === 'job')
      native.exec(
        "CREATE TRIGGER fail_outcome BEFORE UPDATE OF status ON background_jobs WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'receipt fault'); END",
      );
    try {
      const result = Reflect.apply(store.finalizeAtomically, store, [
        context,
        { status: 'failed', message: 'observed failure' },
        () => {
          native.exec("INSERT INTO attempt_events(id) VALUES ('event')");
          if (fault === 'receipt') native.exec("INSERT INTO attempt_events(id) VALUES ('event')");
          if (fault === 'deadline') {
            vi.useFakeTimers();
            vi.setSystemTime(context.deadlineAt + 1);
          }
          if (fault === 'fence')
            native.exec('UPDATE background_jobs SET fencing_epoch=fencing_epoch+1');
          return fault === 'promise' ? Promise.resolve('{}') : '{}';
        },
      ]);
      expect(result).toMatchObject({ state: 'pending-finalization' });
      expect(native.prepare('SELECT * FROM attempt_events').all()).toEqual([]);
      expect(native.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(700);
      expect(store.get('guarded-job')).toMatchObject({ status: 'running', fencingEpoch: 1 });
    } finally {
      context.close();
    }
  });

  it('refuses a borrowed transaction without rolling it back and restores its timeout', () => {
    const { store, context } = prepare();
    native.exec("PRAGMA busy_timeout=700; BEGIN; INSERT INTO guarded_domain VALUES ('caller')");
    const bookkeeping = vi.fn(() => '{}');
    try {
      expect(
        store.finalizeAtomically(
          context,
          { status: 'failed', message: 'observed failure' },
          bookkeeping,
        ),
      ).toMatchObject({
        state: 'pending-finalization',
        reason: expect.stringContaining('another caller owns'),
      });
      expect(bookkeeping).not.toHaveBeenCalled();
      expect(native.prepare('SELECT id FROM guarded_domain').get()?.id).toBe('caller');
      expect(native.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(700);
      native.exec('ROLLBACK');
    } finally {
      context.close();
    }
  });

  it('does not overwrite an independently changed native timeout', () => {
    const { store, context } = prepare();
    native.exec('PRAGMA busy_timeout=700');
    try {
      expect(
        store.finalizeAtomically(context, { status: 'failed', message: 'observed failure' }, () => {
          native.exec('PRAGMA busy_timeout=123');
          return '{}';
        }),
      ).toMatchObject({
        state: 'pending-finalization',
        reason: expect.stringContaining('lock policy'),
      });
      expect(native.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(123);
      expect(store.get('guarded-job')?.status).toBe('running');
    } finally {
      context.close();
    }
  });

  it.each(['cancel', 'deadline'] as const)('does not invoke domain repair after %s', (kind) => {
    const { store, context } = prepare();
    const mutate = vi.fn(() => '{}');
    if (kind === 'cancel') context.close();
    else {
      vi.useFakeTimers();
      vi.setSystemTime(context.deadlineAt + 1);
    }
    try {
      expect(() => store.completeAtomically(context, mutate)).toThrow();
      expect(mutate).not.toHaveBeenCalled();
    } finally {
      context.close();
    }
  });

  it.each([
    'expired',
    'stolen',
    'proposal',
    'error-rewritten',
    'unrequested-cancel',
  ] as const)('preserves pending inspection for %s finalization', (kind) => {
    const { store, context } = prepare();
    const bookkeeping = vi.fn(() => '{}');
    if (kind === 'expired' || kind === 'stolen')
      native.exec('UPDATE background_jobs SET lease_expires_at=0');
    if (kind === 'stolen')
      new DurableJobStore(db, { projectId: request.projectId }).claim('guarded-job', Date.now());
    if (kind === 'proposal') native.exec("UPDATE background_jobs SET proposal_json='{}'");
    if (kind === 'error-rewritten')
      native.exec(
        "CREATE TRIGGER rewrite_outcome AFTER UPDATE OF status ON background_jobs WHEN NEW.status='failed' BEGIN UPDATE background_jobs SET error='fabricated' WHERE id=NEW.id; END",
      );
    try {
      expect(
        store.finalizeAtomically(
          context,
          { status: kind === 'unrequested-cancel' ? 'cancelled' : 'failed', message: 'observed' },
          bookkeeping,
        ),
      ).toMatchObject({ state: 'pending-finalization' });
      expect(store.get('guarded-job')?.status).toBe('running');
      if (kind !== 'error-rewritten') expect(bookkeeping).not.toHaveBeenCalled();
    } finally {
      context.close();
    }
  });

  it('does not accept a temporary-table cancellation as main authority', () => {
    const { store, context } = prepare();
    native.exec('CREATE TEMP TABLE background_jobs AS SELECT * FROM main.background_jobs');
    native.exec('UPDATE temp.background_jobs SET cancellation_requested_at=1');
    const bookkeeping = vi.fn(() => '{}');
    try {
      expect(
        store.finalizeAtomically(
          context,
          { status: 'cancelled', message: 'unsupported cancellation' },
          bookkeeping,
        ),
      ).toMatchObject({ state: 'pending-finalization' });
      expect(bookkeeping).not.toHaveBeenCalled();
    } finally {
      context.close();
    }
  });

  it('bounds contention with a separate writer and restores the original timeout on BEGIN failure', async () => {
    const { store, context } = prepare();
    native.exec('PRAGMA busy_timeout=3000');
    const child = execFile(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked'); setTimeout(()=>{db.exec('ROLLBACK');db.close()},500);",
        path,
      ],
      { timeout: 5000 },
    );
    const finished = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Writer exit ${code}`)),
      );
    });
    if (!child.stdout) throw new Error('Missing writer readiness stream');
    await new Promise<void>((resolve, reject) => {
      child.stdout?.once('data', () => resolve());
      child.once('error', reject);
    });
    const bounded = createOperationExecutionContext(context.identity, {
      budgetMs: 30,
      writeFence: context.writeFence,
    });
    const bookkeeping = vi.fn(() => '{}');
    try {
      const result = store.finalizeAtomically(
        bounded,
        { status: 'failed', message: 'observed failure' },
        bookkeeping,
      );
      expect(result).toMatchObject({ state: 'pending-finalization' });
      expect(result.elapsedMs).toBeLessThan(300);
      expect(bookkeeping).not.toHaveBeenCalled();
      expect(native.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(3000);
      expect(store.get('guarded-job')?.status).toBe('running');
    } finally {
      bounded.close();
      context.close();
      await finished;
    }
  });

  it('retains committed finalization when cancellation and deadline are observed after COMMIT', () => {
    const { store, context } = prepare();
    const run = db.run.bind(db);
    vi.spyOn(db, 'run').mockImplementation((query) => {
      const result = run(query);
      const fresh = new DatabaseSync(path, { readOnly: true });
      try {
        if (fresh.prepare('SELECT status FROM background_jobs').get()?.status === 'failed') {
          context.close();
          vi.useFakeTimers();
          vi.setSystemTime(context.deadlineAt + 1);
        }
      } finally {
        fresh.close();
      }
      return result;
    });
    try {
      expect(
        store.finalizeAtomically(context, { status: 'failed', message: 'observed' }, () => '{}'),
      ).toMatchObject({ state: 'finalized', resultJson: '{}', deadlineExceeded: true });
      expect(store.get('guarded-job')?.status).toBe('failed');
    } finally {
      context.close();
    }
  });

  it('reports a postcommit timeout cleanup failure without inventing an uncommitted outcome', () => {
    const { store, context } = prepare();
    const run = db.run.bind(db);
    let callsAfterCommit = 0;
    vi.spyOn(db, 'run').mockImplementation((query) => {
      const fresh = new DatabaseSync(path, { readOnly: true });
      let committed = false;
      try {
        committed = fresh.prepare('SELECT status FROM background_jobs').get()?.status === 'failed';
      } finally {
        fresh.close();
      }
      if (committed && ++callsAfterCommit === 1) throw new Error('timeout cleanup fault');
      return run(query);
    });
    try {
      expect(
        store.finalizeAtomically(context, { status: 'failed', message: 'observed' }, () => '{}'),
      ).toMatchObject({
        state: 'finalized',
        resultJson: '{}',
        cleanupError: expect.stringContaining('timeout cleanup fault'),
      });
      expect(store.get('guarded-job')).toMatchObject({
        status: 'failed',
        diagnosticError: expect.stringContaining('timeout cleanup fault'),
      });
    } finally {
      context.close();
    }
  });

  it('commits domain rows, domain receipt and job outcome together, visible to a fresh process', () => {
    const { store, context } = prepare();
    native.exec('CREATE TABLE domain_receipts (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    try {
      const receipt = '{"verified":"atomic"}';
      expect(
        store.completeAtomically(context, (captured) => {
          expect(captured).toBe(context);
          native.prepare('INSERT INTO guarded_domain VALUES (?)').run('atomic');
          native.prepare('INSERT INTO domain_receipts VALUES (?,?)').run('receipt', receipt);
          return receipt;
        }),
      ).toBe(receipt);
      const output = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { DatabaseSync } from 'node:sqlite';
        const db = new DatabaseSync(process.argv[1], {readOnly:true});
        process.stdout.write(JSON.stringify({
          rows: db.prepare('SELECT * FROM guarded_domain').all(),
          receipts: db.prepare('SELECT * FROM domain_receipts').all(),
          job: db.prepare('SELECT status,result FROM background_jobs').get()
        }));
        db.close();
      `,
          path,
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      expect(JSON.parse(output)).toEqual({
        rows: [{ id: 'atomic' }],
        receipts: [{ id: 'receipt', payload: receipt }],
        job: { status: 'complete', result: receipt },
      });
      expect(() => store.completeAtomically(context, () => receipt)).toThrow(/not owned/);
    } finally {
      context.close();
    }
  });

  it.each([
    'domain-receipt',
    'job-receipt',
    'invalid-json',
    'cancel',
    'deadline',
    'authority',
  ] as const)('rolls back all owned changes on %s failure and leaves the attempt inspectable', (fault) => {
    const { store, context } = prepare();
    native.exec('CREATE TABLE domain_receipts (id TEXT PRIMARY KEY)');
    if (fault === 'job-receipt')
      native.exec(`CREATE TRIGGER fail_terminal BEFORE UPDATE OF status
        ON background_jobs WHEN NEW.status='complete' BEGIN SELECT RAISE(ABORT,'terminal fault'); END`);
    try {
      expect(() =>
        store.completeAtomically(context, () => {
          native.exec("INSERT INTO guarded_domain VALUES ('atomic')");
          native.exec("INSERT INTO domain_receipts VALUES ('receipt')");
          if (fault === 'domain-receipt')
            native.exec("INSERT INTO domain_receipts VALUES ('receipt')");
          if (fault === 'cancel') context.close();
          if (fault === 'deadline') {
            vi.useFakeTimers();
            vi.setSystemTime(context.deadlineAt + 1);
          }
          if (fault === 'authority')
            native.exec('UPDATE background_jobs SET fencing_epoch=fencing_epoch+1');
          return fault === 'invalid-json' ? 'not json' : '{"verified":true}';
        }),
      ).toThrow();
      expect(native.prepare('SELECT * FROM guarded_domain').all()).toEqual([]);
      expect(native.prepare('SELECT * FROM domain_receipts').all()).toEqual([]);
      expect(store.get('guarded-job')).toMatchObject({
        status: 'running',
        fencingEpoch: 1,
      });
      expect(store.get('guarded-job')?.result).toBeUndefined();
    } finally {
      context.close();
    }
  });

  it.each([
    'cancel',
    'expire',
    'steal',
    'missing-fence',
  ] as const)('refuses %s before invoking an atomic domain mutation', (fault) => {
    const { store, context } = prepare();
    const unfenced = createOperationExecutionContext(context.identity);
    const mutate = vi.fn(() => '{}');
    try {
      if (fault === 'cancel') store.requestCancel('guarded-job', Date.now());
      if (fault === 'expire' || fault === 'steal')
        native.exec('UPDATE background_jobs SET lease_expires_at=0');
      if (fault === 'steal')
        new DurableJobStore(db, { projectId: request.projectId }).claim('guarded-job', Date.now());
      expect(() =>
        store.completeAtomically(fault === 'missing-fence' ? unfenced : context, mutate),
      ).toThrow();
      expect(mutate).not.toHaveBeenCalled();
      expect(store.get('guarded-job')?.status).toBe('running');
    } finally {
      context.close();
      unfenced.close();
    }
  });

  it.each([
    'cancel',
    'proposal',
    'result',
  ] as const)('rejects terminal trigger changes to %s and rolls back the complete unit', (fault) => {
    const { store, context } = prepare();
    const change =
      fault === 'cancel'
        ? 'cancellation_requested_at=1'
        : fault === 'proposal'
          ? "proposal_json='{}'"
          : "result='{}'";
    native.exec(`CREATE TRIGGER alter_terminal AFTER UPDATE OF status ON background_jobs
        WHEN NEW.status='complete' BEGIN UPDATE background_jobs SET ${change} WHERE id=NEW.id; END`);
    try {
      expect(() =>
        store.completeAtomically(context, () => {
          native.exec("INSERT INTO guarded_domain VALUES ('forbidden')");
          return '{"verified":true}';
        }),
      ).toThrow('Domain write refused');
      expect(native.prepare('SELECT * FROM guarded_domain').all()).toEqual([]);
      expect(store.get('guarded-job')).toMatchObject({
        status: 'running',
        cancellationRequestedAt: null,
        proposalJson: request.proposalJson,
      });
      expect(store.get('guarded-job')?.result).toBeUndefined();
    } finally {
      context.close();
    }
  });

  it('rejects a runtime Promise result and rolls back writes made before return', () => {
    const { store, context } = prepare();
    try {
      expect(() =>
        Reflect.apply(store.completeAtomically, store, [
          context,
          () => {
            native.exec("INSERT INTO guarded_domain VALUES ('uncommitted')");
            return Promise.resolve('{"verified":true}');
          },
        ]),
      ).toThrow('must contain serialized JSON bytes');
      expect(native.prepare('SELECT * FROM guarded_domain').all()).toEqual([]);
      expect(store.get('guarded-job')?.status).toBe('running');
    } finally {
      context.close();
    }
  });

  it('does not borrow or roll back a transaction owned by another caller', () => {
    const { store, context } = prepare();
    native.exec("BEGIN; INSERT INTO guarded_domain VALUES ('caller')");
    const mutate = vi.fn(() => '{}');
    try {
      expect(() => store.completeAtomically(context, mutate)).toThrow('another caller owns');
      expect(mutate).not.toHaveBeenCalled();
      expect(native.prepare('SELECT id FROM guarded_domain').get()?.id).toBe('caller');
      native.exec('ROLLBACK');
      expect(native.prepare('SELECT * FROM guarded_domain').all()).toEqual([]);
    } finally {
      context.close();
    }
  });

  it('reports committed success when cancellation arrives immediately after COMMIT', () => {
    const { store, context } = prepare();
    const run = db.run.bind(db);
    vi.spyOn(db, 'run').mockImplementation((query) => {
      const result = run(query);
      if (
        native.prepare("SELECT status FROM background_jobs WHERE id='guarded-job'").get()
          ?.status === 'complete'
      ) {
        // A separate connection only sees the terminal row after COMMIT.
        const fresh = new DatabaseSync(path, { readOnly: true });
        try {
          if (
            fresh.prepare("SELECT status FROM background_jobs WHERE id='guarded-job'").get()
              ?.status === 'complete'
          )
            context.close();
        } finally {
          fresh.close();
        }
      }
      return result;
    });
    try {
      expect(
        store.completeAtomically(context, () => {
          native.exec("INSERT INTO guarded_domain VALUES ('committed')");
          return '{}';
        }),
      ).toBe('{}');
      expect(context.signal.aborted).toBe(true);
      expect(store.get('guarded-job')?.status).toBe('complete');
      expect(native.prepare('SELECT id FROM guarded_domain').get()?.id).toBe('committed');
    } finally {
      context.close();
    }
  });

  it('composes a checked domain mutation with its receipt in one caller-owned transaction', () => {
    const { context } = prepare();
    try {
      db.transaction((tx) => {
        assertOperationWriteFence(tx, context);
        tx.run(sql`INSERT INTO guarded_domain VALUES ('committed')`);
        tx.run(
          sql`UPDATE main.background_jobs SET checkpoint_json = '{"verified":"committed"}' WHERE id='guarded-job'`,
        );
      });
      const fresh = new DatabaseSync(path, { readOnly: true });
      try {
        expect(fresh.prepare('SELECT id FROM guarded_domain').get()?.id).toBe('committed');
        expect(
          fresh.prepare('SELECT checkpoint_json FROM background_jobs WHERE id=?').get('guarded-job')
            ?.checkpoint_json,
        ).toBe('{"verified":"committed"}');
      } finally {
        fresh.close();
      }
    } finally {
      context.close();
    }
  });

  it.each([
    'cancel',
    'expire',
    'steal',
    'proposal',
    'project',
    'retry',
    'file',
  ] as const)('rejects %s before any domain write', (kind) => {
    const { store, context } = prepare();
    let guarded = context;
    try {
      if (kind === 'cancel') store.requestCancel('guarded-job', Date.now());
      if (kind === 'expire' || kind === 'steal')
        native.exec("UPDATE background_jobs SET lease_expires_at=0 WHERE id='guarded-job'");
      if (kind === 'steal')
        new DurableJobStore(db, { projectId: request.projectId }).claim('guarded-job', Date.now());
      if (kind === 'proposal')
        native.exec("UPDATE background_jobs SET proposal_json='{}' WHERE id='guarded-job'");
      if (kind === 'project')
        native.exec("UPDATE background_jobs SET project_id='other-project' WHERE id='guarded-job'");
      if (kind === 'retry')
        native.exec(
          "UPDATE background_jobs SET idempotency_key='other-key' WHERE id='guarded-job'",
        );
      if (kind === 'file')
        guarded = createOperationExecutionContext(context.identity, {
          writeFence: { ...context.writeFence!, dbPath: join(root, 'different.db') },
        });
      expect(() =>
        db.transaction((tx) => {
          assertOperationWriteFence(tx, guarded);
          tx.run(sql`INSERT INTO guarded_domain VALUES ('forbidden')`);
        }),
      ).toThrow('Domain write refused');
      expect(native.prepare('SELECT * FROM guarded_domain').all()).toEqual([]);
    } finally {
      guarded.close();
      context.close();
    }
  });

  it('does not accept a same-named temporary table shadowing cancelled main authority', () => {
    const { context } = prepare();
    native.exec('CREATE TEMP TABLE background_jobs AS SELECT * FROM main.background_jobs');
    native.exec(
      "UPDATE main.background_jobs SET cancellation_requested_at=1 WHERE id='guarded-job'",
    );
    try {
      expect(() =>
        db.transaction((tx) => {
          assertOperationWriteFence(tx, context);
          tx.run(sql`INSERT INTO guarded_domain VALUES ('forbidden')`);
        }),
      ).toThrow('Domain write refused');
      expect(native.prepare('SELECT * FROM guarded_domain').all()).toEqual([]);
    } finally {
      context.close();
      native.exec('DROP TABLE temp.background_jobs');
    }
  });

  it('rolls back both domain mutation and receipt when receipt persistence fails', () => {
    const { context } = prepare();
    native.exec(
      "CREATE TRIGGER fail_guarded_receipt BEFORE UPDATE OF checkpoint_json ON background_jobs BEGIN SELECT RAISE(ABORT,'receipt fault'); END",
    );
    try {
      expect(() =>
        db.transaction((tx) => {
          assertOperationWriteFence(tx, context);
          tx.run(sql`INSERT INTO guarded_domain VALUES ('rolled-back')`);
          tx.run(sql`UPDATE main.background_jobs SET checkpoint_json='{}' WHERE id='guarded-job'`);
        }),
      ).toThrow();
      expect(native.prepare('SELECT * FROM guarded_domain').all()).toEqual([]);
      expect(
        native.prepare('SELECT checkpoint_json FROM background_jobs WHERE id=?').get('guarded-job')
          ?.checkpoint_json,
      ).toBeNull();
    } finally {
      context.close();
    }
  });
});

describe('bounded durable candidate inventory', () => {
  function scope(budgetMs = 2000) {
    const store = new DurableJobStore(db, { projectId: 'project-A', actor: 'fixture' });
    const execution = createOperationExecutionContext(
      {
        projectId: 'project-A',
        projectRoot: root,
        actor: 'fixture',
        operation: 'docs.projection',
        idempotencyKey: 'inventory',
      },
      { budgetMs },
    );
    return { store, execution };
  }
  function submit(id: string, at = 10, projectId = 'project-A', operation = 'docs.projection') {
    const store = new DurableJobStore(db, { projectId, actor: 'submitter' });
    store.defer(id, operation, at, {
      projectId,
      idempotencyKey: id,
      proposalJson: JSON.stringify({ identity: { actor: 'immutable-principal' }, id }),
    });
    return store;
  }

  it('uses bounded SQL and immutable timestamp/ID cursors before materializing opaque payloads', () => {
    submit('b');
    submit('a');
    submit('c', 20);
    submit('other-project', 1, 'project-B');
    submit('other-operation', 1, 'project-A', 'other');
    new DurableJobStore(db).insert('legacy', 'docs.projection', 1);
    native
      .prepare('UPDATE background_jobs SET proposal_json=? WHERE id=?')
      .run('x'.repeat(600000), 'c');
    const { store, execution } = scope();
    const prepare = vi.spyOn(native, 'prepare');
    try {
      const first = store.listPage({ operation: 'docs.projection', limit: 2 }, execution);
      expect(first.candidates.map((job) => job.id)).toEqual(['a', 'b']);
      expect(first).toMatchObject({
        scannedCount: 2,
        hasMoreCandidates: true,
        matchingTotal: null,
        observation: 'per-page-snapshot',
        principalValidation: 'domain-required',
        nextCursor: { startedAt: 10, id: 'b' },
      });
      const queries = prepare.mock.calls.map((call) => call[0]);
      expect(queries.some((query) => /order by.*started_at.*id.*limit \?/i.test(query))).toBe(true);
      expect(
        queries
          .filter((query) => /^select/i.test(query))
          .every((query) => /limit \?/i.test(query) || / in \(/i.test(query)),
      ).toBe(true);
      expect(() =>
        store.listPage(
          { operation: 'docs.projection', limit: 2, after: first.nextCursor ?? undefined },
          execution,
        ),
      ).toThrow('payload exceeds');
      expect(
        native.prepare('SELECT length(proposal_json) AS n FROM background_jobs WHERE id=?').get('c')
          ?.n,
      ).toBe(600000);
    } finally {
      execution.close();
    }
  });

  it('counts actual UTF-8 text bytes, refuses an undersized cap and leaves rows unchanged', () => {
    submit('unicode');
    native
      .prepare('UPDATE background_jobs SET checkpoint_json=? WHERE id=?')
      .run('🌱'.repeat(20), 'unicode');
    const row = native.prepare('SELECT * FROM background_jobs WHERE id=?').get('unicode');
    if (!row) throw new Error('Fixture missing');
    const bytes = Object.values(row).reduce<number>(
      (sum, value) => sum + (typeof value === 'string' ? Buffer.byteLength(value) : 0),
      0,
    );
    const { store, execution } = scope();
    try {
      expect(() =>
        store.listPage({ operation: 'docs.projection', maxPayloadBytes: bytes - 1 }, execution),
      ).toThrow('payload exceeds');
      expect(
        store.listPage({ operation: 'docs.projection', maxPayloadBytes: bytes }, execution)
          .candidates,
      ).toHaveLength(1);
      expect(native.prepare('SELECT * FROM background_jobs WHERE id=?').get('unicode')).toEqual(
        row,
      );
    } finally {
      execution.close();
    }
  });

  it('retains pending, failed and completed jobs across a fresh process and owner reassignment', () => {
    submit('pending', 1);
    const failed = submit('failed', 2);
    failed.claim('failed', Date.now());
    failed.fail('failed', 'retained failure', Date.now());
    const original = submit('complete', 3);
    original.claim('complete', Date.now());
    native.exec("UPDATE background_jobs SET lease_expires_at=0 WHERE id='complete'");
    const next = new DurableJobStore(db, { projectId: 'project-A', actor: 'different-owner' });
    next.claim('complete', Date.now());
    next.complete('complete', { verified: true }, Date.now());
    const expired = submit('expired', 4);
    expired.claim('expired', Date.now());
    native.exec("UPDATE background_jobs SET lease_expires_at=0 WHERE id='expired'");
    const before = native.prepare('SELECT * FROM background_jobs ORDER BY id').all();
    const page = JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(bundleRoot, 'client.mjs'),
          path,
          'page',
          root,
          JSON.stringify({ operation: 'docs.projection', limit: 4 }),
        ],
        { encoding: 'utf8', timeout: 10000 },
      ),
    );
    expect(page.candidates.map((job: BackgroundJob) => job.id)).toEqual([
      'pending',
      'failed',
      'complete',
      'expired',
    ]);
    expect(page.candidates[2]).toMatchObject({
      startedAt: '1970-01-01T00:00:00.003Z',
      claimedBy: 'different-owner',
      attempts: 2,
      status: 'complete',
    });
    expect(JSON.parse(page.candidates[2].proposalJson).identity.actor).toBe('immutable-principal');
    expect(page.candidates[3]).toMatchObject({
      status: 'running',
      ownership: 'expired',
      attempts: 1,
      leaseExpiresAt: 0,
    });
    expect(page.candidates[1]).toMatchObject({ status: 'failed', error: 'retained failure' });
    expect(page).toMatchObject({
      hasMoreCandidates: false,
      nextCursor: null,
      principalValidation: 'domain-required',
    });
    expect(native.prepare('SELECT * FROM background_jobs ORDER BY id').all()).toEqual(before);
  });

  it('binds every cursor field to the captured caller/query and permits a final empty page', () => {
    submit('a');
    submit('b');
    const { store, execution } = scope();
    try {
      const first = store.listPage({ operation: 'docs.projection', limit: 1 }, execution);
      if (!first.nextCursor) throw new Error('Missing cursor');
      for (const change of [
        { version: 2 },
        { projectId: 'B' },
        { projectRoot: root + '/other' },
        { actor: 'other' },
        { operation: 'other' },
        { status: 'pending' },
        { limit: 2 },
        { maxPayloadBytes: 2 },
        { startedAt: NaN },
        { id: '' },
      ]) {
        const query = JSON.parse(
          JSON.stringify({
            operation: 'docs.projection',
            limit: 1,
            after: { ...first.nextCursor, ...change },
          }),
        );
        expect(() => store.listPage(query, execution)).toThrow('cursor belongs');
      }
      const second = store.listPage(
        { operation: 'docs.projection', limit: 1, after: first.nextCursor },
        execution,
      );
      expect(second.candidates.map((job) => job.id)).toEqual(['b']);
      native.exec("DELETE FROM background_jobs WHERE id='b'");
      expect(
        store.listPage(
          { operation: 'docs.projection', limit: 1, after: first.nextCursor },
          execution,
        ),
      ).toMatchObject({
        candidates: [],
        scannedCount: 0,
        hasMoreCandidates: false,
        nextCursor: null,
      });
      for (const change of [
        { limit: 0 },
        { limit: 101 },
        { limit: 1.5 },
        { maxPayloadBytes: 0 },
        { maxPayloadBytes: 1048577 },
        { status: 'fake' },
      ])
        expect(() =>
          store.listPage(
            JSON.parse(JSON.stringify({ operation: 'docs.projection', ...change })),
            execution,
          ),
        ).toThrow('Invalid bounded candidate');
    } finally {
      execution.close();
    }
  });

  it('refuses cancelled/expired invocations before reading and cannot borrow an unrelated transaction', () => {
    submit('job');
    native.exec('PRAGMA busy_timeout=3000');
    const { store, execution } = scope();
    try {
      native.exec('BEGIN IMMEDIATE');
      native.exec("UPDATE background_jobs SET progress=7 WHERE id='job'");
      expect(() => store.listPage({ operation: 'docs.projection' }, execution)).toThrow(
        'another caller owns',
      );
      expect(native.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(3000);
      expect(native.prepare('SELECT progress FROM background_jobs').get()?.progress).toBe(7);
      native.exec('ROLLBACK');
      execution.close();
      expect(() => store.listPage({ operation: 'docs.projection' }, execution)).toThrow();
      const expired = scope(0);
      try {
        expect(() =>
          expired.store.listPage({ operation: 'docs.projection' }, expired.execution),
        ).toThrow();
      } finally {
        expired.execution.close();
      }
      expect(store.get('job')?.progress).toBeUndefined();
    } finally {
      execution.close();
    }
  });

  it('enforces aggregate caller resources and preserves explicit diagnostics for malformed candidates', () => {
    submit('a');
    submit('b');
    native.prepare('UPDATE background_jobs SET proposal_json=? WHERE id=?').run('malformed', 'b');
    const { store, execution } = scope();
    const bounded = createOperationExecutionContext(execution.identity, {
      resources: { maxItems: 1 },
    });
    try {
      const first = store.listPage({ operation: 'docs.projection', limit: 1 }, bounded);
      if (!first.nextCursor) throw new Error('Missing cursor');
      expect(() =>
        store.listPage(
          { operation: 'docs.projection', limit: 1, after: first.nextCursor },
          bounded,
        ),
      ).toThrow('resource');
      expect(
        store.listPage({ operation: 'docs.projection', status: 'pending' }, execution)
          .candidates[1],
      ).toMatchObject({ id: 'b', diagnosticError: 'Pending job proposal is not valid JSON' });
      expect(() =>
        new DurableJobStore(db).listPage({ operation: 'docs.projection' }, execution),
      ).toThrow('exact project');
      expect(
        store.listPage({ operation: 'docs.projection', status: 'complete' }, execution).candidates,
      ).toEqual([]);
    } finally {
      bounded.close();
      execution.close();
    }
  });

  it('refuses a page if cancellation arrives before committing its read snapshot', () => {
    submit('job');
    const { store, execution } = scope();
    const assertion = execution.assertActive;
    let checks = 0;
    const guarded = {
      ...execution,
      assertActive: () => {
        checks++;
        if (checks === 5) execution.close();
        assertion();
      },
    };
    const before = native.prepare('SELECT * FROM background_jobs').all();
    try {
      expect(() => store.listPage({ operation: 'docs.projection' }, guarded)).toThrow();
      expect(checks).toBe(5);
      expect(native.prepare('SELECT * FROM background_jobs').all()).toEqual(before);
      native.exec('BEGIN IMMEDIATE');
      native.exec('ROLLBACK');
    } finally {
      execution.close();
    }
  });

  it('bounds a real exclusive lock wait and restores timeout after read failure', () => {
    submit('job');
    native.exec('PRAGMA busy_timeout=3000');
    const blocker = new DatabaseSync(path);
    blocker.exec('BEGIN EXCLUSIVE');
    const { store, execution } = scope(30);
    const start = Date.now();
    try {
      expect(() => store.listPage({ operation: 'docs.projection' }, execution)).toThrow();
      expect(Date.now() - start).toBeLessThan(500);
      expect(native.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(3000);
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
      execution.close();
    }
    expect(store.get('job')?.status).toBe('pending');
  });
});
