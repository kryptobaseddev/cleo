/**
 * Merge train (T14371): every rule is judged on fixture GitHub data through
 * the injected client, so no test reaches the network or a task store.
 *
 * @task T14371
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MergeSweepResult, MergeTaskOutcome, ReviewJudgement } from '@cleocode/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAIN_FIX_LABEL,
  MERGE_TRAIN_MAX_RERUNS,
  MERGE_TRAIN_MAX_UNREVIEWED_RERUNS,
  MergeTrainApiError,
  type MergeTrainDeps,
  type MergeTrainGitHub,
  parseMergeAfter,
  rerunSafeConcurrency,
  runMergeTrain,
  type TrainJob,
  type TrainPr,
  type TrainRun,
} from '../merge-train.js';

const sha = (c: string): string => c.repeat(40);
const MAIN = sha('a');
const CI_PATH = '.github/workflows/ci.yml';

/** The concurrency block of cleocode's ci.yml after T14136 (rerun-safe). */
const SAFE_CI = `name: CI
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}-\${{ github.ref == 'refs/heads/main' && github.event_name || '' }}\${{ github.ref == 'refs/heads/main' && github.run_attempt != '1' && format('-rerun-{0}', github.sha) || '' }}
  cancel-in-progress: \${{ github.ref != 'refs/heads/main' }}
jobs: {}
`;
/** The same file before T14136: a rerun joins main's live group. */
const UNSAFE_CI = `name: CI
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
jobs: {}
`;

/** An in-memory GitHub: runs per sha, latest-attempt jobs per run, logs per job. */
class FakeGitHub implements MergeTrainGitHub {
  prs: TrainPr[] = [];
  merged = new Set<number>();
  runList: TrainRun[] = [];
  jobs = new Map<number, TrainJob[]>();
  logs = new Map<number, string>();
  files = new Map<string, string>();
  reruns: number[] = [];
  merges: Array<{ pr: number; head: string }> = [];
  failRuns = false;
  onOpenPrs?: () => unknown;

  async defaultBranch(): Promise<string> {
    return 'main';
  }
  async openPrs(): Promise<TrainPr[]> {
    await this.onOpenPrs?.();
    return this.prs;
  }
  async prMerged(n: number): Promise<boolean> {
    return this.merged.has(n);
  }
  async runs(q: { sha?: string; branch?: string; event?: string }): Promise<TrainRun[]> {
    if (this.failRuns) throw new MergeTrainApiError('HTTP 502: Bad Gateway');
    // The fake ignores the event filter, so the train's own filter is what is tested.
    return this.runList
      .filter(
        (r) =>
          (q.sha === undefined || r.headSha === q.sha) &&
          (q.branch === undefined || r.event !== 'pull_request'),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async latestJobs(runId: number): Promise<TrainJob[]> {
    return this.jobs.get(runId) ?? [];
  }
  async jobLog(jobId: number): Promise<string> {
    return this.logs.get(jobId) ?? '';
  }
  async fileAt(at: string, path: string): Promise<string | null> {
    return this.files.get(`${at}:${path}`) ?? null;
  }
  async rerunFailed(runId: number): Promise<void> {
    this.reruns.push(runId);
  }
  async merge(pr: number, head: string): Promise<string | null> {
    this.merges.push({ pr, head });
    this.merged.add(pr);
    return sha(String(pr % 10));
  }

  /** A run on `headSha` whose latest attempt has `jobs`. */
  addRun(
    id: number,
    headSha: string,
    jobs: Array<Partial<TrainJob> & { name: string }>,
    extra: Partial<TrainRun> = {},
  ): void {
    this.runList.push({
      id,
      event: 'pull_request',
      status: 'completed',
      headSha,
      workflowName: 'CI',
      workflowPath: CI_PATH,
      createdAt: `2026-11-09T00:00:${String(id % 60).padStart(2, '0')}Z`,
      ...extra,
    });
    this.jobs.set(
      id,
      jobs.map((j, i) => ({ id: id * 100 + i, status: 'completed', conclusion: 'success', ...j })),
    );
  }
}

let root: string;
let github: FakeGitHub;
let gaps: Map<number, string[]>;
let reviewedHead: Map<number, string>;
let closures: Map<number, Partial<MergeSweepResult['prs'][number]>>;
let swept: number[];

function deps(): MergeTrainDeps {
  return {
    github,
    requiredChecks: async () => ['CI'],
    async reviewCheck(_r, pr, lines) {
      return lines.map((l): ReviewJudgement & { taskId: string } => ({
        taskId: l.taskId,
        headSha: reviewedHead.get(pr) ?? github.prs.find((p) => p.number === pr)?.headSha ?? '',
        met: l.acs,
        gaps: (gaps.get(pr) ?? []).map((reason) => ({ ac: 'AC1', kind: 'stale' as const, reason })),
      }));
    },
    async closureDryRun(_r, pr) {
      const outcomes: MergeTaskOutcome[] = [{ taskId: 'T1', acs: ['AC1'], action: 'closed' }];
      return {
        swept: true,
        dryRun: true,
        prs: [{ prNumber: pr, mergeSha: null, outcomes, ...closures.get(pr) }],
        closed: ['T1'],
        bound: [],
        refused: [],
        waiting: 0,
        reran: 0,
      };
    },
    async sweep(_r, pr) {
      swept.push(pr);
      return {
        swept: true,
        dryRun: false,
        prs: [],
        closed: ['T1'],
        bound: [],
        refused: [],
        waiting: 0,
        reran: 0,
      };
    },
  };
}

function pr(number: number, head: string, extra: Partial<TrainPr> = {}): TrainPr {
  const p: TrainPr = {
    number,
    headSha: head,
    isDraft: false,
    body: 'Closes: T1 AC1',
    labels: [],
    baseRef: 'main',
    ...extra,
  };
  github.prs.push(p);
  return p;
}

/** Main's latest push run green. */
function mainGreen(): void {
  github.addRun(1, MAIN, [{ name: 'CI' }], { event: 'push' });
}

const decision = async (n: number, execute = false) =>
  (await runMergeTrain(root, { execute }, deps())).decisions.find((d) => d.prNumber === n);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'merge-train-'));
  github = new FakeGitHub();
  gaps = new Map();
  reviewedHead = new Map();
  closures = new Map();
  swept = [];
});

describe('dry run (AC1)', () => {
  it('prints merge or skip with a reason for each open PR, and changes nothing', async () => {
    mainGreen();
    pr(10, sha('b'));
    github.addRun(10, sha('b'), [{ name: 'CI' }]);
    pr(11, sha('c'), { isDraft: true });
    pr(12, sha('d'));
    github.addRun(12, sha('d'), [{ name: 'CI', status: 'in_progress', conclusion: null }]);
    const r = await runMergeTrain(root, {}, deps());
    expect(r.dryRun).toBe(true);
    expect(r.decisions.map((d) => [d.prNumber, d.action])).toEqual([
      [10, 'merge'],
      [11, 'skip'],
      [12, 'skip'],
    ]);
    for (const d of r.decisions) expect(d.reason).not.toBe('');
    expect(r.decisions[2]?.reason).toContain('CI has not finished');
    expect(github.merges).toEqual([]);
  });
});

describe('execute (AC2, rule 1)', () => {
  it('merges only a PR green on its head and reviewed, pinned to that head', async () => {
    mainGreen();
    pr(10, sha('b'));
    github.addRun(10, sha('b'), [{ name: 'CI' }]);
    pr(11, sha('c'));
    github.addRun(11, sha('c'), [{ name: 'CI' }]);
    gaps.set(11, ['AC1: no verdict on head ccccccc (latest is for 1111111)']);
    pr(12, sha('d'));
    github.addRun(12, sha('d'), [
      { name: 'CI', conclusion: 'failure' },
      { name: 'Unit Tests', conclusion: 'failure' },
    ]);
    github.logs.set(1201, '##[error]Process completed with exit code 1.\n 3 failed');
    const r = await runMergeTrain(root, { execute: true }, deps());
    expect(github.merges).toEqual([{ pr: 10, head: sha('b') }]);
    expect(r.decisions.find((d) => d.prNumber === 10)?.action).toBe('merged');
    expect(r.decisions.find((d) => d.prNumber === 11)?.reason).toContain('review check');
  });

  it('never merges when the reviewed head is not the current head', async () => {
    mainGreen();
    pr(10, sha('b'));
    github.addRun(10, sha('b'), [{ name: 'CI' }]);
    reviewedHead.set(10, sha('e'));
    const d = await decision(10, true);
    expect(d?.action).toBe('skip');
    expect(d?.reason).toContain('head moved');
    expect(github.merges).toEqual([]);
  });
});

describe('green is the required check on the exact sha (rule 2)', () => {
  it('an empty conclusion is not green', async () => {
    mainGreen();
    pr(10, sha('b'));
    github.addRun(10, sha('b'), [{ name: 'CI', status: 'completed', conclusion: null }]);
    expect((await decision(10))?.reason).toContain('CI has not finished');
  });

  it('a check on another sha does not count', async () => {
    mainGreen();
    pr(10, sha('b'));
    github.addRun(10, sha('f'), [{ name: 'CI' }]);
    expect((await decision(10))?.reason).toContain('CI has not run');
  });

  it('reads the latest attempt: a rerun job green after a red attempt is green', async () => {
    mainGreen();
    pr(10, sha('b'));
    // latestJobs is jobs?filter=latest: only the rerun attempt is listed.
    github.addRun(10, sha('b'), [{ name: 'CI', conclusion: 'success' }]);
    expect((await decision(10))?.action).toBe('merge');
  });
});

describe('red classification (rule 3)', () => {
  beforeEach(() => {
    mainGreen();
    pr(10, sha('b'));
  });

  it('an infra-only red (runner shutdown) reruns failed jobs, at most 3 times per head', async () => {
    github.addRun(10, sha('b'), [
      { name: 'CI', conclusion: 'failure' },
      { name: 'Unit Tests', conclusion: 'failure' },
    ]);
    github.logs.set(
      1001,
      '##[error]The runner has received a shutdown signal. This can happen when...',
    );
    for (let i = 1; i <= MERGE_TRAIN_MAX_RERUNS; i++)
      expect((await decision(10, true))?.action).toBe('rerun');
    expect(github.reruns).toEqual([10, 10, 10]);
    const after = await decision(10, true);
    expect(after?.action).toBe('skip');
    expect(after?.reason).toContain('needs attention');
    expect(after?.firstReport).toBe(true);
    expect(github.reruns).toHaveLength(3);
  });

  it('a cancel-only job is infra', async () => {
    github.addRun(10, sha('b'), [
      { name: 'CI', conclusion: 'failure' },
      { name: 'Build', conclusion: 'cancelled' },
    ]);
    expect((await decision(10, true))?.action).toBe('rerun');
  });

  it('T14389: a review-ready head with a cancel-only red is rerun once per train run', async () => {
    github.addRun(10, sha('b'), [
      { name: 'CI', conclusion: 'failure' },
      { name: 'Build', conclusion: 'cancelled' },
    ]);
    const d = await decision(10, true);
    expect(d?.review).toBe('ready');
    expect(d?.action).toBe('rerun');
    expect(github.reruns).toEqual([10]);
  });

  it('T14389: an unreviewed head with an infra red is rerun at most once', async () => {
    gaps.set(10, ['AC1: no verdict on head bbbbbbb']);
    github.addRun(10, sha('b'), [
      { name: 'CI', conclusion: 'failure' },
      { name: 'Unit Tests', conclusion: 'failure' },
    ]);
    github.logs.set(1001, '##[error]The runner has received a shutdown signal.');
    const first = await decision(10, true);
    expect(first?.action).toBe('rerun');
    expect(first?.review).toMatch(/^gaps: /);
    expect(first?.reason).toContain(`rerun 1 of ${MERGE_TRAIN_MAX_UNREVIEWED_RERUNS}`);
    const second = await decision(10, true);
    expect(second?.action).toBe('skip');
    expect(second?.reason).toContain('not rerun until reviewed');
    expect(second?.firstReport).toBe(true);
    expect((await decision(10, true))?.firstReport).toBeUndefined();
    expect(github.reruns).toEqual([10]);
    // Once reviewed, the same head gets the rest of the full budget, then is reported once.
    gaps.delete(10);
    for (let i = 2; i <= MERGE_TRAIN_MAX_RERUNS; i++)
      expect((await decision(10, true))?.action).toBe('rerun');
    expect(github.reruns).toHaveLength(MERGE_TRAIN_MAX_RERUNS);
    const exhausted = await decision(10, true);
    expect(exhausted?.reason).toContain('needs attention');
    expect(exhausted?.firstReport).toBe(true);
  });

  it('T14389: the dry run states the review state before the rerun decision', async () => {
    gaps.set(10, ['AC1: no verdict on head bbbbbbb']);
    github.addRun(10, sha('b'), [
      { name: 'CI', conclusion: 'failure' },
      { name: 'Build', conclusion: 'cancelled' },
    ]);
    const d = await decision(10);
    expect(d?.action).toBe('rerun');
    expect(d?.review).toMatch(/^gaps: T1 AC1: no verdict/);
    expect(d?.reason).toMatch(/^review check has gaps; infra-only red/);
    expect(Object.keys(d ?? {}).indexOf('review')).toBeLessThan(
      Object.keys(d ?? {}).indexOf('action'),
    );
    expect(github.reruns).toEqual([]);
  });

  it('a real failure is reported once per head and never rerun', async () => {
    github.addRun(10, sha('b'), [
      { name: 'CI', conclusion: 'failure' },
      { name: 'Unit Tests', conclusion: 'failure' },
    ]);
    github.logs.set(
      1001,
      ' FAIL  src/a.test.ts > x\n 1 failed\n##[error]Process completed with exit code 1.',
    );
    const first = await decision(10, true);
    expect(first?.reason).toContain('failed for real');
    expect(first?.firstReport).toBe(true);
    const second = await decision(10, true);
    expect(second?.action).toBe('skip');
    expect(second?.firstReport).toBeUndefined();
    expect(github.reruns).toEqual([]);
  });

  it('a GitHub API error is a retry, never a CI failure', async () => {
    github.failRuns = true;
    const r = await runMergeTrain(root, { execute: true }, deps());
    expect(r.stopped).toBeUndefined();
    expect(r.skippedReason).toContain('502');
    github.failRuns = false;
    const jobLogFails = deps();
    jobLogFails.github.jobLog = async () => {
      throw new MergeTrainApiError('HTTP 502');
    };
    github.addRun(10, sha('b'), [
      { name: 'CI', conclusion: 'failure' },
      { name: 'Unit Tests', conclusion: 'failure' },
    ]);
    const again = await runMergeTrain(root, { execute: true }, jobLogFails);
    const d = again.decisions.find((x) => x.prNumber === 10);
    expect(d?.action).toBe('retry');
    expect(d?.firstReport).toBeUndefined();
  });
});

describe('main red (AC3, rule 4)', () => {
  beforeEach(() => {
    github.addRun(
      1,
      MAIN,
      [
        { name: 'CI', conclusion: 'failure' },
        { name: 'Unit Tests', conclusion: 'failure' },
      ],
      {
        event: 'push',
      },
    );
    github.logs.set(101, ' FAIL  x\n 1 failed');
    pr(10, sha('b'));
    github.addRun(10, sha('b'), [{ name: 'CI' }]);
  });

  it('refuses to merge while main is red', async () => {
    const r = await runMergeTrain(root, { execute: true }, deps());
    expect(r.main?.state).toBe('red');
    expect(r.decisions[0]?.reason).toContain('main is red');
    expect(github.merges).toEqual([]);
  });

  it('merges the PR labelled as the main fix', async () => {
    github.prs[0] = { ...github.prs[0], labels: [MAIN_FIX_LABEL] } as TrainPr;
    await runMergeTrain(root, { execute: true }, deps());
    expect(github.merges).toEqual([{ pr: 10, head: sha('b') }]);
  });

  it('judges main on its push runs only: a newer scheduled run does not count', async () => {
    github.addRun(59, MAIN, [{ name: 'CI' }], { event: 'schedule' });
    expect((await runMergeTrain(root, {}, deps())).main?.state).toBe('red');
  });

  it('reruns an infra-only main red only when its ci.yml has the per-sha rerun group', async () => {
    github.logs.set(101, '##[error]The runner has received a shutdown signal.');
    github.files.set(`${MAIN}:${CI_PATH}`, UNSAFE_CI);
    const unsafe = await runMergeTrain(root, { execute: true }, deps());
    expect(unsafe.mainRerun).toContain('would cancel');
    expect(github.reruns).toEqual([]);
    github.files.set(`${MAIN}:${CI_PATH}`, SAFE_CI);
    const safe = await runMergeTrain(root, { execute: true }, deps());
    expect(safe.mainRerun).toContain('reran');
    expect(github.reruns).toEqual([1]);
  });

  it('reads the rerun guard from the workflow text', () => {
    expect(rerunSafeConcurrency(SAFE_CI)).toBe(true);
    expect(rerunSafeConcurrency(UNSAFE_CI)).toBe(false);
  });
});

describe('the sweep (AC4, rule 5)', () => {
  it('runs after a merge once the merge commit has a completed push run; scheduled runs do not count', async () => {
    mainGreen();
    pr(10, sha('b'));
    github.addRun(10, sha('b'), [{ name: 'CI' }]);
    await runMergeTrain(root, { execute: true }, deps());
    const mergeSha = sha('0');
    github.prs = [];
    github.addRun(20, mergeSha, [{ name: 'CI' }], { event: 'schedule' });
    const waiting = await runMergeTrain(root, { execute: true }, deps());
    expect(waiting.sweeps).toEqual([expect.objectContaining({ prNumber: 10, action: 'pending' })]);
    expect(swept).toEqual([]);
    github.addRun(21, mergeSha, [{ name: 'CI' }], { event: 'push' });
    const done = await runMergeTrain(root, { execute: true }, deps());
    expect(done.sweeps).toEqual([
      expect.objectContaining({ prNumber: 10, action: 'swept', closed: ['T1'] }),
    ]);
    expect(swept).toEqual([10]);
    expect((await runMergeTrain(root, { execute: true }, deps())).sweeps).toEqual([]);
  });
});

describe('ordering gates (rule 6)', () => {
  beforeEach(() => {
    mainGreen();
  });

  it('holds B until A merged (Merge-After)', async () => {
    pr(11, sha('c'), { body: 'Closes: T1 AC1\nMerge-After: #10' });
    github.addRun(11, sha('c'), [{ name: 'CI' }]);
    expect((await decision(11))?.reason).toContain('Merge-After: #10');
    github.merged.add(10);
    expect((await decision(11))?.action).toBe('merge');
    expect(parseMergeAfter('Merge-After: #10\n- Merge-After: 12')).toEqual([10, 12]);
  });

  it('never merges a PR stacked on another branch', async () => {
    pr(11, sha('c'), { baseRef: 'task/T1-a' });
    expect((await decision(11))?.reason).toContain('stacked on task/T1-a');
  });

  it('holds while done --from-merge --dry-run says waiting or refused', async () => {
    pr(10, sha('b'));
    github.addRun(10, sha('b'), [{ name: 'CI' }]);
    closures.set(10, {
      outcomes: [
        { taskId: 'T1', acs: ['AC1'], action: 'waiting', reason: 'no merged PR binds AC2 of T1' },
      ],
    });
    const d = await decision(10, true);
    expect(d?.reason).toContain('T1 waiting');
    expect(github.merges).toEqual([]);
  });
});

describe('single writer (rule 7)', () => {
  it('a second train refuses while one holds the lock', async () => {
    mainGreen();
    let inner: Awaited<ReturnType<typeof runMergeTrain>> | undefined;
    github.onOpenPrs = async () => {
      github.onOpenPrs = undefined;
      inner = await runMergeTrain(root, { execute: true }, deps());
    };
    await runMergeTrain(root, { execute: true }, deps());
    expect(inner?.skippedReason).toContain('another merge train');
  });
});

describe('Closes: lines must resolve (rule 8)', () => {
  beforeEach(() => {
    mainGreen();
  });

  it('a bare Refs: line next to Closes: is refused', async () => {
    pr(10, sha('b'), { body: 'Closes: T1 AC1\nRefs: T9' });
    github.addRun(10, sha('b'), [{ name: 'CI' }]);
    expect((await decision(10))?.reason).toContain('malformed');
  });

  it('a body naming no task links nothing', async () => {
    pr(10, sha('b'), { body: 'Refs:\nfixes things' });
    github.addRun(10, sha('b'), [{ name: 'CI' }]);
    expect((await decision(10))?.reason).toContain('names no task');
  });
});

describe('no silent death (rule 9)', () => {
  it('reports a lost lock', async () => {
    mainGreen();
    pr(10, sha('b'));
    github.onOpenPrs = () => writeFileSync(join(root, '.cleo', 'merge-train.lock'), 'someone-else');
    const r = await runMergeTrain(root, { execute: true }, deps());
    expect(r.stopped).toContain('lost the merge-train lock');
    expect(github.merges).toEqual([]);
  });

  it('reports a crash, and a previous run that died without reporting', async () => {
    const crash = deps();
    crash.requiredChecks = async () => {
      throw new Error('boom');
    };
    expect((await runMergeTrain(root, { execute: true }, crash)).stopped).toContain('boom');
    writeFileSync(
      join(root, '.cleo', 'merge-train-state.json'),
      JSON.stringify({ running: { pid: 4242, startedAt: '2026-11-09T00:00:00Z' } }),
    );
    mainGreen();
    const next = await runMergeTrain(root, { execute: true }, deps());
    expect(next.previousRunStopped).toContain('pid 4242');
    expect(
      JSON.parse(readFileSync(join(root, '.cleo', 'merge-train-state.json'), 'utf-8')).running,
    ).toBeUndefined();
  });
});
