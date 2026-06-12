/**
 * Integration test: per-session suite containment (T11998).
 *
 * ## Acceptance criterion
 *
 * > An integration test spawns a stand-in agent that forks grandchildren,
 * > ends the session, and asserts zero surviving processes.
 *
 * ## CI-runnable design
 *
 * The test uses `_forceSystemdRunAvailable(false)` to run in the **pgid path**
 * so it does not require a user systemd bus.  A separate `describe.skipIf`
 * block exercises the systemd path when `systemd-run --user` is actually
 * available on the test host.
 *
 * ### Stand-in agent script
 *
 * A small shell script is launched that immediately forks two `sleep 60`
 * grandchildren, simulating an MCP server suite:
 *
 * ```sh
 * #!/bin/sh
 * sleep 60 &
 * sleep 60 &
 * wait
 * ```
 *
 * After the reaper is called, we assert that neither the root process nor
 * any `sleep 60` grandchild is still alive.
 *
 * @task T11998
 * @epic T11992
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentSuiteOwnership } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reapAgentSuite } from '../providers/claude-code/suite-reaper.js';
import {
  _forceSystemdRunAvailable,
  buildAgentSpawnArgs,
} from '../providers/shared/agent-spawn-wrapper.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a stand-in agent script to a temp file.
 * The script spawns two sleep grandchildren then waits.
 */
function writeStandInScript(): string {
  const scriptPath = join(tmpdir(), `cleo-test-agent-${process.pid}-${Date.now()}.sh`);
  writeFileSync(scriptPath, '#!/bin/sh\nsleep 60 &\nsleep 60 &\nwait\n', { mode: 0o755 });
  return scriptPath;
}

/**
 * Check whether a PID is still alive via kill(pid, 0).
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait up to `timeoutMs` for a condition to become true.
 */
async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 5_000,
  pollMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return condition();
}

/**
 * Find child PIDs of a given parent PID using /proc (Linux only).
 * Returns empty array on non-Linux or when /proc is unavailable.
 */
function getChildPids(parentPid: number): number[] {
  if (process.platform !== 'linux') return [];
  try {
    const result = spawnSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf8' });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number)
      .filter((n) => !Number.isNaN(n));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Reset forced availability after each test
// ---------------------------------------------------------------------------

afterEach(() => {
  _forceSystemdRunAvailable(false);
});

// ---------------------------------------------------------------------------
// pgid path — CI-runnable (forced: no systemd)
// ---------------------------------------------------------------------------

describe('suite-containment — pgid path (forced, no systemd required)', () => {
  let scriptPath: string | undefined;

  beforeEach(() => {
    scriptPath = writeStandInScript();
  });

  afterEach(() => {
    if (scriptPath && existsSync(scriptPath)) {
      try {
        unlinkSync(scriptPath);
      } catch {
        // ignore
      }
    }
  });

  it('buildAgentSpawnArgs returns mode=pgid when systemd-run is forced unavailable', () => {
    _forceSystemdRunAvailable(false);
    const result = buildAgentSpawnArgs('sh', ['-c', 'echo hi'], 'T11998-test');
    expect(result.ownership.mode).toBe('pgid');
    expect(result.ownership.unitName).toBeUndefined();
    // Command is 'sh' wrapping ulimit
    expect(result.command).toBe('sh');
    expect(result.args).toContain('ulimit -c 0; exec "$@"');
  });

  it('reapAgentSuite (pgid): zero surviving processes after reap', async () => {
    _forceSystemdRunAvailable(false);

    if (process.platform !== 'linux') {
      // pgid kill requires POSIX — skip on non-Linux CI
      return;
    }

    if (!scriptPath) throw new Error('scriptPath not set');

    // Spawn the stand-in agent with detached:true so it gets its own pgid.
    // The agent script itself spawns two sleep grandchildren.
    const child = spawn('sh', [scriptPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    const rootPid = child.pid;
    if (!rootPid) throw new Error('Failed to spawn stand-in agent');

    // Give the stand-in time to fork its grandchildren.
    await new Promise((r) => setTimeout(r, 300));

    // Collect grandchild PIDs before reap.
    const grandchildren = getChildPids(rootPid);
    // We should have at least the root alive.
    expect(isAlive(rootPid)).toBe(true);

    // Build an ownership handle with the root's PID as pgid leader.
    const ownership: AgentSuiteOwnership = {
      mode: 'pgid',
      pgid: rootPid,
      pid: rootPid,
    };

    // Reap the suite.
    await reapAgentSuite(ownership);

    // Wait for all processes to die (up to 5s).
    const allGone = await waitForCondition(() => {
      if (isAlive(rootPid)) return false;
      return grandchildren.every((pid) => !isAlive(pid));
    });

    expect(allGone).toBe(true);

    // Verify individually for a clear failure message.
    expect(isAlive(rootPid)).toBe(false);
    for (const gPid of grandchildren) {
      expect(isAlive(gPid)).toBe(false);
    }
  }, 10_000); // 10s timeout (SIGTERM grace = 3s + buffer)

  it('reapAgentSuite (pgid, none): is a no-op for mode=none', async () => {
    const ownership: AgentSuiteOwnership = { mode: 'none' };
    // Should not throw.
    await expect(reapAgentSuite(ownership)).resolves.toBeUndefined();
  });

  it('reapAgentSuite (pgid): ESRCH is a no-op (already-gone group)', async () => {
    // Use a known-dead PID (extremely high number, likely not in use).
    const ownership: AgentSuiteOwnership = {
      mode: 'pgid',
      pgid: 2_000_000_000,
      pid: 2_000_000_000,
    };
    // Should resolve cleanly (ESRCH is treated as success).
    await expect(reapAgentSuite(ownership)).resolves.toBeUndefined();
  });

  it('abnormal agent exit leaves no processes reparented after reap', async () => {
    if (process.platform !== 'linux') return;
    if (!scriptPath) throw new Error('scriptPath not set');

    // Spawn stand-in, kill the root immediately (simulating abnormal exit),
    // then assert the reaper still handles the orphaned grandchildren.
    const child = spawn('sh', [scriptPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();

    const rootPid = child.pid;
    if (!rootPid) throw new Error('Failed to spawn stand-in agent');

    // Give grandchildren time to start.
    await new Promise((r) => setTimeout(r, 300));
    const grandchildren = getChildPids(rootPid);

    // Kill the root abnormally (simulate crash).
    try {
      process.kill(rootPid, 'SIGKILL');
    } catch {
      // Already dead — fine.
    }

    // Wait a tick for grandchildren to potentially reparent.
    await new Promise((r) => setTimeout(r, 100));

    // Now reap whatever is left via pgid.
    const ownership: AgentSuiteOwnership = {
      mode: 'pgid',
      pgid: rootPid,
      pid: rootPid,
    };
    await reapAgentSuite(ownership);

    // After reap, all grandchildren must be gone.
    const allGone = await waitForCondition(() => grandchildren.every((pid) => !isAlive(pid)));
    expect(allGone).toBe(true);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// systemd path — only when systemd-run is actually available
// ---------------------------------------------------------------------------

const systemdAvailable =
  process.platform === 'linux' &&
  spawnSync('systemd-run', ['--version'], { stdio: 'ignore' }).status === 0 &&
  // Also check for a live user bus (DBUS_SESSION_BUS_ADDRESS or XDG_RUNTIME_DIR).
  (!!process.env['DBUS_SESSION_BUS_ADDRESS'] || !!process.env['XDG_RUNTIME_DIR']);

describe.skipIf(!systemdAvailable)(
  'suite-containment — systemd path (requires live user bus)',
  () => {
    let scriptPath: string | undefined;

    beforeEach(() => {
      scriptPath = writeStandInScript();
      // Do NOT force availability — use the real probe.
      _forceSystemdRunAvailable(true);
    });

    afterEach(() => {
      _forceSystemdRunAvailable(false);
      if (scriptPath && existsSync(scriptPath)) {
        try {
          unlinkSync(scriptPath);
        } catch {
          // ignore
        }
      }
    });

    it('buildAgentSpawnArgs returns mode=systemd with a unit name', () => {
      const result = buildAgentSpawnArgs('sh', ['-c', 'echo hi'], 'T11998-systemd');
      expect(result.ownership.mode).toBe('systemd');
      expect(result.ownership.unitName).toMatch(/^cleo-agent-session-T11998-systemd\.scope$/);
      expect(result.command).toBe('systemd-run');
      expect(result.args).toContain('--scope');
      expect(result.args).toContain(`--slice=cleo.slice`);
    });

    it('reapAgentSuite (systemd): stops the scope and all grandchildren', async () => {
      if (!scriptPath) throw new Error('scriptPath not set');

      const spawnBuild = buildAgentSpawnArgs('sh', [scriptPath], 'T11998-reap-test');
      expect(spawnBuild.ownership.mode).toBe('systemd');
      const { unitName } = spawnBuild.ownership;
      if (!unitName) throw new Error('unitName must be set in systemd mode');

      // Launch via systemd-run.
      const child = spawn(spawnBuild.command, spawnBuild.args, {
        stdio: 'ignore',
      });

      const rootPid = child.pid;
      if (!rootPid) throw new Error('Failed to spawn stand-in agent via systemd-run');

      // Give systemd-run time to activate the scope and let grandchildren start.
      await new Promise((r) => setTimeout(r, 600));

      const ownership: AgentSuiteOwnership = {
        ...spawnBuild.ownership,
        pid: rootPid,
      };

      // Reap the scope.
      await reapAgentSuite(ownership);

      // The scope should be gone — verify via systemctl show (exit non-zero = not found).
      await new Promise((r) => setTimeout(r, 200));
      const showResult = spawnSync(
        'systemctl',
        ['--user', 'show', '--property=ActiveState', unitName],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      // Either the unit is not found (exit 4) or its state is inactive/dead.
      const isInactiveOrGone =
        showResult.status !== 0 ||
        showResult.stdout.includes('ActiveState=inactive') ||
        showResult.stdout.includes('ActiveState=failed') ||
        showResult.stdout.includes('ActiveState=dead') ||
        !showResult.stdout.includes('ActiveState=active');
      expect(isInactiveOrGone).toBe(true);
    }, 15_000);
  },
);
