/**
 * Agent-session leases (T14133): a packet spawn's lease counts against the
 * `agent-session` budget until its session ends, it is released, or it
 * expires. Leases live under a per-test CLEO_HOME.
 *
 * @task T14133
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_LEASE_MAX_LIFETIME_MS,
  type AgentSessionLease,
  liveAgentLeases,
  onSessionStatusWritten,
  releaseAgentLease,
  releaseAgentLeasesForSession,
  renewAgentLeasesForSession,
  writeAgentLease,
} from '../agent-lease.js';
import type { ResourceSample } from '../backend.js';
import {
  _resetGovernorStateForTest,
  ResourceGovernor,
  takeAgentSessionLease,
} from '../governor.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** A calm host with room for exactly three 4 GiB agent sessions above the 2 GiB headroom. */
const SAMPLE: ResourceSample = {
  sampledAtMs: 1,
  pressureAvailable: true,
  memAvailableBytes: 2048 * MB + 3 * 4096 * MB,
  globalPressure: {
    some: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
    full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
  },
  slicePressure: null,
  walObservations: [],
};
const OPTS = { sample: SAMPLE, cpuCount: 16, totalMemBytes: 64 * GB } as const;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cleo-agent-lease-'));
  vi.stubEnv('CLEO_HOME', home);
  vi.stubEnv('CLEO_RESOURCES_MODE', 'local');
  _resetGovernorStateForTest();
});
afterEach(() => {
  vi.unstubAllEnvs();
  _resetGovernorStateForTest();
  rmSync(home, { recursive: true, force: true });
});

const lease = (over: Partial<AgentSessionLease> = {}): AgentSessionLease => ({
  id: 'L1',
  taskId: 'T2374',
  projectRoot: home,
  sessionId: 'ses_spawned',
  takenAtMs: Date.now(),
  expiresAtMs: Date.now() + 60_000,
  ...over,
});

describe('agent-session leases (T14133)', () => {
  it('a live lease takes one slot of the agent-session budget', async () => {
    const g = new ResourceGovernor();
    expect(await g.available('agent-session', OPTS)).toBe(3);
    writeAgentLease(lease());
    expect(await g.available('agent-session', OPTS)).toBe(2);
  });

  it('an expired lease frees its slot and its file is removed', async () => {
    const g = new ResourceGovernor();
    writeAgentLease(lease({ id: 'old', expiresAtMs: Date.now() - 1 }));
    expect(await g.available('agent-session', OPTS)).toBe(3);
    expect(liveAgentLeases()).toEqual([]);
  });

  it("the session's end releases its leases; release by id is idempotent", () => {
    writeAgentLease(lease({ id: 'a' }));
    writeAgentLease(lease({ id: 'b', sessionId: 'ses_other' }));
    expect(releaseAgentLeasesForSession('ses_spawned')).toBe(1);
    expect(liveAgentLeases().map((l) => l.id)).toEqual(['b']);
    releaseAgentLease('b');
    releaseAgentLease('b');
    expect(liveAgentLeases()).toEqual([]);
  });

  it("the session's heartbeat extends its lease, never shortens it", () => {
    const now = Date.now();
    writeAgentLease(lease({ expiresAtMs: now + 1_000 }));
    expect(renewAgentLeasesForSession('ses_spawned', now + 120_000)).toBe(1);
    expect(liveAgentLeases()[0]?.expiresAtMs).toBe(now + 120_000);
    expect(renewAgentLeasesForSession('ses_spawned', now + 5_000)).toBe(0);
    expect(renewAgentLeasesForSession('ses_unknown', now + 120_000)).toBe(0);
  });

  it('takeAgentSessionLease defers once leases hold the whole budget, with nothing written', async () => {
    for (const id of ['x', 'y', 'z']) writeAgentLease(lease({ id }));
    const g = new ResourceGovernor();
    expect(await g.available('agent-session', OPTS)).toBe(0);
    const taken = await takeAgentSessionLease('T1', home, 60_000, OPTS);
    expect('deferral' in taken && taken.deferral.reason).toMatch(
      /3 spawned session lease\(s\) hold the budget of 3/,
    );
    expect(liveAgentLeases()).toHaveLength(3);
    releaseAgentLease('z');
    const second = await takeAgentSessionLease('T1', home, 60_000, OPTS);
    expect('lease' in second && second.lease?.taskId).toBe('T1');
    expect(liveAgentLeases()).toHaveLength(3);
  });

  it("a resume reuses its task's live lease: no second slot, never refused by its own lease", async () => {
    const now = Date.now();
    writeAgentLease(lease({ id: 'mine', taskId: 'T2374', expiresAtMs: now + 1_000 }));
    writeAgentLease(lease({ id: 'other1', taskId: 'T2294', sessionId: 'ses_2' }));
    writeAgentLease(lease({ id: 'other2', taskId: 'T2295', sessionId: 'ses_3' }));
    const g = new ResourceGovernor();
    expect(await g.available('agent-session', OPTS)).toBe(0); // the budget of 3 is full
    const taken = await takeAgentSessionLease('T2374', home, 60_000, OPTS);
    if (!('lease' in taken)) throw new Error(`refused: ${taken.deferral.reason}`);
    expect(taken.reused).toBe(true);
    expect(taken.lease?.id).toBe('mine');
    expect(taken.lease?.expiresAtMs).toBeGreaterThanOrEqual(now + 60_000);
    expect(liveAgentLeases()).toHaveLength(3);
    // The same task in another project is a different spawn, refused while full.
    const elsewhere = await takeAgentSessionLease('T2374', tmpdir(), 60_000, OPTS);
    expect('deferral' in elsewhere).toBe(true);
  });

  it('two concurrent takes on the one free slot: exactly one lease is written', async () => {
    writeAgentLease(lease({ id: 'a', taskId: 'TA' }));
    writeAgentLease(lease({ id: 'b', taskId: 'TB' }));
    const [one, two] = await Promise.all([
      takeAgentSessionLease('T1', home, 60_000, OPTS),
      takeAgentSessionLease('T2', home, 60_000, OPTS),
    ]);
    expect([one, two].filter((r) => 'lease' in r && r.lease !== null)).toHaveLength(1);
    expect([one, two].filter((r) => 'deferral' in r)).toHaveLength(1);
    expect(liveAgentLeases()).toHaveLength(3);
  });

  it('any session-status write that ends a session releases its leases; active keeps them', () => {
    writeAgentLease(lease());
    onSessionStatusWritten('ses_spawned', 'active');
    expect(liveAgentLeases()).toHaveLength(1);
    onSessionStatusWritten('ses_spawned', 'ended');
    expect(liveAgentLeases()).toEqual([]);
  });

  it('a lease never outlives its hard cap, however it is renewed', () => {
    const now = Date.now();
    const taken = now - AGENT_LEASE_MAX_LIFETIME_MS + 1_000;
    writeAgentLease(lease({ takenAtMs: taken, expiresAtMs: now + 1_000 }));
    expect(renewAgentLeasesForSession('ses_spawned', now + 3_600_000)).toBe(0);
    writeAgentLease(
      lease({ takenAtMs: now - AGENT_LEASE_MAX_LIFETIME_MS - 1, expiresAtMs: now + 3_600_000 }),
    );
    expect(liveAgentLeases(now)).toEqual([]);
  });

  it('a lease whose project root is gone no longer counts; an unreadable root still does (T14154)', async () => {
    const gone = mkdtempSync(join(tmpdir(), 'cleo-lease-root-'));
    writeAgentLease(lease({ id: 'gone', projectRoot: gone }));
    writeAgentLease(lease({ id: 'kept' }));
    const g = new ResourceGovernor();
    expect(await g.available('agent-session', OPTS)).toBe(1);
    rmSync(gone, { recursive: true, force: true });
    expect(await g.available('agent-session', OPTS)).toBe(2);
    expect(liveAgentLeases().map((l) => l.id)).toEqual(['kept']);
    // An empty or relative root cannot be checked: the lease is kept.
    writeAgentLease(lease({ id: 'empty', projectRoot: '' }));
    writeAgentLease(lease({ id: 'relative', projectRoot: 'no-such-relative-dir' }));
    expect(
      liveAgentLeases()
        .map((l) => l.id)
        .sort(),
    ).toEqual(['empty', 'kept', 'relative']);
    releaseAgentLease('empty');
    releaseAgentLease('relative');
    // Only ENOENT is death: a root behind a permission error keeps its lease.
    const locked = mkdtempSync(join(tmpdir(), 'cleo-lease-locked-'));
    const inner = join(locked, 'project');
    mkdirSync(inner);
    writeAgentLease(lease({ id: 'eacces', projectRoot: inner }));
    chmodSync(locked, 0o000);
    try {
      if (process.getuid?.() !== 0) {
        expect(
          liveAgentLeases()
            .map((l) => l.id)
            .sort(),
        ).toEqual(['eacces', 'kept']);
      }
    } finally {
      chmodSync(locked, 0o700);
      rmSync(locked, { recursive: true, force: true });
    }
  });
});
