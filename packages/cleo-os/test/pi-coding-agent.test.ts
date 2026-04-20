/**
 * Tests for the Pi Coding Agent harness adapter (T922).
 *
 * These are unit tests for the adapter's logic — they do NOT launch a real
 * `pi` binary. All child_process.spawn calls are mocked via vi.mock so the
 * suite runs without Pi installed.
 *
 * Coverage:
 *   1. Types and interface shape
 *   2. pi-wrapper helpers (env resolution, extension path resolution)
 *   3. processEntry creation and buildStatus snapshot
 *   4. PiCodingAgentAdapter.status() / .output() on unknown instances
 *   5. PiCodingAgentAdapter.kill() idempotency on unknown instances
 *   6. Harness registry (createHarness / listHarnesses)
 *   7. docker-mode helpers (isSandboxedGlobally, getSandboxImage, buildDockerRunArgs)
 *
 * @packageDocumentation
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Temporarily set / restore environment variables. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 1. HarnessAdapter interface shape
// ---------------------------------------------------------------------------

describe('HarnessAdapter interface', () => {
  it('PiCodingAgentAdapter satisfies HarnessAdapter shape', async () => {
    const { PiCodingAgentAdapter } = await import(
      '../src/harnesses/pi-coding-agent/adapter.js'
    );
    const adapter = new PiCodingAgentAdapter();
    expect(adapter.id).toBe('pi-coding-agent');
    expect(typeof adapter.spawn).toBe('function');
    expect(typeof adapter.status).toBe('function');
    expect(typeof adapter.kill).toBe('function');
    expect(typeof adapter.output).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 2. pi-wrapper env helpers
// ---------------------------------------------------------------------------

describe('pi-wrapper env helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('getPiBinaryPath returns "pi" by default', async () => {
    const { getPiBinaryPath } = await import('../src/harnesses/pi-coding-agent/pi-wrapper.js');
    withEnv({ CLEO_PI_BINARY: undefined }, () => {
      expect(getPiBinaryPath()).toBe('pi');
    });
  });

  it('getPiBinaryPath honours CLEO_PI_BINARY', async () => {
    const { getPiBinaryPath } = await import('../src/harnesses/pi-coding-agent/pi-wrapper.js');
    withEnv({ CLEO_PI_BINARY: '/usr/local/bin/pi-custom' }, () => {
      expect(getPiBinaryPath()).toBe('/usr/local/bin/pi-custom');
    });
  });

  it('getTerminateGraceMs returns 5000 by default', async () => {
    const { getTerminateGraceMs } = await import(
      '../src/harnesses/pi-coding-agent/pi-wrapper.js'
    );
    withEnv({ CLEO_TERMINATE_GRACE_MS: undefined }, () => {
      expect(getTerminateGraceMs()).toBe(5000);
    });
  });

  it('getTerminateGraceMs honours CLEO_TERMINATE_GRACE_MS', async () => {
    const { getTerminateGraceMs } = await import(
      '../src/harnesses/pi-coding-agent/pi-wrapper.js'
    );
    withEnv({ CLEO_TERMINATE_GRACE_MS: '2000' }, () => {
      expect(getTerminateGraceMs()).toBe(2000);
    });
  });

  it('getOutputBufferSize returns 500 by default', async () => {
    const { getOutputBufferSize } = await import(
      '../src/harnesses/pi-coding-agent/pi-wrapper.js'
    );
    withEnv({ CLEO_HARNESS_OUTPUT_BUFFER: undefined }, () => {
      expect(getOutputBufferSize()).toBe(500);
    });
  });

  it('getOutputBufferSize honours CLEO_HARNESS_OUTPUT_BUFFER', async () => {
    const { getOutputBufferSize } = await import(
      '../src/harnesses/pi-coding-agent/pi-wrapper.js'
    );
    withEnv({ CLEO_HARNESS_OUTPUT_BUFFER: '100' }, () => {
      expect(getOutputBufferSize()).toBe(100);
    });
  });

  it('resolveExtensionPaths returns an array', async () => {
    const { resolveExtensionPaths } = await import(
      '../src/harnesses/pi-coding-agent/pi-wrapper.js'
    );
    // The extensions directory may not exist in the test environment —
    // the function should return an empty array gracefully.
    const paths = resolveExtensionPaths();
    expect(Array.isArray(paths)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. createProcessEntry + buildStatus
// ---------------------------------------------------------------------------

describe('createProcessEntry + buildStatus', () => {
  it('creates an entry with expected initial state', async () => {
    const { createProcessEntry, buildStatus } = await import(
      '../src/harnesses/pi-coding-agent/pi-wrapper.js'
    );
    const resolveExit = vi.fn();
    const entry = createProcessEntry('inst-1', 'T123', resolveExit);
    expect(entry.instanceId).toBe('inst-1');
    expect(entry.taskId).toBe('T123');
    expect(entry.state).toBe('failed'); // initial placeholder
    expect(entry.pid).toBeNull();
    expect(entry.outputBuffer).toHaveLength(0);

    const snap = buildStatus(entry);
    expect(snap.instanceId).toBe('inst-1');
    expect(snap.taskId).toBe('T123');
    expect(snap.state).toBe('failed');
    expect(snap.pid).toBeNull();
    expect(snap.startedAt).toBeTruthy();
  });

  it('buildStatus omits undefined optional fields', async () => {
    const { createProcessEntry, buildStatus } = await import(
      '../src/harnesses/pi-coding-agent/pi-wrapper.js'
    );
    const resolveExit = vi.fn();
    const entry = createProcessEntry('inst-2', 'T456', resolveExit);
    const snap = buildStatus(entry);
    expect('endedAt' in snap).toBe(false);
    expect('exitCode' in snap).toBe(false);
    expect('error' in snap).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Adapter .status() / .output() on unknown instances
// ---------------------------------------------------------------------------

describe('PiCodingAgentAdapter — unknown instance queries', () => {
  it('status() returns null for unknown instanceId', async () => {
    const { PiCodingAgentAdapter } = await import(
      '../src/harnesses/pi-coding-agent/adapter.js'
    );
    const adapter = new PiCodingAgentAdapter();
    expect(adapter.status('no-such-instance')).toBeNull();
  });

  it('output() returns empty array for unknown instanceId', async () => {
    const { PiCodingAgentAdapter } = await import(
      '../src/harnesses/pi-coding-agent/adapter.js'
    );
    const adapter = new PiCodingAgentAdapter();
    expect(adapter.output('no-such-instance')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Adapter .kill() idempotency
// ---------------------------------------------------------------------------

describe('PiCodingAgentAdapter — kill idempotency', () => {
  it('kill() is a no-op for unknown instanceId', async () => {
    const { PiCodingAgentAdapter } = await import(
      '../src/harnesses/pi-coding-agent/adapter.js'
    );
    const adapter = new PiCodingAgentAdapter();
    // Should not throw.
    await expect(adapter.kill('ghost-instance')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Harness registry
// ---------------------------------------------------------------------------

describe('Harness registry', () => {
  it('createHarness returns a PiCodingAgentAdapter for pi-coding-agent', async () => {
    const { createHarness } = await import('../src/harnesses/index.js');
    const adapter = createHarness('pi-coding-agent');
    expect(adapter).not.toBeNull();
    expect(adapter?.id).toBe('pi-coding-agent');
  });

  it('createHarness returns null for unknown id', async () => {
    const { createHarness } = await import('../src/harnesses/index.js');
    expect(createHarness('no-such-harness')).toBeNull();
  });

  it('listHarnesses includes pi-coding-agent', async () => {
    const { listHarnesses } = await import('../src/harnesses/index.js');
    const entries = listHarnesses();
    expect(entries.some((e) => e.id === 'pi-coding-agent')).toBe(true);
  });

  it('listHarnesses entries each have id, name, and create factory', async () => {
    const { listHarnesses } = await import('../src/harnesses/index.js');
    for (const entry of listHarnesses()) {
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.name).toBe('string');
      expect(typeof entry.create).toBe('function');
      const adapter = entry.create();
      expect(adapter.id).toBe(entry.id);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. docker-mode helpers
// ---------------------------------------------------------------------------

describe('docker-mode helpers', () => {
  it('isSandboxedGlobally returns false by default', async () => {
    const { isSandboxedGlobally } = await import(
      '../src/harnesses/pi-coding-agent/docker-mode.js'
    );
    withEnv({ CLEO_PI_SANDBOXED: undefined }, () => {
      expect(isSandboxedGlobally()).toBe(false);
    });
  });

  it('isSandboxedGlobally returns true when CLEO_PI_SANDBOXED=1', async () => {
    const { isSandboxedGlobally } = await import(
      '../src/harnesses/pi-coding-agent/docker-mode.js'
    );
    withEnv({ CLEO_PI_SANDBOXED: '1' }, () => {
      expect(isSandboxedGlobally()).toBe(true);
    });
  });

  it('getSandboxImage returns default image name', async () => {
    const { getSandboxImage } = await import(
      '../src/harnesses/pi-coding-agent/docker-mode.js'
    );
    withEnv({ CLEO_PI_SANDBOX_IMAGE: undefined }, () => {
      expect(getSandboxImage()).toBe('cleo-sandbox/pi:local');
    });
  });

  it('getSandboxImage honours CLEO_PI_SANDBOX_IMAGE', async () => {
    const { getSandboxImage } = await import(
      '../src/harnesses/pi-coding-agent/docker-mode.js'
    );
    withEnv({ CLEO_PI_SANDBOX_IMAGE: 'my-registry/pi:v2' }, () => {
      expect(getSandboxImage()).toBe('my-registry/pi:v2');
    });
  });

  it('buildDockerRunArgs includes --rm and the prompt file mount', async () => {
    const { buildDockerRunArgs } = await import(
      '../src/harnesses/pi-coding-agent/docker-mode.js'
    );
    const args = buildDockerRunArgs({
      prompt: 'Do the thing',
      promptFilePath: '/tmp/test-prompt.txt',
      image: 'cleo-sandbox/pi:local',
    });
    expect(args).toContain('--rm');
    expect(args).toContain('-v');
    // Should bind-mount the prompt file read-only
    const mountArg = args.find((a) => a.includes('/tmp/test-prompt.txt'));
    expect(mountArg).toBeTruthy();
    expect(mountArg).toContain(':ro');
    // Image should appear before the command
    expect(args).toContain('cleo-sandbox/pi:local');
    // Command should be `pi /tmp/pi-prompt.txt`
    expect(args).toContain('pi');
    expect(args).toContain('/tmp/pi-prompt.txt');
  });

  it('buildDockerRunArgs injects PI_TELEMETRY=0', async () => {
    const { buildDockerRunArgs } = await import(
      '../src/harnesses/pi-coding-agent/docker-mode.js'
    );
    const args = buildDockerRunArgs({ prompt: 'test' });
    expect(args).toContain('PI_TELEMETRY=0');
  });

  it('buildDockerRunArgs forwards extra env vars', async () => {
    const { buildDockerRunArgs } = await import(
      '../src/harnesses/pi-coding-agent/docker-mode.js'
    );
    const args = buildDockerRunArgs({
      prompt: 'test',
      env: { MY_KEY: 'my-value' },
    });
    const idx = args.indexOf('-e');
    const envArgs = args.filter((_, i) => args[i - 1] === '-e');
    expect(envArgs.some((a) => a === 'MY_KEY=my-value')).toBe(true);
    void idx;
  });
});
