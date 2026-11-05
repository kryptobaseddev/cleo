/**
 * Independent per-AC review (T14122): the packet withholds the author's
 * account, a verdict is refused from an author or on a moved head, and the
 * judgement names missing, unmet and stale criteria.
 *
 * GitHub is a stub; the task store is a real temp store.
 *
 * @task T14122
 */

import { randomUUID } from 'node:crypto';
import type { ReviewVerdict } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOUND_TEST_SESSION_ID,
  bindTestSession,
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '../../store/__tests__/test-db-helper.js';
import { checkPrTaskLinkage, reviewedDirectiveLinkage } from '../evidence.js';
import {
  acTextSha256,
  buildReviewPacket,
  canonicalDiff,
  checkPrReviews,
  ghReviewDeps,
  judgeReviewVerdicts,
  type ReviewDeps,
  recordReviewVerdict,
  reviewAuthors,
  reviewVerdictsFor,
  withholdDiffPaths,
} from '../review-verdict.js';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

/** A diff that implements AC1 (a limit option) and not AC2 (an error on a negative limit). */
const DIFF = [
  'diff --git a/src/list.ts b/src/list.ts',
  '--- a/src/list.ts',
  '+++ b/src/list.ts',
  '@@ -1,3 +1,4 @@',
  ' export function list(items: string[], opts: { limit?: number } = {}) {',
  '-  return items;',
  '+  return opts.limit === undefined ? items : items.slice(0, opts.limit);',
  ' }',
  'diff --git a/.changeset/list-limit.md b/.changeset/list-limit.md',
  '--- /dev/null',
  '+++ b/.changeset/list-limit.md',
  '@@ -0,0 +1,2 @@',
  '+Closes: T001 AC1,AC2',
  '+Adds --limit and rejects a negative limit.',
  '',
].join('\n');

function stubGh(heads: string[], diff = DIFF): ReviewDeps {
  let i = 0;
  return {
    prHead: async () => heads[Math.min(i++, heads.length - 1)] ?? null,
    prDiff: async () => diff,
  };
}

let env: TestDbEnv;

beforeEach(async () => {
  env = await createTestDb();
  await seedTasks(env.accessor, [
    {
      id: 'T001',
      title: 'list --limit',
      type: 'task',
      status: 'active',
      priority: 'medium',
      createdAt: new Date().toISOString(),
    },
  ]);
  await env.accessor.transaction(async (tx) => {
    await tx.insertAcRows(
      [
        'list accepts a limit option and returns at most that many items',
        'a negative limit is rejected with E_VALIDATION',
      ].map((text, i) => ({
        id: randomUUID(),
        taskId: 'T001',
        ordinal: i + 1,
        text,
        kind: 'text' as const,
        sourceKey: `direct:${i + 1}`,
        targetTaskId: null,
        projection: 'legacy',
      })),
    );
  });
});

afterEach(async () => {
  await env.cleanup();
  vi.unstubAllEnvs();
});

describe('the review packet (T14122)', () => {
  it('carries the diff and the criteria only: no changeset, PR body or Closes: line', async () => {
    const packet = await buildReviewPacket(env.tempDir, 7, 'T001', stubGh([HEAD]));
    expect(packet).toMatchObject({
      prNumber: 7,
      headSha: HEAD,
      taskId: 'T001',
      acs: [
        { alias: 'AC1', text: 'list accepts a limit option and returns at most that many items' },
        { alias: 'AC2', text: 'a negative limit is rejected with E_VALIDATION' },
      ],
      withheldPaths: ['.changeset/list-limit.md'],
    });
    expect(packet.diff).toContain('opts.limit');
    expect(JSON.stringify(packet)).not.toMatch(/Closes:|rejects a negative limit/);
    expect(packet.packetSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a head that moved while the diff was read', async () => {
    await expect(buildReviewPacket(env.tempDir, 7, 'T001', stubGh([HEAD, NEXT]))).rejects.toThrow(
      /moved from aaaaaaa to bbbbbbb/,
    );
  });

  it('a diff carrying terminal escapes builds a stable packet with no raw escape byte (T14328)', async () => {
    const escaped = DIFF.replace(
      '+  return opts.limit',
      '+  // \u001b[31mred\u001b[0m in a CI log fixture\n+  return opts.limit',
    );
    const first = await buildReviewPacket(env.tempDir, 7, 'T001', stubGh([HEAD], escaped));
    const again = await buildReviewPacket(env.tempDir, 7, 'T001', stubGh([HEAD], escaped));
    expect(first.diff).not.toContain('\u001b');
    expect(first.diff).toContain('\\x1b[31mred\\x1b[0m');
    expect(again.packetSha256).toBe(first.packetSha256);
  });

  it("gh is asked for the diff verbatim, and a gh failure reports gh's own error (T14328)", async () => {
    const calls: string[][] = [];
    const ok = ghReviewDeps((args) => {
      calls.push(args);
      return args[1] === 'view' ? `${HEAD}\n` : DIFF;
    });
    await buildReviewPacket(env.tempDir, 7, 'T001', ok);
    expect(calls.find((a) => a[1] === 'diff')).toEqual([
      'pr',
      'diff',
      '7',
      '--color',
      'never',
      '--allow-escape-sequences',
    ]);
    const failing = ghReviewDeps(() => {
      throw Object.assign(new Error('Command failed: gh pr view 7'), {
        stderr:
          'GraphQL: Could not resolve to a PullRequest with the number of 7. (repository.pullRequest)\n',
      });
    });
    await expect(buildReviewPacket(env.tempDir, 7, 'T001', failing)).rejects.toThrow(
      /gh pr view 7 failed: GraphQL: Could not resolve to a PullRequest/,
    );
  });

  it('two diffs differing only in index-line abbreviation length hash to the same packet (T14325)', async () => {
    const abbreviated = (len: number): string =>
      DIFF.replace(
        '--- a/src/list.ts',
        `index ${'1a2b3c4d5e6f'.slice(0, len)}..${'6f5e4d3c2b1a'.slice(0, len)} 100644\n--- a/src/list.ts`,
      );
    const ten = await buildReviewPacket(env.tempDir, 7, 'T001', stubGh([HEAD], abbreviated(10)));
    const nine = await buildReviewPacket(env.tempDir, 7, 'T001', stubGh([HEAD], abbreviated(9)));
    expect(nine.packetSha256).toBe(ten.packetSha256);
    expect(ten.diff).toContain('index 100644\n--- a/src/list.ts');
    expect(canonicalDiff('index 1a2b3c4..6f5e4d3\n')).toBe('index\n');
    // A real change still moves the packet.
    const changed = await buildReviewPacket(
      env.tempDir,
      7,
      'T001',
      stubGh([HEAD], abbreviated(10).replace('items.slice(0, opts.limit)', 'items')),
    );
    expect(changed.packetSha256).not.toBe(ten.packetSha256);
  });

  it('withholdDiffPaths keeps every other file whole', () => {
    const { diff, withheldPaths } = withholdDiffPaths(DIFF);
    expect(withheldPaths).toEqual(['.changeset/list-limit.md']);
    expect(diff.startsWith('diff --git a/src/list.ts')).toBe(true);
    expect(diff).not.toContain('.changeset');
  });
});

describe('recording a verdict (T14122)', () => {
  const record = async (
    over: Partial<Parameters<typeof recordReviewVerdict>[1]> = {},
    heads = [HEAD],
  ): Promise<ReviewVerdict> => {
    const packet = await buildReviewPacket(env.tempDir, 7, 'T001', stubGh([HEAD]));
    return recordReviewVerdict(
      env.tempDir,
      {
        prNumber: 7,
        taskId: 'T001',
        ac: 'AC2',
        verdict: 'unmet',
        reason: 'The diff never checks for a negative limit.',
        packetSha256: packet.packetSha256,
        ...over,
      },
      { deps: stubGh(heads) },
    );
  };

  it('a verdict on a packet fetched seconds earlier is not stale when only the index abbreviation changed (T14325)', async () => {
    await env.accessor.claimTask('T001', {
      sessionId: 'ses_author',
      agentId: 'agent-author',
      mode: 'acquire',
    });
    await bindTestSession(env);
    vi.stubEnv('CLEO_AGENT_ID', 'agent-reviewer');
    const withIndex = (ids: string): string =>
      DIFF.replace('--- a/src/list.ts', `index ${ids} 100644\n--- a/src/list.ts`);
    const packet = await buildReviewPacket(
      env.tempDir,
      7,
      'T001',
      stubGh([HEAD], withIndex('1a2b3c4d5e..6f5e4d3c2b')),
    );
    const v = await recordReviewVerdict(
      env.tempDir,
      {
        prNumber: 7,
        taskId: 'T001',
        ac: 'AC2',
        verdict: 'unmet',
        reason: 'The diff never checks for a negative limit.',
        packetSha256: packet.packetSha256,
      },
      { deps: stubGh([HEAD], withIndex('1a2b3c4d5..6f5e4d3c2')) },
    );
    expect(v).toMatchObject({ headSha: HEAD, verdict: 'unmet' });
  });

  it('records an unmet verdict under the reviewer’s session, bound to the head, with the authors', async () => {
    await env.accessor.claimTask('T001', {
      sessionId: 'ses_author',
      agentId: 'agent-author',
      mode: 'acquire',
    });
    await bindTestSession(env);
    vi.stubEnv('CLEO_AGENT_ID', 'agent-reviewer');
    const v = await record();
    expect(v).toMatchObject({
      taskId: 'T001',
      ac: 'AC2',
      prNumber: 7,
      headSha: HEAD,
      verdict: 'unmet',
      reviewer: { sessionId: BOUND_TEST_SESSION_ID, agentId: 'agent-reviewer' },
    });
    expect(v.authors.sessionIds).toContain('ses_author');
    expect(v.authors.agentIds).toEqual(['agent-author']);
    // T14259: the verdict binds the criterion text it judged.
    expect(v.acTextSha256).toBe(acTextSha256('a negative limit is rejected with E_VALIDATION'));
    expect(await reviewVerdictsFor(env.tempDir, 'T001', 7)).toEqual([v]);
    expect(await reviewVerdictsFor(env.tempDir, 'T001', 8)).toEqual([]);
  });

  it('refuses the author as reviewer, by session or by agent id', async () => {
    await bindTestSession(env);
    await env.accessor.claimTask('T001', {
      sessionId: BOUND_TEST_SESSION_ID,
      agentId: null,
      mode: 'acquire',
    });
    await expect(record()).rejects.toThrow(/is an author of T001/);
    await env.accessor.unclaimTask('T001', { sessionId: BOUND_TEST_SESSION_ID });
    await env.accessor.claimTask('T001', {
      sessionId: 'ses_author',
      agentId: 'agent-x',
      mode: 'acquire',
    });
    vi.stubEnv('CLEO_AGENT_ID', 'agent-x');
    await expect(record()).rejects.toThrow(/agent agent-x\) is an author of T001/);
    expect(await reviewVerdictsFor(env.tempDir, 'T001', 7)).toEqual([]);
  });

  it('refuses a task with no recorded author, and an unbound reviewer', async () => {
    await bindTestSession(env);
    await expect(record()).rejects.toThrow(/has no recorded author/);
    vi.stubEnv('CLEO_SESSION_ID', '');
    await expect(record()).rejects.toThrow(/reviewer’s own CLEO session/);
  });

  it('a claim released by a refocus still names its author: the author is refused, another reviewer accepted (T14213)', async () => {
    // Session A (the bound test session) claims T001, then refocuses onto
    // other work, which releases the claim.
    await bindTestSession(env);
    await env.accessor.claimTask('T001', {
      sessionId: BOUND_TEST_SESSION_ID,
      agentId: 'agent-author',
      mode: 'acquire',
    });
    await env.accessor.unclaimTask('T001', { sessionId: BOUND_TEST_SESSION_ID });
    expect((await env.accessor.loadSingleTask('T001'))?.claim ?? null).toBeNull();
    await expect(record()).rejects.toThrow(/is an author of T001/);

    // Session B, another agent, records the verdict.
    await bindTestSession(env, 'ses_20261103000000_b1b1b1');
    vi.stubEnv('CLEO_AGENT_ID', 'agent-reviewer');
    const v = await record();
    expect(v.reviewer.sessionId).toBe('ses_20261103000000_b1b1b1');
    expect(v.authors.sessionIds).toContain(BOUND_TEST_SESSION_ID);
    expect(v.authors.agentIds).toEqual(['agent-author']);
  });

  it('refuses a stale packet: the head moved since the reviewer read it', async () => {
    await env.accessor.claimTask('T001', {
      sessionId: 'ses_author',
      agentId: null,
      mode: 'acquire',
    });
    await bindTestSession(env);
    await expect(record({}, [NEXT])).rejects.toThrow(
      /changed since it was reviewed \(now head bbbbbbb\)/,
    );
  });

  it('refuses an unknown criterion and an empty reason', async () => {
    await env.accessor.claimTask('T001', {
      sessionId: 'ses_author',
      agentId: null,
      mode: 'acquire',
    });
    await bindTestSession(env);
    await expect(record({ ac: 'AC9' })).rejects.toThrow(/has no criterion AC9 \(it has AC1, AC2\)/);
    await expect(record({ reason: '  ' })).rejects.toThrow(/needs a --reason/);
  });
});

describe('reviewAuthors (T14122)', () => {
  it('collects the claim holder, replaced holders and the creating session', () => {
    const authors = reviewAuthors(
      {
        claim: {
          sessionId: 'ses_now',
          agentId: 'agent-now',
          claimedAt: '',
          leaseExpiresAt: '',
        },
        provenance: { createdBy: null, modifiedBy: null, sessionId: 'ses_created' },
      },
      [
        {
          sessionId: 'ses_now',
          beforeJson: JSON.stringify({ sessionId: 'ses_before', agentId: 'agent-before' }),
          afterJson: null,
        },
      ],
    );
    expect(authors).toEqual({
      sessionIds: ['ses_before', 'ses_created', 'ses_now'],
      agentIds: ['agent-before', 'agent-now'],
    });
  });
});

describe('judgeReviewVerdicts (T14122)', () => {
  const v = (ac: string, verdict: 'met' | 'unmet', headSha: string, at: string): ReviewVerdict => ({
    id: `${ac}-${at}`,
    taskId: 'T001',
    ac,
    acId: '',
    prNumber: 7,
    headSha,
    verdict,
    reason: verdict === 'met' ? 'implemented' : 'not implemented',
    reviewer: { sessionId: 'ses_r', agentId: null },
    authors: { sessionIds: ['ses_a'], agentIds: [] },
    packetSha256: '',
    createdAt: at,
  });

  it('counts only the latest verdict on the head, and names missing, unmet and stale criteria', () => {
    const verdicts = [
      v('AC1', 'unmet', HEAD, '2026-10-28T10:00:00Z'),
      // T14128: a met clears the earlier unmet only by answering it.
      { ...v('AC1', 'met', HEAD, '2026-10-28T11:00:00Z'), answers: 'AC1-2026-10-28T10:00:00Z' },
      v('AC2', 'unmet', HEAD, '2026-10-28T11:00:00Z'),
      v('AC3', 'met', NEXT, '2026-10-28T09:00:00Z'),
    ];
    expect(judgeReviewVerdicts(verdicts, ['AC1', 'AC2', 'AC3', 'AC4'], HEAD)).toEqual({
      headSha: HEAD,
      met: ['AC1'],
      gaps: [
        {
          ac: 'AC2',
          kind: 'unmet',
          reason:
            'AC2: reviewed unmet on head aaaaaaa (verdict AC2-2026-10-28T11:00:00Z): not implemented',
        },
        {
          ac: 'AC3',
          kind: 'stale',
          reason: 'AC3: no verdict on head aaaaaaa (latest is for bbbbbbb)',
        },
        { ac: 'AC4', kind: 'missing', reason: 'AC4: no verdict on head aaaaaaa' },
      ],
    });
  });

  it('a verdict binds its criterion text: an edit after it invalidates it, whitespace does not, a legacy verdict is judged as before (T14259)', () => {
    const bound = {
      ...v('AC1', 'met', HEAD, '2026-10-28T11:00:00Z'),
      acTextSha256: acTextSha256('list accepts a limit option'),
    };
    const legacy = v('AC2', 'met', HEAD, '2026-10-28T11:00:00Z');
    const judge = (ac1: string) =>
      judgeReviewVerdicts(
        [bound, legacy],
        ['AC1', 'AC2'],
        HEAD,
        new Map([
          ['AC1', ac1],
          ['AC2', 'edited, but this verdict predates the binding'],
        ]),
      );
    expect(judge('list accepts a limit option').met).toEqual(['AC1', 'AC2']);
    expect(judge('  list accepts   a limit\noption ').met).toEqual(['AC1', 'AC2']);
    expect(judge('list accepts a limit option of at most 100').gaps).toEqual([
      {
        ac: 'AC1',
        kind: 'edited',
        reason:
          'AC1: edited after verdict AC1-2026-10-28T11:00:00Z on head aaaaaaa; review it again',
      },
    ]);
  });

  it('a verdict whose reviewer is among its recorded authors counts for nothing', () => {
    const own = {
      ...v('AC1', 'met', HEAD, '2026-10-28T11:00:00Z'),
      reviewer: { sessionId: 'ses_a', agentId: null },
    };
    expect(judgeReviewVerdicts([own], ['AC1'], HEAD)).toEqual({
      headSha: HEAD,
      met: [],
      gaps: [
        {
          ac: 'AC1',
          kind: 'author',
          reason: "AC1: reviewed by the task's own author on head aaaaaaa; review independently",
        },
      ],
    });
  });
});

describe('the pre-merge check (T14122)', () => {
  it('reports each criterion on the current head; a push after review makes the verdicts stale', async () => {
    await env.accessor.claimTask('T001', {
      sessionId: 'ses_author',
      agentId: null,
      mode: 'acquire',
    });
    await bindTestSession(env);
    const packet = await buildReviewPacket(env.tempDir, 7, 'T001', stubGh([HEAD]));
    for (const [ac, verdict] of [
      ['AC1', 'met'],
      ['AC2', 'unmet'],
    ] as const) {
      await recordReviewVerdict(
        env.tempDir,
        {
          prNumber: 7,
          taskId: 'T001',
          ac,
          verdict,
          reason: verdict === 'met' ? 'list slices to the limit' : 'no negative-limit check',
          packetSha256: packet.packetSha256,
        },
        { deps: stubGh([HEAD]) },
      );
    }
    const [onHead] = await checkPrReviews(env.tempDir, 7, ['T001'], { deps: stubGh([HEAD]) });
    expect(onHead).toMatchObject({
      taskId: 'T001',
      met: ['AC1'],
      gaps: [{ ac: 'AC2', kind: 'unmet' }],
    });
    const [pushed] = await checkPrReviews(env.tempDir, 7, ['T001'], { deps: stubGh([NEXT]) });
    expect(pushed?.met).toEqual([]);
    expect(pushed?.gaps.map((g) => g.kind)).toEqual(['stale', 'stale']);
    const [narrowed] = await checkPrReviews(env.tempDir, 7, ['T001'], {
      acs: ['AC1'],
      deps: stubGh([HEAD]),
    });
    expect(narrowed).toMatchObject({ met: ['AC1'], gaps: [] });
  });
});

/**
 * AC5 proof (T14122): a reviewer agent with no other context was given only
 * this fixture's packet (the two criteria and the `src/list.ts` diff; the
 * changeset with the author's `Closes: T001 AC1,AC2` withheld) and returned
 * these verdicts verbatim on 2026-10-28. Recorded under the reviewer's own
 * session, the check finds AC2 unmet: the reviewer caught the criterion the
 * diff does not implement.
 */
const REVIEWER_VERDICTS = [
  {
    ac: 'AC1',
    verdict: 'met',
    reason:
      'The diff adds an optional `limit` to `opts` and returns `items.slice(0, opts.limit)` when it is set, so the result has at most `limit` items for any non-negative limit.',
  },
  {
    ac: 'AC2',
    verdict: 'unmet',
    reason:
      'The diff never checks for a negative limit and never raises E_VALIDATION, so a negative value goes straight to `slice(0, n)` and silently drops items from the end.',
  },
] as const;

describe('AC5 proof: an independent reviewer catches the unmet criterion (T14122)', () => {
  it('records the reviewer agent’s verdicts and the check reports AC2 unmet', async () => {
    await env.accessor.claimTask('T001', {
      sessionId: 'ses_author',
      agentId: 'agent-author',
      mode: 'acquire',
    });
    await bindTestSession(env);
    vi.stubEnv('CLEO_AGENT_ID', 'agent-reviewer');
    const packet = await buildReviewPacket(env.tempDir, 7, 'T001', stubGh([HEAD]));
    expect(packet.diff).not.toContain('Closes:');
    for (const v of REVIEWER_VERDICTS) {
      await recordReviewVerdict(
        env.tempDir,
        { prNumber: 7, taskId: 'T001', ...v, packetSha256: packet.packetSha256 },
        { deps: stubGh([HEAD]) },
      );
    }
    const [check] = await checkPrReviews(env.tempDir, 7, ['T001'], { deps: stubGh([HEAD]) });
    expect(check?.met).toEqual(['AC1']);
    expect(check?.gaps).toEqual([
      {
        ac: 'AC2',
        kind: 'unmet',
        reason: expect.stringMatching(
          /^AC2: reviewed unmet on head aaaaaaa \(verdict [0-9a-f-]{36}\): /,
        ),
      },
    ]);
  });
});

describe('review-shopping guard (T14128)', () => {
  const at = (n: number): string => `2026-10-28T1${n}:00:00Z`;
  const v = (
    id: string,
    verdict: 'met' | 'unmet',
    n: number,
    over: Partial<ReviewVerdict> = {},
  ): ReviewVerdict => ({
    id,
    taskId: 'T001',
    ac: 'AC2',
    acId: '',
    prNumber: 7,
    headSha: HEAD,
    verdict,
    reason: `${verdict} by ${id}`,
    reviewer: { sessionId: `ses_${id}`, agentId: null },
    authors: { sessionIds: ['ses_author'], agentIds: [] },
    packetSha256: '',
    createdAt: at(n),
    ...over,
  });

  it('a later met that does not answer a non-author unmet leaves the criterion unmet, naming the verdict', () => {
    const j = judgeReviewVerdicts([v('u1', 'unmet', 1), v('m1', 'met', 2)], ['AC2'], HEAD);
    expect(j.met).toEqual([]);
    expect(j.gaps).toEqual([
      {
        ac: 'AC2',
        kind: 'unmet',
        reason: 'AC2: a later met on head aaaaaaa does not answer unmet verdict u1: unmet by u1',
      },
    ]);
  });

  it('a met that answers the unmet by id clears it', () => {
    const j = judgeReviewVerdicts(
      [v('u1', 'unmet', 1), v('m1', 'met', 2, { answers: 'u1' })],
      ['AC2'],
      HEAD,
    );
    expect(j).toMatchObject({ met: ['AC2'], gaps: [] });
  });

  it("an unmet from the task's own author is ignored, like any author verdict", () => {
    const own = v('u0', 'unmet', 1, { reviewer: { sessionId: 'ses_author', agentId: null } });
    expect(judgeReviewVerdicts([own, v('m1', 'met', 2)], ['AC2'], HEAD)).toMatchObject({
      met: ['AC2'],
      gaps: [],
    });
  });

  it('recordReviewVerdict records --answers, and refuses one naming no unmet verdict on this head', async () => {
    await env.accessor.claimTask('T001', {
      sessionId: 'ses_author',
      agentId: null,
      mode: 'acquire',
    });
    await bindTestSession(env);
    const packet = await buildReviewPacket(env.tempDir, 7, 'T001', stubGh([HEAD]));
    const base = {
      prNumber: 7,
      taskId: 'T001',
      ac: 'AC2',
      packetSha256: packet.packetSha256,
    };
    const deps = { deps: stubGh([HEAD]) };
    const unmet = await recordReviewVerdict(
      env.tempDir,
      { ...base, verdict: 'unmet', reason: 'no negative-limit check' },
      deps,
    );
    await expect(
      recordReviewVerdict(
        env.tempDir,
        { ...base, verdict: 'met', reason: 'fine', answers: 'no-such-id' },
        deps,
      ),
    ).rejects.toThrow(/--answers no-such-id names no unmet verdict on AC2 of T001/);
    await expect(
      recordReviewVerdict(
        env.tempDir,
        { ...base, verdict: 'unmet', reason: 'still no', answers: unmet.id },
        deps,
      ),
    ).rejects.toThrow(/or the new verdict is not met/);
    // A second reviewer answers the first one's finding (T14137 reports the pair).
    await bindTestSession(env, 'ses_20260930000000_c1c1c1');
    const answer = await recordReviewVerdict(
      env.tempDir,
      {
        ...base,
        verdict: 'met',
        reason: `answers ${unmet.id}: the negative-limit check exists in list()`,
        answers: unmet.id,
      },
      deps,
    );
    expect(answer.answers).toBe(unmet.id);
    expect((await reviewVerdictsFor(env.tempDir, 'T001', 7)).map((x) => x.id)).toEqual([
      unmet.id,
      answer.id,
    ]);
    const [check] = await checkPrReviews(env.tempDir, 7, ['T001'], {
      acs: ['AC2'],
      deps: stubGh([HEAD]),
    });
    expect(check).toMatchObject({ met: ['AC2'], gaps: [] });
    // T14137: the check shows who answered whose finding, and both reviewers.
    expect(answer.reviewer.sessionId).not.toBe(unmet.reviewer.sessionId);
    expect(check?.answered).toEqual([
      {
        ac: 'AC2',
        unmet: { id: unmet.id, reviewer: unmet.reviewer },
        met: { id: answer.id, reviewer: answer.reviewer },
      },
    ]);
  });
});

describe('the merge sweep linkage: a Closes: line plus non-author verdicts (T14259)', () => {
  /** The #1062/T11791 shape: a child delivered by its parent's PR, declaring files the PR never touched. */
  const parentPr = {
    title: 'feat(M6): the parent epic delivers its children',
    body: 'Parent work.\n\nCloses: T001 AC1,AC2',
    headRefName: 'task/T999-parent',
    changedPaths: ['packages/parent/src/a.ts'],
    changedFileCount: 1,
  };
  const child = {
    task: {
      id: 'T001',
      kind: 'work' as const,
      labels: [],
      files: ['packages/child/src/only.ts'],
      acceptance: [],
    },
    gates: ['implemented' as const],
    criteria: [],
  };

  it('the old rule refuses the child; the line and the verdicts link it', () => {
    expect(checkPrTaskLinkage(7, parentPr, child)?.codeName).toBe('E_EVIDENCE_CONTENT_MISMATCH');
    expect(checkPrTaskLinkage(7, parentPr, child, undefined, true)).toBeNull();
  });

  it('closes with met verdicts on every named criterion; an edit after the verdicts refuses, whitespace does not', async () => {
    await env.accessor.claimTask('T001', {
      sessionId: 'ses_author',
      agentId: 'agent-author',
      mode: 'acquire',
    });
    await bindTestSession(env);
    vi.stubEnv('CLEO_AGENT_ID', 'agent-reviewer');
    const link = (body = parentPr.body) =>
      reviewedDirectiveLinkage(7, body, HEAD, env.tempDir, 'T001');
    expect(await link()).toBe(false);
    for (const ac of ['AC1', 'AC2']) {
      const packet = await buildReviewPacket(env.tempDir, 7, 'T001', stubGh([HEAD]));
      await recordReviewVerdict(
        env.tempDir,
        {
          prNumber: 7,
          taskId: 'T001',
          ac,
          verdict: 'met',
          reason: 'The parent PR delivers it.',
          packetSha256: packet.packetSha256,
        },
        { deps: stubGh([HEAD]) },
      );
    }
    expect(await link()).toBe(true);
    // No line naming the task links nothing, whatever the verdicts.
    expect(await link('Parent work, no lines.')).toBe(false);
    expect(await link('Closes: T002 AC1')).toBe(false);
    const rewrite = async (text: string) => {
      const row = (await env.accessor.getAcRows('T001')).find((r) => r.ordinal === 2);
      if (row === undefined) throw new Error('AC2 row missing');
      await env.accessor.transaction(async (tx) => {
        await tx.updateAcRows([
          {
            id: row.id,
            taskId: 'T001',
            ordinal: 2,
            text,
            kind: 'text',
            sourceKey: 'direct:2',
            targetTaskId: null,
            projection: 'legacy',
          },
        ]);
      });
    };
    await rewrite('  a negative limit is rejected   with E_VALIDATION ');
    expect(await link()).toBe(true);
    await rewrite('a negative or zero limit is rejected with E_VALIDATION');
    expect(await link()).toBe(false);
  });
});
