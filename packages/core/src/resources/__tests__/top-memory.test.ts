/**
 * The host's largest memory users, named in an admission wait (T13914).
 *
 * @task T13914
 */

import type { MemoryPressureReading } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  _resetTopMemoryForTest,
  memoryPressureCause,
  parsePsMemory,
  parseTopMemory,
  topMemoryConsumers,
} from '../top-memory.js';

const GIB = 1024 ** 3;

describe('top memory users (T13914)', () => {
  it('parses macOS top by footprint, keeping spaces in a command name', () => {
    const text = [
      'Processes: 712 total, 3 running, 709 sleeping, 4120 threads',
      'PhysMem: 63G used (5120M wired, 9000M compressor), 900M unused.',
      '',
      'PID    MEM    COMMAND',
      '4242   17G+   agy',
      '87300  4391M  OrbStack Helper ',
      '13400  512K-  node',
    ].join('\n');
    expect(parseTopMemory(text)).toEqual([
      { pid: 4242, command: 'agy', footprintBytes: 17 * GIB },
      { pid: 87300, command: 'OrbStack Helper', footprintBytes: 4391 * 1024 ** 2 },
      { pid: 13400, command: 'node', footprintBytes: 512 * 1024 },
    ]);
    expect(parseTopMemory(text, 1)).toHaveLength(1);
    expect(parseTopMemory('no header here')).toEqual([]);
  });

  it('macOS: top fails -> ps, and once top failed it goes straight to ps; ps empty -> null', () => {
    _resetTopMemoryForTest();
    const calls: string[] = [];
    const run = (cmd: string): string => {
      calls.push(cmd);
      if (cmd.endsWith('top')) throw new Error('timed out');
      return ' 4242 17825792 agy\n';
    };
    expect(topMemoryConsumers(3, 'darwin', run)).toEqual([
      { pid: 4242, command: 'agy', footprintBytes: 17 * GIB },
    ]);
    expect(calls).toEqual(['/usr/bin/top', '/bin/ps']);
    topMemoryConsumers(3, 'darwin', run);
    expect(calls).toEqual(['/usr/bin/top', '/bin/ps', '/bin/ps']); // no second top
    expect(topMemoryConsumers(3, 'darwin', () => '')).toBeNull();
    expect(topMemoryConsumers(3, 'linux', () => '')).toBeNull();
    expect(topMemoryConsumers(3, 'win32', run)).toBeNull();
    _resetTopMemoryForTest();
  });

  it('parses Linux ps RSS (KiB) and keeps the largest', () => {
    const text = '    1  21552 systemd\n 4242 17825792 agy\n   77 2097152 node\n';
    expect(parsePsMemory(text, 2)).toEqual([
      { pid: 4242, command: 'agy', footprintBytes: 17 * GIB },
      { pid: 77, command: 'node', footprintBytes: 2 * GIB },
    ]);
  });

  it('names the users and the remedy after the platform summary, or the summary alone', () => {
    const reading: MemoryPressureReading = {
      score: 40,
      fullStall: 0,
      refuseAbove: 25,
      resumeAtOrBelow: 15,
      latched: false,
      memAvailableBytes: null,
      summary: 'swap 8.6 GiB used',
    };
    expect(memoryPressureCause(reading)).toBe('swap 8.6 GiB used');
    // A failed probe says UNKNOWN, never an empty "nothing" (T13963).
    expect(
      memoryPressureCause({
        ...reading,
        topConsumers: { sampledAtMs: 0, processes: [], failed: true },
      }),
    ).toContain('largest memory users: UNKNOWN (memory probe failed');
    expect(
      memoryPressureCause({
        ...reading,
        topConsumers: {
          sampledAtMs: 0,
          processes: [{ pid: 4242, command: 'agy', footprintBytes: 17 * GIB }],
        },
      }),
    ).toBe(
      'swap 8.6 GiB used; largest memory users: agy pid 4242 17.0 GiB ' +
        '(quit or restart them to free memory; check with top -o mem)',
    );
  });
});
