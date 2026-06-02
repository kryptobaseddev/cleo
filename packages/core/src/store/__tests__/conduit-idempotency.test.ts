/**
 * Conduit DB idempotency contract test.
 *
 * Saga T10281 / Epic T10283 E2-DB-INTEGRITY / Task T10314.
 *
 * Asserts that the canonical conduit.db chokepoint
 * ({@link ensureConduitDb}) is idempotent across both open cycles and
 * write replays. The contract:
 *
 *   1. The first call to `await ensureConduitDb(projectRoot)` returns
 *      `action: 'created'`. The second call (after the singleton is
 *      closed to simulate a separate process) returns
 *      `action: 'exists'` — confirming the schema-version sentinel
 *      fast-path is engaged.
 *   2. Running the SAME INSERT against the conduit handle twice
 *      produces exactly one row. The chosen statement uses
 *      `INSERT INTO ... ON CONFLICT DO UPDATE` semantics (matching
 *      the canonical writer `attachAgentToProject`) so the second
 *      write upserts and does not duplicate.
 *   3. PRAGMAs are stable across opens (WAL mode, foreign_keys on).
 *
 * Sandboxing: every test runs inside an `mkdtempSync` directory and
 * pins the conduit.db location to `<tmp>/.cleo/conduit.db`. The real
 * user's `.cleo/` is never touched.
 *
 * Cross-link: ADR-013 §9 — although conduit.db is NOT among the four
 * git-untracked runtime files listed in the original resolution, it is
 * still gitignored at the parent level via `*.db` rules and shares the
 * same "reopen-after-branch-switch must be safe" invariant.
 *
 * @task T10314
 * @epic T10283
 * @saga T10281
 * @adr ADR-013
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeConduitDb,
  ensureConduitDb,
  getConduitDbPath,
  getConduitNativeDb,
} from '../conduit-sqlite.js';

describe('conduit.db idempotency contract (T10314)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-conduit-idempotency-'));
    // E6-L3: getConduitDbPath now resolves via resolveCleoDir(tempDir), which
    // needs a `.cleo/` directory present. Create it (cleo.db itself is created by
    // ensureConduitDb).
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
    closeConduitDb();
  });

  afterEach(() => {
    closeConduitDb();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('ensureConduitDb returns created on first call and exists on second', async () => {
    const first = await ensureConduitDb(tempDir);
    expect(first.action).toBe('created');
    expect(first.path).toBe(getConduitDbPath(tempDir));

    // Close singleton — simulates a second CLI process.
    closeConduitDb();

    const second = await ensureConduitDb(tempDir);
    expect(second.action).toBe('exists');
    expect(second.path).toBe(first.path);
  });

  it('identical agent attach writes do not duplicate rows', async () => {
    await ensureConduitDb(tempDir);
    const dbFirst = getConduitNativeDb();
    expect(dbFirst).not.toBeNull();

    const attachedAt = '2026-05-23T00:00:00.000Z';
    const insertSql = `
      INSERT INTO conduit_project_agent_refs (agent_id, attached_at, role, capabilities_override, last_used_at, enabled)
      VALUES ('idem-agent', '${attachedAt}', NULL, NULL, NULL, 1)
      ON CONFLICT(agent_id) DO UPDATE SET
        enabled = 1,
        attached_at = conduit_project_agent_refs.attached_at
    `;
    dbFirst!.exec(insertSql);

    const countFirst = dbFirst!
      .prepare('SELECT count(*) AS n FROM conduit_project_agent_refs WHERE agent_id = ?')
      .get('idem-agent') as { n: number };
    expect(countFirst.n).toBe(1);

    // Simulate a second process — close singleton, reopen.
    closeConduitDb();
    const reopen = await ensureConduitDb(tempDir);
    expect(reopen.action).toBe('exists');

    const dbSecond = getConduitNativeDb();
    expect(dbSecond).not.toBeNull();

    // Re-run the SAME insert. ON CONFLICT must keep row count at 1.
    dbSecond!.exec(insertSql);

    const countSecond = dbSecond!
      .prepare('SELECT count(*) AS n FROM conduit_project_agent_refs WHERE agent_id = ?')
      .get('idem-agent') as { n: number };
    expect(countSecond.n).toBe(1);

    // Original attached_at must be preserved by the ON CONFLICT clause —
    // the second open's upsert intentionally keeps the historical value.
    const row = dbSecond!
      .prepare('SELECT attached_at, enabled FROM conduit_project_agent_refs WHERE agent_id = ?')
      .get('idem-agent') as { attached_at: string; enabled: number };
    expect(row.attached_at).toBe(attachedAt);
    expect(row.enabled).toBe(1);
  });

  it('schema version sentinel does not double-write on second open', async () => {
    await ensureConduitDb(tempDir);
    const dbFirst = getConduitNativeDb();
    expect(dbFirst).not.toBeNull();

    const metaCountFirst = dbFirst!.prepare('SELECT count(*) AS n FROM _conduit_meta').get() as {
      n: number;
    };

    closeConduitDb();
    await ensureConduitDb(tempDir);

    const dbSecond = getConduitNativeDb();
    expect(dbSecond).not.toBeNull();

    const metaCountSecond = dbSecond!.prepare('SELECT count(*) AS n FROM _conduit_meta').get() as {
      n: number;
    };

    // The sentinel uses INSERT OR REPLACE on a single `schema_version`
    // key — row count must be identical on the second open.
    expect(metaCountSecond.n).toBe(metaCountFirst.n);
  });

  it('PRAGMAs are stable across opens (WAL + foreign_keys)', async () => {
    await ensureConduitDb(tempDir);
    const dbFirst = getConduitNativeDb();
    expect(dbFirst).not.toBeNull();

    const journalFirst = dbFirst!.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    expect(journalFirst.journal_mode).toBe('wal');
    const fkFirst = dbFirst!.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(fkFirst.foreign_keys).toBe(1);

    closeConduitDb();
    await ensureConduitDb(tempDir);
    const dbSecond = getConduitNativeDb();
    expect(dbSecond).not.toBeNull();

    const journalSecond = dbSecond!.prepare('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    expect(journalSecond.journal_mode).toBe('wal');
    const fkSecond = dbSecond!.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(fkSecond.foreign_keys).toBe(1);
  });
});
