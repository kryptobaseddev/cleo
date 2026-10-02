/**
 * Regression tests for gh#1222 — "Tool semaphore is not released when a
 * verify's parent shell dies, so E_EVIDENCE_TOOL_BUSY blocks every later
 * verify".
 *
 * `proper-lockfile` decides staleness from the lock's mtime, refreshed on a
 * timer while the holder lives. A process killed without releasing therefore
 * holds its slot for the full `staleMs` (10 min by default) and is
 * indistinguishable from a legitimately long-running suite. On a box where
 * evidence runs are frequent, one orphan blocks every later verify for ten
 * minutes — and the error named no holder, so it read as a broken semaphore
 * rather than a stuck one.
 *
 * The fix decides liveness by process existence rather than by elapsed time,
 * and fails SAFE: an unknown holder, a holder on another host, or any error
 * counts as alive, because reaping a live holder's slot would let two heavy
 * suites run against one bound. Since T12963 a holder whose tool group still
 * has a member is alive too (the tool runs detached and outlives a SIGKILLed
 * cleo), and only a record that describes the slot's current lock is judged.
 *
 * `process.kill` is stubbed: this process and the groups in `liveGroups`
 * answer alive, everything else ESRCH; the real `process.kill` is never
 * reached.
 *
 * @task T12113 (gh#1222)
 * @task T12963
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentLockId } from '../../resources/slot-holder.js';
import {
  acquireGlobalSlot,
  isHolderAlive,
  listSlotHolders,
  reapOrphanedSlots,
  reapSlotIfOrphaned,
  semaphoreDir,
} from '../tool-semaphore.js';

let originalCleoHome: string | undefined;
let cleoHomeDir: string;

/** Process groups the stubbed `kill(-pgid, 0)` reports as alive. */
let liveGroups: Set<number>;

beforeEach(() => {
  liveGroups = new Set();
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    if (signal !== 0) throw new Error(`test sent signal ${String(signal)} to ${pid}`);
    if (pid === process.pid || (pid < 0 && liveGroups.has(-pid))) return true;
    const err: NodeJS.ErrnoException = new Error('kill ESRCH');
    err.code = 'ESRCH';
    throw err;
  });
  originalCleoHome = process.env.CLEO_HOME;
  cleoHomeDir = mkdtempSync(join(tmpdir(), 'gh1222-cleohome-'));
  process.env.CLEO_HOME = cleoHomeDir;
  process.env.CLEO_TOOL_CONCURRENCY_TEST = '1'; // exactly one slot
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.CLEO_TOOL_CONCURRENCY_TEST;
  if (originalCleoHome === undefined) delete process.env.CLEO_HOME;
  else process.env.CLEO_HOME = originalCleoHome;
  rmSync(cleoHomeDir, { recursive: true, force: true });
});

/**
 * Forge the exact on-disk state a killed holder leaves behind: the slot file,
 * a real proper-lockfile lock over it, and a holder record naming a pid that
 * no longer exists and the lock it describes.
 */
function forgeOrphanedSlot(
  pid: number,
  host: string = hostname(),
  extra: Record<string, unknown> = {},
): string {
  const dir = semaphoreDir('test');
  mkdirSync(dir, { recursive: true });
  const slot = join(dir, 'slot-0.lock');
  writeFileSync(slot, '', 'utf-8');
  mkdirSync(`${slot}.lock`, { recursive: true }); // proper-lockfile's lock dir
  writeFileSync(
    `${slot}.holder.json`,
    JSON.stringify({
      pid,
      host,
      acquiredAt: new Date().toISOString(),
      canonical: 'test',
      slot,
      startedAt: null,
      lockId: currentLockId(slot),
      ...extra,
    }),
    'utf-8',
  );
  return slot;
}

/** A pid the stubbed `process.kill` reports as gone. */
function deadPid(): number {
  return 2_147_483_646;
}

describe('gh#1222 — a dead holder must not hold a slot for staleMs', () => {
  it('acquires immediately when the slot is held by a dead pid', async () => {
    forgeOrphanedSlot(deadPid());

    // Before the fix this waits out staleMs (or times out): the lock is
    // present and its mtime is fresh, so proper-lockfile considers it held.
    const started = Date.now();
    const release = await acquireGlobalSlot('test', { timeoutMs: 5_000, staleMs: 600_000 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000);
    await release();
  }, 20_000);

  it('does NOT reap a slot held by a live process', async () => {
    // Fails safe: our own pid is alive, so the slot must be respected even
    // though we can see exactly who holds it.
    const slot = forgeOrphanedSlot(process.pid);

    expect(reapSlotIfOrphaned(slot)).toBe(false);
    expect(existsSync(`${slot}.lock`)).toBe(true);
  });

  it('does NOT reap a slot whose holder is on another host', async () => {
    // A dead-looking pid from a different machine says nothing about liveness.
    const slot = forgeOrphanedSlot(deadPid(), 'some-other-host');

    expect(reapSlotIfOrphaned(slot)).toBe(false);
    expect(existsSync(`${slot}.lock`)).toBe(true);
  });

  it('treats an unknown holder as alive', () => {
    expect(isHolderAlive(null)).toBe(true);
  });

  it('does NOT reap a dead holder whose tool group still has a member (T12963)', () => {
    liveGroups.add(4_000_010);
    const slot = forgeOrphanedSlot(deadPid(), hostname(), { toolGroups: [4_000_010] });

    expect(reapSlotIfOrphaned(slot)).toBe(false);
    expect(existsSync(`${slot}.lock`)).toBe(true);
    expect(listSlotHolders('test')[0]?.alive).toBe(true);

    liveGroups.delete(4_000_010);
    expect(reapSlotIfOrphaned(slot)).toBe(true);
    expect(existsSync(`${slot}.lock`)).toBe(false);
  });

  it('does NOT reap on a record that names no lock, or another lock (T12963)', () => {
    const legacy = forgeOrphanedSlot(deadPid(), hostname(), { lockId: undefined });
    expect(reapSlotIfOrphaned(legacy)).toBe(false);
    rmSync(`${legacy}.lock`, { recursive: true, force: true });

    const other = forgeOrphanedSlot(deadPid(), hostname(), { lockId: '1:1' });
    expect(reapSlotIfOrphaned(other)).toBe(false);
    expect(existsSync(`${other}.lock`)).toBe(true);
  });

  it('records a holder while the slot is held, and clears it on release', async () => {
    const release = await acquireGlobalSlot('test', { timeoutMs: 5_000 });

    const held = listSlotHolders('test').filter((r) => r.held);
    expect(held).toHaveLength(1);
    expect(held[0]?.holder?.pid).toBe(process.pid);
    expect(held[0]?.holder?.host).toBe(hostname());
    expect(held[0]?.alive).toBe(true);

    await release();
    expect(listSlotHolders('test').filter((r) => r.held)).toHaveLength(0);
  }, 20_000);

  it('reapOrphanedSlots reports exactly the slots it freed', async () => {
    const slot = forgeOrphanedSlot(deadPid());

    expect(reapOrphanedSlots('test')).toEqual([slot]);
    expect(existsSync(`${slot}.lock`)).toBe(false);
    // Idempotent: nothing orphaned remains.
    expect(reapOrphanedSlots('test')).toEqual([]);
  });

  it('the busy timeout error names the holder instead of just saying busy', async () => {
    // A live holder we cannot reap — the operator must still be told who.
    const dir = semaphoreDir('test');
    mkdirSync(dir, { recursive: true });
    const slot = join(dir, 'slot-0.lock');
    writeFileSync(slot, '', 'utf-8');
    const release = await lockfile.lock(slot, { retries: 0, stale: 600_000, realpath: false });
    writeFileSync(
      `${slot}.holder.json`,
      JSON.stringify({
        pid: process.pid,
        host: hostname(),
        acquiredAt: new Date().toISOString(),
        canonical: 'test',
        slot,
      }),
      'utf-8',
    );

    await expect(acquireGlobalSlot('test', { timeoutMs: 400, pollMs: 50 })).rejects.toThrow(
      new RegExp(`pid ${process.pid}`),
    );

    await release();
  }, 20_000);
});
