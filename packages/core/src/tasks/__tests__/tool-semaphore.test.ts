/**
 * Unit tests for machine-wide evidence-run admission (T1534 / ADR-061),
 * which since T13133 is a thin wrapper over the admission ledger.
 *
 * Covers:
 *   - `acquireGlobalSlot` admits at once when the budget is free, hands back
 *     the `CLEO_ADMISSION` token, and its release is idempotent.
 *   - A second heavy run waits for the first (one 36 GiB run fills a 48 GiB
 *     machine's budget) and is admitted when it releases; a light run fits
 *     beside a smaller one.
 *   - The timeout error names the reason and the holders.
 *   - The deprecated `CLEO_TOOL_CONCURRENCY_<TOOL>`: `0` bypasses, any other
 *     value is ignored, and either prints ONE stderr line per process, never
 *     stdout.
 *   - `skipAdmission` and `pressureSample: null`.
 *
 * @task T1534
 * @task T13133
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readLedger } from '../../resources/admission-ledger.js';
import { _resetMemoryGateForTest } from '../../resources/pressure-gate.js';
import {
  _resetToolSemaphoreForTest,
  acquireGlobalSlot,
  legacyConcurrencyOverride,
} from '../tool-semaphore.js';

const MACHINE = { totalRamGib: 48, pressureSample: null, pollMs: 5 } as const;

let home: string;
const saved = { ...process.env };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cleo-home-'));
  process.env.CLEO_HOME = home;
  delete process.env.CLEO_RESOURCES_MODE;
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CLEO_TOOL_CONCURRENCY_')) delete process.env[k];
  }
  _resetToolSemaphoreForTest();
  _resetMemoryGateForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  for (const k of ['CLEO_HOME', 'CLEO_RESOURCES_MODE']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CLEO_TOOL_CONCURRENCY_')) delete process.env[k];
  }
});

describe('acquireGlobalSlot over the admission ledger (T13133)', () => {
  it('admits at once, records one ledger entry, hands back the token, releases idempotently', async () => {
    const release = await acquireGlobalSlot('test', MACHINE);
    const [entry] = readLedger();
    expect(entry).toMatchObject({ label: 'tool:test', state: 'admitted', pid: process.pid });
    expect(release.admission).toBe(`${entry?.id}.${entry?.nonce}`);
    await release();
    await release();
    expect(readLedger()).toEqual([]);
  });

  it('a second heavy run waits for the first and is admitted when it releases', async () => {
    const first = await acquireGlobalSlot('test', MACHINE);
    let admitted = false;
    const second = acquireGlobalSlot('build', { ...MACHINE, timeoutMs: 10_000 }).then((r) => {
      admitted = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(admitted).toBe(false);
    expect(readLedger().map((e) => [e.label, e.state])).toEqual([
      ['tool:test', 'admitted'],
      ['tool:build', 'waiting'],
    ]);
    await first();
    const release = await second;
    expect(admitted).toBe(true);
    await release();
  });

  it('a light run fits beside a run that leaves room', async () => {
    const typecheck = await acquireGlobalSlot('typecheck', MACHINE);
    const lint = await acquireGlobalSlot('lint', { ...MACHINE, timeoutMs: 1_000 });
    expect(readLedger().filter((e) => e.state === 'admitted')).toHaveLength(2);
    await lint();
    await typecheck();
  });

  it('times out naming the reason and the holders', async () => {
    const held = await acquireGlobalSlot('test', MACHINE);
    try {
      await expect(acquireGlobalSlot('test', { ...MACHINE, timeoutMs: 60 })).rejects.toThrow(
        /Timed out waiting for admission of a 'test' run: machine budget in use: 36 GiB of 36 GiB by 1 run\(s\).*Current holders — tool:test pid \d+/,
      );
      expect(readLedger()).toHaveLength(1); // the timed-out run left the queue
    } finally {
      await held();
    }
  });

  it('skipAdmission admits without touching the ledger', async () => {
    const release = await acquireGlobalSlot('test', { ...MACHINE, skipAdmission: true });
    expect(release.admission).toBe('');
    expect(readLedger()).toEqual([]);
    await release();
  });
});

describe('the deprecated CLEO_TOOL_CONCURRENCY_<TOOL> (T13133)', () => {
  it('0 bypasses admission, with ONE stderr deprecation line per process and nothing on stdout', async () => {
    process.env.CLEO_TOOL_CONCURRENCY_TEST = '0';
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write');
    const a = await acquireGlobalSlot('test', MACHINE);
    const b = await acquireGlobalSlot('test', MACHINE);
    expect(readLedger()).toEqual([]);
    await a();
    await b();
    const lines = err.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('CLEO_TOOL_CONCURRENCY_TEST'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^\[cleo\] CLEO_TOOL_CONCURRENCY_TEST is deprecated: .*still bypasses admission/,
    );
    expect(out.mock.calls.some((c) => String(c[0]).includes('CLEO_TOOL_CONCURRENCY'))).toBe(false);
  });

  it('a positive count no longer counts anything: ignored, noticed once', () => {
    process.env.CLEO_TOOL_CONCURRENCY_SECURITY_SCAN = '4';
    const lines: string[] = [];
    expect(legacyConcurrencyOverride('security-scan', (l) => lines.push(l))).toBe('ignored');
    expect(legacyConcurrencyOverride('security-scan', (l) => lines.push(l))).toBe('ignored');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/CLEO_TOOL_CONCURRENCY_SECURITY_SCAN=4 is ignored/);
  });

  it('unset or non-numeric values are not overrides', () => {
    expect(legacyConcurrencyOverride('lint', () => {})).toBeNull();
    process.env.CLEO_TOOL_CONCURRENCY_LINT = 'lots';
    expect(legacyConcurrencyOverride('lint', () => {})).toBeNull();
  });
});
