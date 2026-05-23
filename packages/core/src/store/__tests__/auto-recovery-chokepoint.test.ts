/**
 * Chokepoint regression test for brain.db auto-recovery
 * (T10302 / Saga T10281 / Epic T10286).
 *
 * Acceptance criterion 1 of Epic T10286 was:
 *
 * > "Regression test: synthesize malformed brain.db fixture → run
 * >  cleo memory observe → assert auto-recovery fires, snapshot restored,
 * >  original observation succeeds on retry"
 *
 * T10303 shipped the recovery pipeline plus its own unit tests for
 * {@link recoverMalformedBrainDb} (the leaf function). This file is the
 * COMPLEMENTARY chokepoint test that proves the open path
 * `getBrainDb()` in `packages/core/src/store/memory-sqlite.ts` actually
 * triggers the recovery pipeline end-to-end when a malformed brain.db
 * exists on disk — i.e. the wiring is connected.
 *
 * The chokepoint that auto-recovers is the writer-side `getBrainDb(cwd)`
 * exported from `packages/core/src/store/memory-sqlite.ts`. The
 * `cleo memory observe` CLI path lands in this same chokepoint (every
 * memory write opens brain.db via this singleton initializer), so
 * exercising it here is equivalent to running the CLI verb against a
 * malformed live DB.
 *
 * ## Why this test cannot be unit-level
 *
 * The unit tests in `recover-brain-db.test.ts` already verify the leaf
 * function in isolation. They mock nothing — but they DO call the leaf
 * directly. This file instead lets the brain-DB open pipeline run
 * end-to-end (open → malformation detect → recover → retry → drizzle
 * wrap → migrations) so a future refactor that detaches
 * `recoverMalformedBrainDb` from the chokepoint (e.g. someone removes
 * the call site or skips the post-open `quick_check` probe) is caught
 * by a red CI signal rather than a silent regression.
 *
 * The file name deliberately omits the `-integration` suffix so it
 * runs in the default `pnpm exec vitest run` matrix (the package's
 * vitest config excludes `**\/*-integration.test.ts`); per-test runtime
 * is bounded under 7s so the suite total stays well below 30s.
 *
 * ## Fixture strategy
 *
 * The chokepoint recovers on TWO failure surfaces:
 *  1. `openNativeDatabase()` throws with the malformation signature
 *     (`ERR_SQLITE_ERROR errcode=11` or `/malformed/i`).
 *  2. open succeeds but `PRAGMA quick_check` returns non-`ok`.
 *
 * Writing a non-SQLite garbage file at the brain.db path triggers
 * surface #1 only for SOME node:sqlite versions (others surface
 * SQLITE_NOTADB = 26, which the chokepoint deliberately does not treat
 * as malformation — that would mask unrelated user errors). To match
 * the live T10260/T10265 incident pattern AND give the chokepoint a
 * deterministic trigger, the fixture here builds a real SQLite file
 * with a corrupted `sqlite_schema` B-tree (bytes 100-200 on page 1,
 * matching the live RCA finding) so:
 *
 *   - The 16-byte SQLite header is intact → `new DatabaseSync(...)`
 *     succeeds.
 *   - The schema page B-tree header is mangled → `PRAGMA quick_check`
 *     returns non-`ok` OR throws errcode=11 on the first prepare().
 *
 * Either surface drives the chokepoint into the recovery branch, which
 * is exactly the contract we want to lock in.
 *
 * @task T10302
 * @epic T10286
 * @saga T10281
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Native SQLite handle (node:sqlite is CJS-only in current Node versions).
// Used for fixture seeding only — the test itself drives the chokepoint via
// the real `getBrainDb()` API.
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
 * Name of the marker table used by snapshot fixtures. Deliberately chosen
 * to NOT clash with any production brain schema table — the brain Drizzle
 * migrations (`packages/core/migrations/drizzle-brain/`) define
 * `brain_decisions`, `brain_patterns`, `brain_observations`, etc., none
 * of which match this prefix. The brain.db migration runner that follows
 * the chokepoint open therefore leaves this table untouched, letting the
 * post-recovery test assertions observe it intact.
 */
const T10302_MARKER_TABLE = 't10302_recovery_marker';

/**
 * Seed a minimal valid brain.db at `path` containing the T10302 marker
 * table pre-populated with `count` rows tagged by `seedTag`.
 *
 * The marker table is the ONLY schema seeded — we deliberately do NOT
 * seed any `brain_*` table. The brain Drizzle migrations that run AFTER
 * recovery use `CREATE TABLE IF NOT EXISTS` for every brain table, so
 * skipping them here lets the migration runner create them fresh
 * without column-mismatch warnings against our test stub.
 *
 * Used to build SNAPSHOT files that recovery will restore.
 *
 * @internal
 */
function seedHealthyBrainSnapshot(path: string, count: number, seedTag: string): void {
  const db = new DatabaseSync(path);
  // The marker table is the source of truth for our test assertions.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${T10302_MARKER_TABLE} (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      seed_tag TEXT NOT NULL
    );
  `);
  const stmt = db.prepare(
    `INSERT INTO ${T10302_MARKER_TABLE} (id, content, seed_tag) VALUES (?, ?, ?)`,
  );
  for (let i = 0; i < count; i++) {
    stmt.run(`${seedTag}-${i}`, `pre-seeded marker ${seedTag}-${i}`, seedTag);
  }
  db.close();
}

/**
 * Synthesize a malformed brain.db: build a real SQLite file then corrupt
 * the `sqlite_schema` B-tree page (page 1, bytes 100-200) so the file
 * passes the SQLite magic-header check but fails `PRAGMA quick_check`
 * the moment any schema-touching query runs.
 *
 * Matches the live T10260/T10265 incident signature called out in
 * T10301's RCA: malformed schema page surfacing as
 * `ERR_SQLITE_ERROR errcode=11` on the first prepare().
 *
 * @internal
 */
function synthesizeMalformedBrainDb(path: string): void {
  // Step 1 — build a real SQLite DB with a schema and a row so the file
  // contains real B-tree pages (not just header). The table name is the
  // T10302 marker (not `brain_observations`) so the corruption byte-write
  // below remains the only failure-injection mechanism; we don't want a
  // mismatched schema on the corrupt file to mask the byte-corruption.
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE ${T10302_MARKER_TABLE}_corrupt (id TEXT PRIMARY KEY, content TEXT NOT NULL);
    INSERT INTO ${T10302_MARKER_TABLE}_corrupt (id, content) VALUES ('seed-row', 'pre-corruption');
  `);
  db.close();

  // Step 2 — scribble bytes 100..200 on page 1. Page 1 is the
  // sqlite_schema page; its B-tree header starts at offset 100 (the
  // 16-byte file header occupies bytes 0..15, then SQLite-format
  // metadata fills 16..99, and page 1's interior B-tree header lives
  // at 100..107). Mangling 100..200 destroys both the B-tree header
  // AND the cell-pointer array, guaranteeing `quick_check` will refuse
  // the page.
  const fd = openSync(path, 'r+');
  try {
    // Verify we have a real SQLite header before corrupting — guards
    // against accidentally clobbering an empty/foreign file.
    const headerBuf = Buffer.alloc(16);
    readSync(fd, headerBuf, 0, 16, 0);
    if (headerBuf.toString('utf8', 0, 15) !== 'SQLite format 3') {
      throw new Error(
        'synthesizeMalformedBrainDb: fixture pre-condition failed — ' +
          'seeded file lacks the SQLite-3 magic header',
      );
    }

    // 100 bytes of `0xFF` — a value that's structurally invalid in
    // every B-tree header field (page type, cell count, cell-content
    // start, freeblock pointer) so SQLite cannot misinterpret the
    // page as a degenerate-but-valid one.
    const corruption = Buffer.alloc(100, 0xff);
    writeSync(fd, corruption, 0, 100, 100);
  } finally {
    closeSync(fd);
  }

  // Step 3 — drop any stale WAL/SHM sidecars. They would let SQLite
  // recover the original schema from journal frames, defeating the
  // corruption.
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = path + suffix;
    if (existsSync(sidecar)) {
      rmSync(sidecar, { force: true });
    }
  }
}

/**
 * Build the canonical snapshot filename used by `cleo backup add`:
 * `brain.db.snapshot-<iso-with-dashes>`. The ISO uses `-` for `:` and `.`
 * because Windows filesystems reject `:`.
 *
 * @internal
 */
function snapshotFilename(epochMs: number): string {
  return `brain.db.snapshot-${new Date(epochMs).toISOString().replace(/[:.]/g, '-')}`;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

/**
 * End-to-end regression: prove that calling the real `getBrainDb()`
 * chokepoint against a project root containing a malformed brain.db
 * triggers the T10303 recovery pipeline, restores the freshest
 * snapshot, and yields a usable Drizzle connection. Guards against
 * future refactors detaching `recoverMalformedBrainDb` from the open
 * chokepoint.
 */
describe('brain.db chokepoint integration — auto-recovery on malformed DB (T10302)', () => {
  let projectRoot: string;
  let cleoDir: string;
  let brainDbPath: string;
  let snapshotDir: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-T10302-integration-'));
    cleoDir = join(projectRoot, '.cleo');
    brainDbPath = join(cleoDir, 'brain.db');
    snapshotDir = join(cleoDir, 'backups', 'snapshot');
    mkdirSync(snapshotDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('chokepoint quarantines a malformed brain.db and restores the freshest valid snapshot', async () => {
    // ------------------------------------------------------------------
    // 1. Fixture: place a snapshot that's a real, healthy brain.db file
    //    with a known marker row. Recovery must copy this into place.
    // ------------------------------------------------------------------
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const snapshotPath = join(snapshotDir, snapshotFilename(fiveMinAgo));
    seedHealthyBrainSnapshot(snapshotPath, 4, 'snap');

    // ------------------------------------------------------------------
    // 2. Fixture: place a malformed brain.db at the chokepoint's
    //    canonical location.
    // ------------------------------------------------------------------
    mkdirSync(cleoDir, { recursive: true });
    synthesizeMalformedBrainDb(brainDbPath);

    // ------------------------------------------------------------------
    // 3. Mock the logger before the chokepoint module is loaded so we
    //    can assert the canonical `brain.auto-recovery` warn() fires.
    // ------------------------------------------------------------------
    const warnCalls: Array<{ obj: unknown; msg: string }> = [];
    vi.resetModules();
    vi.doMock('../../logger.js', () => ({
      getLogger: (_subsystem?: string) => ({
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn((...args: unknown[]) => {
          // Pino-style logger: warn(obj, msg) OR warn(msg).
          if (args.length >= 2 && typeof args[1] === 'string') {
            warnCalls.push({ obj: args[0], msg: args[1] });
          } else if (typeof args[0] === 'string') {
            warnCalls.push({ obj: {}, msg: args[0] });
          }
        }),
      }),
    }));

    // ------------------------------------------------------------------
    // 4. Drive the chokepoint with a fresh module graph so the mocks
    //    above are picked up.
    // ------------------------------------------------------------------
    const { getBrainDb, resetBrainDbState, getBrainNativeDb } = await import('../memory-sqlite.js');
    resetBrainDbState();

    let chokepointThrew: unknown = null;
    try {
      const db = await getBrainDb(projectRoot);
      expect(db).toBeTruthy();
    } catch (err) {
      chokepointThrew = err;
    }
    expect(
      chokepointThrew,
      `chokepoint must not throw after auto-recovery — got: ${
        chokepointThrew instanceof Error ? chokepointThrew.message : String(chokepointThrew)
      }`,
    ).toBeNull();

    // ------------------------------------------------------------------
    // 5. Assert: the malformed file moved to quarantine. Recovery
    //    pipeline creates `<cleoDir>/quarantine/brain-malformed-<iso>/
    //    brain.db.malformed`.
    // ------------------------------------------------------------------
    const quarantineRoot = join(cleoDir, 'quarantine');
    expect(existsSync(quarantineRoot)).toBe(true);
    const quarantineEntries = readdirSync(quarantineRoot);
    expect(quarantineEntries.length).toBeGreaterThan(0);
    const quarantineDir = join(quarantineRoot, quarantineEntries[0] as string);
    expect(quarantineDir).toMatch(/brain-malformed-/);
    expect(existsSync(join(quarantineDir, 'brain.db.malformed'))).toBe(true);

    // ------------------------------------------------------------------
    // 6. Assert: brain.db on disk now contains the snapshot's marker
    //    row. This proves the snapshot WAS restored, not that recovery
    //    merely "didn't throw". Opens read-only to avoid stealing the
    //    chokepoint singleton.
    // ------------------------------------------------------------------
    expect(existsSync(brainDbPath)).toBe(true);
    const verify = new DatabaseSync(brainDbPath, { readonly: true });
    try {
      const row = verify
        .prepare(`SELECT content FROM ${T10302_MARKER_TABLE} WHERE id = 'snap-0'`)
        .get() as { content?: string } | undefined;
      expect(row?.content).toBe('pre-seeded marker snap-0');
    } finally {
      verify.close();
    }

    // ------------------------------------------------------------------
    // 7. Assert: the chokepoint emitted the canonical
    //    `brain.auto-recovery` warn() exactly once with a structured
    //    payload pointing at the snapshot we placed.
    // ------------------------------------------------------------------
    const recoveryWarns = warnCalls.filter((c) => {
      const obj = c.obj as Record<string, unknown> | undefined;
      return obj?.['event'] === 'brain.auto-recovery';
    });
    expect(recoveryWarns.length).toBe(1);
    const payload = recoveryWarns[0]?.obj as Record<string, unknown>;
    expect(payload['restoredFrom']).toBe(snapshotPath);
    expect(payload['source']).toBe('system-snapshot');
    expect(typeof payload['dataLossWindowHours']).toBe('number');
    expect(payload['quarantineDir']).toBe(quarantineDir);
    expect(recoveryWarns[0]?.msg).toMatch(/BRAIN auto-recovered/);

    // ------------------------------------------------------------------
    // 8. Assert: the chokepoint's native handle is usable — the
    //    underlying singleton is open and `quick_check` returns ok on
    //    the restored DB. This is the "retry succeeded" half of the
    //    Epic T10286 acceptance criterion.
    // ------------------------------------------------------------------
    const native = getBrainNativeDb();
    expect(native).not.toBeNull();
    if (native) {
      const quick = native.prepare('PRAGMA quick_check').get() as
        | { quick_check?: string }
        | undefined;
      expect(quick?.quick_check).toBe('ok');
    }

    resetBrainDbState();
  });

  it('chokepoint picks the freshest VALIDATED snapshot when multiple exist (newest-first ranking)', async () => {
    // ------------------------------------------------------------------
    // 1. Place two snapshots: an older healthy one (10 minutes ago)
    //    and a newer healthy one (1 minute ago). Recovery must select
    //    the newer one per the freshness-ranking invariant.
    // ------------------------------------------------------------------
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const oneMinAgo = Date.now() - 1 * 60 * 1000;
    const olderPath = join(snapshotDir, snapshotFilename(tenMinAgo));
    const newerPath = join(snapshotDir, snapshotFilename(oneMinAgo));
    seedHealthyBrainSnapshot(olderPath, 2, 'older');
    seedHealthyBrainSnapshot(newerPath, 9, 'newer');

    mkdirSync(cleoDir, { recursive: true });
    synthesizeMalformedBrainDb(brainDbPath);

    const warnCalls: Array<{ obj: unknown; msg: string }> = [];
    vi.resetModules();
    vi.doMock('../../logger.js', () => ({
      getLogger: (_subsystem?: string) => ({
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn((...args: unknown[]) => {
          if (args.length >= 2 && typeof args[1] === 'string') {
            warnCalls.push({ obj: args[0], msg: args[1] });
          }
        }),
      }),
    }));

    const { getBrainDb, resetBrainDbState } = await import('../memory-sqlite.js');
    resetBrainDbState();

    const db = await getBrainDb(projectRoot);
    expect(db).toBeTruthy();

    // The restored DB must contain the NEWER snapshot's marker, not the older one.
    const verify = new DatabaseSync(brainDbPath, { readonly: true });
    try {
      const newerRow = verify
        .prepare(`SELECT content FROM ${T10302_MARKER_TABLE} WHERE id = 'newer-0'`)
        .get() as { content?: string } | undefined;
      expect(newerRow?.content).toBe('pre-seeded marker newer-0');
      // And NOT the older one.
      const olderRow = verify
        .prepare(`SELECT content FROM ${T10302_MARKER_TABLE} WHERE id = 'older-0'`)
        .get() as { content?: string } | undefined;
      expect(olderRow).toBeUndefined();
    } finally {
      verify.close();
    }

    // Single recovery warn naming the newer snapshot path.
    const recovery = warnCalls.find(
      (c) => (c.obj as Record<string, unknown>)['event'] === 'brain.auto-recovery',
    );
    expect(recovery).toBeDefined();
    expect((recovery?.obj as Record<string, unknown>)['restoredFrom']).toBe(newerPath);

    resetBrainDbState();
  });

  it('chokepoint surfaces failure (does NOT silently degrade) when no valid snapshot exists', async () => {
    // ------------------------------------------------------------------
    // 1. Place a malformed brain.db with NO snapshots. The chokepoint
    //    must NOT silently return a usable handle — it must surface
    //    the failure so the operator sees it. The recovery pipeline
    //    moves the corrupt file to quarantine even in this case so the
    //    next process attempt can retry with fresh state.
    // ------------------------------------------------------------------
    mkdirSync(cleoDir, { recursive: true });
    synthesizeMalformedBrainDb(brainDbPath);

    const errorCalls: Array<{ obj: unknown; msg: string }> = [];
    vi.resetModules();
    vi.doMock('../../logger.js', () => ({
      getLogger: (_subsystem?: string) => ({
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn((...args: unknown[]) => {
          if (args.length >= 2 && typeof args[1] === 'string') {
            errorCalls.push({ obj: args[0], msg: args[1] });
          }
        }),
      }),
    }));

    const { getBrainDb, resetBrainDbState } = await import('../memory-sqlite.js');
    resetBrainDbState();

    let outcome: 'threw' | 'returned' = 'returned';
    try {
      await getBrainDb(projectRoot);
    } catch {
      outcome = 'threw';
    }

    // The contract: when no snapshot exists, the chokepoint either
    // throws (preferred — loud failure) OR the migration phase fails
    // because the restored DB is missing. Either way, recovery has
    // already moved the corrupt file into quarantine so forensic
    // state survives.
    const quarantineRoot = join(cleoDir, 'quarantine');
    expect(existsSync(quarantineRoot)).toBe(true);
    const quarantineEntries = readdirSync(quarantineRoot);
    expect(quarantineEntries.length).toBeGreaterThan(0);

    // At least one error log naming the failed-recovery condition.
    expect(
      errorCalls.some((c) => /no validated snapshot/.test(c.msg) || /auto-recovery/.test(c.msg)),
    ).toBe(true);

    // We deliberately don't pin outcome to one branch: the chokepoint
    // is free to throw (e.g. migration runner fails on empty DB) OR
    // return a partially-initialized handle. The CONTRACT is that the
    // failure is OBSERVABLE — captured here by the quarantine + error
    // log presence assertions above.
    expect(['threw', 'returned']).toContain(outcome);

    resetBrainDbState();
  });

  it('chokepoint discovers VACUUM-INTO snapshots (cleo session end output) as fallback', async () => {
    // ------------------------------------------------------------------
    // 1. Place ONLY a VACUUM-INTO snapshot (no system-snapshot). The
    //    chokepoint wires `vacuumSnapshotDir: <cleoDir>/backups/sqlite`
    //    so this path must be discovered and restored.
    // ------------------------------------------------------------------
    const vacuumDir = join(cleoDir, 'backups', 'sqlite');
    mkdirSync(vacuumDir, { recursive: true });

    // VACUUM-INTO filename pattern: brain-YYYYMMDD-HHmmss.db
    const now = new Date();
    const pad = (n: number): string => n.toString().padStart(2, '0');
    const vacuumName = `brain-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.db`;
    const vacuumPath = join(vacuumDir, vacuumName);
    seedHealthyBrainSnapshot(vacuumPath, 3, 'vacuum');

    mkdirSync(cleoDir, { recursive: true });
    synthesizeMalformedBrainDb(brainDbPath);

    const warnCalls: Array<{ obj: unknown; msg: string }> = [];
    vi.resetModules();
    vi.doMock('../../logger.js', () => ({
      getLogger: (_subsystem?: string) => ({
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn((...args: unknown[]) => {
          if (args.length >= 2 && typeof args[1] === 'string') {
            warnCalls.push({ obj: args[0], msg: args[1] });
          }
        }),
      }),
    }));

    const { getBrainDb, resetBrainDbState } = await import('../memory-sqlite.js');
    resetBrainDbState();

    const db = await getBrainDb(projectRoot);
    expect(db).toBeTruthy();

    // Vacuum snapshot's marker is now in brain.db.
    const verify = new DatabaseSync(brainDbPath, { readonly: true });
    try {
      const row = verify
        .prepare(`SELECT content FROM ${T10302_MARKER_TABLE} WHERE id = 'vacuum-0'`)
        .get() as { content?: string } | undefined;
      expect(row?.content).toBe('pre-seeded marker vacuum-0');
    } finally {
      verify.close();
    }

    // Recovery announcement tagged the source as `vacuum-snapshot`.
    const recovery = warnCalls.find(
      (c) => (c.obj as Record<string, unknown>)['event'] === 'brain.auto-recovery',
    );
    expect(recovery).toBeDefined();
    expect((recovery?.obj as Record<string, unknown>)['source']).toBe('vacuum-snapshot');
    expect((recovery?.obj as Record<string, unknown>)['restoredFrom']).toBe(vacuumPath);

    resetBrainDbState();
  });
});

// ---------------------------------------------------------------------------
// Note on fixture construction
// ---------------------------------------------------------------------------
//
// The helpers above use the raw `node:sqlite` `DatabaseSync` constructor
// (not `openNativeDatabase`) to seed the malformed brain.db and the
// snapshot files. The vitest production-DB guard inside
// `assertVitestSafePath` is path-based — it allows any path under
// `os.tmpdir()`, which is where every fixture file lives. The
// db-open-allowed annotation below documents that these fixture seeds
// are deliberate and orthogonal to the `openCleoDb()` chokepoint
// contract enforced by the `DB Open Guard` CI gate (T10073).
// db-open-allowed: T10302 fixture writer — seeds tmp SQLite files under
// os.tmpdir() to construct malformed/snapshot fixtures consumed by the
// integration test above.
