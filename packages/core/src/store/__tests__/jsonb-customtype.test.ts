/**
 * Unit tests for the reusable `jsonb<T>()` Drizzle custom column type.
 *
 * Exercises the load-bearing contract from the json-storage audit:
 *   - writes serialize through the SQL `jsonb()` constructor (binary BLOB);
 *   - whole-value reads round-trip through `json(col)` (via `jsonbText`);
 *   - in-SQL access (`jsonb_extract`, `json_each`, `jsonb_insert`) works on
 *     the BLOB directly;
 *   - a raw-BLOB read is rejected (`fromDriver` guard) so the version-unstable
 *     bytes are never `JSON.parse`-d.
 *
 * @task T11354
 * @epic T11286
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsonb, jsonbText } from '../schema/jsonb.js';

/** Shape stored in the test JSONB column. */
interface Payload {
  name: string;
  tags: string[];
  count: number;
}

/** Throwaway table used only by this test file. */
const probe = sqliteTable('jsonb_probe', {
  id: text('id').primaryKey(),
  payload: jsonb<Payload>('payload').default(sql`jsonb('{}')`),
});

describe('jsonb<T>() custom column type', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-t11354-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('declares a blob storage class', () => {
    expect(probe.payload.getSQLType()).toBe('blob');
  });

  it('round-trips a value through jsonb() and reads it back via json(col)', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');

    const nativeDb = openNativeDatabase(join(tempDir, 'probe.db'));
    nativeDb.exec('CREATE TABLE jsonb_probe (id TEXT PRIMARY KEY, payload BLOB)');
    const db = drizzle({ client: nativeDb });

    const value: Payload = { name: 'alpha', tags: ['x', 'y'], count: 3 };
    await db.insert(probe).values({ id: 'p1', payload: value });

    // The on-disk value is a JSONB BLOB, not text.
    const rawType = nativeDb
      .prepare("SELECT typeof(payload) AS t FROM jsonb_probe WHERE id = 'p1'")
      .get() as { t: string };
    expect(rawType.t).toBe('blob');

    // Whole-value read MUST go through json(col) — Drizzle parses the TEXT.
    const rows = await db
      .select({ id: probe.id, payload: jsonbText<Payload>(probe.payload) })
      .from(probe);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual(value);

    nativeDb.close();
  });

  it('supports in-SQL access: jsonb_extract, json_each, jsonb_insert', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');

    const nativeDb = openNativeDatabase(join(tempDir, 'probe.db'));
    nativeDb.exec('CREATE TABLE jsonb_probe (id TEXT PRIMARY KEY, payload BLOB)');
    nativeDb
      .prepare('INSERT INTO jsonb_probe (id, payload) VALUES (?, jsonb(?))')
      .run('p1', JSON.stringify({ name: 'alpha', tags: ['x', 'y'], count: 3 }));

    // Scalar extraction on the BLOB (no app-side parse).
    const extracted = nativeDb
      .prepare("SELECT jsonb_extract(payload, '$.name') AS name FROM jsonb_probe WHERE id = 'p1'")
      .get() as { name: string };
    expect(extracted.name).toBe('alpha');

    // json_each membership on the BLOB.
    const tags = nativeDb
      .prepare(
        "SELECT je.value AS tag FROM jsonb_probe, json_each(jsonb_probe.payload, '$.tags') AS je WHERE jsonb_probe.id = 'p1' ORDER BY je.value",
      )
      .all() as Array<{ tag: string }>;
    expect(tags.map((r) => r.tag)).toEqual(['x', 'y']);

    // Append via jsonb_insert($[#]) — no read-modify-write of the whole array.
    nativeDb
      .prepare(
        "UPDATE jsonb_probe SET payload = jsonb_insert(payload, '$.tags[#]', 'z') WHERE id = 'p1'",
      )
      .run();
    const after = nativeDb
      .prepare("SELECT json(payload) AS j FROM jsonb_probe WHERE id = 'p1'")
      .get() as { j: string };
    expect(JSON.parse(after.j).tags).toEqual(['x', 'y', 'z']);

    nativeDb.close();
  });

  it('rejects a raw-BLOB read so version-unstable bytes are never parsed', async () => {
    const { openNativeDatabase } = await import('../sqlite.js');
    const { drizzle } = await import('drizzle-orm/node-sqlite');

    const nativeDb = openNativeDatabase(join(tempDir, 'probe.db'));
    nativeDb.exec('CREATE TABLE jsonb_probe (id TEXT PRIMARY KEY, payload BLOB)');
    const db = drizzle({ client: nativeDb });
    await db.insert(probe).values({ id: 'p1', payload: { name: 'a', tags: [], count: 0 } });

    // Selecting the column directly (not via json()) MUST throw — the fromDriver
    // guard prevents silent JSON.parse of the opaque binary format.
    await expect(db.select().from(probe)).rejects.toThrow(/raw BLOB|json\(col\)/);

    nativeDb.close();
  });
});
