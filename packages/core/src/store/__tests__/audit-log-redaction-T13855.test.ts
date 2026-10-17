/**
 * T13855 — every Drizzle write to an audit table scrubs secrets in the column
 * itself (`redactedText`), so `service connect --token …` never reaches
 * `tasks_audit_log`, which syncs.
 *
 * @task T13855
 * @epic T12323
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tasksAuditLog } from '../schema/cleo-project/audit.js';
import { bindTasksDomain, closeDb, getDb } from '../sqlite.js';
import { optOutOfForeignKeys } from './test-db-helper.js';

optOutOfForeignKeys();

let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-audit-redact-T13855-')));
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

describe('tasks_audit_log redacts secrets on write (T13855)', () => {
  it('stores a service.connect row with the token, error and response scrubbed', async () => {
    const native = (await bindTasksDomain(root)).native;
    const db = await getDb(root);
    const token = `gho_${'g'.repeat(36)}`;
    await db
      .insert(tasksAuditLog)
      .values({
        id: 'a1',
        action: 'connect',
        taskId: 'system',
        detailsJson: JSON.stringify({ provider: 'github', label: 'default', token }),
        afterJson: JSON.stringify({
          success: true,
          data: { refreshToken: 'r-1', provider: 'github' },
        }),
        errorMessage: `auth failed for ${token}`,
        domain: 'service',
        operation: 'connect',
      })
      .run();

    const row = native
      .prepare('SELECT details_json, after_json, error_message FROM tasks_audit_log WHERE id = ?')
      .get('a1') as { details_json: string; after_json: string; error_message: string };
    expect(JSON.parse(row.details_json)).toEqual({
      provider: 'github',
      label: 'default',
      token: '[REDACTED]',
    });
    expect(JSON.parse(row.after_json).data.refreshToken).toBe('[REDACTED]');
    expect(row.error_message).toBe('auth failed for [REDACTED]');
    expect(`${row.details_json}${row.after_json}${row.error_message}`).not.toContain('gho_');
  });

  it('leaves a row without secrets byte for byte', async () => {
    const native = (await bindTasksDomain(root)).native;
    const db = await getDb(root);
    const details = '{"taskId":"T1","title":"keyword token budget"}';
    await db
      .insert(tasksAuditLog)
      .values({ id: 'a2', action: 'add', taskId: 'T1', detailsJson: details })
      .run();
    const row = native
      .prepare('SELECT details_json FROM tasks_audit_log WHERE id = ?')
      .get('a2') as {
      details_json: string;
    };
    expect(row.details_json).toBe(details);
  });
});
