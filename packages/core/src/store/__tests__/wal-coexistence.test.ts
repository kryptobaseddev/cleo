/**
 * Integration test — WAL coexistence for openDualScopeDb.
 *
 * Verifies that opening both the project-scope and global-scope `cleo.db`
 * simultaneously from the same process does not cause SQLITE_BUSY / deadlock
 * errors, and that both handles have WAL mode enabled per the pragma SSoT
 * (`specs/sqlite-pragmas.json` `busy_timeout=30000`).
 *
 * Acceptance criteria (T11520 · E3 · SG-DB-SUBSTRATE-V2):
 *   AC1: Both project and global scope opened concurrently from same process.
 *   AC2: WAL mode is ON for both handles (PRAGMA journal_mode = 'wal').
 *   AC3: No SQLITE_BUSY / deadlock errors during concurrent writes.
 *   AC4: Runs under pnpm run test --project @cleocode/core.
 *
 * @task T11520 (E3-T4)
 * @epic T11246 (E3)
 * @saga T11242 (SG-DB-SUBSTRATE-V2)
 * @adr ADR-068, ADR-069
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDb } from '../dual-scope-db.js';
import { openCleoDb } from '../open-cleo-db.js';

// ── Test directory management ─────────────────────────────────────────────────

let testRoot: string;
let projectDir: string;
let globalDir: string;

beforeEach(() => {
  testRoot = join(
    tmpdir(),
    `wal-coexistence-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  // Project scope: needs a .cleo dir under a project root
  projectDir = join(testRoot, 'project');
  mkdirSync(join(projectDir, '.cleo'), { recursive: true });
  // Global scope: CLEO_HOME must point to a 'cleo'-named directory
  // (getCleoHome() returns CLEO_HOME as-is, so the path becomes <globalDir>/cleo.db)
  globalDir = join(testRoot, 'cleo');
  mkdirSync(globalDir, { recursive: true });
  // Set CLEO_HOME so getCleoHome() resolves to our test-controlled directory.
  process.env.CLEO_HOME = globalDir;
});

afterEach(() => {
  _resetDualScopeDbCache();
  delete process.env.CLEO_HOME;
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Extract the native DatabaseSync handle from a handle that may be either a
 * Drizzle ORM wrapper (`openDualScopeDb`, exposes `$client`) or an already-
 * native `DatabaseSync` (`openCleoDb` after E6-L6 / T11526, which unwraps
 * `$client` for callers issuing raw SQL).
 */
function getNativeDb(handle: unknown): DatabaseSync {
  // db-open-allowed: test-only $client introspection
  const client = (handle as { $client?: DatabaseSync }).$client;
  return client ?? (handle as DatabaseSync);
}

/**
 * Query `PRAGMA journal_mode` and return the result string.
 */
function journalMode(nativeDb: DatabaseSync): string {
  const row = nativeDb.prepare('PRAGMA journal_mode').get() as { journal_mode: string } | undefined;
  return row?.journal_mode ?? 'unknown';
}

/**
 * Query `PRAGMA busy_timeout` and return the value in milliseconds.
 */
function busyTimeout(nativeDb: DatabaseSync): number {
  const row = nativeDb.prepare('PRAGMA busy_timeout').get() as { timeout: number } | undefined;
  return row?.timeout ?? -1;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WAL coexistence — project + global scope open simultaneously (T11520)', () => {
  it('AC1: opens both project and global scope concurrently without error', async () => {
    // Open both scopes in parallel to simulate a CLI process touching both DBs.
    const [proj, glob] = await Promise.all([
      openDualScopeDb('project', projectDir),
      openDualScopeDb('global'),
    ]);

    expect(proj.scope).toBe('project');
    expect(glob.scope).toBe('global');
    expect(proj.db).toBeDefined();
    expect(glob.db).toBeDefined();
    // Handles are different (two separate DB files)
    expect(proj).not.toBe(glob);
    expect(proj.dbPath).not.toBe(glob.dbPath);
  }, 30_000);

  it('AC2: WAL mode is ON for both handles (busy_timeout=30000 SSoT)', async () => {
    const [proj, glob] = await Promise.all([
      openDualScopeDb('project', projectDir),
      openDualScopeDb('global'),
    ]);

    const projNative = getNativeDb(proj.db);
    const globNative = getNativeDb(glob.db);

    // Both handles MUST be in WAL mode per specs/sqlite-pragmas.json.
    expect(journalMode(projNative)).toBe('wal');
    expect(journalMode(globNative)).toBe('wal');

    // busy_timeout=30000 is the SSoT value from specs/sqlite-pragmas.json.
    expect(busyTimeout(projNative)).toBe(30000);
    expect(busyTimeout(globNative)).toBe(30000);
  }, 30_000);

  it('AC3: no SQLITE_BUSY / deadlock errors during concurrent writes', async () => {
    const [proj, glob] = await Promise.all([
      openDualScopeDb('project', projectDir),
      openDualScopeDb('global'),
    ]);

    const projNative = getNativeDb(proj.db);
    const globNative = getNativeDb(glob.db);

    // Perform concurrent writes to both DBs. Since they are separate SQLite
    // files, WAL mode allows concurrent reads+writes without SQLITE_BUSY.
    // We run multiple simultaneous write batches to stress the coexistence.
    await expect(
      Promise.all([
        // Write 10 rows to the project DB via raw SQL (using a temp table)
        (async () => {
          projNative.exec('CREATE TEMP TABLE _wal_probe_proj (id INTEGER PRIMARY KEY, val TEXT)');
          for (let i = 0; i < 10; i++) {
            projNative.prepare('INSERT INTO _wal_probe_proj (val) VALUES (?)').run(`row-${i}`);
          }
          const count = projNative.prepare('SELECT COUNT(*) AS c FROM _wal_probe_proj').get() as {
            c: number;
          };
          return count.c;
        })(),
        // Write 10 rows to the global DB via raw SQL (using a temp table)
        (async () => {
          globNative.exec('CREATE TEMP TABLE _wal_probe_glob (id INTEGER PRIMARY KEY, val TEXT)');
          for (let i = 0; i < 10; i++) {
            globNative.prepare('INSERT INTO _wal_probe_glob (val) VALUES (?)').run(`row-${i}`);
          }
          const count = globNative.prepare('SELECT COUNT(*) AS c FROM _wal_probe_glob').get() as {
            c: number;
          };
          return count.c;
        })(),
      ]),
    ).resolves.toEqual([10, 10]);
  }, 30_000);

  it('AC1 (via openCleoDb): project|global delegation works through the legacy chokepoint', async () => {
    // T11517 AC: openCleoDb('project'|'global') delegates to openDualScopeDb.
    // This test exercises the delegation path in open-cleo-db.ts.
    const [projHandle, globHandle] = await Promise.all([
      openCleoDb('project', projectDir),
      openCleoDb('global'),
    ]);

    expect(projHandle.role).toBe('project');
    expect(globHandle.role).toBe('global');
    expect(projHandle.db).toBeDefined();
    expect(globHandle.db).toBeDefined();
    expect(projHandle.db).not.toBe(globHandle.db);

    await projHandle.close();
    await globHandle.close();
  }, 30_000);

  it('AC2 (via openCleoDb): WAL mode is ON for both handles opened via legacy chokepoint', async () => {
    const [projHandle, globHandle] = await Promise.all([
      openCleoDb('project', projectDir),
      openCleoDb('global'),
    ]);

    // The Drizzle handle is returned as CleoDbHandle.db (typed unknown).
    // We use getNativeDb to extract $client for pragma queries.
    const projNative = getNativeDb(projHandle.db);
    const globNative = getNativeDb(globHandle.db);

    expect(journalMode(projNative)).toBe('wal');
    expect(journalMode(globNative)).toBe('wal');
    expect(busyTimeout(projNative)).toBe(30000);
    expect(busyTimeout(globNative)).toBe(30000);
  }, 30_000);
});
