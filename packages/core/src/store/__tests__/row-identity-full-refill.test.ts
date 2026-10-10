/**
 * T13231 — a stale recipe marker on a PROVABLY unshared store re-derives every
 * identity value from scratch; anything that may have left the store is kept.
 *
 * The real-store Gate B (spec t12341-uid-scheme v13 §15.0) found cleocode
 * keeping pre-release uids on symmetric relation edges and a criterion, which
 * a device filling the same data from nothing derives differently. The
 * targeted refill kept uids "because the uid recipe did not change". Now:
 *
 * - unshared (no shared marker, no started stream, never rebound, no vault
 *   push/restore, not Nexus-linked without a vault record): snapshot, clear
 *   every identity column of every declared table, refill;
 * - shared or unknown: keep every value and refuse, loudly.
 *
 * @task T13231
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  prepareRowIdentity,
  ROW_IDENTITY,
  ROW_IDENTITY_RECIPE,
  ROW_IDENTITY_RECIPE_KEY,
  ROW_IDENTITY_REFILL_SNAPSHOT_KEY,
  ROW_IDENTITY_REFUSED_KEY,
  readRowIdentityRefusal,
  rowIdentityColumns,
  rowIdentityFillPending,
  rowIdentityShareState,
} from '../row-identity.js';
import { getNativeTasksDb } from '../sqlite.js';
import { ensureSyncSchema } from '../sync/schema.js';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

const BOGUS_REL = '00000000-0000-8000-8000-0000000000a1';
const BOGUS_AC = '01900000-0000-7000-8000-000000000ac1';

describe('full from-scratch identity refill (T13231)', () => {
  let env: TestDbEnv;
  let db: DatabaseSync;

  const one = (sql: string) => db.prepare(sql).get() as Record<string, string | null> | undefined;
  const relUid = () =>
    one(
      "SELECT uid FROM tasks_task_relations WHERE task_id = 'T001' AND related_to = 'T002' AND relation_type = 'related'",
    )?.uid ?? null;
  const acUid = () =>
    one("SELECT uid FROM tasks_task_acceptance_criteria WHERE id = 'ac-1'")?.uid ?? null;

  /** The pre-release state: kept uids no recipe of the release derives, marker gone. */
  function plantStale(): void {
    db.prepare(
      "UPDATE tasks_task_relations SET uid = ? WHERE task_id = 'T001' AND related_to = 'T002'",
    ).run(BOGUS_REL);
    db.prepare("UPDATE tasks_task_acceptance_criteria SET uid = ? WHERE id = 'ac-1'").run(BOGUS_AC);
    db.exec(`DELETE FROM tasks_row_identity_meta WHERE key = '${ROW_IDENTITY_RECIPE_KEY}'`);
  }

  beforeEach(async () => {
    process.env.CLEO_ROW_UID_FILL = '1';
    env = await createTestDb();
    vi.stubEnv('CLEO_HOME', join(env.tempDir, 'cleo-home'));
    mkdirSync(join(env.tempDir, 'cleo-home'), { recursive: true });
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'One', type: 'task' },
      { id: 'T002', title: 'Two', type: 'task' },
    ]);
    const native = getNativeTasksDb(env.tempDir);
    if (!native) throw new Error('no native handle');
    db = native;
    db.exec(`INSERT INTO tasks_task_relations (task_id, related_to, relation_type) VALUES ('T001', 'T002', 'related');
      INSERT INTO tasks_task_acceptance_criteria (id, task_id, ordinal, text, kind, source_key)
        VALUES ('ac-1', 'T001', 1, 'tests pass', 'text', 'text:1:x');`);
    prepareRowIdentity(db, 'project');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await env.cleanup();
    delete process.env.CLEO_ROW_UID_FILL;
  });

  /** Every identity value of the two rows under test, after a fill from nothing. */
  function fromNothing(): { rel: string | null; ac: string | null } {
    for (const spec of ROW_IDENTITY.project) {
      const cols = rowIdentityColumns('project', spec.table);
      if (spec.table.endsWith('_aliases')) continue;
      db.exec(`UPDATE ${spec.table} SET ${cols.map((c) => `${c} = NULL`).join(', ')}`);
    }
    db.exec(`DELETE FROM tasks_row_identity_meta WHERE key = '${ROW_IDENTITY_RECIPE_KEY}'`);
    prepareRowIdentity(db, 'project');
    return { rel: relUid(), ac: acUid() };
  }

  it('an unshared store re-derives kept relation and criterion uids, after a snapshot', () => {
    plantStale();
    expect(rowIdentityShareState(db).state).toBe('unshared');
    const report = prepareRowIdentity(db, 'project');
    expect(report?.refill).toBe('cleared');
    const refilled = { rel: relUid(), ac: acUid() };
    expect(refilled.rel).not.toBe(BOGUS_REL);
    expect(refilled.ac).not.toBe(BOGUS_AC);
    const snapshot = one(
      `SELECT value FROM tasks_row_identity_meta WHERE key = '${ROW_IDENTITY_REFILL_SNAPSHOT_KEY}'`,
    )?.value;
    expect(snapshot && existsSync(snapshot)).toBe(true);
    // The snapshot holds the old uids, so a rollback can restore them.
    db.exec(`ATTACH '${String(snapshot).replaceAll("'", "''")}' AS snap`);
    const old = one(
      "SELECT uid FROM snap.tasks_task_relations WHERE task_id = 'T001' AND related_to = 'T002'",
    )?.uid;
    db.exec('DETACH snap');
    expect(old).toBe(BOGUS_REL);
    expect(prepareRowIdentity(db, 'project')?.refill).toBe('none');
    // The refill equals a fill from nothing (the Gate B check 5 property).
    expect(fromNothing()).toEqual(refilled);
  });

  it('a vault-pushed store is shared: values kept, refill refused', () => {
    const root = env.tempDir;
    writeFileSync(
      join(env.tempDir, 'cleo-home', 'nexus-vault.json'),
      JSON.stringify({
        version: 1,
        accounts: {
          'https://api.example user': {
            trust: { keyVersion: 0, pins: {}, revoked: [] },
            streams: {
              [`project:p1|${root}`]: {
                lastCheckpointId: 'cp-1',
                lastCoversSeq: 3,
                updatedAt: 'now',
              },
            },
          },
        },
      }),
    );
    plantStale();
    expect(rowIdentityShareState(db).state).toBe('shared');
    expect(prepareRowIdentity(db, 'project')?.refill).toBe('refused');
    expect(relUid()).toBe(BOGUS_REL);
    expect(acUid()).toBe(BOGUS_AC);
  });

  it('a Nexus-linked store with no local vault record is unknown: refused', () => {
    writeFileSync(
      join(env.cleoDir, 'nexus-link.json'),
      JSON.stringify({ version: 1, links: { 'https://api.example': { remoteProjectId: 'p1' } } }),
    );
    plantStale();
    const share = rowIdentityShareState(db);
    expect(share.state).toBe('unknown');
    expect(share.reasons.join(' ')).toMatch(/linked to Cleo Nexus/);
    expect(prepareRowIdentity(db, 'project')?.refill).toBe('refused');
    expect(relUid()).toBe(BOGUS_REL);
  });

  it('an unreadable vault state file is unknown: refused', () => {
    writeFileSync(join(env.tempDir, 'cleo-home', 'nexus-vault.json'), '{not json');
    plantStale();
    expect(rowIdentityShareState(db).state).toBe('unknown');
    expect(prepareRowIdentity(db, 'project')?.refill).toBe('refused');
    expect(acUid()).toBe(BOGUS_AC);
  });

  it('a started sync stream (a sealed push flag) is shared: refused', () => {
    db.exec('CREATE TABLE IF NOT EXISTS _sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.exec("INSERT OR REPLACE INTO _sync_meta (key, value) VALUES ('sync.push', '1')");
    plantStale();
    expect(rowIdentityShareState(db).state).toBe('shared');
    expect(prepareRowIdentity(db, 'project')?.refill).toBe('refused');
    expect(relUid()).toBe(BOGUS_REL);
  });

  describe('journal state refuses (any uid-bearing _sync_* state)', () => {
    beforeEach(() => {
      ensureSyncSchema(db);
    });

    it('the sync schema alone (cleo project link) leaves the store unshared', () => {
      expect(rowIdentityShareState(db)).toMatchObject({ state: 'unshared', reasons: [] });
    });

    it('a repair baseline with no transaction (_sync_row_meta only) is shared: refused', () => {
      db.prepare(
        "INSERT INTO _sync_row_meta (tbl, uid, hlc, origin, version) VALUES ('tasks_tasks', ?, '0', 'baseline', 0)",
      ).run(BOGUS_REL);
      expect(db.prepare('SELECT count(*) AS n FROM _sync_txn').get()).toEqual({ n: 0 });
      plantStale();
      const share = rowIdentityShareState(db);
      expect(share.state).toBe('shared');
      expect(share.signals.map((s) => s.code)).toEqual(['journal-rows']);
      expect(share.reasons.join(' ')).toMatch(/_sync_row_meta/);
      expect(prepareRowIdentity(db, 'project')?.refill).toBe('refused');
      expect(relUid()).toBe(BOGUS_REL);
    });

    it('a journal table added later refuses by default', () => {
      db.exec('CREATE TABLE _sync_future_probe (uid TEXT NOT NULL)');
      db.prepare('INSERT INTO _sync_future_probe (uid) VALUES (?)').run(BOGUS_REL);
      expect(rowIdentityShareState(db).state).toBe('shared');
    });

    it('captured changes refuse: they reference the old uids', () => {
      db.exec('CREATE TABLE IF NOT EXISTS _sync_capture_probe (x)');
      db.exec("INSERT INTO _sync_capture_probe VALUES ('row')");
      expect(rowIdentityShareState(db).reasons.join(' ')).toMatch(/_sync_capture_probe holds rows/);
    });

    it.each([
      'suspect:tasks_tasks',
      'baseline:tasks_tasks',
    ])('a %s key in _sync_meta is shared: refused', (key) => {
      db.prepare(
        "INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, '1', '2026-10-05')",
      ).run(key);
      plantStale();
      expect(rowIdentityShareState(db).signals.map((s) => s.code)).toEqual(['journal-meta']);
      expect(prepareRowIdentity(db, 'project')?.refill).toBe('refused');
      expect(acUid()).toBe(BOGUS_AC);
    });

    it('prefixes match exactly: no LIKE wildcard matches a near name', () => {
      db.prepare(
        "INSERT INTO _sync_meta (key, value, updated_at) VALUES ('suspectXtasks', '1', '2026-10-05')",
      ).run();
      // `_` is a LIKE wildcard: LIKE '_sync_%' would match this table.
      db.exec("CREATE TABLE async_notes (x); INSERT INTO async_notes VALUES ('n');");
      expect(rowIdentityShareState(db).state).toBe('unshared');
    });
  });

  describe('a refused refill is recorded: later opens are fast and quiet (T13305)', () => {
    function linkNoVault(): void {
      writeFileSync(
        join(env.cleoDir, 'nexus-link.json'),
        JSON.stringify({ version: 1, links: { 'https://api.example': { remoteProjectId: 'p1' } } }),
      );
    }

    it('the second open takes the fast path; a NULL-uid row is filled without re-warning', () => {
      linkNoVault();
      plantStale();
      expect(prepareRowIdentity(db, 'project')?.refill).toBe('refused');
      const first = readRowIdentityRefusal(db);
      expect(first).toMatchObject({
        state: 'refused',
        recipe: ROW_IDENTITY_RECIPE,
        shareState: 'unknown',
      });
      // Nothing else pending: the stale marker is settled by the refusal.
      expect(rowIdentityFillPending(db, 'project')).toEqual([]);
      expect(prepareRowIdentity(db, 'project')?.refill).toBe('none');
      // New work (a row without a uid) runs the pass; the refusal is not logged again.
      db.exec(
        "INSERT INTO tasks_task_relations (task_id, related_to, relation_type) VALUES ('T002', 'T001', 'blocks')",
      );
      db.exec("UPDATE tasks_task_relations SET uid = NULL WHERE relation_type = 'blocks'");
      expect(rowIdentityFillPending(db, 'project')).toContain('uid:tasks_task_relations');
      expect(prepareRowIdentity(db, 'project')?.refill).toBe('refused');
      expect(readRowIdentityRefusal(db)?.warnedAt).toBe(first?.warnedAt);
      expect(relUid()).toBe(BOGUS_REL);
    });

    it('a change of the share verdict re-evaluates: unlinked, the store refills', () => {
      linkNoVault();
      plantStale();
      expect(prepareRowIdentity(db, 'project')?.refill).toBe('refused');
      rmSync(join(env.cleoDir, 'nexus-link.json'));
      expect(rowIdentityFillPending(db, 'project')).toContain('recipe');
      expect(prepareRowIdentity(db, 'project')?.refill).toBe('cleared');
      expect(relUid()).not.toBe(BOGUS_REL);
    });

    it('a refusal recorded under another recipe is not settled', () => {
      linkNoVault();
      plantStale();
      prepareRowIdentity(db, 'project');
      const prior = readRowIdentityRefusal(db);
      db.prepare('UPDATE tasks_row_identity_meta SET value = ? WHERE key = ?').run(
        JSON.stringify({ ...prior, recipe: 'cleo/row-identity/v1' }),
        ROW_IDENTITY_REFUSED_KEY,
      );
      expect(rowIdentityFillPending(db, 'project')).toContain('recipe');
    });

    it('cleo doctor row-identity --refill (dry run) clears the refusal and re-evaluates', async () => {
      linkNoVault();
      plantStale();
      prepareRowIdentity(db, 'project');
      expect(rowIdentityFillPending(db, 'project')).toEqual([]);
      const { rowIdentityRefill } = await import('../../doctor/row-identity-refill.js');
      const report = await rowIdentityRefill(env.tempDir, { probe: async () => [] });
      expect(report.refusalCleared).toBe(true);
      expect(readRowIdentityRefusal(db)?.state).toBe('cleared');
      expect(rowIdentityFillPending(db, 'project')).toContain('recipe');
    });
  });
});
