/**
 * T13250 — every path that carries the project store's uids out marks the
 * store shared in the store itself (`row_identity_synced`): a portable bundle
 * export (also the vault push, which exports one), never the local
 * pre-restore safety bundle, and never a store that holds no identity.
 * The marker survives a lost CLEO_HOME vault state and an unlink, so a later
 * stale recipe still refuses the full refill.
 *
 * @task T13250
 */

import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportPortableBundle } from '../portable-bundle.js';
import {
  prepareRowIdentity,
  ROW_IDENTITY_RECIPE_KEY,
  ROW_IDENTITY_SYNCED_KEY,
  rowIdentityShareState,
} from '../row-identity.js';
import { getNativeTasksDb } from '../sqlite.js';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

let env: TestDbEnv;
let db: DatabaseSync;

const synced = () =>
  db
    .prepare('SELECT value FROM tasks_row_identity_meta WHERE key = ?')
    .get(ROW_IDENTITY_SYNCED_KEY) as { value: string } | undefined;

async function setup(fill: boolean): Promise<void> {
  vi.stubEnv('CLEO_ROW_UID_FILL', fill ? '1' : '0');
  env = await createTestDb();
  await seedTasks(env.accessor, [{ id: 'T001', title: 'has a uid', type: 'task' }]);
  const native = getNativeTasksDb(env.tempDir);
  if (!native) throw new Error('no native handle');
  db = native;
  if (fill) prepareRowIdentity(db, 'project');
}

const exportBundle = (sharesIdentity?: boolean) =>
  exportPortableBundle({
    scope: 'project',
    projectRoot: env.tempDir,
    outputPath: join(env.tempDir, 'out', 'p.cleobundle.tar.gz'),
    label: 'p',
    ...(sharesIdentity !== undefined ? { sharesIdentity } : {}),
  });

afterEach(async () => {
  vi.unstubAllEnvs();
  await env.cleanup();
});

describe('portable bundle exports mark identity shared (T13250)', () => {
  beforeEach(async () => {
    await setup(true);
  });

  it('a project bundle export marks the store; a stale recipe then refuses the full refill', async () => {
    expect(synced()).toBeUndefined();
    await exportBundle();
    expect(JSON.parse(String(synced()?.value)).first).toBe('send');
    // No link and no vault state at all: the in-store marker alone decides.
    db.exec(
      `UPDATE tasks_row_identity_meta SET value = 'cleo/row-identity/v1' WHERE key = '${ROW_IDENTITY_RECIPE_KEY}'`,
    );
    const share = rowIdentityShareState(db);
    expect(share.state).toBe('shared');
    expect(share.signals.map((s) => s.code)).toContain('synced-marker');
    expect(prepareRowIdentity(db, 'project')?.refill).toBe('refused');
  });

  it('a machine export marks every project store it bundles (not only a named one)', async () => {
    expect(synced()).toBeUndefined();
    const result = await exportPortableBundle({
      scope: 'machine',
      outputPath: join(env.tempDir, 'out', 'm.cleobundle.tar.gz'),
      label: 'm',
      isTempPath: () => false,
    });
    expect(result.sections.some((s) => s.kind === 'project')).toBe(true);
    expect(JSON.parse(String(synced()?.value)).first).toBe('send');
  });

  it('a local safety bundle (sharesIdentity: false) marks nothing', async () => {
    await exportBundle(false);
    expect(synced()).toBeUndefined();
  });
});

describe('a store with no identity is never touched (T13250)', () => {
  beforeEach(async () => {
    await setup(false);
  });

  it('a bundle export of a fill-off store writes no identity meta', async () => {
    const before = db.prepare('SELECT count(*) AS n FROM tasks_row_identity_meta').get();
    await exportBundle();
    expect(db.prepare('SELECT count(*) AS n FROM tasks_row_identity_meta').get()).toEqual(before);
    expect(synced()).toBeUndefined();
  });
});
