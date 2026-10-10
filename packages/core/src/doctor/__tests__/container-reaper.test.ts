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
  // created 10:00 UTC, ttl 4h: expired
  'aaa111\tt1764-pg\tpostgres:17\t2026-10-10 03:00:00 -0700 PDT\tcleo.task=T1764,cleo.ttl=4h',
  // created 17:30 UTC, ttl 4h: still live
  'bbb222\tfresh-pg\tpostgres:17\t2026-10-10 10:30:00 -0700 PDT\tcleo.ttl=4h,cleo.task=T2000',
  // unparseable ttl: left alone, reported
  'ccc333\tbad-ttl\tredis:7\t2026-10-01 00:00:00 -0700 PDT\tcleo.ttl=forever',
  // two days old, ttl 1d: expired, no task label
  'ddd444\told\tmysql:8\t2026-10-08 10:00:00 -0700 PDT\tcleo.ttl=1d',
].join('\n');

const DANGLING = [HEX('a'), 'pgdata', HEX('b'), 'my-project_cache', ''].join('\n');

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
  it('lists expired labelled containers and anonymous dangling volumes only', () => {
    const plan = planContainerReap({
      labelledContainers: LABELLED,
      danglingVolumes: DANGLING,
      nowMs: NOW,
    });
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

  it('ignores a container without the ttl label even if the filter let it through', () => {
    const plan = planContainerReap({
      labelledContainers: 'eee555\tweb\tnginx\t2026-01-01 00:00:00 -0700 PDT\tcleo.task=T1',
      danglingVolumes: '',
      nowMs: NOW,
    });
    expect(plan.containers).toEqual([]);
  });

  it('reports docker unavailable when both reads failed', () => {
    const plan = planContainerReap({ labelledContainers: null, danglingVolumes: null, nowMs: NOW });
    expect(plan.dockerAvailable).toBe(false);
    expect(plan.containers).toEqual([]);
    expect(plan.volumes).toEqual([]);
  });
});

describe('applyContainerReap', () => {
  it('removes exactly the planned targets and reports each outcome', async () => {
    const calls: string[][] = [];
    const docker: DockerRunFn = async (args) => {
      calls.push([...args]);
      return args[2] === HEX('b') ? 'Error: volume is in use' : null;
    };
    const plan = planContainerReap({
      labelledContainers: LABELLED,
      danglingVolumes: DANGLING,
      nowMs: NOW,
    });
    const done = await applyContainerReap(plan, docker);
    expect(calls).toEqual([
      ['rm', '-f', '-v', 'aaa111'],
      ['rm', '-f', '-v', 'ddd444'],
      ['volume', 'rm', HEX('a')],
      ['volume', 'rm', HEX('b')],
    ]);
    expect(done.mode).toBe('apply');
    expect(done.applied.filter((o) => !o.ok)).toEqual([
      { target: HEX('b'), kind: 'volume', ok: false, error: 'Error: volume is in use' },
    ]);
  });
});
