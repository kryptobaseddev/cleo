/**
 * Tests for the throwaway-container reaper (T13436): only expired `cleo.ttl`
 * containers and anonymous dangling volumes, never anything else.
 *
 * @task T13436
 */

import { describe, expect, it } from 'vitest';
import {
  applyContainerReap,
  type DockerRunFn,
  parseTtl,
  planContainerReap,
} from '../container-reaper.js';

const NOW = Date.parse('2026-10-10T18:00:00Z');
const HEX = (c: string): string => c.repeat(64);

const LABELLED = [
  // stopped, created 10:00 UTC, ttl 4h: expired, removable
  'aaa111\tt1764-pg\tpostgres:17\t2026-10-10 03:00:00 -0700 PDT\texited\tcleo.task=T1764,cleo.ttl=4h',
  // stopped, created 17:30 UTC, ttl 4h: still live
  'bbb222\tfresh-pg\tpostgres:17\t2026-10-10 10:30:00 -0700 PDT\texited\tcleo.ttl=4h,cleo.task=T2000',
  // unparseable ttl: left alone, reported
  'ccc333\tbad-ttl\tredis:7\t2026-10-01 00:00:00 -0700 PDT\texited\tcleo.ttl=forever',
  // stopped, two days old, ttl 1d: expired, no task label
  'ddd444\told\tmysql:8\t2026-10-08 10:00:00 -0700 PDT\texited\tcleo.ttl=1d',
  // running, created two days ago, restarted 10 minutes ago: a reused container mid-test
  'fff666\treused-pg\tpostgres:17\t2026-10-08 10:00:00 -0700 PDT\trunning\tcleo.task=T3000,cleo.ttl=4h',
  // running, started 6h ago, ttl 4h: expired, but only reported
  'ggg777\tstale-pg\tpostgres:17\t2026-10-09 10:00:00 -0700 PDT\trunning\tcleo.ttl=4h',
].join('\n');

const STARTED_AT = {
  [`fff666${'0'.repeat(58)}`]: '2026-10-10T17:50:00.123456789Z',
  [`ggg777${'0'.repeat(58)}`]: '2026-10-10T12:00:00.5Z',
};

const DANGLING = [HEX('a'), 'pgdata', HEX('b'), 'my-project_cache', ''].join('\n');

const plan0 = () =>
  planContainerReap({
    labelledContainers: LABELLED,
    danglingVolumes: DANGLING,
    startedAt: STARTED_AT,
    nowMs: NOW,
  });

describe('parseTtl', () => {
  it('parses s/m/h/d and rejects anything else', () => {
    expect(parseTtl('90s')).toBe(90);
    expect(parseTtl('30m')).toBe(1800);
    expect(parseTtl('4h')).toBe(14400);
    expect(parseTtl('2d')).toBe(172800);
    expect(parseTtl('forever')).toBeNull();
    expect(parseTtl('4')).toBeNull();
    expect(parseTtl('-1h')).toBeNull();
  });
});

describe('planContainerReap', () => {
  it('lists expired stopped labelled containers and anonymous dangling volumes only', () => {
    const plan = plan0();
    expect(plan.mode).toBe('dry-run');
    expect(plan.dockerAvailable).toBe(true);
    expect(plan.containers.map((c) => c.name)).toEqual(['t1764-pg', 'old']);
    expect(plan.containers[0]).toMatchObject({ task: 'T1764', ttl: '4h', ageSec: 8 * 3600 });
    expect(plan.containers[1]?.task).toBeNull();
    expect(plan.invalidTtl).toEqual(['bad-ttl']);
    // named volumes (pgdata, my-project_cache) are never listed
    expect(plan.volumes).toEqual([HEX('a'), HEX('b')]);
    expect(plan.applied).toEqual([]);
  });

  it('times a running container from its last start, and only reports it (T13451)', () => {
    const plan = plan0();
    // created two days ago but restarted 10 minutes ago: not expired at all
    expect(plan.runningExpired.map((c) => c.name)).toEqual(['stale-pg']);
    expect(plan.runningExpired[0]?.ageSec).toBe(6 * 3600);
    expect(plan.containers.map((c) => c.name)).not.toContain('reused-pg');
    expect(plan.containers.map((c) => c.name)).not.toContain('stale-pg');
  });

  it('times a stopped container from when it last stopped, falling back to creation', () => {
    const plan = planContainerReap({
      labelledContainers: LABELLED,
      danglingVolumes: '',
      startedAt: STARTED_AT,
      finishedAt: {
        // t1764-pg: created 8h ago but stopped 30 minutes ago at task end: kept
        [`aaa111${'0'.repeat(58)}`]: '2026-10-10T17:30:00.000000001Z',
        // old: never started (docker zero time): falls back to creation, expired
        [`ddd444${'0'.repeat(58)}`]: '0001-01-01T00:00:00Z',
      },
      nowMs: NOW,
    });
    expect(plan.containers.map((c) => c.name)).toEqual(['old']);
  });

  it('a running container whose start time is unknown is left alone and reported as invalid', () => {
    const plan = planContainerReap({
      labelledContainers: LABELLED,
      danglingVolumes: '',
      startedAt: {},
      nowMs: NOW,
    });
    expect(plan.runningExpired).toEqual([]);
    expect(plan.invalidTtl).toEqual(expect.arrayContaining(['reused-pg', 'stale-pg']));
  });

  it('ignores a container without the ttl label even if the filter let it through', () => {
    const plan = planContainerReap({
      labelledContainers: 'eee555\tweb\tnginx\t2026-01-01 00:00:00 -0700 PDT\texited\tcleo.task=T1',
      danglingVolumes: '',
      startedAt: {},
      nowMs: NOW,
    });
    expect(plan.containers).toEqual([]);
  });

  it('reports docker unavailable when both reads failed', () => {
    const plan = planContainerReap({
      labelledContainers: null,
      danglingVolumes: null,
      startedAt: {},
      nowMs: NOW,
    });
    expect(plan.dockerAvailable).toBe(false);
    expect(plan.containers).toEqual([]);
    expect(plan.volumes).toEqual([]);
  });
});

describe('applyContainerReap', () => {
  it('removes exactly the planned targets without -f, and reports each outcome', async () => {
    const calls: string[][] = [];
    const docker: DockerRunFn = async (args) => {
      calls.push([...args]);
      return args[2] === HEX('b') ? 'Error: volume is in use' : null;
    };
    const done = await applyContainerReap(plan0(), docker);
    expect(calls).toEqual([
      ['rm', '-v', 'aaa111'],
      ['rm', '-v', 'ddd444'],
      ['volume', 'rm', HEX('a')],
      ['volume', 'rm', HEX('b')],
    ]);
    expect(done.mode).toBe('apply');
    expect(done.runningExpired.map((c) => c.name)).toEqual(['stale-pg']);
    expect(done.applied.filter((o) => !o.ok)).toEqual([
      { target: HEX('b'), kind: 'volume', ok: false, error: 'Error: volume is in use' },
    ]);
  });
});
