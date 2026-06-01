/**
 * Brain-domain open-chokepoint contract test.
 *
 * ## History — brain.db auto-recovery (T10302 / Saga T10281 / Epic T10286)
 *
 * This file originally locked in a regression contract: calling the real
 * `getBrainDb()` chokepoint against a project root containing a malformed
 * standalone `brain.db` triggered the T10303 recovery pipeline
 * (`recoverMalformedBrainDb`) — quarantine the corrupt file, restore the
 * freshest validated `brain.db.snapshot-*`, and re-open.
 *
 * ## E6-L2 architectural change (T11522 · SG-DB-SUBSTRATE-V2)
 *
 * `getBrainDb()` no longer opens a standalone `brain.db`. It now routes through
 * `openDualScopeDb('project')`, so the brain domain lives inside the consolidated
 * project `cleo.db` alongside the `tasks_*` / `conduit_*` / `docs_*` domains.
 * The brain-only quarantine/snapshot-restore pipeline cannot be wired into this
 * chokepoint anymore: restoring a brain-only snapshot over `cleo.db` would
 * destroy every co-resident non-brain domain. Consolidated-`cleo.db`
 * malformation recovery is therefore a dual-scope-level concern (a later leaf /
 * the exodus), NOT this brain chokepoint's job.
 *
 * The recovery PRIMITIVE itself — `recoverMalformedBrainDb` — is unchanged and
 * remains under unit test in `recover-brain-db.test.ts`; only its wiring into
 * `getBrainDb()` was removed. This file now asserts the NEW chokepoint contract:
 *
 *  1. `getBrainDbPath()` resolves to the consolidated `cleo.db`, NOT `brain.db`.
 *  2. `getBrainDb()` opens the consolidated `cleo.db` and yields a usable
 *     Drizzle connection.
 *  3. A pre-existing malformed *standalone* `brain.db` on disk is irrelevant to
 *     the chokepoint — it is neither read nor touched, and the chokepoint still
 *     succeeds (the brain domain is served from `cleo.db`).
 *
 * @task T11522
 * @task T10302 (superseded contract)
 * @epic T11249
 * @saga T11242
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Native SQLite handle (node:sqlite is CJS-only in current Node versions).
// Used for fixture seeding + read-back assertions only — the test itself drives
// the chokepoint via the real `getBrainDb()` API.
// ---------------------------------------------------------------------------

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (
    path: string,
    opts?: { readonly?: boolean },
  ) => import('node:sqlite').DatabaseSync;
};

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Synthesize a malformed standalone `brain.db`: build a real SQLite file then
 * corrupt the `sqlite_schema` B-tree page (page 1, bytes 100..200) so the file
 * passes the SQLite magic-header check but fails `PRAGMA quick_check` the moment
 * any schema-touching query runs. Matches the live T10260/T10265 signature.
 *
 * Used here only to prove the E6-L2 chokepoint does NOT read this file.
 *
 * @internal
 */
function synthesizeMalformedBrainDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE corrupt_marker (id TEXT PRIMARY KEY, content TEXT NOT NULL);
    INSERT INTO corrupt_marker (id, content) VALUES ('seed-row', 'pre-corruption');
  `);
  db.close();

  const fd = openSync(path, 'r+');
  try {
    // 100 bytes of 0xFF over the page-1 B-tree header + cell-pointer array
    // (offset 100..200) — guarantees `quick_check` refuses the page.
    const corruption = Buffer.alloc(100, 0xff);
    writeSync(fd, corruption, 0, 100, 100);
  } finally {
    closeSync(fd);
  }

  for (const suffix of ['-wal', '-shm']) {
    const sidecar = path + suffix;
    if (existsSync(sidecar)) rmSync(sidecar, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Test suite — E6-L2 chokepoint contract
// ---------------------------------------------------------------------------

describe('brain-domain open chokepoint — dual-scope cleo.db routing (T11522)', () => {
  let projectRoot: string;
  let cleoDir: string;

  beforeEach(() => {
    process.env.VITEST = '1';
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-T11522-chokepoint-'));
    cleoDir = join(projectRoot, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
  });

  afterEach(async () => {
    const { resetBrainDbState } = await import('../memory-sqlite.js');
    resetBrainDbState();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('getBrainDbPath resolves to the consolidated cleo.db, not a standalone brain.db', async () => {
    const { getBrainDbPath } = await import('../memory-sqlite.js');
    const dbPath = getBrainDbPath(projectRoot);
    expect(basename(dbPath)).toBe('cleo.db');
    expect(dbPath).not.toMatch(/brain\.db$/);
  });

  it('getBrainDb opens the consolidated cleo.db and yields a usable connection', async () => {
    const { getBrainDb, getBrainNativeDb, getBrainDbPath, resetBrainDbState } = await import(
      '../memory-sqlite.js'
    );
    resetBrainDbState();

    const db = await getBrainDb(projectRoot);
    expect(db).toBeTruthy();

    // The chokepoint must have created the consolidated cleo.db on disk.
    expect(existsSync(getBrainDbPath(projectRoot))).toBe(true);

    // The native handle serves the brain domain: the consolidated brain_*
    // tables AND the runtime-legacy tables added by the T11522 forward
    // migration (brain_task_observations, unprefixed deriver_queue) exist.
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();
    for (const table of [
      'brain_decisions',
      'brain_observations',
      'brain_task_observations',
      'deriver_queue',
    ]) {
      const row = nativeDb
        ?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table) as { name?: string } | undefined;
      expect(row?.name, `expected table ${table} to exist in cleo.db`).toBe(table);
    }
  });

  it('a pre-existing malformed standalone brain.db is irrelevant to the chokepoint', async () => {
    // The brain domain moved to cleo.db (E6-L2). A leftover malformed brain.db
    // file must NOT be read by — nor break — the chokepoint, and must NOT be
    // quarantined by it (that recovery moved to the dual-scope level).
    const legacyBrainDbPath = join(cleoDir, 'brain.db');
    synthesizeMalformedBrainDb(legacyBrainDbPath);

    const { getBrainDb, resetBrainDbState } = await import('../memory-sqlite.js');
    resetBrainDbState();

    let threw: unknown = null;
    try {
      const db = await getBrainDb(projectRoot);
      expect(db).toBeTruthy();
    } catch (err) {
      threw = err;
    }
    expect(
      threw,
      `chokepoint must succeed regardless of a malformed standalone brain.db — got: ${
        threw instanceof Error ? threw.message : String(threw)
      }`,
    ).toBeNull();

    // The chokepoint does not own brain.db-file recovery anymore: the malformed
    // file is left untouched (no quarantine dir created by this chokepoint).
    expect(existsSync(legacyBrainDbPath)).toBe(true);
    expect(existsSync(join(cleoDir, 'quarantine'))).toBe(false);
  });
});
