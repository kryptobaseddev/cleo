/**
 * The shared `_sync_row_meta` writer (journal spec §1.6; T13204).
 *
 * @task T13204
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import { setCaptureEnabled } from '../capture.js';
import {
  compressFieldHlcs,
  fieldHlcsOf,
  nextFhlc,
  type RowMetaRow,
  readRowMeta,
  upsertRowMeta,
  upsertRowMetaFromFields,
} from '../row-meta.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const DEF = { columns: ['uid', 'birth_fp', 'a', 'b', 'c'], identity: ['uid', 'birth_fp'] };

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-row-meta-'));
  mkdirSync(join(dir, 'project', '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  dbPath = join(dir, 'project', '.cleo', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function store(): Promise<DatabaseSync> {
  const handle = await openDualScopeDbAtPath('project', dbPath);
  const db = handle.db.$client as DatabaseSync;
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  return db;
}

const prev = (hlc: string, fhlc: Record<string, string> | null): RowMetaRow => ({
  hlc,
  fhlc: fhlc ? JSON.stringify(fhlc) : null,
  version: 1,
  deleted: 0,
  key_json: null,
  chash: null,
  bfp: null,
});

describe('field HLC compression (T13204)', () => {
  it('keeps only the columns older than the row HLC, never identity columns', () => {
    expect(compressFieldHlcs(DEF, { uid: 'h0', a: 'h1', b: 'h3', c: 'h3' }, 'h3')).toBe(
      JSON.stringify({ a: 'h1' }),
    );
    expect(compressFieldHlcs(DEF, { a: 'h3', b: 'h3', c: 'h3' }, 'h3')).toBeNull();
  });

  it('a local op moves its changed columns to its HLC; the rest keep theirs (the sealer rule)', () => {
    const p = prev('h2', { a: 'h1' }); // a at h1, b and c at h2
    expect(fieldHlcsOf(DEF, p)).toEqual({ a: 'h1', b: 'h2', c: 'h2' });
    expect(nextFhlc(p, DEF, ['b'], 'h5')).toBe(JSON.stringify({ a: 'h1', c: 'h2' }));
    expect(nextFhlc(p, DEF, ['a', 'b', 'c'], 'h5')).toBeNull();
    expect(nextFhlc(undefined, DEF, ['a'], 'h5')).toBeNull();
  });
});

describe('the writer (T13204)', () => {
  it('a full per-field map writes the newest HLC as hlc and only older fields as fhlc', async () => {
    const db = await store();
    const hlc = upsertRowMetaFromFields(db, DEF, {
      tbl: 'tasks_tasks',
      uid: 'u1',
      fieldHlc: { a: 'h1', b: 'h4', c: 'h4' },
      origin: 'replica-b',
      actor: null,
      deleted: false,
      keyJson: '{"k":1}',
      bfp: 'fp-1',
    });
    expect(hlc).toBe('h4');
    expect(readRowMeta(db, 'tasks_tasks', 'u1')).toMatchObject({
      hlc: 'h4',
      fhlc: JSON.stringify({ a: 'h1' }),
      version: 1,
      deleted: 0,
      key_json: '{"k":1}',
      bfp: 'fp-1',
    });
    // A second write raises the version and keeps key and bfp when absent.
    upsertRowMetaFromFields(db, DEF, {
      tbl: 'tasks_tasks',
      uid: 'u1',
      fieldHlc: { a: 'h6', b: 'h6', c: 'h6' },
      origin: 'replica-c',
      actor: 'agent',
      deleted: true,
    });
    expect(readRowMeta(db, 'tasks_tasks', 'u1')).toMatchObject({
      hlc: 'h6',
      fhlc: null,
      version: 2,
      deleted: 1,
      key_json: '{"k":1}',
      bfp: 'fp-1',
    });
  });

  it('a partial map keeps the other fields where they were, never advancing them (review-hotfix MED)', async () => {
    const db = await store();
    upsertRowMetaFromFields(db, DEF, {
      tbl: 't',
      uid: 'u',
      fieldHlc: { a: 'h1', b: 'h2', c: 'h3' },
      origin: 'r',
      actor: null,
      deleted: false,
    });
    upsertRowMetaFromFields(db, DEF, {
      tbl: 't',
      uid: 'u',
      fieldHlc: { b: 'h9' },
      origin: 'r2',
      actor: null,
      deleted: false,
    });
    const meta = readRowMeta(db, 't', 'u');
    expect(meta?.hlc).toBe('h9');
    expect(fieldHlcsOf(DEF, meta as RowMetaRow)).toEqual({ a: 'h1', b: 'h9', c: 'h3' });
  });

  it('an older incoming field HLC leaves the stored one, and the row hlc, unchanged (T13207)', async () => {
    const db = await store();
    upsertRowMetaFromFields(db, DEF, {
      tbl: 't',
      uid: 'u',
      fieldHlc: { a: 'h5', b: 'h2', c: 'h2' },
      origin: 'r',
      actor: null,
      deleted: false,
    });
    upsertRowMetaFromFields(db, DEF, {
      tbl: 't',
      uid: 'u',
      fieldHlc: { a: 'h3', b: 'h4' },
      origin: 'r2',
      actor: null,
      deleted: false,
    });
    const meta = readRowMeta(db, 't', 'u') as RowMetaRow;
    expect(meta.hlc).toBe('h5');
    expect(fieldHlcsOf(DEF, meta)).toEqual({ a: 'h5', b: 'h4', c: 'h2' });
  });

  it('a write in which every named field loses changes nothing, not even a tombstone (review-hotfix MED)', async () => {
    const db = await store();
    upsertRowMetaFromFields(db, DEF, {
      tbl: 't',
      uid: 'u',
      fieldHlc: { a: 'h5', b: 'h5', c: 'h5' },
      origin: 'r1',
      actor: 'x',
      deleted: false,
      chash: 'ch',
    });
    const before = db.prepare("SELECT * FROM _sync_row_meta WHERE tbl = 't' AND uid = 'u'").get();
    const hlc = upsertRowMetaFromFields(db, DEF, {
      tbl: 't',
      uid: 'u',
      fieldHlc: { a: 'h3' },
      origin: 'r2',
      actor: 'y',
      deleted: true,
      chash: null,
    });
    expect(hlc).toBe('h5');
    expect(db.prepare("SELECT * FROM _sync_row_meta WHERE tbl = 't' AND uid = 'u'").get()).toEqual(
      before,
    );
  });

  it("refuses a row's first write that misses a field", async () => {
    const db = await store();
    expect(() =>
      upsertRowMetaFromFields(db, DEF, {
        tbl: 't',
        uid: 'new',
        fieldHlc: { a: 'h1' },
        origin: 'r',
        actor: null,
        deleted: false,
      }),
    ).toThrow(/first write misses b, c/);
    expect(readRowMeta(db, 't', 'new')).toBeUndefined();
  });

  it('refuses a write with no field HLC', async () => {
    const db = await store();
    expect(() =>
      upsertRowMetaFromFields(db, DEF, {
        tbl: 't',
        uid: 'u',
        fieldHlc: { uid: 'h1' },
        origin: 'r',
        actor: null,
        deleted: false,
      }),
    ).toThrow(/no field HLC/);
    upsertRowMeta(db, {
      tbl: 't',
      uid: 'u',
      hlc: 'h1',
      fhlc: null,
      origin: 'r',
      actor: null,
      version: 1,
      deleted: false,
    });
    expect(readRowMeta(db, 't', 'u')?.hlc).toBe('h1');
  });
});
