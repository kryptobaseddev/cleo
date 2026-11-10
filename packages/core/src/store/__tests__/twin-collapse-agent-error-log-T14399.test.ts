/**
 * T14399 — the twin collapse drains the bare `agent_error_log` (agent error
 * history an older build, or every store before T14387, wrote) into
 * `tasks_agent_error_log`, the table the registry reads and that syncs.
 *
 * Both tables number rows from 1, so a bare id the twin already holds for a
 * different row lands under a fresh twin id; a copy the twin already holds
 * (an exodus copy) lands once; pending bare rows never count as a strand.
 *
 * Every open goes through the real tasks-domain bind (`bindTasksDomain`).
 *
 * @task T14399
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAgentErrorHistory } from '../../agents/registry.js';
import { bindTasksDomain, closeDb } from '../sqlite.js';
import { legacyStrands } from '../sync/flags.js';
import { TWIN_COLLAPSE_MARKER_PREFIX } from '../twin-collapse.js';
import { optOutOfForeignKeys } from './test-db-helper.js';

optOutOfForeignKeys();

const MARKER = `${TWIN_COLLAPSE_MARKER_PREFIX}agent_error_log`;

let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-agent-error-drain-T14399-')));
  mkdirSync(join(root, '.cleo'), { recursive: true });
  for (const k of ['CLEO_DIR', 'CLEO_HOME']) saved[k] = process.env[k];
  process.env['CLEO_DIR'] = join(root, '.cleo');
  process.env['CLEO_HOME'] = join(root, 'cleo-home');
});

afterEach(() => {
  closeDb();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const open = async (): Promise<DatabaseSync> => (await bindTasksDomain(root)).native;
const reopen = async (): Promise<DatabaseSync> => {
  closeDb();
  return open();
};

/** One error row (id, agent, message), written straight into `table`. */
function row(db: DatabaseSync, table: string, id: number, agent: string, message: string): void {
  db.prepare(
    `INSERT INTO main.${table} (id, agent_id, error_type, message, occurred_at, resolved)
     VALUES (?, ?, 'retriable', ?, '2026-10-01 09:00:00', 0)`,
  ).run(id, agent, message);
}

const count = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT count(*) AS n FROM main.${table}`).get() as { n: number }).n;

const twin = (db: DatabaseSync) =>
  db
    .prepare('SELECT id, agent_id, message FROM main.tasks_agent_error_log ORDER BY id')
    .all() as Array<{ id: number; agent_id: string; message: string }>;

describe('agent_error_log drain into tasks_agent_error_log (T14399)', () => {
  it('a fresh store opens with both tables empty and drains nothing', async () => {
    let db = await open();
    expect(count(db, 'agent_error_log')).toBe(0);
    expect(count(db, 'tasks_agent_error_log')).toBe(0);
    db = await reopen();
    expect(count(db, 'tasks_agent_error_log')).toBe(0);
  });

  it('a legacy store: every bare row reaches the twin once, re-keyed when its id is taken', async () => {
    let db = await open();
    // Twin: id 1 an exodus copy of bare 1, id 2 a row this build wrote since T14387.
    row(db, 'tasks_agent_error_log', 1, 'agt-a', 'old failure');
    row(db, 'tasks_agent_error_log', 2, 'agt-new', 'new failure');
    // Bare: 1 (copy already in the twin), 2 (collides with a different twin row), 3 (free).
    row(db, 'agent_error_log', 1, 'agt-a', 'old failure');
    row(db, 'agent_error_log', 2, 'agt-a', 'second legacy failure');
    row(db, 'agent_error_log', 3, 'agt-b', 'third legacy failure');
    db.prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?').run(MARKER);
    // Pending bare rows are an inbox the next open drains, never a strand.
    expect(legacyStrands(db).filter((s) => s.bareTable === 'agent_error_log')).toEqual([]);

    db = await reopen();
    expect(count(db, 'agent_error_log')).toBe(0);
    expect(twin(db)).toEqual([
      { id: 1, agent_id: 'agt-a', message: 'old failure' },
      { id: 2, agent_id: 'agt-new', message: 'new failure' },
      { id: 3, agent_id: 'agt-b', message: 'third legacy failure' },
      { id: 4, agent_id: 'agt-a', message: 'second legacy failure' },
    ]);
    // The registry reader sees the legacy history.
    expect((await getAgentErrorHistory('agt-a', root)).map((r) => r.message)).toEqual([
      'old failure',
      'second legacy failure',
    ]);

    // Idempotent: a further open moves nothing, and a row an older build
    // writes later drains at the next open.
    db = await reopen();
    expect(twin(db)).toHaveLength(4);
    row(db, 'agent_error_log', 5, 'agt-c', 'written by an older build');
    db = await reopen();
    expect(count(db, 'agent_error_log')).toBe(0);
    expect(twin(db).map((r) => [r.id, r.agent_id])).toEqual([
      [1, 'agt-a'],
      [2, 'agt-new'],
      [3, 'agt-b'],
      [4, 'agt-a'],
      [5, 'agt-c'],
    ]);
  });
});
