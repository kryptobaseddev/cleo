/**
 * Agent-session leases (T14133): a packet spawn's lease counts against the
 * `agent-session` budget until its session ends, it is released, or it
 * expires. Leases live under a per-test CLEO_HOME.
 *
 * @task T14133
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_LEASE_MAX_LIFETIME_MS,
  type AgentSessionLease,
  liveAgentLeases,
  releaseAgentLease,
  releaseAgentLeasesForSession,
  releaseAgentLeasesForSessions,
  renewAgentLeasesForSession,
  writeAgentLease,
} from '../agent-lease.js';
import type { ResourceSample } from '../backend.js';
import {
  _resetAgentSessionConfigNoteForTest,
  _resetGovernorStateForTest,
  agentSessionBudgetConfig,
  computeClassBudget,
  ResourceGovernor,
  takeAgentSessionLease,
} from '../governor.js';
import { externalPressureFix } from '../pressure-gate.js';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** A calm host. */
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
/** A budget of three spawned sessions (T14283: a lease count, set by maxSessions). */
const OPTS = { sample: SAMPLE, cpuCount: 16, totalMemBytes: 64 * GB, agentMaxSessions: 3 } as const;

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

  it('releases the leases of several ended sessions in one scan', () => {
    writeAgentLease(lease({ id: 'a', sessionId: 'ses_a' }));
    writeAgentLease(lease({ id: 'b', sessionId: 'ses_b' }));
    writeAgentLease(lease({ id: 'c', sessionId: 'ses_c' }));
    expect(releaseAgentLeasesForSessions(new Set(['ses_a', 'ses_c', 'ses_none']))).toBe(2);
    expect(liveAgentLeases().map((l) => l.id)).toEqual(['b']);
    expect(releaseAgentLeasesForSessions(new Set())).toBe(0);
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

describe('the agent-session budget is a lease count; only critical memory vetoes (T14227, T14283)', () => {
  const GIB = GB;
  /** 30 GB held by programs outside CLEO: little free memory, but no hard danger. */
  const SQUEEZED: ResourceSample = { ...SAMPLE, memAvailableBytes: 2 * GIB };
  const CRITICAL: ResourceSample = {
    ...SAMPLE,
    globalPressure: {
      some: { avg10: 40, avg60: 40, avg300: 40, totalUs: 0 },
      full: { avg10: 12, avg60: 12, avg300: 12, totalUs: 0 },
    },
  };
  const SWAP_HEAVY: ResourceSample = {
    ...SAMPLE,
    memAvailableBytes: 22.1 * GIB,
    darwinMemory: {
      pressureLevel: 1,
      availablePercent: 52,
      compressorBytes: 20.5 * GIB,
      reclaimableBytes: 20.6 * GIB,
      swapUsedBytes: 8.2 * GIB,
      swapTotalBytes: 9 * GIB,
      totalBytes: 48 * GIB,
    },
  };

  it.each([
    {
      pressureLevel: 1,
      reclaimableBytes: 64 * MB,
      availableBytes: 64 * MB,
      criterion: 'kernel level normal',
    },
    {
      pressureLevel: 1,
      reclaimableBytes: 64 * MB,
      availableBytes: 22.1 * GIB,
      criterion: 'kernel level normal',
    },
    {
      pressureLevel: null,
      reclaimableBytes: 20.6 * GIB,
      availableBytes: 22.1 * GIB,
      criterion: 'kernel level UNKNOWN',
    },
    {
      pressureLevel: null,
      reclaimableBytes: null,
      availableBytes: null,
      criterion: 'kernel level UNKNOWN',
      pressureAvailable: false,
    },
    {
      pressureLevel: 1,
      reclaimableBytes: null,
      availableBytes: null,
      criterion: 'kernel level normal',
    },
    {
      pressureLevel: 1,
      reclaimableBytes: null,
      availableBytes: 64 * MB,
      criterion: 'kernel level normal',
    },
  ])('refuses full swap without proven normal-kernel headroom: $pressureLevel/$reclaimableBytes/$availableBytes', async ({
    pressureLevel,
    reclaimableBytes,
    availableBytes,
    criterion,
    pressureAvailable = true,
  }) => {
    if (!SWAP_HEAVY.darwinMemory) throw new Error('expected darwin signals');
    const taken = await takeAgentSessionLease('T1', home, 60_000, {
      ...OPTS,
      sample: {
        ...SWAP_HEAVY,
        pressureAvailable,
        globalPressure: pressureAvailable ? SWAP_HEAVY.globalPressure : null,
        memAvailableBytes: availableBytes,
        darwinMemory: {
          ...SWAP_HEAVY.darwinMemory,
          pressureLevel,
          reclaimableBytes,
          swapUsedBytes: 8.91 * GIB,
        },
      },
      topMemory: () => [],
    });
    if (!('deferral' in taken) || !taken.externalPressure)
      throw new Error('expected memory deferral');
    expect(taken.deferral.reason).toContain('99.0%) is at or above 90%');
    expect(taken.deferral.reason).toContain(criterion);
    expect(taken.deferral.reason).toContain('ample headroom threshold 12.0 GiB');
    expect(externalPressureFix(taken.externalPressure)).toContain(criterion);
    expect(liveAgentLeases()).toEqual([]);
  });

  it.each([
    { reclaimableBytes: 12 * GIB, availableBytes: 64 * MB, admitted: true },
    { reclaimableBytes: 12 * GIB - 1, availableBytes: 64 * MB, admitted: false },
    { reclaimableBytes: null, availableBytes: 12 * GIB, admitted: true },
    { reclaimableBytes: null, availableBytes: 12 * GIB - 1, admitted: false },
  ])('normal-kernel swap exemption requires the headroom floor: $reclaimableBytes/$availableBytes', async ({
    reclaimableBytes,
    availableBytes,
    admitted,
  }) => {
    if (!SWAP_HEAVY.darwinMemory) throw new Error('expected darwin signals');
    const taken = await takeAgentSessionLease('T1', home, 60_000, {
      ...OPTS,
      sample: {
        ...SWAP_HEAVY,
        memAvailableBytes: availableBytes,
        darwinMemory: { ...SWAP_HEAVY.darwinMemory, reclaimableBytes },
      },
      topMemory: () => [],
    });
    expect('lease' in taken).toBe(admitted);
    expect(liveAgentLeases()).toHaveLength(admitted ? 1 : 0);
  });

  it.each([
    0, 3.8, 8.9,
  ])('admits old swap at normal kernel pressure with score %s and ample headroom (T14530)', async (score) => {
    const sample: ResourceSample = {
      ...SWAP_HEAVY,
      globalPressure: {
        some: { avg10: score, avg60: score, avg300: score, totalUs: 0 },
        full: { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 },
      },
    };
    const topMemory = vi.fn(() => []);
    const taken = await takeAgentSessionLease('T1', home, 60_000, {
      ...OPTS,
      sample,
      topMemory,
    });
    expect('lease' in taken && taken.lease?.taskId).toBe('T1');
    expect(liveAgentLeases()).toHaveLength(1);
    expect(topMemory).not.toHaveBeenCalled();
  });

  it.each([
    { pressureLevel: 4, criterion: 'kernel memory pressure level 4 (critical), threshold 4' },
    {
      pressureLevel: 2,
      criterion: 'swap use 8.2 GiB of 9.0 GiB (91.1%) is at or above 90% with kernel level warning',
    },
  ])('names the critical criterion at kernel level $pressureLevel (T14530)', async ({
    pressureLevel,
    criterion,
  }) => {
    if (!SWAP_HEAVY.darwinMemory) throw new Error('expected darwin signals');
    const taken = await takeAgentSessionLease('T1', home, 60_000, {
      ...OPTS,
      sample: {
        ...SWAP_HEAVY,
        darwinMemory: { ...SWAP_HEAVY.darwinMemory, pressureLevel },
      },
      topMemory: () => [],
    });
    if (!('deferral' in taken) || !taken.externalPressure)
      throw new Error('expected memory deferral');
    expect(taken.deferral.reason).toContain(criterion);
    expect(externalPressureFix(taken.externalPressure)).toContain(criterion);
    expect(taken.deferral.reason).not.toContain('pressure 0 stayed above 25');
    expect(liveAgentLeases()).toEqual([]);
  });

  it('with 30 GB held outside CLEO and no hard danger, 4 spawns succeed when maxSessions = 4', async () => {
    const opts = { sample: SQUEEZED, cpuCount: 16, totalMemBytes: 64 * GB, agentMaxSessions: 4 };
    expect(computeClassBudget('agent-session', SQUEEZED, opts)).toBe(4);
    for (const id of ['T1', 'T2', 'T3', 'T4']) {
      const taken = await takeAgentSessionLease(id, home, 60_000, opts);
      if (!('lease' in taken)) throw new Error(`refused ${id}: ${taken.deferral.reason}`);
    }
    expect(liveAgentLeases()).toHaveLength(4);
    const fifth = await takeAgentSessionLease('T5', home, 60_000, opts);
    if (!('deferral' in fifth)) throw new Error('a fifth lease was admitted');
    expect(fifth.externalPressure).toBeUndefined();
    // The refusal names the one key that raises the budget.
    expect(fifth.deferral.reason).toContain('resources.agentSession.maxSessions (now 4)');
    expect(fifth.deferral.reason).not.toContain('estRamMb');
  });

  it('unset, the budget is cpus - 2 whatever the free memory', () => {
    const opts = { sample: SQUEEZED, cpuCount: 16, totalMemBytes: 64 * GB };
    expect(computeClassBudget('agent-session', SQUEEZED, opts)).toBe(14);
    expect(computeClassBudget('agent-session', SAMPLE, { ...opts, cpuCount: 2 })).toBe(1);
  });

  it('under critical memory a spawn defers with the external-pressure details, nothing written', async () => {
    const taken = await takeAgentSessionLease('T1', home, 60_000, {
      ...OPTS,
      sample: CRITICAL,
      topMemory: () => [{ pid: 4242, command: 'codex', footprintBytes: 13 * GIB }],
    });
    if (!('deferral' in taken)) throw new Error('expected a deferral');
    expect(taken.externalPressure?.topProcesses).toEqual([
      { pid: 4242, command: 'codex', rssBytes: 13 * GIB },
    ]);
    expect(taken.externalPressure?.expectedAdmitAt).toBeNull();
    expect(taken.deferral.reason).toContain('memory is critical');
    expect(taken.deferral.reason).toContain('memory full avg10 12 is above 10');
    expect(liveAgentLeases()).toEqual([]);
  });

  it('maxSessions is read from config; estRamMb and headroomMb are ignored with one deprecation note', async () => {
    const project = mkdtempSync(join(tmpdir(), 'cleo-agent-budget-'));
    _resetAgentSessionConfigNoteForTest();
    try {
      mkdirSync(join(project, '.cleo'), { recursive: true });
      const notes: string[] = [];
      const note = (l: string) => notes.push(l);
      expect(await agentSessionBudgetConfig(project, note)).toEqual({});
      const config = (resources: object) =>
        writeFileSync(join(project, '.cleo', 'config.json'), JSON.stringify({ resources }));
      config({ agentSession: { maxSessions: 6, estRamMb: 2048, headroomMb: 1024 } });
      expect(await agentSessionBudgetConfig(project, note)).toEqual({ agentMaxSessions: 6 });
      expect(await agentSessionBudgetConfig(project, note)).toEqual({ agentMaxSessions: 6 });
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain(
        'resources.agentSession.estRamMb and resources.agentSession.headroomMb are ignored',
      );
      config({ agentSession: { maxSessions: 0 } });
      expect(await agentSessionBudgetConfig(project, note)).toEqual({});
    } finally {
      _resetAgentSessionConfigNoteForTest();
      rmSync(project, { recursive: true, force: true });
    }
  });
});
