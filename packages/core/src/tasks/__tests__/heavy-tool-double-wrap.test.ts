/**
 * CLEO must not wrap a command that already carries its own resource wrapper,
 * and the scope it does create must have a name it can be reaped by (gh#1396).
 *
 * ## The defect
 *
 * `axiom-analytics` pins a `testing.command` that IS a systemd-run invocation:
 *
 * ```
 * systemd-run --user --scope --quiet -p MemoryMax=8G -p MemorySwapMax=0 -- \
 *   env VITEST_MAX_WORKERS=4 … pnpm exec vitest run
 * ```
 *
 * `parseCommandString` splits on whitespace, so `command.cmd` is literally
 * `systemd-run`, and `withMemoryLimit` prepended a second one. `systemd-run
 * --scope` execs its payload rather than forking, so the inner client
 * regenerates a unit name the outer has already registered.
 *
 * Measured on systemd 259 (259.8-1.fc44), this box:
 *
 * ```
 * nested systemd-run … -- systemd-run … -- /bin/true   → 5/5 rc=1
 *   "Unit run-p<pid>-i<id>.scope was already loaded or has a fragment file."
 * single systemd-run … -- /bin/true                    → 0/6 failures
 * ```
 *
 * The collision is the symptom; the double wrap is the defect. Declining it is
 * the rule this codebase already applies twice — `heapCapApplied()` in
 * `bin/cleo.js` does not re-exec over an operator's own `NODE_OPTIONS` heap
 * cap, and `mergeNodeOptions()` lets an existing explicit value outrank our
 * default. A project pinning `-p MemoryMax=8G` has made that same choice.
 *
 * ## Why this file carries no module mock
 *
 * `tool-cache-harness-failure.test.ts` mocks `heavy-tool-limit.js` wholesale to
 * drive the cache path. These cases need the REAL `withMemoryLimit`, so they
 * live in their own file rather than reaching around that mock with
 * `vi.importActual` — which deadlocked collection when it was tried.
 *
 * @task T12221 (gh#1396)
 */

import { spawn, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  buildToolScopeUnitName,
  cgroupConfinementAvailable,
  isSystemdRunCommand,
  withMemoryLimit,
} from '../heavy-tool-limit.js';

describe('double-wrap detection (gh#1396)', () => {
  // The actual defect. `axiom-analytics` pins a `testing.command` that IS a
  // systemd-run invocation; `parseCommandString` splits on whitespace so
  // `cmd === 'systemd-run'`, and prepending a second one nests two transient
  // scopes. Measured on systemd 259: nested 5/5 collide with the gh#1396
  // string, a single invocation 0/6.
  //

  it('recognises systemd-run by bare name and by absolute path', () => {
    expect(isSystemdRunCommand('systemd-run')).toBe(true);
    expect(isSystemdRunCommand('/usr/bin/systemd-run')).toBe(true);
    expect(isSystemdRunCommand('pnpm')).toBe(false);
    expect(isSystemdRunCommand('systemd-runner')).toBe(false);
  });

  it('declines to wrap a command that is already systemd-run', () => {
    const pinned = withMemoryLimit(
      'test',
      'systemd-run',
      ['--user', '--scope', '-p', 'MemoryMax=8G', '--', 'pnpm', 'test'],
      { available: true },
    );
    expect(pinned.cmd).toBe('systemd-run');
    expect(pinned.confined).toBe(false);
    expect(pinned.unitName).toBeNull();
    // The decisive assertion: exactly ONE systemd-run in the spawned argv.
    expect([pinned.cmd, ...pinned.args].filter((a) => a === 'systemd-run')).toHaveLength(1);
  });

  it('still wraps an ordinary heavy tool', () => {
    const wrapped = withMemoryLimit('test', 'pnpm', ['run', 'test'], { available: true });
    expect(wrapped.cmd).toBe('systemd-run');
    expect(wrapped.confined).toBe(true);
    expect(wrapped.args).toContain(`--unit=${wrapped.unitName}`);
  });
});

describe('transient-unit name contract (gh#1396)', () => {
  it('is a valid systemd unit name: charset and length', () => {
    const name = buildToolScopeUnitName('test', '/some/execution/root');
    // systemd unit names allow [a-zA-Z0-9:-_.] and cap at 256 bytes.
    expect(name).toMatch(/^[a-z0-9-]+\.scope$/);
    expect(Buffer.byteLength(name)).toBeLessThan(256);
    expect(name.startsWith('cleo-tool-test-')).toBe(true);
  });

  it('is stable per execution root but unique per call', () => {
    const a = buildToolScopeUnitName('test', '/root/one');
    const b = buildToolScopeUnitName('test', '/root/one');
    const c = buildToolScopeUnitName('test', '/root/two');
    // rootHash8 is the 3rd hyphen-separated field; it identifies the tree.
    const hash = (n: string) => n.split('-')[3];
    expect(hash(a)).toBe(hash(b));
    expect(hash(a)).not.toBe(hash(c));
    // ...but the full name never repeats, which is what defends concurrent
    // verifies of the same tool in the same tree.
    expect(a).not.toBe(b);
  });

  it('never embeds the pid, which is the component that collides', () => {
    const name = buildToolScopeUnitName('test', '/root');
    expect(name).not.toContain(String(process.pid));
    expect(name).not.toMatch(/run-p\d+-i\d+/);
  });
});

/**
 * Can this host actually create a transient user scope? Mirrors the probe in
 * `heavy-tool-confinement.test.ts`.
 */
function canActuallyConfine(): boolean {
  if (!cgroupConfinementAvailable()) return false;
  const r = spawnSync(
    'systemd-run',
    ['--user', '--scope', '--quiet', '--collect', '-p', 'MemoryMax=64M', '--', 'true'],
    { stdio: 'ignore', timeout: 15_000 },
  );
  return !r.error && r.status === 0;
}

const canConfine = canActuallyConfine();

if (!canConfine) {
  // A silent skip is indistinguishable from a pass, which is the exact defect
  // family this whole task is about (gh#1397). Say so out loud, so a reader of
  // a green CI log can tell "not exercised here" from "verified here".
  console.warn(
    '[heavy-tool-double-wrap] systemd scope-reaping NOT EXERCISED on this host: ' +
      'no usable user systemd manager. These cases assert a property of systemd, ' +
      'not of CLEO, and cannot be mocked without asserting the mock.',
  );
}

describe('named scopes are reaped and are individually targetable (gh#1396)', () => {
  /**
   * `systemctl show -p LoadState` is deterministic for a unit that does not
   * exist (`LoadState=not-found`), unlike `list-units`, whose output format is
   * a presentation detail.
   */
  function unitLoadState(unit: string): string {
    const r = spawnSync('systemctl', ['--user', 'show', unit, '-p', 'LoadState'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return (r.stdout ?? '').trim();
  }

  /** Poll until the unit reaches `state`, bounded. Returns whether it did. */
  async function waitForLoadState(unit: string, state: string): Promise<boolean> {
    for (let i = 0; i < 50; i++) {
      if (unitLoadState(unit) === state) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  it.skipIf(!canConfine)('propagates the child exit code through a NAMED scope', async () => {
    const unit = buildToolScopeUnitName('test', '/repro/exit-code');
    const r = spawnSync(
      'systemd-run',
      ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '--', 'sh', '-c', 'exit 3'],
      { stdio: 'ignore', timeout: 20_000 },
    );
    // `systemd-run --scope` is transparent on success. If naming broke that,
    // every tool's exit code would silently become systemd-run's instead —
    // which would turn a green suite into an evidence failure.
    expect(r.status).toBe(3);
    // `--collect` reaping is ASYNCHRONOUS: measured, the unit is still
    // `LoadState=loaded` at the instant `systemd-run` returns. A bare check
    // here fails, and `sleep`-then-check would be a flake generator.
    expect(await waitForLoadState(unit, 'LoadState=not-found')).toBe(true);
  });

  it.skipIf(!canConfine)('is stoppable BY NAME, which is what naming buys', async () => {
    // The point of the fix, as a test. `suite-reaper.ts:93` reaps via
    // `systemctl --user stop <unitName>` and could never target a heavy-tool
    // scope while the name was systemd's auto-generated `run-p<pid>-i<id>`.
    //
    // Uses async `spawn`, not `spawnSync`: the scope has to be ALIVE while we
    // target it, which a blocking call cannot arrange.
    const unit = buildToolScopeUnitName('test', '/repro/targetable');
    const child = spawn(
      'systemd-run',
      ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '--', 'sleep', '30'],
      { stdio: 'ignore' },
    );
    try {
      // Wait for the unit to register, bounded so a failure reports rather
      // than hangs.
      expect(await waitForLoadState(unit, 'LoadState=loaded')).toBe(true);

      // The assertion the fix exists for: this scope can be named, and
      // therefore stopped, by exactly the command the reaper already runs.
      const stop = spawnSync('systemctl', ['--user', 'stop', unit], {
        stdio: 'ignore',
        timeout: 15_000,
      });
      expect(stop.status).toBe(0);

      // `--collect` must reap it, so a repeated verify does not accumulate
      // units or find its own name taken.
      expect(await waitForLoadState(unit, 'LoadState=not-found')).toBe(true);
    } finally {
      child.kill('SIGKILL');
      spawnSync('systemctl', ['--user', 'reset-failed', unit], { stdio: 'ignore' });
    }
  });
});
