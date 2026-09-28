/**
 * A failed twin collapse must not brick CLEO silently (T12535, Blocker B).
 *
 * With `.cleo/backups` blocked, or not enough free space for the snapshot,
 * the bind fails with `E_TWIN_COLLAPSE_FAILED` naming the cause, the snapshot
 * path and the space needed; the doctor check and `cleo doctor twin-collapse`
 * report it without binding a domain; and the retry succeeds once the cause
 * is cleared. The space check runs before the snapshot.
 *
 * @task T12535
 */

import * as fs from 'node:fs';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  inspectProjectTwinCollapse,
  retryTwinCollapse,
  twinCollapseDoctorCheck,
} from '../../doctor/twin-collapse.js';
import { sessionStatus } from '../../session/engine-ops.js';
import { getBrainDb } from '../memory-sqlite.js';
import { getDb, getNativeDb, resetDbState } from '../sqlite.js';
import { TWIN_COLLAPSE_MARKER_PREFIX } from '../twin-collapse.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statfsSync: vi.fn(actual.statfsSync) };
});

let root: string;
let projectDir: string;

/** Put the store in the pre-migration shape with live bare rows to carry. */
function preMigration(): void {
  const db = getNativeDb(projectDir) as DatabaseSync;
  db.prepare('DELETE FROM main.tasks_schema_meta WHERE key = ?').run(
    `${TWIN_COLLAPSE_MARKER_PREFIX}schema_meta`,
  );
  db.prepare(
    'INSERT INTO main.schema_meta (key, value) VALUES (\'project_meta\', \'{"name":"live"}\')',
  ).run();
}

/** The next open (a new process) and the error it raises, if any. */
async function reopen(): Promise<unknown> {
  resetDbState();
  try {
    await getDb(projectDir);
    return undefined;
  } catch (error) {
    return error;
  }
}

beforeEach(async () => {
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  resetDbState();
  root = join(tmpdir(), `twin-collapse-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  projectDir = join(root, 'project');
  mkdirSync(join(projectDir, '.cleo'), { recursive: true });
  mkdirSync(join(root, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(root, 'cleo'));
  await getDb(projectDir);
  await getBrainDb(projectDir);
  preMigration();
});

afterEach(() => {
  vi.mocked(fs.statfsSync).mockRestore?.();
  resetDbState();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('a blocked backups directory', () => {
  it('fails the open with E_TWIN_COLLAPSE_FAILED, is reported by doctor, and retry succeeds', async () => {
    const backups = join(projectDir, '.cleo', 'backups');
    writeFileSync(backups, 'not a directory');

    const error = await reopen();
    expect(error).toMatchObject({
      code: 55,
      details: {
        tables: ['schema_meta'],
        snapshotPath: expect.stringContaining(
          join('.cleo', 'backups', 'sqlite', 'cleo.db.migration-'),
        ),
        requiredBytes: expect.any(Number),
      },
    });
    expect(String((error as Error).message)).toMatch(/Snapshot: .*cleo\.db\.migration-/);

    const report = inspectProjectTwinCollapse(projectDir);
    expect(report.pairs[0]).toMatchObject({ state: 'failed' });
    expect(report.preflight).toMatchObject({
      ok: false,
      backupDirProblem: expect.stringMatching(/not a directory/),
    });
    expect(twinCollapseDoctorCheck(projectDir)).toMatchObject({
      check: 'twin_collapse',
      status: 'error',
      fix: expect.stringContaining('cleo doctor twin-collapse --retry'),
    });

    // An engine op that used to report any store failure as "not initialized"
    // keeps the collapse error, so the caller sees why and what to run.
    resetDbState();
    const status = await sessionStatus(projectDir);
    expect(status).toMatchObject({
      success: false,
      error: {
        code: 'E_TWIN_COLLAPSE_FAILED',
        message: expect.stringMatching(/cleo doctor twin-collapse/),
      },
    });

    rmSync(backups);
    const receipts = await retryTwinCollapse(projectDir);
    expect(receipts[0]).toMatchObject({ table: 'schema_meta', status: 'initial' });
    expect(await reopen()).toBeUndefined();
    expect(twinCollapseDoctorCheck(projectDir).status).toBe('ok');
  });
});

describe('not enough free space', () => {
  it('fails BEFORE writing the snapshot, names the space needed, and retry succeeds once space is free', async () => {
    vi.mocked(fs.statfsSync).mockImplementation(
      () => ({ bavail: 1, bsize: 4096 }) as unknown as ReturnType<typeof fs.statfsSync>,
    );
    const error = await reopen();
    expect(error).toMatchObject({
      code: 55,
      details: { availableBytes: 4096, requiredBytes: expect.any(Number) },
    });
    expect(String((error as Error).message)).toMatch(/not enough free space/);
    expect(fs.existsSync(join(projectDir, '.cleo', 'backups', 'sqlite'))).toBe(false);
    expect(twinCollapseDoctorCheck(projectDir).status).toBe('error');

    vi.mocked(fs.statfsSync).mockRestore();
    expect((await retryTwinCollapse(projectDir))[0]?.status).toBe('initial');
    expect(twinCollapseDoctorCheck(projectDir).status).toBe('ok');
  });
});

describe('doctor warnings', () => {
  it('warns about a pending collapse and about bare rows changed after the marker', async () => {
    expect(twinCollapseDoctorCheck(projectDir)).toMatchObject({
      status: 'warning',
      message: expect.stringMatching(/pending for schema_meta/),
    });
    expect(await reopen()).toBeUndefined();
    const db = getNativeDb(projectDir) as DatabaseSync;
    db.prepare(
      'UPDATE main.schema_meta SET value = \'{"name":"old"}\' WHERE key = \'project_meta\'',
    ).run();
    expect(twinCollapseDoctorCheck(projectDir)).toMatchObject({
      status: 'warning',
      message: expect.stringMatching(/older CLEO build changed schema_meta \(1\)/),
    });
  });
});
