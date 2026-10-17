/**
 * One-time local scrub of pre-T13855 audit secrets (T13857).
 *
 * Coverage: a seeded token is redacted (top level and nested), a clean row is
 * untouched byte for byte, the marker makes a second run a no-op, the scrub
 * captures nothing with capture on, and the store open pass runs it.
 *
 * @task T13857
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import { scrubAuditSecrets } from '../audit-scrub.js';
import { setCaptureEnabled } from '../capture.js';
import { AUDIT_SCRUB_MARKER, auditScrubPending } from '../schema.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const TOKEN = 'gho_' + 'a'.repeat(36);

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-audit-scrub-'));
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
  return handle.db.$client as DatabaseSync;
}

/** Insert raw, as a pre-T13855 build did (bypassing the redacting column). */
const addAudit = (db: DatabaseSync, id: string, details: string, after: string | null = null) =>
  db
    .prepare(
      `INSERT INTO tasks_audit_log (id, action, task_id, details_json, after_json)
       VALUES (?, 'mutate', 'T1', ?, ?)`,
    )
    .run(id, details, after);

const row = (db: DatabaseSync, id: string) =>
  db.prepare('SELECT details_json, after_json FROM tasks_audit_log WHERE id = ?').get(id) as {
    details_json: string;
    after_json: string | null;
  };

const unmark = (db: DatabaseSync) =>
  db.prepare('DELETE FROM tasks_row_identity_meta WHERE key = ?').run(AUDIT_SCRUB_MARKER);

describe('scrubAuditSecrets (audit_secret_scrub_v1)', () => {
  it('redacts top-level and nested secrets, leaves clean rows byte for byte, runs once', async () => {
    const db = await store();
    unmark(db);
    const clean = '{"taskId":"T1", "keyword":"x","maxTokens":5}';
    addAudit(db, 'a1', JSON.stringify({ service: 'github', token: TOKEN }));
    addAudit(db, 'a2', clean);
    addAudit(db, 'a3', '{}', JSON.stringify({ result: { auth: { refreshToken: 'r-secret' } } }));

    const r = scrubAuditSecrets(db);
    expect(r).toEqual({
      status: 'done',
      rewritten: { 'tasks_audit_log.details_json': 1, 'tasks_audit_log.after_json': 1 },
    });
    expect(row(db, 'a1').details_json).not.toContain(TOKEN);
    expect(JSON.parse(row(db, 'a1').details_json)).toEqual({
      service: 'github',
      token: '[REDACTED]',
    });
    expect(row(db, 'a2').details_json).toBe(clean);
    expect(row(db, 'a3').after_json).not.toContain('r-secret');
    expect(auditScrubPending(db)).toBe(false);

    // The marker makes a second run a no-op, even over a raw row written since.
    addAudit(db, 'a4', JSON.stringify({ token: TOKEN }));
    expect(scrubAuditSecrets(db)).toEqual({ status: 'already' });
    expect(row(db, 'a4').details_json).toContain(TOKEN);
  });

  it('captures nothing when sync capture is on', async () => {
    const db = await store();
    setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
    unmark(db);
    addAudit(db, 'a1', JSON.stringify({ token: TOKEN }));
    db.exec('DELETE FROM _sync_capture');

    expect(scrubAuditSecrets(db)).toMatchObject({ status: 'done' });
    expect(row(db, 'a1').details_json).not.toContain(TOKEN);
    const n = (db.prepare('SELECT count(*) AS n FROM _sync_capture').get() as { n: number }).n;
    expect(n).toBe(0);
  });

  it('runs at store open when the marker is absent', async () => {
    const db = await store();
    unmark(db);
    addAudit(db, 'a1', JSON.stringify({ token: TOKEN }));
    _resetDualScopeDbCache();
    const reopened = await store();
    expect(row(reopened, 'a1').details_json).not.toContain(TOKEN);
    expect(auditScrubPending(reopened)).toBe(false);
  });
});
