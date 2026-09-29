/**
 * T12661 — one scorer behind `cleo next`, the briefing and `cleo analyze`.
 *
 * Field report (axiom-analytics): T741, a fresh high-priority `kind=bug` with
 * no severity, ranked 136/385 in `cleo next` (75 + 10) while the briefing
 * listed T016, a 93-day-old medium feature that unblocks 8 tasks
 * (50 + 13 + 40 = 103). The three rankers kept their own weights; none gave a
 * bug any weight without an owner-set severity, and the briefing's leverage
 * bonus was unbounded.
 *
 * The fixture reproduces that ordering in a scratch project store.
 *
 * @task T12661
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeBriefing } from '../../sessions/briefing.js';
import { getTaskAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import {
  formatScoreFactor,
  parseTimestampMs,
  rankTasks,
  scoreTask,
} from '../../task-tools/score-task-priority.js';
import { analyzeTaskPriority } from '../analyze.js';
import { coreTaskAnalyze } from '../task-analyze.js';
import { coreTaskNext } from '../task-next.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const daysAgo = (days: number): string => new Date(NOW - days * DAY).toISOString();

const roots: string[] = [];

/** The axiom-app shape: a fresh high bug, an old medium feature with leverage 8, and peers. */
async function axiomFixture(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'cleo-t12661-'));
  roots.push(root);
  mkdirSync(join(root, '.cleo'), { recursive: true });
  writeFileSync(
    join(root, '.cleo', 'project-info.json'),
    JSON.stringify({ projectId: 'proj-t12661', projectHash: 'hash-t12661' }),
  );
  const acc = await getTaskAccessor(root);
  const tasks: Array<Partial<Task> & Pick<Task, 'id' | 'title'>> = [
    { id: 'T741', title: 'Crash on login', priority: 'high', kind: 'bug', createdAt: daysAgo(0) },
    { id: 'T016', title: 'Old dashboard feature', priority: 'medium', createdAt: daysAgo(93) },
    { id: 'T324', title: 'Medium chore', priority: 'medium', createdAt: daysAgo(40) },
    { id: 'T698', title: 'High feature', priority: 'high', createdAt: daysAgo(2) },
    { id: 'T800', title: 'Low tidy-up', priority: 'low', createdAt: daysAgo(200) },
  ];
  // Eight open tasks waiting on T016 — its leverage.
  for (let i = 0; i < 8; i++)
    tasks.push({
      id: `T9${i}0`,
      title: `waits on T016 #${i}`,
      priority: 'medium',
      depends: ['T016'],
      createdAt: daysAgo(30),
    });
  for (const task of tasks)
    await acc.upsertSingleTask({
      description: 'T12661 fixture',
      status: 'pending',
      priority: 'medium',
      ...task,
    } as Task);
  return root;
}

beforeEach(() => {
  vi.stubEnv('CLEO_SESSION_ID', undefined);
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined);
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  resetDbState();
});

afterEach(() => {
  resetDbState();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('T12661 — shared scorer', () => {
  it('a plain ready critical task outranks a low-priority P0 bug carrying every bonus — priority is the documented dominant axis', () => {
    const low = scoreTask(
      {
        id: 'TLOW',
        title: 'Low P0 bug',
        priority: 'low',
        severity: 'P0',
        kind: 'bug',
        phase: 'impl',
        createdAt: daysAgo(120),
      },
      { nowMs: NOW, currentPhase: 'impl', leverage: new Map([['TLOW', 4]]) },
    );
    const crit = scoreTask(
      { id: 'TCRIT', title: 'Plain critical', priority: 'critical', createdAt: daysAgo(0) },
      { nowMs: NOW, currentPhase: 'impl' },
    );
    expect(crit.score).toBeGreaterThan(low.score);
  });

  it('a fresh high bug with no severity outranks a 90-day-old medium feature with leverage 8', () => {
    const bug = scoreTask(
      { id: 'T741', title: 'Crash', priority: 'high', kind: 'bug', createdAt: daysAgo(0) },
      { nowMs: NOW },
    );
    const feature = scoreTask(
      { id: 'T016', title: 'Old feature', priority: 'medium', createdAt: daysAgo(93) },
      { nowMs: NOW, leverage: new Map([['T016', 8]]) },
    );
    expect(bug.score).toBeGreaterThan(feature.score);

    // Every factor is named; the bug default and the bounded age bonus say so.
    expect(bug.factors.map(formatScoreFactor)).toContain(
      'severity: kind=bug with no severity, scored as P2 (+10)',
    );
    const reasons = feature.factors.map(formatScoreFactor);
    expect(reasons).toContain('age: anti-starvation: 93 days old (capped at +10) (+10)');
    expect(reasons).toContain('leverage: unblocks 8 open task(s) (capped at +20) (+20)');
  });

  it('an explicit severity wins over the bug default, and applies to any kind', () => {
    const p0 = scoreTask({ id: 'A', title: 'a', priority: 'medium', severity: 'P0' }, {});
    expect(p0.factors.find((f) => f.name === 'severity')).toEqual({
      name: 'severity',
      delta: 30,
      detail: 'P0',
    });
    const work = scoreTask({ id: 'B', title: 'b', priority: 'medium', kind: 'work' }, {});
    expect(work.factors.some((f) => f.name === 'severity')).toBe(false);
  });

  it('bounds the age bonus', () => {
    const ancient = scoreTask(
      { id: 'C', title: 'c', priority: 'low', createdAt: daysAgo(3650) },
      { nowMs: NOW },
    );
    expect(ancient.factors.find((f) => f.name === 'age')?.delta).toBe(10);
  });
});

describe('T12661 — every ranker agrees on the axiom fixture', () => {
  it('cleo next ranks T741 first and explains every factor', async () => {
    const root = await axiomFixture();
    const next = await coreTaskNext(root, { count: 3, explain: true });
    expect(next.suggestions[0]?.id).toBe('T741');
    expect(next.suggestions[0]?.reasons).toEqual([
      'priority: high (+75)',
      'severity: kind=bug with no severity, scored as P2 (+10)',
      'depsReady: all dependencies satisfied (+10)',
    ]);
  });

  it('briefing nextTasks and cleo next --count 3 return the same ids in the same order', async () => {
    const root = await axiomFixture();
    const next = await coreTaskNext(root, { count: 3 });
    const briefing = await computeBriefing(root, { scope: 'global', maxNextTasks: 3 });
    // T741 95 (75 + bug P2 10 + deps 10), T016 90 (50 + deps 10 + leverage cap 20
    // + age cap 10), T698 85 (75 + deps 10).
    expect(next.suggestions.map((s) => s.id)).toEqual(['T741', 'T016', 'T698']);
    expect(briefing.nextTasks.map((t) => t.id)).toEqual(['T741', 'T016', 'T698']);
    expect(briefing.nextTasks.map((t) => t.score)).toEqual(next.suggestions.map((s) => s.score));
    expect(briefing.nextTasks.find((t) => t.id === 'T016')?.leverage).toBe(8);
  });

  it('cleo analyze (CLI and SDK) recommends the same top task', async () => {
    const root = await axiomFixture();
    expect((await analyzeTaskPriority({ cwd: root })).recommended?.id).toBe('T741');
    expect((await coreTaskAnalyze(root)).recommended?.id).toBe('T741');
  });

  it('with a current phase set, next, briefing and both analyze paths still agree', async () => {
    const root = await axiomFixture();
    const acc = await getTaskAccessor(root);
    // T324 (medium, 40 days) joins the current phase: 50 + phase 20 + deps 10 + age 5 = 85.
    const t324 = await acc.loadSingleTask('T324');
    await acc.upsertSingleTask({ ...t324!, phase: 'v2' });
    await acc.setMetaValue('project_meta', { currentPhase: 'v2' });

    const next = (await coreTaskNext(root, { count: 4 })).suggestions.map((s) => s.id);
    expect(next).toContain('T324');
    const briefing = await computeBriefing(root, { scope: 'global', maxNextTasks: 4 });
    expect(briefing.nextTasks.map((t) => t.id)).toEqual(next);

    const sdk = await analyzeTaskPriority({ cwd: root });
    const cli = await coreTaskAnalyze(root);
    expect(sdk.recommended?.id).toBe(next[0]);
    expect(cli.recommended?.id).toBe(next[0]);
    // Within each priority tier, analyze lists tasks in next's order.
    for (const analysis of [sdk, cli]) {
      for (const tier of [analysis.tiers.critical, analysis.tiers.high, analysis.tiers.normal]) {
        const ids = tier.map((t) => t.id).filter((id) => next.includes(id));
        expect(ids).toEqual(next.filter((id) => ids.includes(id)));
      }
    }
  });
});

describe('T12661 — timestamps are compared as UTC instants', () => {
  it('reads a zone-less SQLite timestamp as UTC', () => {
    expect(parseTimestampMs('2026-09-01 10:00:00')).toBe(Date.UTC(2026, 8, 1, 10));
    expect(parseTimestampMs('2026-09-01T10:00:00Z')).toBe(Date.UTC(2026, 8, 1, 10));
    expect(parseTimestampMs('2026-09-01T12:00:00+02:00')).toBe(Date.UTC(2026, 8, 1, 10));
    expect(Number.isNaN(parseTimestampMs('not a date'))).toBe(true);
  });

  it('breaks score ties by the older instant across mixed formats, then id', () => {
    const ranked = rankTasks(
      [
        // Later instant, but its text sorts first lexically ("2026-09-01 " < "2026-09-01T").
        { id: 'TA', title: 'a', priority: 'medium', createdAt: '2026-09-01 11:00:00' },
        { id: 'TB', title: 'b', priority: 'medium', createdAt: '2026-09-01T10:00:00Z' },
        { id: 'TC', title: 'c', priority: 'medium' },
      ],
      { nowMs: Date.UTC(2026, 8, 2) },
    ).map((r) => r.task.id);
    expect(ranked).toEqual(['TB', 'TA', 'TC']);
  });
});
