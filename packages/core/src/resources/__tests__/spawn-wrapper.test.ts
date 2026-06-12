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

import { afterEach, describe, expect, it } from 'vitest';
import {
  _forceSystemdRunAvailable,
  buildSpawnArgs,
  CLEO_SLICE,
  DEFAULT_SCOPE_RESOURCES,
} from '../spawn-wrapper.js';

// ---------------------------------------------------------------------------
// Teardown: reset the forced availability between tests so they don't bleed.
// Each test that forces a value should reset it to false after.
// ---------------------------------------------------------------------------

afterEach(() => {
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
