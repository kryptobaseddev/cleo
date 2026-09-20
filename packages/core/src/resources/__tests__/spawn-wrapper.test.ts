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

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', { spy: true });

import { _resetTeardownSignalForTests, markShuttingDown } from '../../teardown-signal.js';
import {
  _forceSystemdRunAvailable,
  buildSpawnArgs,
  CLEO_SLICE,
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
