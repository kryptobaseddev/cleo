import { type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WarningCollector, withWarningCollector } from '@cleocode/lafs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { drainWarnings } from '../../output.js';
import { snapshotAfterSessionEnd } from '../../sessions/session-end-snapshot.js';
import { recoverProjectStore } from '../backup-recover.js';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
  resolveDualScopeDbPath,
} from '../dual-scope-db.js';
import { acquireLock } from '../lock.js';
import { assertDoctorStoreIntegrity } from '../open-cleo-db.js';
import { inspectStoreIntegrity, repairStore } from '../repair-store.js';
import { assertRepairQuiescent, repairFileHash } from '../repair-store-files.js';
import { getNativeTasksDb, resetDbState } from '../sqlite.js';
import { loadSqliteVecExtension } from '../sqlite-native.js';
import { OWNER_STORE_REWRITE_AUDIT_FILE } from '../worktree-isolation-guard.js';
import { createTestDb, type TestDbEnv } from './test-db-helper.js';

const nativePlatform = process.platform;
const proc = vi.hoisted(() => ({
  enabled: false,
  comm: 'systemd',
  code: 'EACCES',
  statPath: '',
  stage: 'directory',
  state: 'S',
  exitAfterProbe: false,
  scans: 0,
}));
vi.mock('node:timers/promises', async (original) => {
  const timers = await original<typeof import('node:timers/promises')>();
  return { ...timers, setTimeout: vi.fn(timers.setTimeout) };
});
vi.mock('node:child_process', async (original) => {
  const child = await original<typeof import('node:child_process')>();
  return { ...child, spawnSync: vi.fn(child.spawnSync) };
});
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => {
      if (proc.enabled && args[0] === '/proc')
        return proc.stage === 'quiescent' || (proc.exitAfterProbe && proc.scans++ > 0)
          ? []
          : ['424242'];
      if (proc.enabled && args[0] === '/proc/424242/fd') {
        if (proc.stage === 'descriptor') return ['0'];
        throw Object.assign(new Error('injected descriptor permission refusal'), {
          code: proc.code,
        });
      }
      return fs.readdirSync(...args);
    },
    statSync: (...args: Parameters<typeof fs.statSync>) => {
      if (proc.enabled && args[0] === '/proc/424242/fd/0')
        throw Object.assign(new Error('injected descriptor entry permission refusal'), {
          code: proc.code,
        });
      if (proc.enabled && (args[0] === '/proc/self' || args[0] === '/proc/424242'))
        return fs.statSync(proc.statPath);
      return fs.statSync(...args);
    },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      if (proc.enabled && args[0] === '/proc/locks') return '';
      if (proc.enabled && args[0] === '/proc/424242/stat') {
        if (proc.state === 'gone')
          throw Object.assign(new Error('process exited during inspection'), { code: 'ENOENT' });
        return `424242 (${proc.comm}) ${proc.state} 1 0 0`;
      }
      if (proc.enabled && args[0] === '/proc/424242/comm') return proc.comm;
      return fs.readFileSync(...args);
    },
  };
});

let env: TestDbEnv;
let live: string;
let snapshot: string;
let loaderRoot: string;
let loader: string;
beforeAll(() => {
  loaderRoot = mkdtempSync(join(tmpdir(), 'cleo-repair-child-'));
  loader = join(loaderRoot, 'loader.mjs');
  // The installed compiler loads current source in the killed child without a build.
  writeFileSync(
    loader,
    `
    import { registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import ts from ${JSON.stringify(createRequire(import.meta.url).resolve('typescript'))};
    import { readFileSync } from 'node:fs';
    let workspaceResolve = () => null;
    registerHooks({
      resolve(specifier, context, next) {
        const mapped = workspaceResolve(specifier);
        if (mapped) return next(pathToFileURL(mapped).href, context);
        try { return next(specifier, context); }
        catch (error) {
          if ((specifier.startsWith('.') || specifier.startsWith('file:')) && specifier.endsWith('.js')) return next(specifier.slice(0,-3)+'.ts', context);
          throw error;
        }
      },
      load(url, context, next) {
        if (url.endsWith('.ts')) return {format:'module', shortCircuit:true, source:ts.transpileModule(readFileSync(new URL(url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText};
        return next(url, context);
      }
    });
    const {cleoWorkspaceSubpathAliases} = await import(${JSON.stringify(new URL('../../../../../vitest-workspace-resolver.ts', import.meta.url).href)});
    workspaceResolve = cleoWorkspaceSubpathAliases()[0].customResolver;
  `,
  );
});
afterAll(() => {
  rmSync(loaderRoot, { recursive: true, force: true });
});
beforeEach(async () => {
  proc.state = 'S';
  proc.exitAfterProbe = false;
  proc.scans = 0;
  env = await createTestDb();
  live = join(env.cleoDir, 'cleo.db');
  const db = getNativeTasksDb(env.tempDir);
  if (!db) throw new Error('missing fixture handle');
  db.exec(`CREATE TABLE repair_records (id TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    INSERT INTO repair_records VALUES ('base', 'snapshot', '2026-10-01T00:00:00Z');
    CREATE INDEX repair_value ON repair_records(value);
    CREATE TABLE damage_marker (id INTEGER PRIMARY KEY, body TEXT);
    INSERT INTO damage_marker VALUES (1, 'restored from snapshot');`);
  const backups = join(env.cleoDir, 'backups', 'sqlite');
  mkdirSync(backups, { recursive: true });
  snapshot = join(backups, 'tasks-20261001-120000.db');
  db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  copyFileSync(live, join(env.cleoDir, 'older-main.db'));
  db.exec(
    "INSERT INTO repair_records VALUES ('delta', 'readable after snapshot', '2026-11-12T00:00:00Z')",
  );
  resetDbState();
});
afterEach(async () => {
  vi.restoreAllMocks();
  proc.enabled = false;
  Object.defineProperty(process, 'platform', { value: nativePlatform });
  resetDbState();
  await env.cleanup();
});

it.each([
  ['EACCES', 'directory'],
  ['EPERM', 'directory'],
  ['EACCES', 'descriptor'],
  ['EPERM', 'descriptor'],
])('records %s for an inaccessible non-store Linux process %s', async (code, stage) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!platform) throw new Error('platform descriptor missing');
  const diagnostics: string[] = [];
  proc.enabled = true;
  proc.comm = 'systemd';
  proc.code = code;
  proc.stage = stage;
  proc.statPath = env.tempDir;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    await assertRepairQuiescent(live, diagnostics);
    expect(diagnostics).toContain(
      'Skipped inaccessible descriptors for non-store process pid 424242 (systemd)',
    );
  } finally {
    proc.enabled = false;
    Object.defineProperty(process, 'platform', platform);
  }
});

it.each([
  ['EACCES', 'directory'],
  ['EPERM', 'directory'],
  ['EACCES', 'descriptor'],
  ['EPERM', 'descriptor'],
])('refuses %s for an inaccessible possible Linux store holder %s', async (code, stage) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!platform) throw new Error('platform descriptor missing');
  proc.enabled = true;
  proc.comm = 'node';
  proc.code = code;
  proc.stage = stage;
  proc.statPath = env.tempDir;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(15_000);
  try {
    await expect(assertRepairQuiescent(live, [])).rejects.toThrow(
      'possible store holder pid 424242 (node)',
    );
  } finally {
    clock.mockRestore();
    proc.enabled = false;
    Object.defineProperty(process, 'platform', platform);
  }
});

it.each([
  'directory',
  'descriptor',
])('rechecks an unreadable exiting Node process %s before proving quiescence', async (stage) => {
  proc.enabled = true;
  proc.comm = 'node-MainThread';
  proc.code = 'EACCES';
  proc.stage = stage;
  proc.statPath = env.tempDir;
  proc.exitAfterProbe = true;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const before = repairFileHash(live);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  const pause = vi
    .spyOn(await import('node:timers/promises'), 'setTimeout')
    .mockResolvedValue(undefined);
  const command = vi
    .spyOn(await import('../../sessions/terminal-identity.js'), 'readProcessArgs')
    .mockReturnValue('node-MainThread');
  const diagnostics: string[] = [];
  try {
    await assertRepairQuiescent(live, diagnostics);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(proc.scans).toBe(2);
    expect(diagnostics).toContain('CLEO store holders exited during the bounded teardown wait');
    expect(repairFileHash(live)).toBe(before);
  } finally {
    command.mockRestore();
    pause.mockRestore();
    clock.mockRestore();
  }
});

it.each(['Z', 'gone'])('skips an exited Node process with state %s', async (state) => {
  proc.enabled = true;
  proc.comm = 'node (worker)';
  proc.code = 'EACCES';
  proc.stage = 'directory';
  proc.state = state;
  proc.statPath = env.tempDir;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const before = repairFileHash(live);
  await assertRepairQuiescent(live, []);
  expect(repairFileHash(live)).toBe(before);
});

it('accepts an unrelated macOS mount warning only after proving its device is unrelated', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const device = (BigInt.asUintN(32, statSync(live, { bigint: true }).dev) ^ 1n).toString(16);
  const warning = `lsof: WARNING: can't stat() smbfs file system /Volumes/unreachable-backup
      Output information may be incomplete.
      assuming "dev=${device}" from mount table
`;
  const result: SpawnSyncReturns<string> = {
    pid: 424243,
    output: [null, '', warning],
    stdout: '',
    stderr: warning,
    status: 1,
    signal: null,
  };
  const probe = vi.spyOn(await import('node:child_process'), 'spawnSync').mockReturnValue(result);
  const diagnostics: string[] = [];
  const before = repairFileHash(live);
  try {
    await assertRepairQuiescent(live, diagnostics);
    expect(diagnostics.join('\n')).toContain(`Unrelated filesystem warning (device 0x${device})`);
    expect(probe).toHaveBeenCalledWith(
      '/usr/sbin/lsof',
      ['-nP', '-S2', '-F', 'p', '-f', '--', live],
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(repairFileHash(live)).toBe(before);
  } finally {
    probe.mockRestore();
  }
});

it.each([
  'target filesystem',
  'unknown warning',
  'failed probe',
  'spawn failure',
])('refuses a macOS %s at the existing teardown deadline', async (failure) => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const device = BigInt.asUintN(32, statSync(live, { bigint: true }).dev);
  const warningDevice = failure === 'target filesystem' ? device : device ^ 1n;
  const warning =
    failure === 'unknown warning'
      ? 'lsof: WARNING: target handle coverage unavailable\n'
      : `lsof: WARNING: can't stat() smbfs file system /Volumes/unreachable-backup
      Output information may be incomplete.
      assuming "dev=${warningDevice.toString(16)}" from mount table
`;
  const result: SpawnSyncReturns<string> = {
    pid: 424243,
    output: [null, '', warning],
    stdout: '',
    stderr: warning,
    status: failure === 'spawn failure' ? null : failure === 'failed probe' ? 2 : 1,
    signal: null,
    ...(failure === 'spawn failure' ? { error: new Error('injected lsof spawn failure') } : {}),
  };
  const probe = vi.spyOn(await import('node:child_process'), 'spawnSync').mockReturnValue(result);
  const started = Date.now();
  let now = started;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const pause = vi
    .spyOn(await import('node:timers/promises'), 'setTimeout')
    .mockImplementation(async () => {
      now += 5_000;
    });
  const before = repairFileHash(live);
  try {
    await expect(assertRepairQuiescent(live, [])).rejects.toMatchObject({
      codeName: 'E_STORE_IN_USE',
      message: expect.stringContaining('Cannot prove the store is closed'),
    });
    expect(now - started).toBe(15_000);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(repairFileHash(live)).toBe(before);
  } finally {
    pause.mockRestore();
    clock.mockRestore();
    probe.mockRestore();
  }
});

it('refuses a registered CLEO writer lock before copying the store', async () => {
  // Unrelated runner processes must not preempt the writer-lock refusal.
  proc.enabled = true;
  proc.stage = 'quiescent';
  proc.statPath = env.tempDir;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const release = await acquireLock(live, { retries: 0 });
  const before = repairFileHash(live);
  try {
    await expect(assertRepairQuiescent(live, [])).rejects.toThrow(
      'CLEO writer holds the store lock',
    );
    expect(repairFileHash(live)).toBe(before);
  } finally {
    await release();
  }
});

it('refuses live foreign writer leases read from a private copy', async () => {
  // Keep the OS scan and synthetic lease owner's identity independent of the host.
  proc.enabled = true;
  proc.stage = 'quiescent';
  proc.statPath = env.tempDir;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const db = new DatabaseSync(live);
  try {
    db.prepare(`INSERT INTO _writer_leases
      (scope,lane,holder_id,holder_pid,epoch,acquired_at,heartbeat_at,ttl_ms,active)
      VALUES ('project','bulk','repair-foreign-holder',424242,1,?,?,60000,1)`).run(
      Date.now(),
      Date.now(),
    );
  } finally {
    db.close();
  }
  const before = repairFileHash(live);
  const command = vi
    .spyOn(await import('../../sessions/terminal-identity.js'), 'readProcessArgs')
    .mockReturnValue('node repair-foreign-holder');
  try {
    await expect(assertRepairQuiescent(live, [])).rejects.toThrow('pid 424242 (bulk)');
    expect(repairFileHash(live)).toBe(before);
  } finally {
    command.mockRestore();
  }
});

it('refuses a still-live lease for a dead holder at the teardown deadline', async () => {
  proc.enabled = true;
  proc.stage = 'quiescent';
  proc.statPath = env.tempDir;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const db = new DatabaseSync(live);
  try {
    db.prepare(`INSERT INTO _writer_leases
      (scope,lane,holder_id,holder_pid,epoch,acquired_at,heartbeat_at,ttl_ms,active)
      VALUES ('project','bulk','repair-dead-holder',424242,1,?,?,60000,1)`).run(
      Date.now(),
      Date.now(),
    );
  } finally {
    db.close();
  }
  const before = repairFileHash(live);
  const started = Date.now();
  let now = started;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const pause = vi
    .spyOn(await import('node:timers/promises'), 'setTimeout')
    .mockImplementation(async () => {
      now += 5_000;
    });
  const command = vi
    .spyOn(await import('../../sessions/terminal-identity.js'), 'readProcessArgs')
    .mockReturnValue(null);
  try {
    await expect(assertRepairQuiescent(live, [])).rejects.toMatchObject({
      codeName: 'E_STORE_IN_USE',
      message: expect.stringContaining('pid 424242 (bulk)'),
      fix: expect.stringContaining('normal shutdown'),
    });
    expect(now - started).toBe(15_000);
    expect(pause).toHaveBeenCalledTimes(3);
    expect(repairFileHash(live)).toBe(before);
  } finally {
    command.mockRestore();
    pause.mockRestore();
    clock.mockRestore();
  }
});

it('plain doctor diagnoses global damage without auto-repair or original changes', () => {
  const global = resolveDualScopeDbPath('global');
  _resetDualScopeDbCache();
  rmSync(`${global}-wal`, { force: true });
  rmSync(`${global}-shm`, { force: true });
  mkdirSync(join(global, '..'), { recursive: true });
  writeFileSync(global, 'this is not a sqlite database'.repeat(200));
  const before = repairFileHash(global);
  expect(() => assertDoctorStoreIntegrity()).toThrowError(
    expect.objectContaining({
      codeName: 'E_DB_CORRUPT',
      fix: 'cleo doctor repair-store',
    }),
  );
  expect(repairFileHash(global)).toBe(before);
  expect(existsSync(join(global, '..', 'quarantine'))).toBe(false);
});

function damageIndex(name = 'repair_value'): void {
  const db = new DatabaseSync(live);
  const page = Number(
    db.prepare('SELECT rootpage FROM sqlite_schema WHERE name=?').get(name)?.rootpage,
  );
  db.close();
  const bytes = readFileSync(live);
  bytes.fill(0, (page - 1) * 4096, page * 4096);
  writeFileSync(live, bytes);
}

function values(file = live): string[] {
  const db = new DatabaseSync(file);
  try {
    return db
      .prepare('SELECT id FROM repair_records ORDER BY id')
      .all()
      .map((r) => String(r.id));
  } finally {
    db.close();
  }
}

function damagedWal(torn = false): void {
  const writer = join(env.cleoDir, 'wal-fixture.db');
  copyFileSync(live, writer);
  const db = new DatabaseSync(writer);
  const page = Number(
    db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='damage_marker'").get()?.rootpage,
  );
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO repair_records VALUES ('wal', 'committed WAL row', '2026-11-13T00:00:00Z')",
  );
  for (const s of ['', '-wal', '-shm']) copyFileSync(writer + s, live + s);
  db.close();
  const bytes = readFileSync(live);
  bytes.fill(0, (page - 1) * 4096, page * 4096);
  writeFileSync(live, bytes);
  if (torn) appendFileSync(`${live}-wal`, Buffer.alloc(19, 0xa5));
}

function hashes(): Record<string, string> {
  return Object.fromEntries(
    ['', '-wal', '-shm', '-journal']
      .filter((s) => existsSync(live + s))
      .map((s) => [s, repairFileHash(live + s)]),
  );
}

describe('copy-only whole-store repair', () => {
  it('healthy stores are byte-identical no-ops without quarantine', async () => {
    const writer = join(env.tempDir, 'healthy-wal.db');
    copyFileSync(live, writer);
    const db = new DatabaseSync(writer);
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO repair_records VALUES('healthy-wal','normal uncheckpointed data','2026-11-13T00:00:00Z')",
    );
    for (const suffix of ['', '-wal', '-shm']) copyFileSync(writer + suffix, live + suffix);
    db.close();
    const before = hashes();
    const result = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
    expect(result.status).toBe('healthy');
    expect(hashes()).toEqual(before);
    expect(existsSync(join(env.cleoDir, 'quarantine'))).toBe(false);
  });

  it('merges readable delta rows, validates, keeps immutable originals and reruns as a no-op', async () => {
    damageIndex();
    const before = hashes();
    const result = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
    expect(result.status).toBe('repaired');
    expect(result.diagnostics).not.toContainEqual(expect.stringMatching(/snapshot .*\.restoring/));
    expect(values()).toEqual(['base', 'delta']);
    expect(inspectStoreIntegrity(live).healthy).toBe(true);
    expect(repairFileHash(live)).toBe(result.commitMainSha256);
    const alone = join(env.tempDir, 'repaired-main-only.db');
    copyFileSync(live, alone);
    expect(values(alone)).toEqual(['base', 'delta']);
    expect(result.tables.repair_records).toMatchObject({
      snapshot: 1,
      salvaged: 2,
      merged: 1,
      final: 2,
    });
    if (!result.quarantineDir) throw new Error('missing quarantine');
    expect(repairFileHash(join(result.quarantineDir, 'cleo.db'))).toBe(before['']);
    expect(
      JSON.parse(readFileSync(join(result.quarantineDir, 'receipt.json'), 'utf8')).status,
    ).toBe('repaired');
    const repaired = hashes();
    const directories = readdirSync(join(env.cleoDir, 'quarantine'));
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'healthy',
    );
    expect(hashes()).toEqual(repaired);
    expect(readdirSync(join(env.cleoDir, 'quarantine'))).toEqual(directories);
  });

  it.each([
    { divergent: false, pin: false },
    { divergent: true, pin: false },
    { divergent: false, pin: true },
  ])('recovers an integrity-clean checkout from its newer snapshot (%o)', async ({
    divergent,
    pin,
  }) => {
    const pinned = join(env.tempDir, 'pinned.db');
    copyFileSync(snapshot, pinned);
    const db = new DatabaseSync(live);
    db.exec(`INSERT INTO tasks_tasks(id,title,type,created_at,updated_at) VALUES
      ('T950001','shared task','task','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z');
      INSERT INTO tasks_sessions(id,name,status,started_at) VALUES
      ('shared','snapshot session','ended','2026-10-01T00:00:00Z');
      PRAGMA wal_checkpoint(TRUNCATE)`);
    const old = join(env.tempDir, 'checkout.db');
    copyFileSync(live, old);
    db.exec(`INSERT INTO tasks_tasks(id,title,type,created_at,updated_at) VALUES
      ('T950002','newer snapshot task','task','2026-11-13T00:00:00Z','2026-11-13T00:00:00Z');
      INSERT INTO tasks_sessions(id,name,status,started_at) VALUES
      ('new-session','newer session','ended','2026-11-13T00:00:00Z');
      INSERT INTO tasks_audit_log(id,timestamp,action,task_id) VALUES
      ('new-audit','2026-11-13T00:00:00Z','create','T950002')`);
    rmSync(snapshot);
    db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    db.close();
    copyFileSync(old, live);
    if (divergent) {
      const changed = new DatabaseSync(live);
      changed.exec(`INSERT INTO tasks_tasks(id,title,type,created_at,updated_at) VALUES
        ('T950003','live-only task','task','2026-10-02T00:00:00Z','2026-10-02T00:00:00Z');
        UPDATE tasks_sessions SET status='active' WHERE id='shared'`);
      changed.close();
    }
    const physical = new DatabaseSync(live, { readOnly: true });
    expect(physical.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    physical.close();
    const before = hashes();
    const finding = inspectStoreIntegrity(live);
    expect(finding).toMatchObject({
      healthy: false,
      freshness: [{ kind: 'snapshot', source: snapshot, divergent }],
    });
    expect(finding.detail).toContain('tasks_audit_log');
    expect(finding.detail).toContain('tasks_sessions');
    expect(() => assertDoctorStoreIntegrity()).toThrowError(
      expect.objectContaining({
        codeName: 'E_DB_CORRUPT',
        cause: expect.objectContaining({ message: expect.stringContaining(snapshot) }),
      }),
    );
    expect(hashes()).toEqual(before);
    const preview = await repairStore({
      projectRoot: env.tempDir,
      cwd: env.tempDir,
      dryRun: true,
      fromSnapshot: pin ? pinned : undefined,
    });
    expect(preview.status).toBe('dry-run');
    expect(hashes()).toEqual(before);
    expect(existsSync(join(env.cleoDir, 'quarantine'))).toBe(false);
    const result = await repairStore({
      projectRoot: env.tempDir,
      cwd: env.tempDir,
      fromSnapshot: pin ? pinned : undefined,
    });
    expect(result.status).toBe('repaired');
    expect(result.freshness).toEqual(finding.freshness);
    const check = new DatabaseSync(live);
    try {
      expect(
        check
          .prepare('SELECT id FROM tasks_tasks ORDER BY id')
          .all()
          .map((r) => r.id),
      ).toEqual(divergent ? ['T950001', 'T950002', 'T950003'] : ['T950001', 'T950002']);
      expect(check.prepare("SELECT id FROM tasks_audit_log WHERE id='new-audit'").get()?.id).toBe(
        'new-audit',
      );
      expect(check.prepare("SELECT id FROM tasks_sessions WHERE id='new-session'").get()?.id).toBe(
        'new-session',
      );
      if (divergent)
        expect(
          check.prepare("SELECT status FROM tasks_sessions WHERE id='shared'").get()?.status,
        ).toBe('ended');
    } finally {
      check.close();
    }
    if (divergent) {
      expect(result.recovery?.rows).toContainEqual(
        expect.objectContaining({
          kind: 'conflict',
          table: 'tasks_sessions',
          values: expect.objectContaining({ id: 'shared', status: 'active' }),
        }),
      );
      expect(JSON.parse(readFileSync(result.recovery?.file ?? '', 'utf8'))).toEqual(
        result.recovery?.rows,
      );
    }
    expect(values()).toEqual(['base', 'delta']);
    expect(repairFileHash(join(result.quarantineDir ?? '', 'cleo.db'))).toBe(before['']);
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'healthy',
    );
  });

  it('keeps a newer live store byte-identical even when its older backup has a future mtime', async () => {
    const db = new DatabaseSync(live);
    db.exec(`INSERT INTO tasks_tasks(id,title,type,created_at,updated_at) VALUES
      ('T950004','live task','task','2026-11-13T00:00:00Z','2026-11-13T00:00:00Z')`);
    db.close();
    utimesSync(snapshot, new Date('2099-01-01'), new Date('2099-01-01'));
    const before = hashes();
    expect(inspectStoreIntegrity(live).healthy).toBe(true);
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'healthy',
    );
    expect(hashes()).toEqual(before);
    expect(existsSync(join(env.cleoDir, 'quarantine'))).toBe(false);
  });

  it('recovers every newer snapshot after checkout and a stale session-end snapshot', async () => {
    const old = join(env.tempDir, 'checkout-before-task.db');
    const seed = new DatabaseSync(live);
    seed.exec(
      "INSERT INTO tasks_tasks(id,title,type,created_at,updated_at) VALUES('T950010','old shared version','task','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')",
    );
    seed.close();
    copyFileSync(live, old);
    const snapshotTime = new Date(Date.now() - 60_000).toISOString();
    const db = new DatabaseSync(live);
    db.prepare(
      "INSERT INTO tasks_tasks(id,title,type,created_at,updated_at) VALUES('T950006','snapshot-only task','task',?,?)",
    ).run(snapshotTime, snapshotTime);
    db.prepare(
      "INSERT INTO brain_decisions(id,type,decision,rationale,confidence,created_at) VALUES('D950006','architecture','snapshot decision','proof','high',?)",
    ).run(snapshotTime);
    db.prepare(
      "INSERT INTO brain_observations(id,type,title,narrative,content_hash,source_type,quality_score,created_at) VALUES('O950006','feature','snapshot observation','proof','freshness-observation','manual',1,?)",
    ).run(snapshotTime);
    db.prepare(
      "UPDATE tasks_tasks SET title='newer shared version',updated_at=? WHERE id='T950010'",
    ).run(snapshotTime);
    db.prepare(
      "INSERT INTO tasks_sessions(id,name,status,started_at) VALUES('before-checkout','recover ended session','active',?)",
    ).run(snapshotTime);
    rmSync(snapshot);
    db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    db.close();
    const manual = join(env.cleoDir, 'backups', 'sqlite', 'cleo.db.snapshot-20261113-120000');
    // A separate fork supplies exclusive rows without expressing a logical deletion.
    const forkPath = join(env.tempDir, 'independent-fork.db');
    copyFileSync(old, forkPath);
    const fork = new DatabaseSync(forkPath);
    fork
      .prepare(
        "INSERT INTO tasks_tasks(id,title,type,created_at,updated_at) VALUES('T950011','manual-only task','task',?,?)",
      )
      .run(snapshotTime, snapshotTime);
    fork
      .prepare(
        "UPDATE tasks_tasks SET title='newest shared version',updated_at=? WHERE id='T950010'",
      )
      .run(new Date(Date.now() - 30_000).toISOString());
    const endedAt = new Date(Date.now() - 30_000).toISOString();
    fork
      .prepare(
        "INSERT INTO tasks_sessions(id,name,status,started_at,ended_at) VALUES('before-checkout','recover ended session','ended',?,?)",
      )
      .run(snapshotTime, endedAt);
    fork.exec(`VACUUM INTO '${manual.replaceAll("'", "''")}'`);
    fork.close();
    const twin = join(env.cleoDir, 'backups', 'sqlite', 'cleo.db.snapshot-20261113-120001');
    copyFileSync(manual, twin);
    for (const file of [snapshot, manual, twin])
      utimesSync(file, new Date('2026-10-01'), new Date('2026-10-01'));
    copyFileSync(old, live);
    const retentionVictim = join(env.cleoDir, 'backups', 'sqlite', 'tasks-20200101-000000.db');
    copyFileSync(snapshot, retentionVictim);
    utimesSync(retentionVictim, new Date('2026-10-01'), new Date('2026-10-01'));
    for (let day = 1; day <= 12; day++)
      copyFileSync(
        live,
        join(
          env.cleoDir,
          'backups',
          'sqlite',
          `tasks-202601${String(day).padStart(2, '0')}-000000.db`,
        ),
      );
    const now = new Date().toISOString();
    const write = new DatabaseSync(live);
    write
      .prepare(
        "INSERT INTO tasks_tasks(id,title,type,created_at,updated_at) VALUES('T950007','post-checkout task','task',?,?)",
      )
      .run(now, now);
    write
      .prepare(
        "INSERT INTO tasks_sessions(id,name,status,started_at) VALUES('post-checkout','normal session','active',?)",
      )
      .run(now);
    write
      .prepare(
        "INSERT INTO tasks_audit_log(id,timestamp,action,task_id) VALUES('post-checkout',?,'session-start','T950007')",
      )
      .run(now);
    write.exec(
      "UPDATE tasks_sessions SET status='ended',ended_at=started_at WHERE id='post-checkout'",
    );
    write.close();
    expect(await snapshotAfterSessionEnd(env.tempDir, { alwaysSnapshot: true })).toMatchObject({
      failed: [],
      skipped: null,
    });
    resetDbState();
    expect(existsSync(retentionVictim)).toBe(true);
    const before = hashes();
    const copies = vi.spyOn(await import('node:fs'), 'copyFileSync');
    const comparisons = vi.spyOn(
      await import('../recover-malformed-db.js'),
      'compareStoreFreshness',
    );
    const finding = inspectStoreIntegrity(live);
    expect(copies.mock.calls.some(([from]) => String(from) === live)).toBe(true);
    expect(
      copies.mock.calls.some(([from]) => [snapshot, manual, twin].includes(String(from))),
    ).toBe(false);
    expect(
      comparisons.mock.calls.filter(([, , path]) => [manual, twin].includes(path)),
    ).toHaveLength(1);
    copies.mockRestore();
    comparisons.mockRestore();
    expect(finding.healthy).toBe(false);
    expect(finding.detail).toContain('T950006');
    expect(finding.detail).toContain('T950010');
    expect(finding.detail).toContain('T950011');
    expect(finding.freshness?.filter((f) => f.kind === 'snapshot')).toHaveLength(2);
    expect(() => assertDoctorStoreIntegrity()).toThrowError(
      expect.objectContaining({ codeName: 'E_DB_CORRUPT' }),
    );
    expect(finding.detail).toContain('1 older versions');
    expect(finding.detail).toContain('D950006');
    expect(finding.detail).toContain('O950006');
    expect(finding.freshness?.[0]?.divergent).toBe(true);
    expect(hashes()).toEqual(before);
    const result = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
    expect(result.status).toBe('repaired');
    const check = new DatabaseSync(live, { readOnly: true });
    try {
      expect(
        check
          .prepare('SELECT id FROM tasks_tasks ORDER BY id')
          .all()
          .map((r) => r.id),
      ).toEqual(['T950006', 'T950007', 'T950010', 'T950011']);
      expect(check.prepare("SELECT title FROM tasks_tasks WHERE id='T950010'").get()?.title).toBe(
        'newest shared version',
      );
      expect(check.prepare("SELECT id FROM brain_decisions WHERE id='D950006'").get()?.id).toBe(
        'D950006',
      );
      expect(check.prepare("SELECT id FROM brain_observations WHERE id='O950006'").get()?.id).toBe(
        'O950006',
      );
      expect(
        check.prepare("SELECT id FROM tasks_audit_log WHERE id='post-checkout'").get()?.id,
      ).toBe('post-checkout');
      expect(
        check.prepare("SELECT id FROM tasks_sessions WHERE id='post-checkout'").get()?.id,
      ).toBe('post-checkout');
      expect(
        check
          .prepare("SELECT status, ended_at FROM tasks_sessions WHERE id='before-checkout'")
          .get(),
      ).toMatchObject({ status: 'ended', ended_at: endedAt });
    } finally {
      check.close();
    }
    expect(result.recovery?.rows).toContainEqual(
      expect.objectContaining({
        kind: 'conflict',
        table: 'tasks_tasks',
        values: expect.objectContaining({ id: 'T950010', title: 'newer shared version' }),
      }),
    );
    expect(JSON.parse(readFileSync(result.recovery?.file ?? '', 'utf8'))).toEqual(
      result.recovery?.rows,
    );
    const recovered = hashes();
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'healthy',
    );
    expect(hashes()).toEqual(recovered);
  });

  it('rejects a damaged snapshot even when its task table is readable', async () => {
    const { snapshotRecoveryReason } = await import('../recover-malformed-db.js');
    const db = new DatabaseSync(snapshot);
    db.exec(
      "INSERT INTO tasks_tasks(id,title,type,created_at,updated_at) VALUES('T950019','untrusted snapshot row','task','2026-11-01','2026-11-01')",
    );
    const page = Number(
      db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='damage_marker'").get()?.rootpage,
    );
    const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size);
    db.close();
    const bytes = readFileSync(snapshot);
    bytes.fill(0, (page - 1) * pageSize, page * pageSize);
    writeFileSync(snapshot, bytes);
    const readable = new DatabaseSync(snapshot, { readOnly: true });
    expect(readable.prepare("SELECT id FROM tasks_tasks WHERE id='T950019'").get()?.id).toBe(
      'T950019',
    );
    readable.close();
    expect(inspectStoreIntegrity(live).healthy).toBe(true);
    expect(snapshotRecoveryReason(live, snapshot)).toBeUndefined();
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'healthy',
    );
    const check = new DatabaseSync(live, { readOnly: true });
    expect(check.prepare("SELECT id FROM tasks_tasks WHERE id='T950019'").get()).toBeUndefined();
    check.close();
  });

  it('honors committed prune and GC deletes during diagnosis, rotation and a later lossless recovery', async () => {
    const { pruneAuditLog } = await import('../../audit-prune.js');
    const { loadConfig } = await import('../../config.js');
    const { rotateBackupDir } = await import('../backup-sidecar.js');
    const dir = join(env.cleoDir, 'backups', 'sqlite');
    const oldest = join(dir, 'cleo.db.snapshot-20260101-000000');
    const newer = join(dir, 'cleo.db.snapshot-20260102-000000');
    const db = new DatabaseSync(live);
    db.exec(`INSERT INTO tasks_audit_log(id,timestamp,action,task_id) VALUES('pruned-audit','2020-01-01T00:00:00Z','create','old');
      INSERT INTO tasks_sessions(id,name,status,started_at,ended_at) VALUES('pruned-session','old session','ended','2020-01-01T00:00:00Z','2020-01-01T00:00:01Z');
      VACUUM INTO '${oldest.replaceAll("'", "''")}'`);
    db.close();
    copyFileSync(oldest, newer);
    utimesSync(oldest, new Date('2026-01-01'), new Date('2026-01-01'));
    utimesSync(newer, new Date('2026-01-02'), new Date('2026-01-02'));
    const config = await loadConfig(env.tempDir);
    expect(
      (
        await pruneAuditLog(env.cleoDir, {
          ...config.logging,
          auditRetentionDays: 30,
          archiveBeforePrune: false,
        })
      ).rowsDeleted,
    ).toBe(1);
    // This test checks the committed delete, not the unrelated detached soft-reference cleanup.
    vi.spyOn(
      await import('../cross-db-cleanup.js'),
      'cleanupBrainRefsOnSessionDelete',
    ).mockResolvedValue();
    await env.accessor.removeSingleSession('pruned-session');
    resetDbState();
    expect(inspectStoreIntegrity(live).healthy).toBe(true);
    const rotation = rotateBackupDir(dir, 1, 'snapshot');
    expect(rotation.retained).toEqual({});
    expect(rotation.deleted).toContain('cleo.db.snapshot-20260101-000000');
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'healthy',
    );

    const checkout = join(env.tempDir, 'post-prune-checkout.db');
    // This checkout predates deletion receipts; only retained post-prune history carries them.
    copyFileSync(snapshot, checkout);
    const changed = new DatabaseSync(live);
    changed.exec(
      "INSERT INTO tasks_tasks(id,title,type,created_at,updated_at) VALUES('T950020','recover after prune','task','2026-11-01','2026-11-01')",
    );
    const recovery = join(dir, 'tasks-20261101-000000.db');
    changed.exec(`VACUUM INTO '${recovery.replaceAll("'", "''")}'`);
    changed.close();
    resetDbState();
    for (const suffix of ['-wal', '-shm']) rmSync(live + suffix, { force: true });
    copyFileSync(checkout, live);
    // The older image is deliberately the base; its pruned rows must be removed by receipts.
    utimesSync(newer, new Date('2099-01-01'), new Date('2099-01-01'));
    expect(inspectStoreIntegrity(live).healthy).toBe(false);
    const result = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
    expect(result.status).toBe('repaired');
    const check = new DatabaseSync(live, { readOnly: true });
    try {
      expect(check.prepare("SELECT id FROM tasks_tasks WHERE id='T950020'").get()?.id).toBe(
        'T950020',
      );
      expect(
        check.prepare("SELECT id FROM tasks_audit_log WHERE id='pruned-audit'").get(),
      ).toBeUndefined();
      expect(
        check.prepare("SELECT id FROM tasks_sessions WHERE id='pruned-session'").get(),
      ).toBeUndefined();
      expect(
        check.prepare('SELECT count(*) AS n FROM _store_deleted_keys').get()?.n,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      check.close();
    }
    expect(result.recovery?.rows).toContainEqual(
      expect.objectContaining({
        kind: 'deleted',
        table: 'tasks_audit_log',
        values: expect.objectContaining({ id: 'pruned-audit' }),
      }),
    );
    const before = hashes();
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'healthy',
    );
    expect(hashes()).toEqual(before);
  });

  it('preserves a losing live edit when a peer snapshot timestamp is in the future', async () => {
    const db = new DatabaseSync(live);
    db.exec(
      "INSERT INTO tasks_tasks(id,title,type,created_at,updated_at) VALUES('T950008','peer version','task','2026-10-01T00:00:00Z','2099-01-01T00:00:00Z')",
    );
    rmSync(snapshot);
    db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    db.prepare("UPDATE tasks_tasks SET title='real live edit',updated_at=? WHERE id='T950008'").run(
      new Date().toISOString(),
    );
    db.close();
    const result = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
    expect(result.status).toBe('repaired');
    expect(result.recovery?.rows).toContainEqual(
      expect.objectContaining({
        kind: 'conflict',
        table: 'tasks_tasks',
        values: expect.objectContaining({ id: 'T950008', title: 'real live edit' }),
      }),
    );
    expect(JSON.parse(readFileSync(result.recovery?.file ?? '', 'utf8'))).toContainEqual(
      expect.objectContaining({
        table: 'tasks_tasks',
        values: expect.objectContaining({ title: 'real live edit' }),
      }),
    );
  });

  it('honors an explicit no-delta rollback while reporting retained newer backups', async () => {
    const newer = join(env.cleoDir, 'backups', 'sqlite', 'tasks-20261114-000000.db');
    const db = new DatabaseSync(live);
    db.exec(
      "INSERT INTO tasks_tasks(id,title,type,created_at,updated_at) VALUES('T950009','intentionally rolled back','task','2026-11-13T00:00:00Z','2026-11-13T00:00:00Z')",
    );
    db.exec(`VACUUM INTO '${newer.replaceAll("'", "''")}'`);
    db.close();
    const result = await recoverProjectStore({
      role: 'tasks',
      projectRoot: env.tempDir,
      cwd: env.tempDir,
      fromSnapshot: snapshot,
      noDelta: true,
    });
    expect(result).toMatchObject({ restored: true });
    const before = hashes();
    const finding = inspectStoreIntegrity(live);
    expect(finding.healthy).toBe(true);
    expect(finding.freshness).toContainEqual(
      expect.objectContaining({ source: newer, authoritative: false }),
    );
    expect(finding.detail).toContain('deliberate restore');
    const { snapshotRecoveryReason } = await import('../recover-malformed-db.js');
    expect(snapshotRecoveryReason(live, newer)).toBeUndefined();
    const intentPath = `${live}.restore.intent.json`;
    const intentBytes = readFileSync(intentPath);
    const prepared = JSON.parse(intentBytes.toString('utf8'));
    prepared.state = 'prepared';
    writeFileSync(intentPath, JSON.stringify(prepared));
    expect(inspectStoreIntegrity(live).healthy).toBe(true);
    writeFileSync(intentPath, '{invalid intent');
    expect(inspectStoreIntegrity(live).healthy).toBe(false);
    writeFileSync(intentPath, intentBytes);
    withWarningCollector(new WarningCollector(), () => {
      expect(() => assertDoctorStoreIntegrity()).not.toThrow();
      expect(drainWarnings()).toContainEqual(
        expect.objectContaining({ code: 'W_STORE_RESTORE_INTENT' }),
      );
    });
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'healthy',
    );
    expect(hashes()).toEqual(before);
    const write = new DatabaseSync(live);
    write
      .prepare(
        "INSERT INTO tasks_sessions(id,name,status,started_at) VALUES('after-rollback','new branch session','active',?)",
      )
      .run(new Date().toISOString());
    const postRollback = join(env.cleoDir, 'backups', 'sqlite', 'tasks-20261115-000000.db');
    write.exec(`VACUUM INTO '${postRollback.replaceAll("'", "''")}'`);
    write.close();
    expect(inspectStoreIntegrity(live).healthy).toBe(true);
    expect(inspectStoreIntegrity(live).freshness).toContainEqual(
      expect.objectContaining({ source: newer, authoritative: false }),
    );
    copyFileSync(snapshot, live);
    expect(inspectStoreIntegrity(live).healthy).toBe(false);
    const repaired = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
    expect(repaired.status).toBe('repaired');
    const check = new DatabaseSync(live, { readOnly: true });
    expect(check.prepare("SELECT id FROM tasks_sessions WHERE id='after-rollback'").get()?.id).toBe(
      'after-rollback',
    );
    expect(check.prepare("SELECT id FROM tasks_tasks WHERE id='T950009'").get()).toBeUndefined();
    check.close();
    const { enforceBackupByteCap } = await import('../backup-sidecar.js');
    const rotation = enforceBackupByteCap(join(env.cleoDir, 'backups', 'sqlite'), 0);
    expect(rotation.removed.flatMap((r) => r.files)).toContain(newer.split('/').at(-1));
    expect(existsSync(newer)).toBe(false);
  });

  it.each([
    { hasSnapshot: false, external: false, label: 'no snapshot' },
    { hasSnapshot: true, external: false, label: 'newer snapshot' },
    { hasSnapshot: true, external: true, label: 'explicit external snapshot' },
  ])('reports a discarded WAL and recovers only with newer snapshot evidence ($label)', async ({
    hasSnapshot,
    external,
  }) => {
    const writer = join(env.tempDir, 'ignored-wal.db');
    copyFileSync(live, writer);
    const db = new DatabaseSync(writer);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      INSERT INTO tasks_tasks(id,title,type,created_at,updated_at) VALUES
      ('T950005','WAL-only task','task','2026-11-13T00:00:00Z','2026-11-13T00:00:00Z');
      INSERT INTO repair_records VALUES ('wal','WAL-only record','2026-11-13T00:00:00Z')`);
    rmSync(snapshot);
    db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    copyFileSync(join(env.cleoDir, 'older-main.db'), live);
    for (const suffix of ['-wal', '-shm']) copyFileSync(writer + suffix, live + suffix);
    db.close();
    if (!hasSnapshot) rmSync(snapshot);
    const externalSnapshot = join(env.tempDir, 'external-snapshot.db');
    if (external) {
      copyFileSync(snapshot, externalSnapshot);
      rmSync(snapshot);
    }
    const wal = readFileSync(`${live}-wal`);
    wal[24] = (wal[24] ?? 0) ^ 0xff; // A discarded header checksum leaves integrity-clean older rows visible.
    writeFileSync(`${live}-wal`, wal);
    const before = hashes();
    const finding = inspectStoreIntegrity(live);
    expect(finding).toMatchObject({
      healthy: false,
      freshness: [
        { kind: 'wal', source: `${live}-wal`, unreadable: true },
        ...(hasSnapshot && !external ? [{ kind: 'snapshot', source: snapshot }] : []),
      ],
    });
    expect(finding.detail).toContain('Unapplied WAL');
    expect(finding.detail).toContain('SQLite accepted 0');
    if (hasSnapshot && !external) expect(finding.detail).toContain('tasks_tasks');
    expect(hashes()).toEqual(before);
    if (!hasSnapshot) {
      await expect(repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).rejects.toThrow(
        'no newer snapshot proves recovery',
      );
      expect(hashes()).toEqual(before);
      return;
    }
    const result = await repairStore({
      projectRoot: env.tempDir,
      cwd: env.tempDir,
      fromSnapshot: external ? externalSnapshot : undefined,
    });
    expect(result.status).toBe('repaired');
    expect(values()).toEqual(['base', 'delta', 'wal']);
    const check = new DatabaseSync(live, { readOnly: true });
    expect(check.prepare("SELECT title FROM tasks_tasks WHERE id='T950005'").get()?.title).toBe(
      'WAL-only task',
    );
    check.close();
    expect(repairFileHash(join(result.quarantineDir ?? '', 'cleo.db-wal'))).toBe(before['-wal']);
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'healthy',
    );
  });

  it('repairs the canonical configured directory used by normal store opens', async () => {
    damageIndex();
    const before = hashes();
    const configured = join(env.tempDir, 'configured-store');
    mkdirSync(configured);
    const configuredDb = join(configured, 'cleo.db');
    copyFileSync(live, configuredDb);
    vi.stubEnv('CLEO_DIR', configured);
    try {
      expect(resolveDualScopeDbPath('project', env.tempDir)).toBe(configuredDb);
      const result = await repairStore({
        projectRoot: env.tempDir,
        cwd: env.tempDir,
        fromSnapshot: snapshot,
      });
      expect(result.target).toBe(configuredDb);
      expect(result.status).toBe('repaired');
      expect(values(configuredDb)).toEqual(['base', 'delta']);
      expect(hashes()).toEqual(before);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('dry-run performs salvage and validation without any .cleo writes', async () => {
    damageIndex();
    const before = hashes();
    const names = readdirSync(env.cleoDir);
    const result = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir, dryRun: true });
    expect(result.status).toBe('dry-run');
    expect(result.tables.repair_records?.final).toBe(2);
    expect(hashes()).toEqual(before);
    expect(readdirSync(env.cleoDir)).toEqual(names);
  });

  it('refuses an open handle with its holder details, shutdown fix and unchanged originals', async () => {
    damageIndex();
    const db = new DatabaseSync(live);
    db.exec('PRAGMA journal_mode=WAL');
    const before = hashes();
    try {
      await expect(
        repairStore({ projectRoot: env.tempDir, cwd: env.tempDir }),
      ).rejects.toMatchObject({
        codeName: 'E_STORE_IN_USE',
        message: expect.stringContaining(`pid ${process.pid}`),
        fix: expect.stringContaining('normal shutdown'),
      });
      expect(hashes()).toEqual(before);
    } finally {
      db.close();
    }
  });

  it('a failure before commit leaves every original sidecar unchanged', async () => {
    damageIndex();
    const before = hashes();
    await expect(
      repairStore({
        projectRoot: env.tempDir,
        cwd: env.tempDir,
        onPhase: (phase) => {
          if (phase === 'validate') throw new Error('injected failure');
        },
      }),
    ).rejects.toMatchObject({ codeName: 'E_DB_CORRUPT' });
    expect(hashes()).toEqual(before);
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'repaired',
    );
  });

  it('resumes a committed checkpoint failure and previews it without changing any live bytes', async () => {
    damagedWal();
    await expect(
      repairStore({
        projectRoot: env.tempDir,
        cwd: env.tempDir,
        onPhase(phase) {
          if (phase === 'checkpoint') throw new Error('injected checkpoint interruption');
        },
      }),
    ).rejects.toMatchObject({ codeName: 'E_DB_CORRUPT', fix: 'cleo doctor repair-store' });
    const before = hashes();
    const quarantine = join(env.cleoDir, 'quarantine');
    const dirs = readdirSync(quarantine);
    const receiptFile = join(quarantine, dirs[0] ?? '', 'receipt.json');
    const oldReceipt = repairFileHash(receiptFile);
    expect(JSON.parse(readFileSync(receiptFile, 'utf8')).status).toBe('checkpoint-pending');
    expect(inspectStoreIntegrity(live).healthy).toBe(true);
    const preview = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir, dryRun: true });
    expect(preview.status).toBe('dry-run');
    expect(hashes()).toEqual(before);
    expect(repairFileHash(receiptFile)).toBe(oldReceipt);
    const held = new DatabaseSync(live, { readOnly: true });
    try {
      await expect(
        repairStore({ projectRoot: env.tempDir, cwd: env.tempDir }),
      ).rejects.toMatchObject({
        codeName: 'E_STORE_IN_USE',
        fix: expect.stringContaining('normal shutdown'),
      });
    } finally {
      held.close();
    }
    expect(JSON.parse(readFileSync(receiptFile, 'utf8')).status).toBe('checkpoint-pending');
    const resumed = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
    expect(resumed.status).toBe('repaired');
    expect(readdirSync(quarantine)).toEqual(dirs);
    expect(JSON.parse(readFileSync(receiptFile, 'utf8')).status).toBe('repaired');
    const mainOnly = join(env.tempDir, 'resumed-main-only.db');
    copyFileSync(live, mainOnly);
    expect(values(mainOnly)).toEqual(['base', 'delta', 'wal']);
    const repaired = hashes();
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'healthy',
    );
    expect(hashes()).toEqual(repaired);
  });

  it('reads both an older main file and the newer committed WAL without losing readable rows', async () => {
    const writer = join(env.cleoDir, 'wal-fixture.db');
    copyFileSync(live, writer);
    const db = new DatabaseSync(writer);
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO repair_records VALUES ('wal', 'committed WAL row', '2026-11-13T00:00:00Z')",
    );
    copyFileSync(join(env.cleoDir, 'older-main.db'), live);
    for (const s of ['-wal', '-shm']) copyFileSync(writer + s, live + s);
    db.close();
    const result = await repairStore({
      projectRoot: env.tempDir,
      cwd: env.tempDir,
      restoreSnapshot: true,
    });
    expect(result.status).toBe('repaired');
    expect(values()).toEqual(['base', 'delta', 'wal']);
    expect(inspectStoreIntegrity(live).healthy).toBe(true);
    const repaired = hashes();
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'healthy',
    );
    expect(hashes()).toEqual(repaired);
  });

  it('recovers the committed prefix of a torn WAL and preserves every readable row', async () => {
    damagedWal(true);
    const result = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
    expect(result.status).toBe('repaired');
    expect(values()).toEqual(['base', 'delta', 'wal']);
    expect(result.files.map((f) => f.name)).toContain('cleo.db-wal');
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'healthy',
    );
  });

  it('builds a migrated empty base when there is no usable snapshot', async () => {
    rmSync(snapshot);
    damageIndex();
    const result = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
    expect(result.status).toBe('repaired');
    expect(result.snapshot).toBeNull();
    expect(values()).toEqual(['base', 'delta']);
  });

  it('migrates the base before merging and retains values in newly added columns', async () => {
    const old = new DatabaseSync(snapshot);
    old.exec(
      "ALTER TABLE tasks_sessions DROP COLUMN injection_version; DELETE FROM __drizzle_migrations WHERE name='20261106140000_t14327-session-injection-version'; INSERT INTO tasks_sessions(id,name,status) VALUES('recovered-session','schema fixture','active')",
    );
    old.close();
    const source = new DatabaseSync(live);
    source.exec(
      "INSERT INTO tasks_sessions(id,name,status,injection_version) VALUES('recovered-session','schema fixture','ended','2.31.0')",
    );
    source.close();
    damageIndex();
    const result = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
    expect(result.status).toBe('repaired');
    const check = new DatabaseSync(live);
    try {
      expect(
        check
          .prepare('PRAGMA table_info(tasks_sessions)')
          .all()
          .map((r) => r.name),
      ).toContain('injection_version');
      expect(
        check
          .prepare(
            "SELECT injection_version,status FROM tasks_sessions WHERE id='recovered-session'",
          )
          .get(),
      ).toEqual({ injection_version: '2.31.0', status: 'ended' });
    } finally {
      check.close();
    }
    expect(values()).toEqual(['base', 'delta']);
  });

  it('repairs the global consolidated store with the same merge and a no-op rerun', async () => {
    _resetDualScopeDbCache();
    const global = resolveDualScopeDbPath('global');
    const h = await openDualScopeDbAtPath('global', global, undefined, { dedicated: true });
    const native = getDualScopeNativeDb(h);
    native.exec(
      "CREATE TABLE repair_records (id TEXT PRIMARY KEY, value TEXT); INSERT INTO repair_records VALUES ('base', 'global snapshot'); CREATE INDEX repair_value ON repair_records(value)",
    );
    const dir = join(env.tempDir, '.cleo-home', 'backups', 'sqlite');
    mkdirSync(dir, { recursive: true });
    native.exec(`VACUUM INTO '${join(dir, 'global-20261001-120000.db').replaceAll("'", "''")}'`);
    native.exec("INSERT INTO repair_records VALUES ('delta', 'global delta')");
    const page = Number(
      native.prepare("SELECT rootpage FROM sqlite_schema WHERE name='repair_value'").get()
        ?.rootpage,
    );
    h.close();
    const bytes = readFileSync(global);
    bytes.fill(0, (page - 1) * 4096, page * 4096);
    writeFileSync(global, bytes);
    const result = await repairStore({
      projectRoot: env.tempDir,
      cwd: env.tempDir,
      scope: 'global',
    });
    expect(result.status).toBe('repaired');
    expect(result.scope).toBe('global');
    expect(values(global)).toEqual(['base', 'delta']);
    expect(
      (await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir, scope: 'global' })).status,
    ).toBe('healthy');
  });

  it('detects and merges a newer global audit snapshot', async () => {
    _resetDualScopeDbCache();
    const global = resolveDualScopeDbPath('global');
    const handle = await openDualScopeDbAtPath('global', global, undefined, { dedicated: true });
    const db = getDualScopeNativeDb(handle);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const old = join(env.tempDir, 'old-global.db');
    copyFileSync(global, old);
    db.exec(
      "INSERT INTO nexus_audit_log(id,timestamp,action) VALUES('new-global-audit','2099-01-01T00:00:00Z','proof')",
    );
    const directory = join(global, '..', 'backups', 'sqlite');
    mkdirSync(directory, { recursive: true });
    db.exec(`VACUUM INTO '${join(directory, 'global-20261114-000000.db').replaceAll("'", "''")}'`);
    handle.close();
    copyFileSync(old, global);
    expect(inspectStoreIntegrity(global).detail).toContain('nexus_audit_log');
    const result = await repairStore({
      projectRoot: env.tempDir,
      cwd: env.tempDir,
      scope: 'global',
    });
    expect(result.status).toBe('repaired');
    const check = new DatabaseSync(global, { readOnly: true });
    expect(
      check.prepare("SELECT id FROM nexus_audit_log WHERE id='new-global-audit'").get()?.id,
    ).toBe('new-global-audit');
    check.close();
    expect(
      (await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir, scope: 'global' })).status,
    ).toBe('healthy');
  });

  it('automatically repairs a failed canonical open and reports the same receipt', async () => {
    damageIndex('__drizzle_migrations');
    drainWarnings();
    const h = await openDualScopeDbAtPath('project', live);
    try {
      expect(
        getDualScopeNativeDb(h).prepare('SELECT count(*) AS n FROM repair_records').get()?.n,
      ).toBe(2);
      expect(drainWarnings()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'W_DB_REPAIRED',
            context: expect.objectContaining({
              receipt: expect.objectContaining({
                status: 'repaired',
                tables: expect.objectContaining({
                  __drizzle_migrations: expect.objectContaining({ unreadable: null }),
                }),
              }),
            }),
          }),
        ]),
      );
    } finally {
      h.close();
    }
  });

  it('repairs a store containing optional vector tables without losing vectors', async (context) => {
    const db = new DatabaseSync(live, { allowExtension: true });
    if (!loadSqliteVecExtension(db)) {
      db.close();
      context.skip();
      return;
    }
    db.exec(
      "CREATE VIRTUAL TABLE vectors USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3]); INSERT INTO vectors VALUES('base','[1,2,3]')",
    );
    rmSync(snapshot);
    db.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    db.exec("INSERT INTO vectors VALUES('delta','[4,5,6]')");
    db.close();
    damageIndex();
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'repaired',
    );
    const check = new DatabaseSync(live, { allowExtension: true });
    loadSqliteVecExtension(check);
    try {
      expect(
        check
          .prepare('SELECT id FROM vectors ORDER BY id')
          .all()
          .map((r) => r.id),
      ).toEqual(['base', 'delta']);
    } finally {
      check.close();
    }
  });

  it('returns E_STORE_IN_USE when a failed open finds a live store holder', async () => {
    damageIndex('__drizzle_migrations');
    const held = new DatabaseSync(live, { readOnly: true });
    held.exec('BEGIN; SELECT name FROM sqlite_schema LIMIT 1');
    try {
      await expect(openDualScopeDbAtPath('project', live)).rejects.toMatchObject({
        codeName: 'E_STORE_IN_USE',
        fix: expect.stringContaining('normal shutdown'),
      });
    } finally {
      held.close();
    }
  });

  it('quarantines foreign-key orphans and still publishes a healthy result', async () => {
    const source = new DatabaseSync(live);
    source.exec(
      'PRAGMA foreign_keys=OFF; CREATE TABLE repair_parent(id INTEGER PRIMARY KEY); CREATE TABLE repair_child(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES repair_parent(id)); INSERT INTO repair_child VALUES(1,999)',
    );
    source.close();
    damageIndex();
    const result = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
    expect(result.status).toBe('repaired');
    expect(result.recovery?.rows).toContainEqual(
      expect.objectContaining({ table: 'repair_child', kind: 'conflict' }),
    );
    expect(result.recovery?.file).toBeTruthy();
    const recovery = JSON.parse(readFileSync(result.recovery?.file ?? '', 'utf8'));
    expect(recovery).toContainEqual(
      expect.objectContaining({
        table: 'repair_child',
        values: expect.objectContaining({ parent: { type: 'bigint', value: '999' } }),
      }),
    );
    expect(inspectStoreIntegrity(live).healthy).toBe(true);
    expect(values()).toEqual(['base', 'delta']);
  });

  it.each([
    false,
    true,
  ])('repairs a zeroed page-1 header (entire page: %s) from readable b-trees or the snapshot', async (entire) => {
    const bytes = readFileSync(live);
    bytes.fill(0, 0, entire ? 4096 : 100);
    writeFileSync(live, bytes);
    const result = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
    expect(result.status).toBe('repaired');
    expect(inspectStoreIntegrity(live).healthy).toBe(true);
    expect(values()).toEqual(entire ? ['base'] : ['base', 'delta']);
    if (entire) expect(result.tables.repair_records.unreadable).toBeNull();
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'healthy',
    );
  });

  it('repairs a damaged page-1 header with the newer WAL retained', async () => {
    const source = new DatabaseSync(live);
    source.exec(
      "CREATE TABLE notes(id TEXT PRIMARY KEY,body TEXT); INSERT INTO notes VALUES('n','v2-snapshot')",
    );
    rmSync(snapshot);
    source.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    source.close();
    damagedWal();
    const bytes = readFileSync(live);
    bytes.fill(0, 0, 100);
    writeFileSync(live, bytes);
    const result = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
    expect(result.status).toBe('repaired');
    expect(values()).toEqual(['base', 'delta', 'wal']);
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'healthy',
    );
  });

  it('keeps manual worktree refusal actionable and audits the deliberate open-time policy', async () => {
    const gitdir = join(env.tempDir, '.git', 'worktrees', 'repair-fixture');
    mkdirSync(gitdir, { recursive: true });
    const linked = join(env.tempDir, 'linked-fixture');
    mkdirSync(linked);
    writeFileSync(join(linked, '.git'), `gitdir: ${gitdir}\n`);
    damageIndex();
    const before = hashes();
    await expect(repairStore({ projectRoot: env.tempDir, cwd: linked })).rejects.toMatchObject({
      codeName: 'E_WT_STORE_REWRITE_CONFIRM_REQUIRED',
      fix: expect.stringContaining('--confirm-owner-store'),
    });
    expect(hashes()).toEqual(before);
    expect(
      (await repairStore({ projectRoot: env.tempDir, cwd: linked, openTime: true })).status,
    ).toBe('repaired');
    expect(
      readFileSync(join(env.cleoDir, 'audit', OWNER_STORE_REWRITE_AUDIT_FILE), 'utf8'),
    ).toContain('"trigger":"open-time"');
  });

  it('reports missing commit-message task IDs without inventing tasks', async () => {
    const init = spawnSync('git', ['init', env.tempDir], { encoding: 'utf8' });
    expect(init.status, init.stderr).toBe(0);
    const commit = spawnSync(
      'git',
      [
        '-c',
        'user.name=Recovery Test',
        '-c',
        'user.email=recovery@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'Follow up T999888 T999889',
      ],
      { cwd: env.tempDir, encoding: 'utf8' },
    );
    expect(commit.status, commit.stderr).toBe(0);
    damageIndex();
    const receipt = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
    expect(receipt.missingTaskIds).toEqual(['T999888', 'T999889']);
  });

  it.each([
    'quarantine',
    'diagnose',
    'salvage',
    'merge',
    'migrate',
    'validate',
    'commit',
    'checkpoint',
    'checkpointed',
    'receipt',
  ] as const)('a process killed at %s leaves original bytes or the complete repair, and reruns safely', async (wanted) => {
    damagedWal();
    const before = hashes();
    const module = new URL('../repair-store.ts', import.meta.url).href;
    const reached = join(env.tempDir, 'phase-reached');
    const source = `import {writeFileSync} from 'node:fs';const {repairStore}=await import(${JSON.stringify(module)}); await repairStore({projectRoot:${JSON.stringify(env.tempDir)},cwd:${JSON.stringify(env.tempDir)},onPhase(phase){if(phase===${JSON.stringify(wanted)}){writeFileSync(${JSON.stringify(reached)},phase);process.kill(process.pid,'SIGKILL')}}});`;
    const child = spawn(
      process.execPath,
      ['--import', loader, '--input-type=module', '-e', source],
      { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    let exitCode: number | null = null;
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        exitCode = code;
        resolve(signal);
      });
    });
    expect(existsSync(reached), stderr).toBe(true);
    expect(readFileSync(reached, 'utf8')).toBe(wanted);
    if (process.platform === 'win32') expect(exitCode).not.toBe(0);
    else expect(signal, stderr).toBe('SIGKILL');
    if (wanted === 'receipt') expect(values()).toEqual(['base', 'delta', 'wal']);
    else if (wanted === 'checkpoint') {
      const published = hashes();
      expect(published['']).toBe(before['']);
      expect(published['-wal']).not.toBe(before['-wal']);
      expect(published['-shm']).toBe(before['-shm']);
      expect(inspectStoreIntegrity(live).healthy).toBe(true);
    } else if (wanted === 'checkpointed') {
      const mainOnly = join(env.tempDir, 'checkpointed-main.db');
      copyFileSync(live, mainOnly);
      expect(values(mainOnly)).toEqual(['base', 'delta', 'wal']);
    } else expect(hashes()).toEqual(before);
    const result = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
    expect(['healthy', 'repaired']).toContain(result.status);
    if (wanted === 'checkpoint' || wanted === 'checkpointed') {
      expect(result.status).toBe('repaired');
      expect(result.diagnostics).toContainEqual(expect.stringContaining('Resuming the checkpoint'));
      const alone = join(env.tempDir, 'resumed-main.db');
      copyFileSync(live, alone);
      expect(values(alone)).toEqual(['base', 'delta', 'wal']);
    }
    expect(values()).toEqual(['base', 'delta', 'wal']);
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'healthy',
    );
  }, 60_000);
});
