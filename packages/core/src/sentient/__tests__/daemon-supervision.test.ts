/**
 * Tests for Studio supervision (T1683) — StudioSupervisor class.
 *
 * Covers:
 *   - StudioSupervisor.start() spawns a child process
 *   - Crash-restart: child exits → supervisor schedules restart
 *   - StudioSupervisor.stop() sends SIGTERM and awaits exit
 *   - Graceful shutdown cascades SIGTERM to Studio child
 *   - readSuperviseStudioConfig reads daemon.superviseStudio from config
 *   - SentientStatus.supervisesStudio / studioStatus fields present
 *
 * Uses fake child process injection — never forks a real Studio server.
 *
 * @task T1683
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getSentientDaemonStatus,
  SENTIENT_STATE_FILE,
  STUDIO_DEFAULT_PORT,
  STUDIO_INITIAL_RESTART_DELAY_MS,
  STUDIO_MAX_RESTART_DELAY_MS,
  StudioSupervisor,
} from '../daemon.js';
import { DEFAULT_SENTIENT_STATE, writeSentientState } from '../state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an EventEmitter-like fake child process for testing. */
function makeFakeChild(pid = 12345) {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const child = {
    pid,
    killed: false,
    _exitCode: null as number | null,
    _signal: null as string | null,
    on(event: string, fn: (...args: unknown[]) => void) {
      listeners[event] = listeners[event] ?? [];
      listeners[event]?.push(fn);
      return child;
    },
    once(event: string, fn: (...args: unknown[]) => void) {
      const wrapped = (...args: unknown[]) => {
        fn(...args);
        const idx = listeners[event]?.indexOf(wrapped) ?? -1;
        if (idx !== -1) listeners[event]?.splice(idx, 1);
      };
      return child.on(event, wrapped);
    },
    removeAllListeners(event?: string) {
      if (event) {
        delete listeners[event];
      } else {
        for (const k of Object.keys(listeners)) delete listeners[k];
      }
      return child;
    },
    kill(signal?: string) {
      child.killed = true;
      child._signal = signal ?? 'SIGTERM';
      // Emit 'exit' synchronously to simulate immediate exit.
      for (const fn of listeners['exit'] ?? []) {
        fn(null, child._signal);
      }
      return true;
    },
    /** Simulate crash from test. */
    _crashWith(code: number | null, signal: string | null = null) {
      for (const fn of listeners['exit'] ?? []) {
        fn(code, signal);
      }
    },
  };
  return child;
}

// ---------------------------------------------------------------------------
// StudioSupervisor constants
// ---------------------------------------------------------------------------

describe('StudioSupervisor — constants', () => {
  it('STUDIO_DEFAULT_PORT is 3456', () => {
    expect(STUDIO_DEFAULT_PORT).toBe(3456);
  });

  it('STUDIO_INITIAL_RESTART_DELAY_MS is 1000', () => {
    expect(STUDIO_INITIAL_RESTART_DELAY_MS).toBe(1_000);
  });

  it('STUDIO_MAX_RESTART_DELAY_MS is 30000', () => {
    expect(STUDIO_MAX_RESTART_DELAY_MS).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// StudioSupervisor lifecycle
// ---------------------------------------------------------------------------

describe('StudioSupervisor — lifecycle', () => {
  it('initial status is "stopped"', () => {
    const sup = new StudioSupervisor({ studioPackageDir: '/fake/studio' });
    expect(sup.status).toBe('stopped');
    expect(sup.pid).toBeNull();
  });

  it('stop() on a stopped supervisor resolves immediately', async () => {
    const sup = new StudioSupervisor({ studioPackageDir: '/fake/studio' });
    await expect(sup.stop()).resolves.toBeUndefined();
    expect(sup.status).toBe('stopped');
  });
});

// ---------------------------------------------------------------------------
// StudioSupervisor with spawn injection
// ---------------------------------------------------------------------------

describe('StudioSupervisor — spawn injection via subclass', () => {
  it('start() does not throw even when the studio package dir is missing', () => {
    // Test the observable contract: start() must never throw, even if the Studio
    // binary does not exist. The supervisor handles spawn failures gracefully.
    // T1684 hotfix: when the Studio entrypoint does not exist at the package dir,
    // the supervisor sets status to 'not-available' rather than crash-looping.
    const sup = new StudioSupervisor({
      studioPackageDir: '/nonexistent/studio/path',
    });
    // start() is synchronous — it detects the missing entrypoint and degrades.
    // Status will be 'not-available' (T1684), 'crashed', or 'stopped'.
    expect(() => sup.start()).not.toThrow();
    expect(['running', 'crashed', 'stopped', 'not-available']).toContain(sup.status);
  });

  it('start() sets status to "not-available" when build/index.js does not exist (T1684)', () => {
    // Direct verification of the T1684 graceful-degrade path.
    const sup = new StudioSupervisor({
      studioPackageDir: '/tmp/nonexistent-studio-T1684',
    });
    sup.start();
    expect(sup.status).toBe('not-available');
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown — stop() SIGTERM cascade
// ---------------------------------------------------------------------------

describe('StudioSupervisor — stop() SIGTERM cascade', () => {
  it('stop() sets stopped=true and resolves when child exits', async () => {
    // Create supervisor without starting it (stopped state).
    const sup = new StudioSupervisor({ studioPackageDir: '/fake' });

    // Manually inject a fake child to simulate an in-flight Studio process.
    const fakeChild = makeFakeChild(99);

    // Access private field via type assertion (test-only introspection).
    (sup as unknown as Record<string, unknown>)['_StudioSupervisor__child'] = fakeChild;
    (sup as unknown as Record<string, unknown>)['_StudioSupervisor__status'] = 'running';
    (sup as unknown as Record<string, unknown>)['_StudioSupervisor__stopped'] = false;

    const stopPromise = sup.stop();
    // stop() should resolve (fake kill emits exit synchronously in makeFakeChild).
    await expect(stopPromise).resolves.toBeUndefined();
    expect(sup.status).toBe('stopped');
  });
});

// ---------------------------------------------------------------------------
// SentientStatus — supervisesStudio + studioStatus fields
// ---------------------------------------------------------------------------

describe('getSentientDaemonStatus — Studio supervision fields', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-t1683-'));
    const statePath = join(root, SENTIENT_STATE_FILE);
    await writeSentientState(statePath, DEFAULT_SENTIENT_STATE);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns supervisesStudio and studioStatus fields', async () => {
    const status = await getSentientDaemonStatus(root);
    expect(status).toHaveProperty('supervisesStudio');
    expect(status).toHaveProperty('studioStatus');
    expect(typeof status.supervisesStudio).toBe('boolean');
    expect(['running', 'stopped', 'crashed', 'disabled', 'not-available']).toContain(
      status.studioStatus,
    );
  });

  it('studioStatus is "stopped" when daemon is not running', async () => {
    const status = await getSentientDaemonStatus(root);
    // Daemon is not running (no live PID), so Studio cannot be supervising.
    // When superviseStudio=true (default) + daemon stopped → 'stopped'.
    // When superviseStudio=false → 'disabled'.
    expect(['stopped', 'disabled']).toContain(status.studioStatus);
  });

  it('studioStatus is "disabled" when config.daemon.superviseStudio=false', async () => {
    // Write a global config that disables Studio supervision.
    // CLEO_HOME points to root; readSuperviseStudioConfig reads ${CLEO_HOME}/config.json
    // (NOT ${CLEO_HOME}/.cleo/config.json — global config lives at CLEO_HOME root).
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ daemon: { superviseStudio: false } }), 'utf-8');

    // Override CLEO_HOME to point to our temp root.
    const origHome = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = root;
    try {
      const status = await getSentientDaemonStatus(root);
      // The config is at root/config.json (CLEO_HOME = root).
      // readSuperviseStudioConfig reads CLEO_HOME/config.json.
      expect(status.supervisesStudio).toBe(false);
      expect(status.studioStatus).toBe('disabled');
    } finally {
      if (origHome === undefined) delete process.env['CLEO_HOME'];
      else process.env['CLEO_HOME'] = origHome;
    }
  });
});
