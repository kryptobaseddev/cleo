/**
 * T682 — STDP Phase 5 Functional Test (end-to-end CLI verification).
 *
 * Verifies that plasticity events fire in a real brain.db when the `cleo`
 * binary is invoked via `execFile` (not mocked). This test exercises the full
 * stack: direct SQLite row insertion → CLI spawn → DB assertion.
 *
 * Strategy:
 *   1. Create a fresh tmpdir with an initialised brain.db (via getBrainDb).
 *   2. Insert real brain_retrieval_log rows with timestamps within the STDP
 *      pairing window so that STDP has pairs to process.
 *   3. Close the in-process DB connection (to avoid WAL conflicts with CLI).
 *   4. Spawn `cleo memory dream --json` via `execFile`, passing CLEO_DIR as an
 *      absolute path — this triggers the full runConsolidation pipeline
 *      (Steps 9a/9b/9c) inside the real installed cleo binary.
 *   5. Re-open the DB and assert:
 *        - brain_plasticity_events COUNT > 0
 *        - at least one event has kind = 'ltp'
 *        - brain_page_edges has at least one co_retrieved edge
 *   6. Spawn `cleo brain plasticity stats --json` and verify that
 *      stats.totalEvents > 0 in the parsed JSON output.
 *   7. Cleanup tmpdir in afterEach.
 *
 * No vi.mock() is used anywhere in this file — all assertions hit real SQLite.
 *
 * @task T682
 * @epic T673
 * @see docs/specs/stdp-wire-up-spec.md §6.3
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Vitest timeout — CLI spawns add real process startup latency
// ---------------------------------------------------------------------------

vi.setConfig({ testTimeout: 60_000 });

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Resolve the `cleo` binary path at module load time.
// Prefer the installed binary on PATH so it exercises the real distributed CLI.
// ---------------------------------------------------------------------------

/**
 * Locate the `cleo` executable. Resolves via the system PATH.
 * If not found, tests that require the CLI binary will be skipped.
 */
function getCleoPath(): string {
  // Prefer the installed npm-global binary (matches CI environment)
  return 'cleo';
}

const CLEO_BIN = getCleoPath();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

/**
 * Initialise a fresh brain.db in the given directory.
 * Returns the native DatabaseSync instance for direct SQL operations.
 */
async function setupBrainDb(dir: string) {
  const { closeBrainDb, getBrainDb, getBrainNativeDb } = await import(
    '../../store/brain-sqlite.js'
  );
  // Reset any lingering singleton from a previous test run.
  closeBrainDb();
  // Set CLEO_DIR so getBrainDb writes to our tmpdir.
  process.env['CLEO_DIR'] = join(dir, '.cleo');
  await getBrainDb(dir);
  return { nativeDb: getBrainNativeDb()!, closeBrainDb };
}

/**
 * Insert a brain_retrieval_log row with two distinct entry_ids so that the
 * STDP engine has a concrete A→B spike pair to process.
 *
 * @param nativeDb - Native SQLite connection to insert into.
 * @param entryIds - Array of observation IDs (at least 2 for a valid spike pair).
 * @param sessionId - Session ID to assign to this retrieval row.
 * @param secondsAgo - How many seconds in the past to stamp created_at.
 */
function insertRetrievalRow(
  nativeDb: import('node:sqlite').DatabaseSync,
  opts: {
    entryIds: string[];
    sessionId: string;
    secondsAgo: number;
  },
): void {
  nativeDb
    .prepare(
      `INSERT INTO brain_retrieval_log
         (query, entry_ids, entry_count, source, session_id, created_at)
       VALUES ('q', ?, ?, 'find', ?, datetime('now', '-' || ? || ' seconds'))`,
    )
    .run(JSON.stringify(opts.entryIds), opts.entryIds.length, opts.sessionId, opts.secondsAgo);
}

/**
 * Spawn the cleo CLI binary with CLEO_DIR pointing to the test tmpdir.
 *
 * Returns { stdout, stderr, exitCode }. Does NOT throw on non-zero exit so
 * the caller can inspect stderr for diagnostics.
 */
async function runCleo(
  args: string[],
  cleoDirAbsolute: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(CLEO_BIN, args, {
      env: {
        ...process.env,
        CLEO_DIR: cleoDirAbsolute,
      },
      timeout: 30_000,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    // execFile rejects with an error that has stdout/stderr/code on non-zero exit
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.code ?? 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

describe('T682 — STDP Phase 5 Functional Test (real CLI, real brain.db)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-stdp-functional-'));
    // Create the .cleo subdirectory that CLEO_DIR points to.
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../store/brain-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // T682-1: Core functional — CLI dream cycle writes LTP events to real brain.db
  // =========================================================================

  it('T682-1: cleo memory dream writes brain_plasticity_events with kind=ltp to real brain.db', async () => {
    const cleoDirAbsolute = join(tempDir, '.cleo');

    // Step 1: Initialise DB and insert retrieval pairs
    const { nativeDb, closeBrainDb } = await setupBrainDb(tempDir);

    // Two rows 2 minutes apart in the same session — guaranteed within the
    // default pairingWindowMs (5 min). Different entry_ids create A→B pairs.
    insertRetrievalRow(nativeDb, {
      entryIds: ['obs:functional-A'],
      sessionId: 'ses_t682_functional_1',
      secondsAgo: 120,
    });

    insertRetrievalRow(nativeDb, {
      entryIds: ['obs:functional-B'],
      sessionId: 'ses_t682_functional_1',
      secondsAgo: 60,
    });

    // Verify the rows landed in the DB before releasing the connection.
    const rowCount = nativeDb.prepare('SELECT COUNT(*) AS cnt FROM brain_retrieval_log').get() as {
      cnt: number;
    };
    expect(rowCount.cnt).toBe(2);

    // Step 2: Close the in-process connection so the CLI binary can open the
    // WAL-mode DB without contention.
    closeBrainDb();
    delete process.env['CLEO_DIR'];

    // Step 3: Spawn `cleo memory dream --json` — triggers runConsolidation
    // Steps 9a (R-STDP reward backfill) and 9b (STDP plasticity).
    const dreamResult = await runCleo(['memory', 'dream', '--json'], cleoDirAbsolute);

    // CLI must exit successfully
    expect(
      dreamResult.exitCode,
      `cleo memory dream exited ${dreamResult.exitCode}.\nstdout: ${dreamResult.stdout}\nstderr: ${dreamResult.stderr}`,
    ).toBe(0);

    // Parse JSON output
    let dreamJson: {
      success: boolean;
      data?: {
        stdpPlasticity?: { ltpEvents: number; ltdEvents: number; edgesCreated: number };
      };
    };
    try {
      dreamJson = JSON.parse(dreamResult.stdout);
    } catch {
      throw new Error(
        `cleo memory dream output was not valid JSON:\n${dreamResult.stdout}\nstderr: ${dreamResult.stderr}`,
      );
    }
    expect(dreamJson.success).toBe(true);

    // Step 9b (STDP) must have run and produced at least 1 LTP event
    expect(
      dreamJson.data?.stdpPlasticity,
      'stdpPlasticity must be present in dream JSON — Step 9b ran',
    ).toBeDefined();
    expect(
      dreamJson.data?.stdpPlasticity?.ltpEvents,
      'Dream cycle must produce at least 1 LTP event from the 2 retrieval rows',
    ).toBeGreaterThanOrEqual(1);

    // Step 4: Re-open the DB to assert the persisted state.
    process.env['CLEO_DIR'] = cleoDirAbsolute;
    const { getBrainDb: getBrainDb2, getBrainNativeDb: getBrainNativeDb2 } = await import(
      '../../store/brain-sqlite.js'
    );
    await getBrainDb2(tempDir);
    const nativeDb2 = getBrainNativeDb2()!;

    // brain_plasticity_events must have rows
    const evtCount = nativeDb2
      .prepare(`SELECT COUNT(*) AS cnt FROM brain_plasticity_events`)
      .get() as { cnt: number };
    expect(
      evtCount.cnt,
      'brain_plasticity_events must have > 0 rows after CLI dream cycle',
    ).toBeGreaterThan(0);

    // At least one event must be kind='ltp'
    const ltpCount = nativeDb2
      .prepare(`SELECT COUNT(*) AS cnt FROM brain_plasticity_events WHERE kind = 'ltp'`)
      .get() as { cnt: number };
    expect(ltpCount.cnt, 'At least one plasticity event must have kind=ltp').toBeGreaterThanOrEqual(
      1,
    );

    // brain_page_edges must have at least one co_retrieved edge
    const edgeCount = nativeDb2
      .prepare(`SELECT COUNT(*) AS cnt FROM brain_page_edges WHERE edge_type = 'co_retrieved'`)
      .get() as { cnt: number };
    expect(
      edgeCount.cnt,
      'brain_page_edges must have at least one co_retrieved edge after LTP',
    ).toBeGreaterThanOrEqual(1);
  });

  // =========================================================================
  // T682-2: CLI stats surface — `cleo brain plasticity stats --json` reflects events
  // =========================================================================

  it('T682-2: cleo brain plasticity stats --json reports totalEvents > 0 after dream cycle', async () => {
    const cleoDirAbsolute = join(tempDir, '.cleo');

    // Setup DB with retrieval pairs (same approach as T682-1)
    const { nativeDb, closeBrainDb } = await setupBrainDb(tempDir);

    insertRetrievalRow(nativeDb, {
      entryIds: ['obs:stats-A'],
      sessionId: 'ses_t682_stats_1',
      secondsAgo: 180,
    });
    insertRetrievalRow(nativeDb, {
      entryIds: ['obs:stats-B'],
      sessionId: 'ses_t682_stats_1',
      secondsAgo: 90,
    });

    closeBrainDb();
    delete process.env['CLEO_DIR'];

    // Run dream cycle to populate plasticity events
    const dreamResult = await runCleo(['memory', 'dream', '--json'], cleoDirAbsolute);
    expect(
      dreamResult.exitCode,
      `cleo memory dream failed.\nstdout: ${dreamResult.stdout}\nstderr: ${dreamResult.stderr}`,
    ).toBe(0);

    // Now query stats via the CLI
    const statsResult = await runCleo(['brain', 'plasticity', 'stats', '--json'], cleoDirAbsolute);
    expect(
      statsResult.exitCode,
      `cleo brain plasticity stats exited ${statsResult.exitCode}.\nstdout: ${statsResult.stdout}\nstderr: ${statsResult.stderr}`,
    ).toBe(0);

    let statsJson: {
      success: boolean;
      data?: {
        totalEvents: number;
        ltpCount: number;
        ltdCount: number;
        netDeltaW: number;
      };
    };
    try {
      statsJson = JSON.parse(statsResult.stdout);
    } catch {
      throw new Error(
        `cleo brain plasticity stats output was not valid JSON:\n${statsResult.stdout}\nstderr: ${statsResult.stderr}`,
      );
    }

    expect(statsJson.success).toBe(true);
    expect(
      statsJson.data?.totalEvents,
      'totalEvents must be > 0 in plasticity stats after dream cycle',
    ).toBeGreaterThan(0);
    expect(
      statsJson.data?.ltpCount,
      'ltpCount must be >= 1 in plasticity stats',
    ).toBeGreaterThanOrEqual(1);
  });

  // =========================================================================
  // T682-3: LTP edge weight delta — delta_w must be non-zero for LTP events
  // =========================================================================

  it('T682-3: LTP plasticity events have non-zero weight delta (delta_w > 0)', async () => {
    const cleoDirAbsolute = join(tempDir, '.cleo');

    const { nativeDb, closeBrainDb } = await setupBrainDb(tempDir);

    // Insert 3 retrieval rows — more pairs → stronger signal
    insertRetrievalRow(nativeDb, {
      entryIds: ['obs:delta-A'],
      sessionId: 'ses_t682_delta_1',
      secondsAgo: 240,
    });
    insertRetrievalRow(nativeDb, {
      entryIds: ['obs:delta-B'],
      sessionId: 'ses_t682_delta_1',
      secondsAgo: 120,
    });
    insertRetrievalRow(nativeDb, {
      entryIds: ['obs:delta-A', 'obs:delta-C'],
      sessionId: 'ses_t682_delta_1',
      secondsAgo: 30,
    });

    closeBrainDb();
    delete process.env['CLEO_DIR'];

    const dreamResult = await runCleo(['memory', 'dream', '--json'], cleoDirAbsolute);
    expect(
      dreamResult.exitCode,
      `cleo memory dream failed.\nstdout: ${dreamResult.stdout}\nstderr: ${dreamResult.stderr}`,
    ).toBe(0);

    // Verify delta_w in the DB
    process.env['CLEO_DIR'] = cleoDirAbsolute;
    const { getBrainDb: getBrainDb3, getBrainNativeDb: getBrainNativeDb3 } = await import(
      '../../store/brain-sqlite.js'
    );
    await getBrainDb3(tempDir);
    const nativeDb3 = getBrainNativeDb3()!;

    const ltpEvents = nativeDb3
      .prepare(`SELECT delta_w FROM brain_plasticity_events WHERE kind = 'ltp' ORDER BY id`)
      .all() as Array<{ delta_w: number }>;

    expect(
      ltpEvents.length,
      'Expected at least 1 LTP event in brain_plasticity_events',
    ).toBeGreaterThanOrEqual(1);

    for (const evt of ltpEvents) {
      expect(evt.delta_w, `LTP event delta_w must be > 0 (was ${evt.delta_w})`).toBeGreaterThan(0);
    }
  });
});
