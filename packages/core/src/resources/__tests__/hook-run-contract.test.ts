/**
 * What the heavy-command hook (T12983) needs from `cleo run` (#1777).
 *
 * The hook rewrites an agent's command to `cleo run … -- <command>`, so a
 * `cleo run` that cannot reach its machine-wide state must not stop the
 * command: under Codex's workspace-write sandbox or Claude Code's sandboxed
 * Bash, `CLEO_HOME` can be read-only or full. The expected behaviour is that
 * the command runs ungoverned and a notice says so.
 *
 * #1777 added this in e8cafc0b3 (until then `runGoverned` threw EACCES on
 * `<CLEO_HOME>/locks/resource-test-run`, and this case was `it.fails`). The
 * command run is `sh -c 'exit 3'`: no real tool.
 *
 * @task T12983
 * @epic T12978
 */

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGoverned, spawnGovernedChild } from '../run-governed.js';

let dir: string;
let readOnlyHome: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-hook-run-contract-'));
  readOnlyHome = mkdtempSync(join(tmpdir(), 'cleo-hook-ro-home-'));
  chmodSync(readOnlyHome, 0o555);
  vi.stubEnv('CLEO_HOME', readOnlyHome);
});

afterEach(() => {
  vi.unstubAllEnvs();
  chmodSync(readOnlyHome, 0o755);
  rmSync(readOnlyHome, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

describe('cleo run fails open when its state is unwritable (#1777, HIGH-2 of the #1781 review)', () => {
  it('runs the command ungoverned, with a notice, when CLEO_HOME is read-only', async () => {
    const notices: string[] = [];
    const result = await runGoverned({
      argv: ['sh', '-c', 'exit 3'],
      cls: 'test-run',
      cwd: dir,
      env: { ...process.env, CLEO_HOME: readOnlyHome },
      sessionId: null,
      wait: true,
      timeoutMs: 10_000,
      notice: (line) => notices.push(line),
      // T13236: the explicit opt-in to start a real process inside vitest.
      deps: { spawn: spawnGovernedChild },
    });
    expect(result.kind).toBe('exited');
    expect(result.kind === 'exited' && result.exitCode).toBe(3);
    expect(notices.join('\n')).toMatch(/ungoverned|EACCES|EPERM|EROFS|ENOSPC/i);
  });
});
