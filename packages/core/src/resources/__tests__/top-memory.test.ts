/**
 * The host's largest memory users, named in an admission wait (T13914).
 *
 * @task T13914
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryPressureReading } from '@cleocode/contracts';
import { formatProjectManifest } from '@cleocode/paths';
import { describe, expect, it } from 'vitest';
import {
  _resetTopMemoryForTest,
  memoryPressureCause,
  parseLsofCwd,
  parsePsMemory,
  parseTopMemory,
  processCwds,
  projectOfDir,
  topMemoryConsumers,
  withProjects,
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

describe('the project each memory user runs in (T14206)', () => {
  /** A temp tree: `acme/` with a project manifest, `bare/` a plain git checkout. */
  function tree(): { root: string; acme: string; bare: string } {
    const root = mkdtempSync(join(tmpdir(), 'cleo-top-memory-project-'));
    const acme = join(root, 'acme');
    mkdirSync(join(acme, '.cleo'), { recursive: true });
    writeFileSync(
      join(acme, '.cleo', 'project.json'),
      formatProjectManifest({ schemaVersion: 1, id: 'c0ffee000001', name: 'Acme Lab' }),
    );
    mkdirSync(join(acme, 'packages', 'api'), { recursive: true });
    const bare = join(root, 'bare-repo');
    mkdirSync(join(bare, '.git'), { recursive: true });
    mkdirSync(join(bare, 'src'));
    return { root, acme, bare };
  }

  it('names the nearest .cleo/project.json, else the git toplevel', () => {
    const t = tree();
    try {
      expect(projectOfDir(join(t.acme, 'packages', 'api'))).toBe('Acme Lab');
      expect(projectOfDir(join(t.bare, 'src'))).toBe('bare-repo');
      expect(projectOfDir(t.root)).toBeUndefined();
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });

  it('parses lsof cwd records, one pid per p line', () => {
    expect(parseLsofCwd('p4242\nfcwd\nn/Users/k/acme\np77\nfcwd\nn/tmp\n')).toEqual(
      new Map([
        [4242, '/Users/k/acme'],
        [77, '/tmp'],
      ]),
    );
  });

  it('macOS asks lsof once for every pid; a failed lsof names no project', () => {
    const calls: string[][] = [];
    const cwds = processCwds([4242, 77], 'darwin', (cmd, args) => {
      calls.push([cmd, ...args]);
      return 'p4242\nn/w\n';
    });
    expect(calls).toEqual([['/usr/sbin/lsof', '-w', '-a', '-p', '4242,77', '-d', 'cwd', '-Fn']]);
    expect(cwds.get(4242)).toBe('/w');
    // lsof exits 1 when one pid is unreadable but still prints the others.
    const partial = processCwds([4242, 1], 'darwin', () => {
      throw Object.assign(new Error('Command failed: lsof'), { status: 1, stdout: 'p4242\nn/w\n' });
    });
    expect(partial.get(4242)).toBe('/w');
    expect(
      processCwds([4242], 'darwin', () => {
        throw new Error('timed out');
      }).size,
    ).toBe(0);
  });

  it('sets project where the cwd is known and omits it where the lookup fails', () => {
    const t = tree();
    try {
      const out = withProjects(
        [
          { pid: 4242, command: 'agy', footprintBytes: 17 * GIB },
          { pid: 77, command: 'node', footprintBytes: 2 * GIB },
        ],
        () => new Map([[4242, join(t.acme, 'packages', 'api')]]),
      );
      expect(out[0]).toEqual({
        pid: 4242,
        command: 'agy',
        footprintBytes: 17 * GIB,
        project: 'Acme Lab',
      });
      expect(out[1]).toEqual({ pid: 77, command: 'node', footprintBytes: 2 * GIB });
      expect(
        withProjects([{ pid: 1, command: 'x', footprintBytes: GIB }], () => {
          throw new Error('EPERM');
        }),
      ).toEqual([{ pid: 1, command: 'x', footprintBytes: GIB }]);
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });
});
