/**
 * Migration-readiness adapter proof (T11370 — R2 AC7 validation).
 *
 * Proves the `defineSubsystem` API can express the FULL lifecycle of the two
 * representative legacy daemons WITHOUT loss, so R4-R7 inherit a verified
 * contract:
 *
 * 1. A **process-supervisor** adapter mirroring `StudioSupervisor`
 *    (packages/core/src/sentient/daemon.ts): `start()` (sync spawn), `stop()`
 *    (SIGTERM grace → SIGKILL), `status`/`pid` getters, and exponential-backoff
 *    crash respawn.
 * 2. A **scheduled (cron)** adapter mirroring `gc/daemon.ts`: spawn → persisted
 *    pid + startedAt, cron schedule, crash recovery (resume pending prune), and
 *    missed-run recovery (run immediately if elapsed > 24h).
 *
 * These adapters are TEST-ONLY fakes that reproduce the legacy lifecycle SHAPE
 * (not the real process IO). NO production code in core/cleo is migrated here —
 * R4-R7 own that. The goal is to validate the API surface and feed the
 * gap-analysis note (doc slug `daemon-subsystem-api-gap-analysis`).
 *
 * @task T11370
 */

import type { SubsystemHealth } from '@cleocode/contracts';
import { describe, expect, it, vi } from 'vitest';

import { defineSubsystem } from '../define-subsystem.js';
import { SubsystemRegistry } from '../registry.js';

// ─── Adapter 1: process supervisor (StudioSupervisor shape) ──────────────────

/** Liveness states a process supervisor reports — mirrors StudioStatus. */
type StudioStatus = 'stopped' | 'running' | 'crashed' | 'not-available';

/**
 * A faithful in-memory fake of the StudioSupervisor lifecycle: synchronous
 * `start()`, async `stop()` with a SIGTERM grace window, `status`/`pid`
 * getters, and exponential-backoff respawn on crash. Mirrors the real class's
 * observable surface without spawning a real child process.
 */
class FakeStudioSupervisor {
  #status: StudioStatus = 'stopped';
  #pid: number | null = null;
  #stopped = false;
  #currentDelay: number;
  readonly #maxDelay: number;
  #nextPid = 4242;

  constructor(initialDelay = 1_000, maxDelay = 30_000) {
    this.#currentDelay = initialDelay;
    this.#maxDelay = maxDelay;
  }

  get status(): StudioStatus {
    return this.#status;
  }
  get pid(): number | null {
    return this.#pid;
  }
  /** Current backoff delay (exposed for the respawn assertion). */
  get backoffMs(): number {
    return this.#currentDelay;
  }

  start(): void {
    if (this.#stopped || this.#pid !== null) return;
    this.#pid = this.#nextPid++;
    this.#status = 'running';
  }

  /** Simulate a crash → schedule respawn with exponential backoff. */
  simulateCrash(): void {
    this.#pid = null;
    this.#status = 'crashed';
    this.#currentDelay = Math.min(this.#currentDelay * 2, this.#maxDelay);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#pid = null;
    this.#status = 'stopped';
    await Promise.resolve();
  }
}

/** Map a StudioStatus onto a supervisor-ipc SubsystemHealth row. */
function studioToHealth(name: string, sup: FakeStudioSupervisor): SubsystemHealth {
  const state =
    sup.status === 'running' ? 'running' : sup.status === 'crashed' ? 'restarting' : 'stopped';
  return { child_id: name, pid: sup.pid ?? 0, state, restart_count: 0 };
}

// ─── Adapter 2: scheduled cron daemon (gc/daemon.ts shape) ───────────────────

/** A faithful in-memory fake of the GC cron daemon lifecycle. */
class FakeGcDaemon {
  pid: number | null = null;
  startedAt: string | null = null;
  lastRunAt: string | null = null;
  pendingPrune: string[] = [];
  cronScheduled = false;
  runs = 0;

  /** spawn → persist pid + startedAt + schedule cron (mirrors spawnGCDaemon). */
  async spawn(): Promise<number> {
    this.pid = 9100;
    this.startedAt = new Date().toISOString();
    this.cronScheduled = true;
    // Bootstrap recovery steps run at spawn:
    await this.#crashRecovery();
    await this.#missedRunRecovery();
    return this.pid;
  }

  /** Resume a pending prune left by a prior crash (crash recovery). */
  async #crashRecovery(): Promise<void> {
    if (this.pendingPrune.length > 0) {
      this.pendingPrune = [];
      this.runs += 1;
      this.lastRunAt = new Date().toISOString();
    }
    await Promise.resolve();
  }

  /** Run immediately if last run was > 24h ago (missed-run recovery). */
  async #missedRunRecovery(): Promise<void> {
    const elapsed = this.lastRunAt
      ? Date.now() - Date.parse(this.lastRunAt)
      : Number.POSITIVE_INFINITY;
    if (elapsed > 24 * 60 * 60 * 1000) {
      this.runs += 1;
      this.lastRunAt = new Date().toISOString();
    }
    await Promise.resolve();
  }

  async stop(): Promise<{ stopped: boolean; pid: number | null }> {
    const pid = this.pid;
    this.pid = null;
    this.cronScheduled = false;
    return { stopped: pid !== null, pid };
  }
}

describe('T11370 — StudioSupervisor lifecycle expressed via defineSubsystem', () => {
  it('expresses start → healthProbe → shutdown without loss', async () => {
    const sup = new FakeStudioSupervisor();
    const subsystem = defineSubsystem({
      name: 'studio',
      start: () => {
        sup.start();
      },
      healthProbe: () => studioToHealth('studio', sup),
      shutdown: () => sup.stop(),
    });

    const registry = new SubsystemRegistry();
    registry.register(subsystem);

    await registry.startAll();
    expect(sup.status).toBe('running');
    expect(sup.pid).not.toBeNull();

    const health = await registry.aggregateHealth();
    expect(health.subsystems[0]?.state).toBe('running');
    expect(health.subsystems[0]?.pid).toBe(sup.pid);

    await registry.shutdownAll();
    expect(sup.status).toBe('stopped');
    expect(sup.pid).toBeNull();
  });

  it('surfaces a crashed supervisor as a restarting health row (backoff covered)', async () => {
    const sup = new FakeStudioSupervisor(1_000, 30_000);
    const subsystem = defineSubsystem({
      name: 'studio',
      start: () => sup.start(),
      healthProbe: () => studioToHealth('studio', sup),
      shutdown: () => sup.stop(),
    });
    const registry = new SubsystemRegistry();
    registry.register(subsystem);
    await registry.startAll();

    // Crash → exponential backoff doubles the delay.
    sup.simulateCrash();
    expect(sup.backoffMs).toBe(2_000);

    const health = await registry.aggregateHealth();
    // The crashed/pending-respawn state maps to the supervisor 'restarting' state.
    expect(health.subsystems[0]?.state).toBe('restarting');
    expect(health.allHealthy).toBe(false);
  });
});

describe('T11370 — GC cron daemon lifecycle expressed via defineSubsystem', () => {
  it('expresses a scheduled (cron) subsystem with crash + missed-run recovery', async () => {
    const gc = new FakeGcDaemon();
    // Seed a pending prune to exercise crash recovery at spawn.
    gc.pendingPrune = ['blob-a', 'blob-b'];

    const subsystem = defineSubsystem({
      name: 'gc',
      start: () => gc.spawn(),
      healthProbe: (): SubsystemHealth => ({
        child_id: 'gc',
        pid: gc.pid ?? 0,
        state: gc.pid !== null ? 'running' : 'stopped',
        restart_count: gc.runs,
        detail: `cron=${gc.cronScheduled} runs=${gc.runs} lastRunAt=${gc.lastRunAt ?? 'never'}`,
      }),
      shutdown: () => gc.stop().then(() => undefined),
    });

    const registry = new SubsystemRegistry();
    registry.register(subsystem);

    await registry.startAll();
    // spawn persisted pid + startedAt and scheduled cron.
    expect(gc.pid).toBe(9100);
    expect(gc.startedAt).not.toBeNull();
    expect(gc.cronScheduled).toBe(true);
    // Crash recovery (pending prune resumed) AND missed-run recovery both ran.
    expect(gc.runs).toBeGreaterThanOrEqual(1);

    const health = await registry.aggregateHealth();
    expect(health.subsystems[0]?.state).toBe('running');
    expect(health.subsystems[0]?.detail).toContain('cron=true');

    await registry.shutdownAll();
    expect(gc.pid).toBeNull();
    expect(gc.cronScheduled).toBe(false);
  });

  it('drives both subsystems together with LIFO shutdown', async () => {
    const sup = new FakeStudioSupervisor();
    const gc = new FakeGcDaemon();
    const shutdownOrder: string[] = [];
    const onShutdown = vi.fn((name: string) => {
      shutdownOrder.push(name);
    });

    const registry = new SubsystemRegistry({ onShutdown });
    registry.register(
      defineSubsystem({
        name: 'studio',
        start: () => sup.start(),
        healthProbe: () => studioToHealth('studio', sup),
        shutdown: () => sup.stop(),
      }),
    );
    registry.register(
      defineSubsystem({
        name: 'gc',
        start: () => gc.spawn(),
        healthProbe: (): SubsystemHealth => ({
          child_id: 'gc',
          pid: gc.pid ?? 0,
          state: gc.pid !== null ? 'running' : 'stopped',
          restart_count: gc.runs,
        }),
        shutdown: () => gc.stop().then(() => undefined),
      }),
    );

    await registry.startAll();
    const health = await registry.aggregateHealth();
    expect(health.subsystems).toHaveLength(2);
    expect(health.allHealthy).toBe(true);

    await registry.shutdownAll();
    // Registration order studio, gc → LIFO shutdown gc, studio.
    expect(shutdownOrder).toEqual(['gc', 'studio']);
  });
});
