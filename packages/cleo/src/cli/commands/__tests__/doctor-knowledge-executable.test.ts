/** Executable regression: child flags validate before repair and emit one envelope. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeTempDirSync } from '../../../../../core/src/__tests__/test-cleanup.js';
import {
  getBrainDb,
  getBrainNativeDb,
  resetBrainDbState,
} from '../../../../../core/src/store/memory-sqlite.js';

const cli = resolve('packages/cleo/dist/cli/index.js');
let root: string;
let previousDir: string | undefined;
let previousHome: string | undefined;

beforeEach(async () => {
  expect(existsSync(cli), 'Build the CLI before running executable regressions').toBe(true);
  root = mkdtempSync(join(tmpdir(), 'cleo-doctor-cli-'));
  mkdirSync(join(root, '.cleo'));
  previousDir = process.env['CLEO_DIR'];
  previousHome = process.env['CLEO_HOME'];
  process.env['CLEO_DIR'] = join(root, '.cleo');
  process.env['CLEO_HOME'] = join(root, 'home');
  await getBrainDb(root);
  const db = getBrainNativeDb(root);
  if (!db) throw new Error('Missing fixture database');
  db.prepare(`INSERT INTO main.brain_observations (id, type, title, narrative)
    VALUES ('O-stub', 'discovery', 'Task complete: T448', 'Task T448 completed with status: undefined')`).run();
});

afterEach(() => {
  resetBrainDbState();
  if (previousDir === undefined) delete process.env['CLEO_DIR'];
  else process.env['CLEO_DIR'] = previousDir;
  if (previousHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = previousHome;
  removeTempDirSync(root);
});

function invoke(flags: string[]) {
  return spawnSync(
    process.execPath,
    ['--no-warnings', cli, 'doctor', 'knowledge', '--json', ...flags],
    {
      cwd: root,
      env: { ...process.env, CLEO_ROOT: root },
      encoding: 'utf8',
      timeout: 30000,
    },
  );
}

describe('doctor knowledge executable dispatch', () => {
  it('accepts a child-only --task flag and emits one successful envelope', () => {
    const result = invoke(['--dry-run', '--task', 'T448']);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ success: true });
  });

  it('rejects an unknown child flag before --fix can quarantine a record', () => {
    const result = invoke(['--fix', '--task-id', 'T448']);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(6);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ success: false });
    expect(lines[0]).toContain('E_UNKNOWN_FLAG');
    expect(
      getBrainNativeDb(root)
        ?.prepare("SELECT invalid_at FROM main.brain_observations WHERE id = 'O-stub'")
        .get()?.invalid_at,
    ).toBeNull();
  });
});
