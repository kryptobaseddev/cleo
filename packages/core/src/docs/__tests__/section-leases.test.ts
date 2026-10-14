/**
 * Local section lease manager — T13356.
 *
 * Semantics matched against llmtxt's LeaseManager (dist/leases.js, T285;
 * `llmtxt/leases` unreachable via the exports map, upstream #16): advisory
 * leases scoped to (slug, sectionId), acquire/release/renew, TTL bounded to
 * 1–300 s, 409 = social signal not a hard lock, auto-renew below a 10 s
 * threshold — plus T13356's session tie: renew/release are holder-session
 * only, and an expired lease is stale/overwritable.
 *
 * Covers: acquire/release/renew, TTL expiry + takeover, the advisory
 * conflict (two agents, second gets the conflict result — not an error),
 * holder-only renew/release, the llmtxt-identical throwing variant message,
 * TTL clamping, auto-renew with an injected clock, file-backed persistence
 * across manager instances, and session-death staleness.
 *
 * Run: `npx vitest run packages/core/src/docs/__tests__/section-leases.test.ts`
 *
 * @task T13356 (Epic T13340 / Saga T13339)
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RENEW_THRESHOLD_SECONDS,
  isStaleSectionLease,
  MAX_LEASE_TTL_SECONDS,
  MIN_LEASE_TTL_SECONDS,
  SectionLeaseConflictError,
  SectionLeaseManager,
} from '../section-leases.js';

let tempDir: string;
let nowMs: number;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-section-leases-'));
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  nowMs = Date.parse('2026-10-12T00:00:00.000Z');
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
});

/** A manager for the given session with the injected clock. */
function manager(sessionId: string, holder?: string): SectionLeaseManager {
  return new SectionLeaseManager(tempDir, {
    sessionId,
    ...(holder ? { holder } : {}),
    now: () => nowMs,
  });
}

describe('SectionLeaseManager acquire/release/renew (T13356)', () => {
  it('acquires a lease with llmtxt Lease identity (leaseId/holder/expiresAt) at the requested TTL', async () => {
    const m = manager('ses-a', 'agent-a');
    const result = await m.acquire('plan-doc', 's1', 60, 'editing section');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.lease.leaseId).toBeTruthy();
    expect(result.lease.holder).toBe('agent-a');
    expect(result.lease.sessionId).toBe('ses-a');
    expect(result.lease.reason).toBe('editing section');
    expect(result.lease.expiresAt).toBe('2026-10-12T00:01:00.000Z');
    expect(result.tookOverFrom).toBeUndefined();
  });

  it('second agent gets the advisory conflict (409 equivalent), not an error', async () => {
    const a = manager('ses-a', 'agent-a');
    const b = manager('ses-b', 'agent-b');
    const first = await a.acquire('plan-doc', 's1', 60);
    expect(first.ok).toBe(true);

    const second = await b.acquire('plan-doc', 's1', 60);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.conflict.holder).toBe('agent-a');
    expect(second.conflict.sessionId).toBe('ses-a');
    expect(second.conflict.expiresAt).toBe('2026-10-12T00:01:00.000Z');
    // The held lease stands untouched.
    const status = await b.status('plan-doc', 's1');
    expect(status?.holder).toBe('agent-a');
  });

  it('acquireOrThrow mirrors llmtxt LeaseConflictError byte-for-byte', async () => {
    const a = manager('ses-a', 'agent-a');
    await a.acquireOrThrow('plan-doc', 's1', 60);
    const b = manager('ses-b', 'agent-b');
    const attempt = b.acquireOrThrow('plan-doc', 's1', 60);
    await expect(attempt).rejects.toThrow(SectionLeaseConflictError);
    await expect(attempt).rejects.toThrow(
      'Section is already leased by agent-a until 2026-10-12T00:01:00.000Z',
    );
    try {
      await b.acquireOrThrow('plan-doc', 's1', 60);
    } catch (err) {
      expect(err).toBeInstanceOf(SectionLeaseConflictError);
      const conflict = err as SectionLeaseConflictError;
      expect(conflict.holder).toBe('agent-a');
      expect(conflict.expiresAt).toBe('2026-10-12T00:01:00.000Z');
    }
  });

  it('release is holder-session only; the freed section is acquirable by anyone', async () => {
    const a = manager('ses-a', 'agent-a');
    await a.acquire('plan-doc', 's1', 60);

    // A different session cannot release.
    const b = manager('ses-b', 'agent-b');
    expect(await b.release('plan-doc', 's1')).toBe(false);
    expect((await b.status('plan-doc', 's1'))?.holder).toBe('agent-a');

    // The holder can.
    expect(await a.release('plan-doc', 's1')).toBe(true);
    expect(await a.status('plan-doc', 's1')).toBeNull();

    const second = await b.acquire('plan-doc', 's1', 60);
    expect(second.ok).toBe(true);
  });

  it('renew extends the TTL from now; only the holder session can renew', async () => {
    const a = manager('ses-a', 'agent-a');
    await a.acquire('plan-doc', 's1', 60);

    // Advance 30 s: renew for another 60 s from the new now.
    nowMs += 30_000;
    const renewed = await a.renew('plan-doc', 's1', 60);
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) throw new Error('unreachable');
    expect(renewed.lease.expiresAt).toBe('2026-10-12T00:01:30.000Z');

    // Another session cannot renew a live lease it does not hold.
    const b = manager('ses-b', 'agent-b');
    const foreign = await b.renew('plan-doc', 's1', 60);
    expect(foreign.ok).toBe(false);
    if (foreign.ok || 'notHeld' in foreign) throw new Error('expected a conflict');
    expect(foreign.conflict.holder).toBe('agent-a');

    // Renewing a section nobody holds reports notHeld (llmtxt: "No active lease to renew").
    const none = await a.renew('plan-doc', 's9', 60);
    expect(none.ok).toBe(false);
    if (none.ok) throw new Error('unreachable');
    expect('notHeld' in none && none.notHeld).toBe(true);
  });

  it('TTL is clamped to llmtxt 1–300 s range', async () => {
    const m = manager('ses-a');
    const low = await m.acquire('doc', 's-low', 0);
    if (!low.ok) throw new Error('unreachable');
    expect(low.lease.expiresAt).toBe(new Date(nowMs + MIN_LEASE_TTL_SECONDS * 1000).toISOString());
    const high = await m.acquire('doc', 's-high', 9999);
    if (!high.ok) throw new Error('unreachable');
    expect(high.lease.expiresAt).toBe(new Date(nowMs + MAX_LEASE_TTL_SECONDS * 1000).toISOString());
  });

  it('leases are file-backed: a second manager instance sees them', async () => {
    const a = manager('ses-a', 'agent-a');
    await a.acquire('plan-doc', 's1', 60);
    const b = manager('ses-b', 'agent-b');
    const status = await b.status('plan-doc', 's1');
    expect(status?.holder).toBe('agent-a');
    expect(status?.sessionId).toBe('ses-a');
  });
});

describe('TTL expiry, staleness and takeover (T13356)', () => {
  it('an expired lease is stale: another session takes over, tookOverFrom naming the stale holder', async () => {
    const a = manager('ses-a', 'agent-a');
    const acquired = await a.acquire('plan-doc', 's1', 60);
    if (!acquired.ok) throw new Error('unreachable');
    expect(isStaleSectionLease(acquired.lease, nowMs + 59_999)).toBe(false);

    // Session A dies (no renew possible); TTL passes.
    nowMs += 61_000;
    expect(isStaleSectionLease(acquired.lease, nowMs)).toBe(true);

    const b = manager('ses-b', 'agent-b');
    expect(await b.status('plan-doc', 's1')).toBeNull();
    const takeover = await b.acquire('plan-doc', 's1', 60);
    expect(takeover.ok).toBe(true);
    if (!takeover.ok) throw new Error('unreachable');
    expect(takeover.lease.holder).toBe('agent-b');
    expect(takeover.lease.expiresAt).toBe('2026-10-12T00:02:01.000Z');
    expect(takeover.tookOverFrom?.holder).toBe('agent-a');
  });

  it('renew on an expired lease reports notHeld (the lease is gone)', async () => {
    const a = manager('ses-a', 'agent-a');
    await a.acquire('plan-doc', 's1', 60);
    nowMs += 61_000;
    const renewed = await a.renew('plan-doc', 's1', 60);
    expect(renewed.ok).toBe(false);
    if (renewed.ok) throw new Error('unreachable');
    expect('notHeld' in renewed && renewed.notHeld).toBe(true);
  });

  it('isStaleSectionLease is true exactly past the TTL', async () => {
    const a = manager('ses-a');
    const acquired = await a.acquire('plan-doc', 's1', 60);
    if (!acquired.ok) throw new Error('unreachable');
    expect(isStaleSectionLease(acquired.lease, nowMs + 59_999)).toBe(false);
    expect(isStaleSectionLease(acquired.lease, nowMs + 60_000)).toBe(true);
  });
});

describe('auto-renew (llmtxt parity)', () => {
  it('renews when the TTL drops below the threshold and stops on stopAutoRenew', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);
    const m = new SectionLeaseManager(tempDir, { sessionId: 'ses-a', now: () => Date.now() });
    const acquired = await m.acquire('plan-doc', 's1', 30);
    if (!acquired.ok) throw new Error('unreachable');

    m.startAutoRenew('plan-doc', 's1', 30, DEFAULT_RENEW_THRESHOLD_SECONDS);
    expect(m.autoRenewRunning).toBe(true);

    // Advance 25 s: remaining TTL (5 s) is below the 10 s threshold → renew.
    vi.advanceTimersByTime(25_000);
    await vi.waitFor(async () => {
      const status = await m.status('plan-doc', 's1');
      expect(status).not.toBeNull();
      expect(Date.parse(status!.expiresAt)).toBeGreaterThan(nowMs + 30_000);
    });

    m.stopAutoRenew();
    expect(m.autoRenewRunning).toBe(false);

    // After a stop, the lease expires for real (no renew loop).
    vi.advanceTimersByTime(31_000);
    expect(await m.status('plan-doc', 's1')).toBeNull();
  });
});
