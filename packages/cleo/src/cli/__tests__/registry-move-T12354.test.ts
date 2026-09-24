/**
 * Move a project, then run an ORDINARY command: the registry follows (T12354).
 *
 * Before the fix only `cleo init` and `cleo nexus reconcile` updated the
 * registry path after a move. `cleo list` never reached the encounter hook (it
 * lived in a deprecated path resolver), and `cleo briefing` reached it only as
 * detached work that teardown cancelled. An empty `cleo list` also leaves
 * through `process.exit(100)`, so a hook after the command would miss it too.
 *
 * Spawns the compiled CLI against a temp project and a temp `CLEO_HOME`.
 *
 * @task T12354
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI_DIST = resolve(PKG_ROOT, 'dist', 'cli', 'index.js');
const CLI_DIST_AVAILABLE = existsSync(CLI_DIST);

let sandbox: string;
let cleoHome: string;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cleo-T12354-move-'));
  cleoHome = join(sandbox, 'cleo-home');
});

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true }).catch(() => {
    /* never fail teardown */
  });
});

/** Run the compiled CLI in `cwd` with the sandboxed global home. */
function runCli(args: readonly string[], cwd: string): number | null {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLEO_HOME: cleoHome,
    CLEO_OUTPUT_FORMAT: 'json',
  };
  for (const pinned of ['CLEO_ROOT', 'CLEO_DIR', 'CLEO_PROJECT_ROOT']) delete env[pinned];
  return spawnSync('node', [CLI_DIST, ...args], { cwd, env, encoding: 'utf-8', timeout: 90_000 })
    .status;
}

/** Registry row path and path-map paths, read-only. */
function registryState(): { rows: string[]; paths: string[] } {
  const db = new DatabaseSync(join(cleoHome, 'cleo.db'), { readOnly: true });
  try {
    const col = (query: string) =>
      (db.prepare(query).all() as Array<{ p: string }>).map((r) => r.p).sort();
    return {
      rows: col('SELECT project_path AS p FROM nexus_project_registry'),
      paths: col('SELECT project_path AS p FROM nexus_project_paths'),
    };
  } finally {
    db.close();
  }
}

describe.skipIf(!CLI_DIST_AVAILABLE)('registry follows a move on an ordinary command', () => {
  it('cleo list after mv re-points the row; a copy adds a second checkout', () => {
    const before = join(sandbox, 'before');
    mkdirSync(before, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: before });
    expect(runCli(['init'], before)).toBe(0);
    expect(registryState()).toEqual({ rows: [before], paths: [before] });

    const after = join(sandbox, 'after');
    renameSync(before, after);
    // Empty project: `list` exits NO_DATA (100) through process.exit.
    expect(runCli(['list'], after)).toBe(100);
    expect(registryState()).toEqual({ rows: [after], paths: [after] });

    const copy = join(sandbox, 'copy');
    cpSync(after, copy, { recursive: true });
    runCli(['list'], copy);
    expect(registryState()).toEqual({ rows: [copy], paths: [after, copy].sort() });
  });
});
