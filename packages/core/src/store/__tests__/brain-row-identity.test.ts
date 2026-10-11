/**
 * Row identity of the brain text-keyed tables, in both scopes (T12894).
 *
 * Stores are fresh `cleo.db` files opened through the chokepoint
 * (`openDualScopeDbAtPath`) under a `mkdtemp` directory: the project store at
 * `<root>/.cleo/cleo.db`, the global store at `<CLEO_HOME>/cleo.db`.
 *
 * @task T12894
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../dual-scope-db.js';
import { missingRowIdentitySchema } from '../row-identity.js';
import { ROW_UID_FILL_FLAG } from '../row-identity-flag.js';
import { ROW_IDENTITY, rowIdentityColumns } from '../row-identity-registry.js';
import { setCaptureEnabled } from '../sync/capture.js';
import { seedBrainRows } from './brain-identity-fixture.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../migrations/sync-journal');

let dir: string;
let home: string;

/** The store file of a scope under this test's directory (`n` picks a sibling project). */
function storePath(scope: TableScope, n = 1): string {
  if (scope === 'global') return join(home, 'cleo.db');
  const root = join(dir, `project-${n}`, '.cleo');
  mkdirSync(root, { recursive: true });
  return join(root, 'cleo.db');
}

async function open(scope: TableScope, path: string): Promise<DatabaseSync> {
  _resetDualScopeDbCache();
  const handle = await openDualScopeDbAtPath(scope, path);
  return handle.db.$client as DatabaseSync;
}

const brainSpecs = (scope: TableScope) =>
  ROW_IDENTITY[scope].filter((s) => s.table.startsWith('brain_'));

/** Every declared brain row's identity, keyed `table:key`. */
function identities(db: DatabaseSync, scope: TableScope): Map<string, string> {
  const out = new Map<string, string>();
  for (const spec of brainSpecs(scope)) {
    const cols = rowIdentityColumns(scope, spec.table);
    const rows = db
      .prepare(
        `SELECT ${spec.key.map((k) => `"${k}"`).join(', ')}, ${cols.map((c) => `"${c}"`).join(', ')} FROM main."${spec.table}"`,
      )
      .all() as Record<string, string | null>[];
    for (const row of rows) {
      const key = spec.key.map((k) => row[k]).join('|');
      out.set(`${spec.table}:${key}`, cols.map((c) => `${c}=${row[c]}`).join(' '));
    }
  }
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-brain-uid-'));
  home = join(dir, 'cleo');
  mkdirSync(home, { recursive: true });
  vi.stubEnv('CLEO_HOME', home);
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe.each(['project', 'global'] as const)('brain row identity in the %s store', (scope) => {
  it('declares the text-keyed brain tables with uid columns and a unique uid index', async () => {
    const tables = brainSpecs(scope).map((s) => s.table);
    expect(tables).toEqual(
      expect.arrayContaining([
        'brain_decisions',
        'brain_learnings',
        'brain_observations',
        'brain_patterns',
        'brain_page_nodes',
        'brain_session_narrative',
      ]),
    );
    expect(tables.includes('brain_sticky_notes')).toBe(scope === 'global');
    const db = await open(scope, storePath(scope));
    expect(missingRowIdentitySchema(db, scope)).toEqual([]);
    for (const table of tables) {
      const index = db
        .prepare("SELECT sql FROM main.sqlite_master WHERE type = 'index' AND name = ?")
        .get(`uq_${table}_uid`) as { sql: string } | undefined;
      expect(index?.sql, table).toMatch(/CREATE UNIQUE INDEX/);
    }
  });

  it('fills every brain row a raw insert writes, in the same statement', async () => {
    const db = await open(scope, storePath(scope));
    seedBrainRows(db, { sticky: scope === 'global' });
    const ids = identities(db, scope);
    expect(ids.size).toBeGreaterThanOrEqual(brainSpecs(scope).length);
    for (const [row, values] of ids) {
      expect(values, row).not.toMatch(/=null/);
    }
  });

  it('a store filled at open derives the same uids as one filled at insert', async () => {
    // Store 1: rows written with the fill off, filled by the next open's pass.
    vi.stubEnv(ROW_UID_FILL_FLAG, '0');
    const first = storePath(scope, 1);
    seedBrainRows(await open(scope, first), { sticky: scope === 'global' });
    vi.stubEnv(ROW_UID_FILL_FLAG, '1');
    const atOpen = identities(await open(scope, first), scope);
    // Store 2 (another project root, or the same global path after a reset):
    // the same rows filled by the uid trigger as they are written.
    let second = storePath(scope, 2);
    if (scope === 'global') {
      _resetDualScopeDbCache();
      rmSync(first, { force: true });
      rmSync(`${first}-wal`, { force: true });
      rmSync(`${first}-shm`, { force: true });
      second = first;
    }
    const db2 = await open(scope, second);
    seedBrainRows(db2, { sticky: scope === 'global' });
    expect(identities(db2, scope)).toEqual(atOpen);
    for (const values of atOpen.values()) expect(values).not.toMatch(/=null/);
  });

  it('heals a store whose migration was stamped without its columns, then fills it', async () => {
    const path = storePath(scope);
    const db = await open(scope, path);
    seedBrainRows(db, { sticky: scope === 'global' });
    // This connection's TEMP uid triggers name the columns about to go.
    for (const spec of brainSpecs(scope)) {
      db.exec(`DROP TRIGGER IF EXISTS temp."trg_row_uid_${spec.table}"`);
    }
    for (const spec of brainSpecs(scope)) {
      db.exec(`DROP INDEX IF EXISTS main."uq_${spec.table}_uid"`);
      for (const column of rowIdentityColumns(scope, spec.table)) {
        db.exec(`DROP INDEX IF EXISTS main."idx_${spec.table}_${column}"`);
        db.exec(`ALTER TABLE main."${spec.table}" DROP COLUMN "${column}"`);
      }
    }
    expect(missingRowIdentitySchema(db, scope)).toContain('index uq_brain_decisions_uid');
    const healed = await open(scope, path);
    expect(missingRowIdentitySchema(healed, scope)).toEqual([]);
    for (const [row, values] of identities(healed, scope)) {
      expect(values, row).not.toMatch(/=null/);
    }
  });
});

describe('brain uid recipes', () => {
  it('reads an INTEGER epoch-ms birth as the uid timestamp (brain_attention)', async () => {
    const db = await open('project', storePath('project'));
    seedBrainRows(db);
    const { uid } = db.prepare("SELECT uid FROM brain_attention WHERE id = 'att-1'").get() as {
      uid: string;
    };
    expect(Number.parseInt(uid.replaceAll('-', '').slice(0, 12), 16)).toBe(1788253500000);
  });

  it('hashes the scope: the same brain row gets different uids in the two stores', async () => {
    const project = await open('project', storePath('project'));
    seedBrainRows(project);
    const projectUid = (
      project.prepare("SELECT uid FROM brain_decisions WHERE id = 'D0001'").get() as {
        uid: string;
      }
    ).uid;
    const global = await open('global', storePath('global'));
    seedBrainRows(global);
    const globalUid = (
      global.prepare("SELECT uid FROM brain_decisions WHERE id = 'D0001'").get() as {
        uid: string;
      }
    ).uid;
    expect(projectUid).not.toBe(globalUid);
  });

  it('the natural session narrative uid depends on the session id alone', async () => {
    const db = await open('project', storePath('project'));
    seedBrainRows(db);
    const before = db
      .prepare("SELECT uid FROM brain_session_narrative WHERE session_id = 'ses-1'")
      .get() as { uid: string };
    db.exec("DELETE FROM brain_session_narrative WHERE session_id = 'ses-1'");
    db.exec(
      "INSERT INTO brain_session_narrative (session_id, narrative, turn_count) VALUES ('ses-1', 'a different story', 7)",
    );
    const after = db
      .prepare("SELECT uid FROM brain_session_narrative WHERE session_id = 'ses-1'")
      .get() as { uid: string };
    expect(after.uid).toBe(before.uid);
  });
});

describe('capture with row uids on', () => {
  it('a raw brain insert captures exactly one I carrying the filled identity, and no K', async () => {
    const db = await open('project', storePath('project'));
    setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
    db.exec(
      "INSERT INTO brain_observations (id, type, title, created_at) VALUES ('O-cap00001', 'discovery', 'captured', '2026-09-01 10:00:00')",
    );
    const row = db
      .prepare("SELECT uid, birth_fp AS birthFp FROM brain_observations WHERE id = 'O-cap00001'")
      .get() as { uid: string; birthFp: string };
    const caps = db
      .prepare(
        "SELECT op, uid, img FROM _sync_capture WHERE tbl = 'brain_observations' ORDER BY seq",
      )
      .all() as { op: string; uid: string | null; img: string }[];
    expect(caps.map((c) => c.op)).toEqual(['I']);
    expect(caps[0]?.uid).toBe(row.uid);
    // Image values are SQL literals (§2.3).
    expect(JSON.parse(caps[0]?.img ?? '{}')).toMatchObject({
      uid: `'${row.uid}'`,
      birth_fp: `'${row.birthFp}'`,
    });
  });
});
