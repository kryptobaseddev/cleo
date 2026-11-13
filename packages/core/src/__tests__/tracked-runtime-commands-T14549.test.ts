/**
 * T14549 AC4 — `cleo init`, `cleo upgrade` and `cleo session start` run the
 * tracked-file check and give the untrack fix, end to end on a real project
 * whose git index tracks `.cleo` runtime files. Init on a clone that tracks
 * the store refuses with `cleo doctor --fix`, never `--force`.
 *
 * Global state (CLEO home, XDG, harness homes) is isolated per run.
 *
 * @task T14549
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CleoError } from '../errors.js';
import { discoveryEnv } from '../git/work-tree.js';
import { initProject } from '../init.js';
import { sessionStart } from '../session/engine-ops.js';
import { SESSION_ENV_KEY_PRECEDENCE } from '../sessions/session-id.js';
import { TERMINAL_KEY_SOURCES } from '../sessions/terminal-identity.js';
import { runUpgrade } from '../upgrade.js';

let isolatedRoot: string;
let project: string;
let origCwd: string;

/** Run git in the project with no ambient repo variables; hooks bypassed (a clone's history). */
function git(...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: project,
    env: discoveryEnv(),
    stdio: 'ignore',
  });
}

beforeEach(() => {
  isolatedRoot = mkdtempSync(join(tmpdir(), 'cleo-t14549-cmds-'));
  const home = join(isolatedRoot, 'home');
  const roots: Record<string, string> = {
    HOME: home,
    USERPROFILE: home,
    CLEO_HOME: join(isolatedRoot, 'cleo'),
    XDG_DATA_HOME: join(isolatedRoot, 'data-home'),
    XDG_CONFIG_HOME: join(isolatedRoot, 'config-home'),
    XDG_CACHE_HOME: join(isolatedRoot, 'cache-home'),
    AGENTS_HOME: join(isolatedRoot, 'agents'),
  };
  for (const [name, dir] of Object.entries(roots)) {
    mkdirSync(dir, { recursive: true });
    vi.stubEnv(name, dir);
  }
  for (const name of [
    'CLEO_ROOT',
    'CLEO_DIR',
    'CLAUDE_HOME',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'HERMES_HOME',
    'PI_CODING_AGENT_DIR',
    'PI_HOME',
    ...SESSION_ENV_KEY_PRECEDENCE,
    ...TERMINAL_KEY_SOURCES.flatMap((s) =>
      s.qualifierEnvVar ? [s.envVar, s.qualifierEnvVar] : [s.envVar],
    ),
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv('TERM_SESSION_ID', 'w0t0p0:T14549');

  project = join(isolatedRoot, 'project');
  mkdirSync(project, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  origCwd = process.cwd();
  process.chdir(project);
});

afterEach(async () => {
  process.chdir(origCwd);
  vi.unstubAllEnvs();
  try {
    const { closeAllDatabases } = await import('../store/sqlite.js');
    await closeAllDatabases();
  } catch {
    /* ignore */
  }
  rmSync(isolatedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('T14549: init, upgrade and session start warn about tracked .cleo runtime files', () => {
  it('init warns, then refuses a store-tracking clone with the untrack fix; upgrade and session start warn', async () => {
    // A clone that already tracks a runtime file (not the store): init proceeds and warns.
    mkdirSync(join(project, '.cleo', 'metrics'), { recursive: true });
    writeFileSync(join(project, '.cleo', 'metrics', 'GRADES.jsonl'), '{"grade":1}\n');
    git('add', '-f', '--', '.cleo/metrics/GRADES.jsonl');
    git('commit', '-q', '-m', 'T14549 history tracks grades');

    const init = await initProject({ name: 't14549' });
    const warning = init.warnings.find((w) => w.includes('.cleo/metrics/GRADES.jsonl'));
    expect(warning).toContain('cleo doctor --fix');

    // The history then tracks the store itself, as a pushed-and-cloned project would.
    git('add', '-f', '--', '.cleo/cleo.db', '.cleo/config.json');
    git('commit', '-q', '-m', 'T14549 history tracks the store');

    let refusal: unknown;
    try {
      await initProject({ name: 't14549' });
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(CleoError);
    const err = refusal as CleoError;
    expect(err.fix).toBe('cleo doctor --fix');
    expect(err.message).toContain('.cleo/cleo.db');
    expect(err.message).toContain('.cleo/config.json');

    const upgrade = await runUpgrade({ cwd: project });
    const upgradeWarning = upgrade.summary.warnings.find((w) => w.includes('.cleo/cleo.db'));
    expect(upgradeWarning).toContain('cleo doctor --fix');

    const started = await sessionStart(project, { scope: 'global', name: 't14549' });
    expect(started.success).toBe(true);
    const storeSafety = started.data?.storeSafetyWarnings;
    expect(storeSafety?.[0]).toContain('.cleo/cleo.db');
    expect(storeSafety?.[0]).toContain('cleo doctor --fix');
  }, 120_000);
  it('init on an initialized project whose git index is unreadable points at cleo doctor, never --force', async () => {
    await initProject({ name: 't14549' });
    writeFileSync(join(project, '.git', 'index'), 'not an index');
    let refusal: unknown;
    try {
      await initProject({ name: 't14549' });
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(CleoError);
    const err = refusal as CleoError;
    expect(err.fix).toBe('cleo doctor');
    expect(err.message).toContain('git could not read its index');
  }, 120_000);
});
