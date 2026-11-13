import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drainWarnings } from '../../output.js';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
  resolveDualScopeDbPath,
} from '../dual-scope-db.js';
import { inspectStoreIntegrity, repairStore } from '../repair-store.js';
import { repairFileHash } from '../repair-store-files.js';
import { getNativeTasksDb, resetDbState } from '../sqlite.js';
import { loadSqliteVecExtension } from '../sqlite-native.js';
import { createTestDb, type TestDbEnv } from './test-db-helper.js';

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
  resetDbState();
  await env.cleanup();
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
    expect(values()).toEqual(['base', 'delta']);
    expect(inspectStoreIntegrity(live).healthy).toBe(true);
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

  it('refuses an open handle with the exact recovery fix and unchanged originals', async () => {
    damageIndex();
    const db = new DatabaseSync(live);
    db.exec('PRAGMA journal_mode=WAL');
    const before = hashes();
    try {
      await expect(
        repairStore({ projectRoot: env.tempDir, cwd: env.tempDir }),
      ).rejects.toMatchObject({ codeName: 'E_DB_CORRUPT', fix: 'cleo doctor repair-store' });
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

  it('runs missing schema migrations after merging data, before importing newer journal stamps', async () => {
    const old = new DatabaseSync(snapshot);
    old.exec(
      "ALTER TABLE tasks_sessions DROP COLUMN injection_version; DELETE FROM __drizzle_migrations WHERE name='20261106140000_t14327-session-injection-version'",
    );
    old.close();
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
              receipt: expect.objectContaining({ status: 'repaired' }),
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

  it('returns E_DB_CORRUPT when a failed open cannot prove exclusive access', async () => {
    damageIndex('__drizzle_migrations');
    const held = new DatabaseSync(live, { readOnly: true });
    held.exec('BEGIN; SELECT name FROM sqlite_schema LIMIT 1');
    try {
      await expect(openDualScopeDbAtPath('project', live)).rejects.toMatchObject({
        codeName: 'E_DB_CORRUPT',
        fix: 'cleo doctor repair-store',
      });
    } finally {
      held.close();
    }
  });

  it('refuses a foreign-key-invalid merged image without changing an original byte', async () => {
    const source = new DatabaseSync(live);
    source.exec(
      'PRAGMA foreign_keys=OFF; CREATE TABLE repair_parent(id INTEGER PRIMARY KEY); CREATE TABLE repair_child(id INTEGER PRIMARY KEY, parent INTEGER REFERENCES repair_parent(id)); INSERT INTO repair_child VALUES(1,999)',
    );
    source.close();
    damageIndex();
    const before = hashes();
    await expect(repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).rejects.toThrow(
      /foreign_key_check/,
    );
    expect(hashes()).toEqual(before);
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
    else expect(hashes()).toEqual(before);
    const result = await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir });
    expect(['healthy', 'repaired']).toContain(result.status);
    expect(values()).toEqual(['base', 'delta', 'wal']);
    expect((await repairStore({ projectRoot: env.tempDir, cwd: env.tempDir })).status).toBe(
      'healthy',
    );
  }, 60_000);
});
