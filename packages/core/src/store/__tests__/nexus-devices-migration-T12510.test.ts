/**
 * T12510 migration — `nexus_devices` is created through the REAL global open
 * path (`openDualScopeDbAtPath('global', …)`), both on a fresh store and on a
 * store at main's state (every migration applied except T12510), so the
 * journal probe (T12541) must see the missing table and let drizzle run it.
 *
 * @task T12510
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../dual-scope-db.js';
import { getDbSyncConstructor } from '../sqlite-native.js';

const T12510 = '20260928020000_t12510-nexus-devices';

let testDir: string;
let dbPath: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-devices-mig-T12510-')));
  dbPath = join(testDir, 'cleo-home', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** Open through the real chokepoint and return its native handle. */
async function openGlobal(): Promise<DatabaseSync> {
  const handle = await openDualScopeDbAtPath('global', dbPath);
  return getDualScopeNativeDb(handle);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function journalHas(db: DatabaseSync, name: string): boolean {
  return db.prepare('SELECT 1 FROM __drizzle_migrations WHERE name = ?').get(name) !== undefined;
}

describe('T12510 nexus_devices migration via openDualScopeDbAtPath(global)', () => {
  it('creates nexus_devices and journals the migration on a fresh store', async () => {
    const db = await openGlobal();
    expect(tableExists(db, 'nexus_devices')).toBe(true);
    expect(journalHas(db, T12510)).toBe(true);
    const cols = (
      db.prepare("PRAGMA table_info('nexus_devices')").all() as Array<{
        name: string;
        pk: number;
      }>
    ).map((c) => [c.name, c.pk]);
    expect(cols).toEqual([
      ['device_id', 1],
      ['hostname', 0],
      ['os', 0],
      ['arch', 0],
      ['cleo_version', 0],
      ['first_seen', 0],
      ['last_heartbeat_at', 0],
    ]);
    const idx = db.prepare("PRAGMA index_list('nexus_devices')").all() as Array<{ name: string }>;
    expect(idx.map((i) => i.name)).toContain('idx_nexus_devices_last_heartbeat');
    expect(() =>
      db
        .prepare(
          "INSERT INTO nexus_devices (device_id, hostname, os, arch, cleo_version, last_heartbeat_at) VALUES ('d', 'h', 'o', 'a', 'v', 'not-a-date')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('applies to a store at main state (table and journal row absent) and keeps existing rows', async () => {
    // Build main's state: every migration applied, then T12510 removed —
    // table and journal row — exactly what a pre-T12510 binary leaves.
    const first = await openGlobal();
    first
      .prepare(
        "INSERT INTO nexus_project_registry (project_id, project_hash, project_path, name) VALUES ('p-main', 'h', '/w/p', 'p')",
      )
      .run();
    first.exec('DROP TABLE nexus_devices');
    first.prepare('DELETE FROM __drizzle_migrations WHERE name = ?').run(T12510);
    _resetDualScopeDbCache();

    // Sanity: the file really is at main's state before the reopen.
    const Ctor = getDbSyncConstructor();
    const raw = new Ctor(dbPath);
    expect(tableExists(raw, 'nexus_devices')).toBe(false);
    expect(journalHas(raw, T12510)).toBe(false);
    raw.close();

    const db = await openGlobal();
    expect(tableExists(db, 'nexus_devices')).toBe(true);
    expect(journalHas(db, T12510)).toBe(true);
    expect(
      db.prepare("SELECT name FROM nexus_project_registry WHERE project_id = 'p-main'").get(),
    ).toEqual({ name: 'p' });
    db.prepare(
      "INSERT INTO nexus_devices (device_id, hostname, os, arch, cleo_version) VALUES ('d', 'h', 'darwin', 'arm64', '1')",
    ).run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM nexus_devices').get()).toEqual({ n: 1 });
  });

  it('is a no-op on reopen of a store that already has it', async () => {
    const db = await openGlobal();
    db.prepare(
      "INSERT INTO nexus_devices (device_id, hostname, os, arch, cleo_version) VALUES ('keep', 'h', 'linux', 'x64', '1')",
    ).run();
    _resetDualScopeDbCache();
    const again = await openGlobal();
    expect(again.prepare('SELECT device_id FROM nexus_devices').all()).toEqual([
      { device_id: 'keep' },
    ]);
    expect(
      again.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations WHERE name = ?').get(T12510),
    ).toEqual({ n: 1 });
  });
});
