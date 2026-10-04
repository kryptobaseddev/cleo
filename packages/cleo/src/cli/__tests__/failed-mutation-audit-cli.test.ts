/**
 * A failed mutation leaves its audit_log row (T13164).
 *
 * Before the fix, `cleo update T999` exited 4 and wrote no row: the audit
 * middleware inserted fire-and-forget, and the CLI's error path called
 * `process.exit` before the insert ran. The middleware's own unit test waited
 * 50 ms before asserting, so only the real CLI path showed the loss. This runs
 * the built CLI in a throwaway HOME / CLEO_HOME / project and reads the row back
 * through `cleo log`.
 *
 * @task T13164
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');

/** The test needs the compiled CLI (CI builds before testing). */
const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);

/** One audit entry as `cleo log` reports it. */
interface LogEntry {
  operation: string;
  taskId: string;
  success: boolean;
  error?: string;
}

describe('failed mutation audit row in the built CLI (T13164)', () => {
  let root: string;
  let project: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'cleo-failed-audit-'));
    project = join(root, 'project');
    for (const d of ['home', 'cleo', 'state', 'project']) mkdirSync(join(root, d));
    env = {
      PATH: process.env['PATH'],
      HOME: join(root, 'home'),
      USERPROFILE: join(root, 'home'),
      CLEO_HOME: join(root, 'cleo'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_DATA_HOME: join(root, 'home', '.local', 'share'),
      XDG_CONFIG_HOME: join(root, 'home', '.config'),
      TMPDIR: tmpdir(),
      NO_COLOR: '1',
      CLEO_DISABLE_LOCAL_INFERENCE: '1',
      // A worktree build may migrate only a sandbox store; this is one.
      CLEO_ALLOW_WORKTREE_BUILD_MIGRATIONS: '1',
    };
    if (!CLI_DIST_AVAILABLE) return;
    spawnSync('git', ['init', '-q', project], { encoding: 'utf8' });
    const init = cleo(['init', '--name', 'audit-probe']);
    expect(init.status, init.stderr).toBe(0);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function cleo(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [CLI_DIST, ...args], {
      cwd: project,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  function auditEntries(): LogEntry[] {
    const log = cleo(['log', '--limit', '100']);
    expect(log.status, log.stderr).toBe(0);
    const envelope = JSON.parse(log.stdout) as { data: { entries: LogEntry[] } };
    return envelope.data.entries;
  }

  it.skipIf(!CLI_DIST_AVAILABLE)('cleo update on a missing task exits 4 and is audited', () => {
    const before = auditEntries().length;

    const update = cleo(['update', 'T999', '--title', 'nope']);
    expect(update.status, update.stderr).toBe(4);

    const entries = auditEntries();
    expect(entries).toHaveLength(before + 1);
    expect(entries[0]).toMatchObject({
      operation: 'update',
      taskId: 'T999',
      success: false,
    });
    expect(entries[0]?.error).toContain('T999');
  });
});
