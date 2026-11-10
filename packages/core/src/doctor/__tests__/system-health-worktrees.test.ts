/**
 * `cleo doctor system` worktree findings (T14440 AC2): thresholds for
 * worktree count and census bytes, and the live `fseventsd` reading, each
 * naming the reclaim command.
 *
 * @task T14440
 */

import { describe, expect, it } from 'vitest';
import type { SystemSnapshot } from '../system-health.js';
import {
  assessSystemHealth,
  FSEVENTSD_RSS_WARN,
  WORKTREE_BYTES_WARN,
  WORKTREE_COUNT_WARN,
} from '../system-health.js';

const GIB = 1024 ** 3;
const NOW = Date.parse('2026-11-10T18:00:00Z');

/** `ps -A -o pid=,ppid=,pgid=,rss=,pcpu=,etime=,tty=,args=` row (rss in KiB). */
function psRow(pid: number, rssKib: number, args: string): string {
  return `${String(pid).padStart(6)} ${String(1).padStart(6)} ${String(pid).padStart(6)} ${String(rssKib).padStart(8)} ${(0).toFixed(1).padStart(5)} ${'00:10:00'.padStart(11)} ${'??'.padEnd(8)} ${args}`;
}

/** A census record over the warn thresholds, shaped like the real one. */
function censusRecord(over: {
  worktrees?: number;
  apparentBytes?: number;
  partial?: boolean;
}): SystemSnapshot['worktreeCensus'] {
  const worktrees = over.worktrees ?? WORKTREE_COUNT_WARN;
  const bytes = over.apparentBytes ?? WORKTREE_BYTES_WARN;
  const per = Math.floor(worktrees / 2);
  return {
    schemaVersion: 2,
    mode: 'report',
    startedAt: new Date(NOW - 60_000).toISOString(),
    finishedAt: new Date(NOW).toISOString(),
    machineRoot: '/home/u/worktrees',
    applyProjects: [],
    counts: { active: worktrees, redundant: 0, keep: 0, unknown: 0 },
    apparentBytes: bytes,
    reclaimedApparentBytes: 0,
    dfFreeBefore: null,
    dfFreeAfter: null,
    dfDelta: null,
    kept: [],
    rows: [],
    partial: over.partial ?? false,
    projects: [
      {
        project: '/p/a',
        projectHash: 'aaaaaaaaaaaaaaaa',
        worktrees: per,
        apparentBytes: Math.floor(bytes / 2),
        mergedLocalBranches: 12,
        mergedRemoteBranches: 3,
        orphan: false,
      },
      {
        project: null,
        projectHash: 'bbbbbbbbbbbbbbbb',
        worktrees: worktrees - per,
        apparentBytes: bytes - Math.floor(bytes / 2),
        mergedLocalBranches: null,
        mergedRemoteBranches: null,
        orphan: true,
      },
    ],
    orphanFolders: [
      { projectHash: 'bbbbbbbbbbbbbbbb', worktrees: worktrees - per, apparentBytes: 1 },
    ],
    pnpmStore: { path: '/home/u/.pnpm/store', apparentBytes: 5 * GIB },
  };
}

function snapshot(over: Partial<SystemSnapshot>): SystemSnapshot {
  return {
    platform: 'darwin',
    sampledAtMs: NOW,
    totalMemBytes: 64 * GIB,
    cpuCount: 16,
    loadAvg1: 2,
    sample: null,
    linuxSwap: null,
    ps: null,
    governedPgids: [],
    governedPids: [],
    docker: null,
    indexing: null,
    memoryGuard: null,
    worktreeCensus: null,
    ...over,
  };
}

function findingsOf(s: SystemSnapshot) {
  return assessSystemHealth(s).findings.filter((f) => f.category === 'worktrees');
}

describe('worktree findings (T14440 AC2)', () => {
  it('no census record is coverage, not a finding', () => {
    const report = assessSystemHealth(snapshot({}));
    expect(findingsOf(snapshot({}))).toEqual([]);
    expect(report.coverage.find((c) => c.check === 'worktrees')).toMatchObject({
      status: 'skipped',
    });
  });

  it('warns on worktree count with the reclaim command, critical at twice the warn line', () => {
    const warn = findingsOf(snapshot({ worktreeCensus: censusRecord({}) }));
    expect(warn.map((f) => f.id)).toContain('worktree-count');
    const countFinding = warn.find((f) => f.id === 'worktree-count');
    expect(countFinding?.severity).toBe('warning');
    expect(countFinding?.remedy?.command).toBe('cleo hygiene census --report');
    expect(countFinding?.remedy?.description).toContain('--apply');

    const crit = findingsOf(
      snapshot({ worktreeCensus: censusRecord({ worktrees: WORKTREE_COUNT_WARN * 2 }) }),
    ).find((f) => f.id === 'worktree-count');
    expect(crit?.severity).toBe('critical');
  });

  it('stays silent under the count threshold', () => {
    const calm = findingsOf(
      snapshot({ worktreeCensus: censusRecord({ worktrees: WORKTREE_COUNT_WARN - 1 }) }),
    ).find((f) => f.id === 'worktree-count');
    expect(calm).toBeUndefined();
  });

  it('warns on census bytes with the pnpm store in the evidence', () => {
    const finding = findingsOf(snapshot({ worktreeCensus: censusRecord({}) })).find(
      (f) => f.id === 'worktree-bytes',
    );
    expect(finding?.severity).toBe('warning');
    expect(finding?.evidence['pnpmStorePath']).toBe('/home/u/.pnpm/store');
    expect(finding?.evidence['pnpmStoreBytes']).toBe(5 * GIB);
  });

  it('flags fseventsd RSS from the live ps sample, independent of any census record', () => {
    const rssKib = Math.round(FSEVENTSD_RSS_WARN / 1024);
    const ps = [
      psRow(107, rssKib, '/usr/libexec/fseventsd'),
      psRow(200, 1024, '/usr/sbin/cupsd'),
    ].join('\n');
    const finding = findingsOf(snapshot({ ps }))[0];
    expect(finding?.id).toBe('fseventsd-rss:107');
    expect(finding?.remedy?.command).toBe('cleo hygiene census --report');

    const critical = findingsOf(
      snapshot({ ps: psRow(107, rssKib * 2, '/usr/libexec/fseventsd') }),
    )[0];
    expect(critical?.severity).toBe('critical');
  });

  it('an fseventsd under the warn line and a calm census stay quiet on that side', () => {
    const ps = psRow(107, 1024, '/usr/libexec/fseventsd');
    const s = snapshot({
      ps,
      worktreeCensus: censusRecord({
        worktrees: WORKTREE_COUNT_WARN - 1,
        apparentBytes: WORKTREE_BYTES_WARN - 1,
      }),
    });
    expect(findingsOf(s)).toEqual([]);
  });

  it('the parsed record drives per-project evidence, orphans included', () => {
    const finding = findingsOf(snapshot({ worktreeCensus: censusRecord({}) })).find(
      (f) => f.id === 'worktree-count',
    );
    const byProject = finding?.evidence['byProject'] as readonly string[];
    expect(byProject.some((line) => line.startsWith('orphan bbbbbbbbbbbbbbbb'))).toBe(true);
  });

  it('a v1 cache record without per-project rollups still warns, without crashing (P1b)', () => {
    // latest.json written by a schemaVersion-1 census: no projects field.
    const legacy = {
      schemaVersion: 1,
      mode: 'report',
      startedAt: new Date(NOW - 60_000).toISOString(),
      finishedAt: new Date(NOW).toISOString(),
      machineRoot: '/home/u/worktrees',
      applyProjects: [],
      counts: { active: WORKTREE_COUNT_WARN, redundant: 0, keep: 0, unknown: 0 },
      apparentBytes: WORKTREE_BYTES_WARN,
      reclaimedApparentBytes: 0,
      dfFreeBefore: null,
      dfFreeAfter: null,
      dfDelta: null,
      kept: [],
      rows: [],
      partial: false,
    } as unknown as NonNullable<SystemSnapshot['worktreeCensus']>;
    const findings = findingsOf(snapshot({ worktreeCensus: legacy }));
    const count = findings.find((f) => f.id === 'worktree-count');
    expect(count?.title).toContain('predates per-project rollups');
    expect(findings.find((f) => f.id === 'worktree-bytes')).toBeDefined();
  });
});
