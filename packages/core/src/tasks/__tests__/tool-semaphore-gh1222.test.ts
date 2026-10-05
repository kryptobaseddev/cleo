/**
 * Regression tests for gh#1222 — "Tool semaphore is not released when a
 * verify's parent shell dies, so E_EVIDENCE_TOOL_BUSY blocks every later
 * verify" — on the admission ledger that replaced the tool semaphore (T13133).
 *
 * A process killed without releasing must not hold the machine budget for
 * long, and a waiter must be told who holds it. Liveness is decided by
 * process existence, and fails SAFE: a live pid, a holder whose tool group
 * still has a member (the tool runs detached and outlives a SIGKILLed cleo),
 * or a fresh heartbeat from another host keeps the share held, because
 * releasing a live holder's share would admit two heavy runs against one
 * budget.
 *
 * `process.kill` is stubbed: this process and the groups in `liveGroups`
 * answer alive, everything else ESRCH; the real `process.kill` is never
 * reached.
 *
 * @task T12113 (gh#1222)
 * @task T12963
 * @task T13133
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admissionCapacityBytes,
  admissionDir,
  admit,
  GIB,
  readLedger,
  reapLedger,
} from '../../resources/admission-ledger.js';
import { _resetMemoryGateForTest } from '../../resources/pressure-gate.js';
import { _resetToolGroupsForTest } from '../../resources/tool-groups.js';
import { acquireGlobalSlot } from '../tool-semaphore.js';

const DEAD_PID = 4_000_001;
const MACHINE = { totalRamGib: 48, pressureSample: null, pollMs: 5 } as const;

let home: string;
let liveGroups: Set<number>;
const saved = { home: process.env.CLEO_HOME };

/** Put a whole-budget heavy run in the ledger, held by `pid`. */
async function plantHolder(pid: number): Promise<void> {
  const out = await admit(
    {
      label: 'tool:test',
      footprintBytes: 36 * GIB,
      command: 'cleo verify T1 --evidence tool:test',
    },
    {
      wait: false,
      pid,
      capacityBytes: admissionCapacityBytes(48 * GIB),
      sample: async () => {
        throw new Error('no signal');
      },
      facts: { ancestorsOf: () => [], groupOf: () => null, startedAt: () => null },
      env: {},
    },
  );
  expect(out.admitted).toBe(true);
}

beforeEach(() => {
  liveGroups = new Set();
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    if (signal !== 0) throw new Error(`test sent signal ${String(signal)} to ${pid}`);
    if (pid === process.pid || (pid < 0 && liveGroups.has(-pid))) return true;
    const err: NodeJS.ErrnoException = new Error('kill ESRCH');
    err.code = 'ESRCH';
    throw err;
  });
  home = mkdtempSync(join(tmpdir(), 'gh1222-cleohome-'));
  process.env.CLEO_HOME = home;
  delete process.env.CLEO_TOOL_CONCURRENCY_TEST;
  _resetToolGroupsForTest();
  _resetMemoryGateForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetToolGroupsForTest();
  rmSync(home, { recursive: true, force: true });
  if (saved.home === undefined) delete process.env.CLEO_HOME;
  else process.env.CLEO_HOME = saved.home;
});

describe('a killed verify does not hold the budget (gh#1222 on the ledger)', () => {
  it('is admitted at once when the budget is held by a dead pid', async () => {
    await plantHolder(DEAD_PID);
    const started = Date.now();
    const release = await acquireGlobalSlot('test', { ...MACHINE, timeoutMs: 5_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(readLedger().map((e) => e.pid)).toEqual([process.pid]);
    await release();
  });

  it('a dead holder whose tool group still runs keeps the budget (T12963)', async () => {
    await plantHolder(DEAD_PID);
    // The dead holder's detached tool is still running: its entry lists the
    // tool's group, as the holder's own process recorded it.
    const toolGroup = 4_000_002;
    liveGroups.add(toolGroup);
    const [planted] = readLedger();
    expect(planted).toBeDefined();
    writeFileSync(
      join(admissionDir(home), 'ledger.json'),
      JSON.stringify({ version: 1, entries: [{ ...planted, toolGroups: [toolGroup] }] }),
    );
    await expect(acquireGlobalSlot('test', { ...MACHINE, timeoutMs: 60 })).rejects.toThrow(
      /Timed out/,
    );
    // The tool exits: now the budget is free.
    liveGroups.delete(toolGroup);
    const release = await acquireGlobalSlot('test', { ...MACHINE, timeoutMs: 5_000 });
    await release();
  });

  it('a live holder is never reaped', async () => {
    const held = await acquireGlobalSlot('test', MACHINE);
    expect(await reapLedger({ capacityBytes: admissionCapacityBytes(48 * GIB) })).toEqual([]);
    expect(readLedger()).toHaveLength(1);
    await held();
  });

  it('the timeout error names the holder instead of just saying busy', async () => {
    const held = await acquireGlobalSlot('test', MACHINE);
    try {
      await expect(acquireGlobalSlot('test', { ...MACHINE, timeoutMs: 60 })).rejects.toThrow(
        new RegExp(`Current holders — tool:test pid ${process.pid} \\(`),
      );
    } finally {
      await held();
    }
  });

  it('reapLedger reports exactly the entries it dropped', async () => {
    await plantHolder(DEAD_PID);
    const [planted] = readLedger();
    expect(await reapLedger({ capacityBytes: admissionCapacityBytes(48 * GIB) })).toEqual([
      planted?.id,
    ]);
    expect(readLedger()).toEqual([]);
  });
});
