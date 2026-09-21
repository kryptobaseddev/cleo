/**
 * Unit tests for spawn-wrapper.ts (T11993 · Epic T11992).
 *
 * ## CI-runnable design (Amendment 4)
 *
 * These tests are hermetic and CI-runnable without a live systemd user bus.
 * They use `_forceSystemdRunAvailable` to exercise BOTH the systemd path and
 * the pgid-fallback path deterministically, then assert the EXACT systemd-run
 * argv produced.
 *
 * The induced-OOM / zero-coredump journal assertion (AC3) is a soak/e2e
 * criterion gated on systemd availability at runtime, NOT in this suite.
 *
 * @task T11993
 * @epic T11992
 */

import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', { spy: true });

import { _resetTeardownSignalForTests, markShuttingDown } from '../../teardown-signal.js';
import {
  _forceSystemdRunAvailable,
  buildSpawnArgs,
  CLEO_SLICE,
  captureWrapped,
  createParserExecutionPort,
  DEFAULT_SCOPE_RESOURCES,
  hasSystemdRun,
  spawnWrapped,
} from '../spawn-wrapper.js';

// ---------------------------------------------------------------------------
// Teardown: reset the forced availability between tests so they don't bleed.
// Each test that forces a value should reset it to false after.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Reset to false (unavailable) so the next test gets a clean probe.
  _forceSystemdRunAvailable(false);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the slice/unit/property directives from a built systemd-run argv.
 */
function parseSystemdRunArgv(args: string[]): {
  slice: string | undefined;
  unit: string | undefined;
  props: Record<string, string>;
  innerCommand: string;
  innerArgs: string[];
} {
  const slice = args.find((a) => a.startsWith('--slice='))?.slice('--slice='.length);
  const unit = args.find((a) => a.startsWith('--unit='))?.slice('--unit='.length);
  const props: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-p' && i + 1 < args.length) {
      const kv = args[i + 1];
      const eqIdx = kv.indexOf('=');
      if (eqIdx !== -1) {
        props[kv.slice(0, eqIdx)] = kv.slice(eqIdx + 1);
      }
      i++; // skip the value token
    }
  }
  const sepIdx = args.indexOf('--');
  const innerCommand = sepIdx !== -1 ? args[sepIdx + 1] : '';
  const innerArgs = sepIdx !== -1 ? args.slice(sepIdx + 2) : [];
  return { slice, unit, props, innerCommand, innerArgs };
}

// ---------------------------------------------------------------------------
// systemd path (forced available)
// ---------------------------------------------------------------------------

describe('buildSpawnArgs — systemd path', () => {
  it('produces systemd-run as command with correct mode', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('node', ['--version']);
    expect(result.command).toBe('systemd-run');
    expect(result.mode).toBe('systemd');
  });

  it('places the scope under cleo.slice', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('node', ['-e', 'console.log(1)']);
    const { slice } = parseSystemdRunArgv(result.args);
    expect(slice).toBe(CLEO_SLICE);
  });

  it('emits --user --scope flags', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('node', []);
    expect(result.args).toContain('--user');
    expect(result.args).toContain('--scope');
  });

  it('emits MemoryMax=32G by default (P1 staged value)', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('pnpm', ['run', 'test']);
    const { props } = parseSystemdRunArgv(result.args);
    expect(props['MemoryMax']).toBe(DEFAULT_SCOPE_RESOURCES.memoryMax);
  });

  it('does NOT emit MemoryHigh when it is infinity (P1 default)', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('pnpm', ['run', 'test']);
    const { props } = parseSystemdRunArgv(result.args);
    // MemoryHigh MUST be absent in P1 (no throttle risk for WAL write-txn holders)
    expect(props['MemoryHigh']).toBeUndefined();
  });

  it('emits MemoryHigh when explicitly set to a non-infinity value', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('node', [], { resources: { memoryHigh: '8G' } });
    const { props } = parseSystemdRunArgv(result.args);
    expect(props['MemoryHigh']).toBe('8G');
  });

  it('emits MemorySwapMax=0', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('node', []);
    const { props } = parseSystemdRunArgv(result.args);
    expect(props['MemorySwapMax']).toBe('0');
  });

  it('wraps inner command with sh/ulimit by default (noCoreFile=true)', () => {
    // LimitCORE is a service-unit EXEC property — invalid on --scope units.
    // Core suppression is done caller-side via ulimit -c 0 instead.
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('node', []);
    const { props, innerCommand, innerArgs } = parseSystemdRunArgv(result.args);
    // No LimitCORE scope property
    expect(props['LimitCORE']).toBeUndefined();
    // Inner command is sh running the ulimit fragment
    expect(innerCommand).toBe('sh');
    expect(innerArgs[0]).toBe('-c');
    expect(innerArgs[1]).toContain('ulimit -c 0');
    expect(innerArgs[1]).toContain('exec "$@"');
    // The real command is at innerArgs[3] (after 'sh', '-c', '<script>', 'sh')
    expect(innerArgs[3]).toBe('node');
  });

  it('does NOT wrap with sh/ulimit and has no LimitCORE when noCoreFile=false', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('node', [], { noCoreFile: false });
    const { props, innerCommand } = parseSystemdRunArgv(result.args);
    expect(props['LimitCORE']).toBeUndefined();
    // Inner command is the real command directly (no sh wrapping)
    expect(innerCommand).toBe('node');
  });

  it('passes the original command + args inside sh/ulimit wrapper', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('pnpm', ['run', 'test', '--reporter=verbose']);
    const { innerCommand, innerArgs } = parseSystemdRunArgv(result.args);
    // sh is the inner command; real command is at innerArgs[3]
    expect(innerCommand).toBe('sh');
    expect(innerArgs[3]).toBe('pnpm');
    expect(innerArgs.slice(4)).toEqual(['run', 'test', '--reporter=verbose']);
  });

  it('generates a unit name under cleo-<class>-*.scope pattern', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('node', [], { scopeClass: 'agent', scopeId: 'T1234' });
    expect(result.unitName).toMatch(/^cleo-agent-T1234\.scope$/);
    const { unit } = parseSystemdRunArgv(result.args);
    expect(unit).toBe(result.unitName);
  });

  it('sanitizes special characters in scopeId', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('node', [], { scopeClass: 'tool', scopeId: 'task/T1234' });
    expect(result.unitName).toMatch(/^cleo-tool-task-T1234\.scope$/);
  });
});

// ---------------------------------------------------------------------------
// Selective ManagedOOMPreference=avoid (Amendment 2)
// ---------------------------------------------------------------------------

describe('ManagedOOMPreference=avoid — selective per scope class', () => {
  it('emits ManagedOOMPreference=avoid for daemon scope class', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('node', [], { scopeClass: 'daemon' });
    const { props } = parseSystemdRunArgv(result.args);
    expect(props['ManagedOOMPreference']).toBe('avoid');
  });

  it('emits ManagedOOMPreference=avoid for db scope class', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('node', [], { scopeClass: 'db' });
    const { props } = parseSystemdRunArgv(result.args);
    expect(props['ManagedOOMPreference']).toBe('avoid');
  });

  it('does NOT emit ManagedOOMPreference=avoid for agent scope class', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('node', [], { scopeClass: 'agent' });
    const { props } = parseSystemdRunArgv(result.args);
    expect(props['ManagedOOMPreference']).toBeUndefined();
  });

  it('does NOT emit ManagedOOMPreference=avoid for test scope class', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('node', [], { scopeClass: 'test' });
    const { props } = parseSystemdRunArgv(result.args);
    expect(props['ManagedOOMPreference']).toBeUndefined();
  });

  it('does NOT emit ManagedOOMPreference=avoid for tool scope class', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('node', [], { scopeClass: 'tool' });
    const { props } = parseSystemdRunArgv(result.args);
    expect(props['ManagedOOMPreference']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pgid fallback path (forced unavailable) — CI-runnable path (Amendment 4)
// ---------------------------------------------------------------------------

describe('buildSpawnArgs — pgid fallback path (no systemd-run)', () => {
  it('returns mode=pgid when systemd-run is unavailable', () => {
    _forceSystemdRunAvailable(false);
    const result = buildSpawnArgs('node', ['--version']);
    expect(result.mode).toBe('pgid');
  });

  it('wraps with sh/ulimit on pgid path when noCoreFile=true (default)', () => {
    // ulimit -c 0 suppresses coredumps consistently in both paths.
    _forceSystemdRunAvailable(false);
    const result = buildSpawnArgs('pnpm', ['run', 'test']);
    expect(result.command).toBe('sh');
    expect(result.args[0]).toBe('-c');
    expect(result.args[1]).toContain('ulimit -c 0');
    // Real command embedded at index 3
    expect(result.args[3]).toBe('pnpm');
    expect(result.args.slice(4)).toEqual(['run', 'test']);
  });

  it('returns the original command unchanged on pgid path when noCoreFile=false', () => {
    _forceSystemdRunAvailable(false);
    const result = buildSpawnArgs('pnpm', ['run', 'test'], { noCoreFile: false });
    expect(result.command).toBe('pnpm');
    expect(result.args).toEqual(['run', 'test']);
  });

  it('returns undefined unitName on pgid path', () => {
    _forceSystemdRunAvailable(false);
    const result = buildSpawnArgs('node', []);
    expect(result.unitName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Resource override
// ---------------------------------------------------------------------------

describe('resource overrides', () => {
  it('uses caller-supplied MemoryMax', () => {
    _forceSystemdRunAvailable(true);
    const result = buildSpawnArgs('node', [], { resources: { memoryMax: '16G' } });
    const { props } = parseSystemdRunArgv(result.args);
    expect(props['MemoryMax']).toBe('16G');
  });

  it('resolves fractional MemoryMax to an absolute MiB string', () => {
    _forceSystemdRunAvailable(true);
    // 0.85 fraction of any MemTotal should produce a MiB string (ends with 'M').
    const result = buildSpawnArgs('node', [], { resources: { memoryMax: 0.85 } });
    const { props } = parseSystemdRunArgv(result.args);
    // Should end with 'M' (mebibytes).
    expect(props['MemoryMax']).toMatch(/^\d+M$/);
  });
});

describe('contained parser execution port (T12262)', () => {
  it('overrides inherited heap flags, preserves IPC and waits for cancellation exit', async () => {
    _forceSystemdRunAvailable(false);
    _resetTeardownSignalForTests();
    const directory = mkdtempSync(join(tmpdir(), 'parser-port-'));
    const path = join(directory, 'worker.cjs');
    writeFileSync(
      path,
      "process.send({ heap: require('node:v8').getHeapStatistics().heap_size_limit }); setInterval(() => {}, 1000);",
    );
    const controller = new AbortController();
    const handle = createParserExecutionPort().spawn(path, {
      workerHeapMb: 32,
      signal: controller.signal,
    });
    try {
      const heap = await new Promise<number>((resolve, reject) => {
        handle.child.once('error', reject);
        handle.child.once('message', (message) => {
          if (
            typeof message !== 'object' ||
            message === null ||
            !('heap' in message) ||
            typeof message.heap !== 'number'
          )
            reject(new Error('Missing actual heap evidence'));
          else resolve(message.heap);
        });
      });
      expect(heap).toBeLessThan(64 * 1024 * 1024);
      expect(handle.nativeMemory).toBe('unverified');
      controller.abort();
      await handle.stop();
      expect(handle.child.signalCode).toBe('SIGKILL');
    } finally {
      await handle.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects work after runtime teardown and invalid requested heap caps', () => {
    _resetTeardownSignalForTests();
    expect(() => createParserExecutionPort().spawn('unused.mjs', { workerHeapMb: 1 })).toThrow(
      'heap',
    );
    markShuttingDown();
    try {
      expect(() => createParserExecutionPort().spawn('unused.mjs', {})).toThrow('E_TEARDOWN');
    } finally {
      _resetTeardownSignalForTests();
    }
  });
});

describe.skipIf(process.platform !== 'linux')('explicit systemd manager context', () => {
  it('keeps unavailable ambient and explicit manager probes separate without global env changes', () => {
    const successful = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    _forceSystemdRunAvailable(undefined);
    vi.stubEnv('XDG_RUNTIME_DIR', undefined);
    vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', undefined);
    vi.mocked(spawnSync).mockImplementation((command, _args, options) => {
      if (command === 'systemctl' && options?.env?.['XDG_RUNTIME_DIR'] === '/unavailable-manager')
        return { ...successful, status: 1 };
      return successful;
    });
    expect(hasSystemdRun()).toBe(false);
    expect(hasSystemdRun({ runtimeDirectory: '/available-manager' })).toBe(true);
    expect(hasSystemdRun({ runtimeDirectory: '/unavailable-manager' })).toBe(false);
    const calls = vi.mocked(spawnSync).mock.calls.length;
    expect(hasSystemdRun({ runtimeDirectory: '/available-manager' })).toBe(true);
    expect(vi.mocked(spawnSync).mock.calls).toHaveLength(calls);
    expect(hasSystemdRun()).toBe(false);
    expect(process.env['XDG_RUNTIME_DIR']).toBeUndefined();
    expect(process.env['DBUS_SESSION_BUS_ADDRESS']).toBeUndefined();
    const probe = vi
      .mocked(spawnSync)
      .mock.calls.find(
        ([command, , options]) =>
          command === 'systemctl' && options?.env?.['XDG_RUNTIME_DIR'] === '/available-manager',
      );
    expect(probe?.[2]?.env?.['DBUS_SESSION_BUS_ADDRESS']).toBe('unix:path=/available-manager/bus');
  });

  it('rejects relative manager paths and nonlocal buses before launching work', () => {
    expect(() =>
      buildSpawnArgs('unused', [], { systemdControl: { runtimeDirectory: 'relative' } }),
    ).toThrow('absolute');
    expect(() =>
      buildSpawnArgs('unused', [], {
        systemdControl: { runtimeDirectory: '/manager', busAddress: 'tcp:host=remote' },
      }),
    ).toThrow('local Unix');
  });

  it('restores isolated child roots and keeps credential values out of launcher argv', async () => {
    _forceSystemdRunAvailable(true);
    const directory = mkdtempSync(join(tmpdir(), 'cleo-manager-context-'));
    const marker = join(directory, 'launcher.json');
    const executable = join(directory, 'systemd-run');
    writeFileSync(
      executable,
      `#!${process.execPath}\nconst cp=require('node:child_process');const fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({args,runtime:process.env.XDG_RUNTIME_DIR,bus:process.env.DBUS_SESSION_BUS_ADDRESS}));const at=args.indexOf('--');const child=cp.spawn(args[at+1],args.slice(at+2),{stdio:'inherit',env:process.env});child.on('error',()=>{process.exitCode=1});child.on('close',code=>{process.exitCode=code??1});\n`,
    );
    chmodSync(executable, 0o700);
    const secret = 'synthetic-credential-not-for-argv';
    const owned = spawnWrapped(
      process.execPath,
      [
        '-e',
        'process.stdout.write(JSON.stringify({home:process.env.HOME,runtime:process.env.XDG_RUNTIME_DIR,bus:process.env.DBUS_SESSION_BUS_ADDRESS,secret:process.env.VERIFIER_TEST_SECRET}))',
      ],
      {
        env: {
          PATH: `${directory}:${process.env['PATH'] ?? ''}`,
          HOME: join(directory, 'home'),
          XDG_RUNTIME_DIR: join(directory, 'isolated-runtime'),
          VERIFIER_TEST_SECRET: secret,
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
      {
        systemdControl: { runtimeDirectory: join(directory, 'manager-runtime') },
        scopeId: 'context-test',
      },
    );
    let output = '';
    owned.child.stdout?.on('data', (bytes: Buffer) => {
      output += bytes.toString();
    });
    const timer = setTimeout(() => {
      if (owned.child.pid) {
        try {
          process.kill(-owned.child.pid, 'SIGKILL');
        } catch {}
      }
    }, 3000);
    try {
      const status = await new Promise<number | null>((resolve, reject) => {
        owned.child.once('error', reject);
        owned.child.once('close', resolve);
      });
      expect(status).toBe(0);
      expect(JSON.parse(output)).toEqual({
        home: join(directory, 'home'),
        runtime: join(directory, 'isolated-runtime'),
        secret,
      });
      const launcher = JSON.parse(readFileSync(marker, 'utf8'));
      expect(launcher.runtime).toBe(join(directory, 'manager-runtime'));
      expect(launcher.bus).toBe(`unix:path=${join(directory, 'manager-runtime', 'bus')}`);
      expect(launcher.args.join(' ')).not.toContain(secret);
      expect(owned.mode).toBe('systemd');
    } finally {
      clearTimeout(timer);
      if (owned.child.pid) {
        try {
          process.kill(-owned.child.pid, 'SIGKILL');
        } catch {}
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== 'linux')('original process launch deadline', () => {
  it('does not start a provider after a synchronous availability probe exhausts the original budget', () => {
    const successful = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    vi.clearAllMocks();
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    _forceSystemdRunAvailable(undefined);
    vi.mocked(spawnSync).mockImplementation(() => {
      now += 20;
      return successful;
    });
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('provider-started');
    });
    expect(() =>
      spawnWrapped(
        'unused-provider',
        [],
        {},
        {
          systemdControl: { runtimeDirectory: '/manager' },
          execution: { deadlineAt: 1010 },
        },
      ),
    ).toThrow('E_PROCESS_DEADLINE');
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(spawnSync).mock.calls[0]?.[2]?.timeout).toBe(10);
  });

  it('propagates cancellation after a probe before any second probe or provider launch', () => {
    const successful = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    vi.clearAllMocks();
    const controller = new AbortController();
    _forceSystemdRunAvailable(undefined);
    vi.mocked(spawnSync).mockImplementation(() => {
      controller.abort(new Error('probe-cancelled'));
      return successful;
    });
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('provider-started');
    });
    expect(() =>
      spawnWrapped(
        'unused-provider',
        [],
        {},
        {
          systemdControl: { runtimeDirectory: '/manager' },
          execution: { deadlineAt: Date.now() + 1000, signal: controller.signal },
        },
      ),
    ).toThrow('probe-cancelled');
    expect(spawn).not.toHaveBeenCalled();
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it('uses remaining time for each probe and rejects expired cached/fallback launches', () => {
    const successful = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    vi.clearAllMocks();
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    _forceSystemdRunAvailable(undefined);
    vi.mocked(spawnSync).mockImplementation(() => {
      now += 4;
      return successful;
    });
    expect(hasSystemdRun({ runtimeDirectory: '/manager' }, { deadlineAt: 1010 })).toBe(true);
    expect(vi.mocked(spawnSync).mock.calls.map((call) => call[2]?.timeout)).toEqual([10, 6]);
    now = 1010;
    expect(() => hasSystemdRun({ runtimeDirectory: '/manager' }, { deadlineAt: 1010 })).toThrow(
      'E_PROCESS_DEADLINE',
    );
    _forceSystemdRunAvailable(false);
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('provider-started');
    });
    expect(() => spawnWrapped('unused', [], {}, { execution: { deadlineAt: 1010 } })).toThrow(
      'E_PROCESS_DEADLINE',
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === 'win32')('captured target lifecycle', () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementation(actual.spawn);
    vi.mocked(spawnSync).mockImplementation(actual.spawnSync);
    _resetTeardownSignalForTests();
  });
  it('separates a missing executable from an actual nonzero exit and retains exact argv', async () => {
    _forceSystemdRunAvailable(false);
    _resetTeardownSignalForTests();
    const options = { cwd: tmpdir(), env: {}, execution: { deadlineAt: Date.now() + 5000 } };
    const missing = await captureWrapped('/no-such-cleo-capture-binary', [], options);
    expect(missing).toMatchObject({ started: false, exitCode: null, stopped: null });
    expect(missing.error).toContain('ENOENT');
    const exited = await captureWrapped(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1]); process.exit(7)', 'quoted ü | argument'],
      options,
    );
    expect(exited).toMatchObject({
      started: true,
      exitCode: 7,
      signal: null,
      error: null,
      stopped: null,
      stdout: 'quoted ü | argument',
      nativeMemory: 'unverified',
      cleanupErrors: [],
    });
  });

  it('refuses requested hard limits before target execution when the owned cgroup is unavailable', async () => {
    _forceSystemdRunAvailable(false);
    const result = await captureWrapped(
      process.execPath,
      ['-e', "process.stdout.write('TARGET-RAN')"],
      {
        cwd: tmpdir(),
        env: {},
        memoryMaxMb: 4096,
        tasksMax: 256,
        execution: { deadlineAt: Date.now() + 5000 },
      },
    );
    expect(result).toMatchObject({
      started: false,
      exitCode: null,
      stopped: 'resource-limit',
      stdout: '',
      nativeMemory: 'unverified',
    });
    expect(result.error).toContain('E_PROCESS_RESOURCE_LIMIT');
    expect(result.resourceLimits).toBeUndefined();
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
  ])('rejects invalid or inexact memory bound %s before any process starts', async (memoryMaxMb) => {
    vi.clearAllMocks();
    await expect(
      captureWrapped('unused', [], {
        cwd: tmpdir(),
        env: {},
        memoryMaxMb,
        execution: { deadlineAt: Date.now() + 5000 },
      }),
    ).rejects.toThrow(RangeError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects a fractional kernel task limit before any process starts', async () => {
    vi.clearAllMocks();
    await expect(
      captureWrapped('unused', [], {
        cwd: tmpdir(),
        env: {},
        tasksMax: 1.5,
        execution: { deadlineAt: Date.now() + 5000 },
      }),
    ).rejects.toThrow(RangeError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('retains signals independently from numeric exit outcomes', async () => {
    _forceSystemdRunAvailable(false);
    const result = await captureWrapped(
      process.execPath,
      ['-e', "process.kill(process.pid, 'SIGTERM')"],
      { cwd: tmpdir(), env: {}, execution: { deadlineAt: Date.now() + 5000 } },
    );
    expect(result).toMatchObject({
      started: true,
      exitCode: null,
      signal: 'SIGTERM',
      stopped: null,
    });
  });

  it('stops aggregate UTF-8 output at the declared byte limit', async () => {
    _forceSystemdRunAvailable(false);
    const result = await captureWrapped(
      process.execPath,
      ['-e', "process.stdout.write('😀'.repeat(10000)); process.stderr.write('x'.repeat(10000))"],
      { cwd: tmpdir(), env: {}, maxOutputBytes: 102, execution: { deadlineAt: Date.now() + 5000 } },
    );
    expect(result.stopped).toBe('output-limit');
    expect(result.outputTruncated).toBe(true);
    // Capture never represents an incomplete UTF-8 suffix as extra replacement bytes.
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      102,
    );
  });

  it('rejects an expired original deadline before spawning', async () => {
    _forceSystemdRunAvailable(false);
    vi.clearAllMocks();
    await expect(
      captureWrapped(process.execPath, ['-e', 'process.exit(0)'], {
        cwd: tmpdir(),
        env: {},
        execution: { deadlineAt: Date.now() - 1 },
      }),
    ).rejects.toThrow('DEADLINE');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('stops the original running process group on cancellation', async () => {
    _forceSystemdRunAvailable(false);
    const controller = new AbortController();
    const pending = captureWrapped(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: tmpdir(),
      env: {},
      execution: { deadlineAt: Date.now() + 5000, signal: controller.signal },
    });
    const timer = setTimeout(() => controller.abort(), 150);
    try {
      const result = await pending;
      expect(result.stopped).toBe('cancelled');
      expect(result.cleanupErrors).toEqual([]);
      const targetPid = result.targetPid;
      if (targetPid) {
        // T12308: the group has been signalled by the time the capture
        // resolves, but reaping is NOT synchronous — the kernel still has to
        // deliver the signal and reap the child. Asserting the pid is gone in
        // the same tick made this a race against runner load: it failed once
        // on a CI shard that was competing with a full sweep, and passed on a
        // re-run of the identical commit.
        //
        // The claim under test is the test's own name — that the group is
        // STOPPED — not that it stops within one tick, so polling to a bounded
        // deadline keeps the assertion exactly as strong while removing the
        // timing dependency. A pid that never goes away still fails, after 5s.
        await expect
          .poll(
            () => {
              try {
                process.kill(targetPid, 0);
                return false;
              } catch {
                return true;
              }
            },
            { timeout: 5000, interval: 25 },
          )
          .toBe(true);
      }
    } finally {
      clearTimeout(timer);
    }
  });

  it('preserves deadline expiry when an enclosing lifetime aborts before the capture timer', async () => {
    _forceSystemdRunAvailable(false);
    const controller = new AbortController();
    const deadlineAt = Date.now() + 5000;
    const pending = captureWrapped(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      cwd: tmpdir(),
      env: {},
      execution: { deadlineAt, signal: controller.signal },
    });
    const timer = setTimeout(() => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(deadlineAt);
      try {
        controller.abort(new Error('enclosing operation expired'));
      } finally {
        clock.mockRestore();
      }
    }, 100);
    try {
      const result = await pending;
      expect(result.stopped).toBe('deadline');
      expect(result.cleanupErrors).toEqual([]);
    } finally {
      clearTimeout(timer);
    }
  });

  it('bounds a descendant that keeps the target pipes open after its parent exits', async () => {
    _forceSystemdRunAvailable(false);
    const script =
      "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});process.stdout.write(String(c.pid));c.unref()";
    const result = await captureWrapped(process.execPath, ['-e', script], {
      cwd: tmpdir(),
      env: {},
      execution: { deadlineAt: Date.now() + 400 },
    });
    expect(result.stopped).toBe('deadline');
    expect(result.stdout).toMatch(/^\d+$/);
    expect(result.cleanupErrors).toEqual([]);
    expect(() => process.kill(Number(result.stdout), 0)).toThrow();
  });

  it.each([
    ['malformed', "process.stdout.write('not-json\\n')"],
    ['truncated', "process.stdout.write('{')"],
    ['wrapper exit', 'process.exit(127)'],
    [
      'missing start',
      "process.stdout.write(JSON.stringify({type:'closed',code:0,signal:null})+'\\n')",
    ],
  ])('refuses %s transport as a target verdict', async (_label, script) => {
    _forceSystemdRunAvailable(false);
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(spawn).mockImplementation((_command, _args, options) =>
      actual.spawn(process.execPath, ['-e', script], options),
    );
    const result = await captureWrapped('must-not-be-executed', [], {
      cwd: tmpdir(),
      env: {},
      execution: { deadlineAt: Date.now() + 5000 },
    });
    expect(result).toMatchObject({ started: false, exitCode: null, stopped: 'transport-error' });
    expect(result.error).toBeTruthy();
  });

  it('captures environment before caller edits and keeps secrets out of argv', async () => {
    _forceSystemdRunAvailable(false);
    const env = { CAPTURE_SECRET: 'original-sensitive-value' };
    const pending = captureWrapped(
      process.execPath,
      ['-e', 'process.stdout.write(process.env.CAPTURE_SECRET)'],
      { cwd: tmpdir(), env, execution: { deadlineAt: Date.now() + 5000 } },
    );
    env.CAPTURE_SECRET = 'changed';
    const result = await pending;
    expect(result.stdout).toBe('original-sensitive-value');
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[1]?.join(' ')).not.toContain(
      'original-sensitive-value',
    );
  });

  it('aborts tracked capture on teardown and refuses future launches', async () => {
    _forceSystemdRunAvailable(false);
    const options = { cwd: tmpdir(), env: {}, execution: { deadlineAt: Date.now() + 5000 } };
    const pending = captureWrapped(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options);
    const timer = setTimeout(() => markShuttingDown(), 100);
    try {
      const result = await pending;
      expect(result.stopped).toBe('teardown');
      await expect(captureWrapped('unused', [], options)).rejects.toThrow('E_TEARDOWN');
    } finally {
      clearTimeout(timer);
      _resetTeardownSignalForTests();
    }
  });

  it.skipIf(process.platform !== 'linux')(
    'observes real scope membership and terminal cleanup when a user manager is available',
    async (context) => {
      const systemdControl = { runtimeDirectory: `/run/user/${process.getuid?.()}` };
      _forceSystemdRunAvailable(undefined);
      if (!hasSystemdRun(systemdControl, { deadlineAt: Date.now() + 1000 })) {
        context.skip();
        return;
      }
      const result = await captureWrapped(
        process.execPath,
        ['-e', "process.stdout.write(require('node:fs').readFileSync('/proc/self/cgroup','utf8'))"],
        { cwd: tmpdir(), env: {}, systemdControl, execution: { deadlineAt: Date.now() + 5000 } },
      );
      expect(result).toMatchObject({
        started: true,
        exitCode: 0,
        stopped: null,
        error: null,
        mode: 'systemd',
        transportClosed: true,
        targetCloseObserved: true,
        cleanupObservation: 'scope-terminal',
        cleanupErrors: [],
      });
      expect(result.unitName).toBeTruthy();
      if (!result.unitName) throw new Error('Missing observed scope identity');
      expect(result.stdout).toContain(result.unitName);
      expect(result.nativeMemory).toBe('unverified');
      const bounded = await captureWrapped(
        process.execPath,
        [
          '-e',
          `
        const fs = require('node:fs');
        const group = fs.readFileSync('/proc/self/cgroup','utf8').trim().split('\\n').find(x => x.startsWith('0::')).slice(3);
        process.stdout.write(JSON.stringify({
          memory: fs.readFileSync('/sys/fs/cgroup' + group + '/memory.max','utf8').trim(),
          tasks: fs.readFileSync('/sys/fs/cgroup' + group + '/pids.max','utf8').trim(),
          group,
        }));
      `,
        ],
        {
          cwd: tmpdir(),
          env: {},
          systemdControl,
          memoryMaxMb: 4096,
          tasksMax: 256,
          execution: { deadlineAt: Date.now() + 5000 },
        },
      );
      expect(bounded).toMatchObject({
        started: true,
        exitCode: 0,
        error: null,
        stopped: null,
        nativeMemory: 'observed-cgroup',
        cleanupObservation: 'scope-terminal',
        cleanupErrors: [],
        resourceLimits: { memoryMaxBytes: 4294967296, tasksMax: 256 },
      });
      expect(JSON.parse(bounded.stdout)).toEqual({
        memory: '4294967296',
        tasks: '256',
        group: bounded.resourceLimits?.cgroup,
      });
      const configured = vi.mocked(spawn).mock.calls.at(-1)?.[1] ?? [];
      expect(configured).toContain('MemoryMax=4096M');
      expect(configured).toContain('TasksMax=256');
      expect(configured).not.toContain('MemoryMax=32G');

      const expired = await captureWrapped(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        cwd: tmpdir(),
        env: {},
        systemdControl,
        execution: { deadlineAt: Date.now() + 300 },
      });
      expect(expired).toMatchObject({
        started: true,
        stopped: 'deadline',
        mode: 'systemd',
        cleanupErrors: [],
      });
      expect(expired.unitName).not.toBe(result.unitName);
    },
  );
});
