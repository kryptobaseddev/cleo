/**
 * Reviewer dispatch (T14372): one dispatch per routine PR head lacking
 * verdicts, recorded with the PR number and head; a new head dispatches again;
 * lead-reserved PRs are never dispatched; the dispatched reviewer is refused
 * when it is an author; shadow verdicts never count but are compared.
 *
 * GitHub is a stub; the task store is a real temp store.
 *
 * @task T14372
 */

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOUND_TEST_SESSION_ID,
  bindTestSession,
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '../../store/__tests__/test-db-helper.js';
import type { TrainPr } from '../merge-train.js';
import {
  changedFilesOfDiff,
  classifyReviewRoute,
  REVIEW_DISPATCH_ACTION,
  type ReviewDispatchDeps,
  reviewerAgentId,
  runReviewDispatch,
} from '../review-dispatch.js';
import { buildReviewPacket, checkPrReviews, recordReviewVerdict } from '../review-verdict.js';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

const fileDiff = (path: string, deleted = false): string =>
  [
    `diff --git a/${path} b/${path}`,
    ...(deleted ? ['deleted file mode 100644', `--- a/${path}`, '+++ /dev/null'] : []),
    ...(deleted ? [] : [`--- a/${path}`, `+++ b/${path}`]),
    '@@ -1 +1 @@',
    '-old',
    ...(deleted ? [] : ['+new']),
    '',
  ].join('\n');

const ROUTINE = fileDiff('packages/core/src/list.ts') + fileDiff('.changeset/list.md');

let env: TestDbEnv;

/** A stub GitHub: one open PR whose head and diff the test can change. */
function stub(pr: { head: string; diff: string; body?: string }): ReviewDispatchDeps {
  const open = (): TrainPr => ({
    number: 7,
    headSha: pr.head,
    isDraft: false,
    body: pr.body ?? 'Closes: T001 AC1,AC2',
    labels: [],
    baseRef: 'main',
  });
  return {
    openPrs: async () => [open()],
    review: { prHead: async () => pr.head, prDiff: async () => pr.diff },
  };
}

async function dispatchRows(): Promise<Array<Record<string, unknown>>> {
  const rows = await env.accessor.queryAuditLog({
    taskIds: ['T001'],
    actions: [REVIEW_DISPATCH_ACTION],
  });
  return rows.map((r) => JSON.parse(r.detailsJson ?? '{}') as Record<string, unknown>);
}

beforeEach(async () => {
  env = await createTestDb();
  await seedTasks(env.accessor, [
    {
      id: 'T001',
      title: 'list --limit',
      type: 'task',
      status: 'pending',
      priority: 'medium',
      createdAt: new Date().toISOString(),
    },
  ]);
  await env.accessor.transaction(async (tx) => {
    await tx.insertAcRows(
      ['list accepts a limit option', 'a negative limit is rejected'].map((text, i) => ({
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
  await env.accessor.claimTask('T001', {
    sessionId: 'ses_author',
    agentId: 'agent-author',
    mode: 'acquire',
  });
});

afterEach(async () => {
  await env.cleanup();
  vi.unstubAllEnvs();
});

describe('classifyReviewRoute (T14372)', () => {
  const route = (diff: string) => classifyReviewRoute(changedFilesOfDiff(diff));

  it('a source change with a changeset is routine', () => {
    expect(route(ROUTINE)).toEqual({ route: 'routine', reasons: [] });
  });

  it.each([
    ['migration', 'packages/core/migrations/drizzle-tasks/20261110_x/migration.sql'],
    ['store-sync', 'packages/core/src/store/sync/apply/rows.ts'],
    ['store-sync', 'packages/core/src/store/data-accessor.ts'],
    ['gate', 'scripts/lint-paths-ssot.mjs'],
    ['gate', 'scripts/.lint-cli-boundary-baseline.json'],
    ['gate', '.github/workflows/ci.yml'],
    ['evidence', 'packages/core/src/tasks/evidence.ts'],
    ['evidence', 'packages/core/src/tasks/review-verdict.ts'],
    ['evidence', 'packages/core/src/lifecycle/verification/explain.ts'],
  ])('a %s path (%s) is lead-reserved', (kind, path) => {
    const r = route(ROUTINE + fileDiff(path));
    expect(r.route).toBe('lead');
    expect(r.reasons).toContainEqual({ kind, path });
  });

  it('a deleted file is lead-reserved, a deleted changeset is not', () => {
    expect(route(fileDiff('packages/core/src/old.ts', true)).reasons).toEqual([
      { kind: 'deletion', path: 'packages/core/src/old.ts' },
    ]);
    expect(route(fileDiff('.changeset/old.md', true)).route).toBe('routine');
  });
});

describe('runReviewDispatch (T14372)', () => {
  it('AC1: a PR missing verdicts gets exactly one dispatch, recorded with PR number and head sha', async () => {
    const gh = stub({ head: HEAD, diff: ROUTINE });
    const first = await runReviewDispatch(env.tempDir, { execute: true }, gh);
    expect(first.decisions).toHaveLength(1);
    expect(first.decisions[0]).toMatchObject({ prNumber: 7, headSha: HEAD, action: 'dispatch' });
    expect(first.decisions[0]?.brief).toContain(`--agent ${reviewerAgentId(7, HEAD)}`);
    expect(first.decisions[0]?.brief).toContain('cleo review packet 7 --task T001');
    expect(await dispatchRows()).toEqual([
      expect.objectContaining({
        prNumber: 7,
        headSha: HEAD,
        taskId: 'T001',
        acs: ['AC1', 'AC2'],
        mode: 'counted',
        reviewerAgentId: 'reviewer-pr7-aaaaaaa',
      }),
    ]);
    const again = await runReviewDispatch(env.tempDir, { execute: true }, gh);
    expect(again.decisions[0]?.action).toBe('dispatched-already');
    expect(await dispatchRows()).toHaveLength(1);
  });

  it('AC3: a changed head re-dispatches; the unchanged head does not', async () => {
    const pr = { head: HEAD, diff: ROUTINE };
    const gh = stub(pr);
    await runReviewDispatch(env.tempDir, { execute: true }, gh);
    await runReviewDispatch(env.tempDir, { execute: true }, gh);
    expect(await dispatchRows()).toHaveLength(1);
    pr.head = NEXT;
    const moved = await runReviewDispatch(env.tempDir, { execute: true }, gh);
    expect(moved.decisions[0]).toMatchObject({ headSha: NEXT, action: 'dispatch' });
    expect((await dispatchRows()).map((d) => d.headSha).sort()).toEqual([HEAD, NEXT]);
  });

  it('a dry run decides the same and records nothing', async () => {
    const r = await runReviewDispatch(env.tempDir, {}, stub({ head: HEAD, diff: ROUTINE }));
    expect(r).toMatchObject({ dryRun: true, ran: true });
    expect(r.decisions[0]?.action).toBe('dispatch');
    expect(await dispatchRows()).toEqual([]);
  });

  it('a lead-reserved PR is never dispatched', async () => {
    const diff = ROUTINE + fileDiff('packages/core/src/store/sync/merge/rows.ts');
    const r = await runReviewDispatch(env.tempDir, { execute: true }, stub({ head: HEAD, diff }));
    expect(r.decisions[0]).toMatchObject({ action: 'lead', routing: { route: 'lead' } });
    expect(r.decisions[0]?.reason).toContain(
      'store-sync packages/core/src/store/sync/merge/rows.ts',
    );
    expect(await dispatchRows()).toEqual([]);
  });

  it('a PR whose head has a verdict on every criterion is not dispatched', async () => {
    await bindTestSession(env);
    vi.stubEnv('CLEO_AGENT_ID', reviewerAgentId(7, HEAD));
    const review = { prHead: async () => HEAD, prDiff: async () => ROUTINE };
    const packet = await buildReviewPacket(env.tempDir, 7, 'T001', review);
    for (const ac of ['AC1', 'AC2'])
      await recordReviewVerdict(
        env.tempDir,
        {
          prNumber: 7,
          taskId: 'T001',
          ac,
          verdict: ac === 'AC1' ? 'met' : 'unmet',
          reason: 'judged from the diff',
          packetSha256: packet.packetSha256,
        },
        { deps: review },
      );
    const r = await runReviewDispatch(
      env.tempDir,
      { execute: true },
      stub({ head: HEAD, diff: ROUTINE }),
    );
    expect(r.decisions[0]).toMatchObject({ action: 'skip' });
    expect(r.decisions[0]?.reason).toMatch(/every criterion has a verdict/);
  });
});

describe('the dispatched reviewer (T14372)', () => {
  const review = { prHead: async () => HEAD, prDiff: async () => ROUTINE };
  const record = async (shadow: boolean) => {
    const packet = await buildReviewPacket(env.tempDir, 7, 'T001', review);
    return recordReviewVerdict(
      env.tempDir,
      {
        prNumber: 7,
        taskId: 'T001',
        ac: 'AC1',
        verdict: 'met',
        reason: 'the diff adds the option',
        packetSha256: packet.packetSha256,
        shadow,
      },
      { deps: review },
    );
  };

  it('AC2: a reviewer whose session authored the task is refused, counted or shadow; its own session records', async () => {
    await bindTestSession(env);
    await env.accessor.unclaimTask('T001', { sessionId: 'ses_author' });
    await env.accessor.claimTask('T001', {
      sessionId: BOUND_TEST_SESSION_ID,
      agentId: null,
      mode: 'acquire',
    });
    vi.stubEnv('CLEO_AGENT_ID', reviewerAgentId(7, HEAD));
    await expect(record(false)).rejects.toThrow(/is an author of T001/);
    await expect(record(true)).rejects.toThrow(/is an author of T001/);

    await bindTestSession(env, 'ses_20261110000000_c0c0c0');
    const v = await record(false);
    expect(v.reviewer).toEqual({
      sessionId: 'ses_20261110000000_c0c0c0',
      agentId: 'reviewer-pr7-aaaaaaa',
    });
    expect(v.authors.sessionIds).not.toContain(v.reviewer.sessionId);
  });

  it('shadow mode: the brief asks for shadow verdicts, which never count but are compared', async () => {
    const gh = stub({ head: HEAD, diff: ROUTINE });
    const r = await runReviewDispatch(env.tempDir, { execute: true, shadow: true }, gh);
    expect(r.mode).toBe('shadow');
    expect(r.decisions[0]?.brief).toContain('--shadow');
    expect((await dispatchRows())[0]).toMatchObject({ mode: 'shadow', headSha: HEAD });

    await bindTestSession(env);
    vi.stubEnv('CLEO_AGENT_ID', reviewerAgentId(7, HEAD));
    expect(await record(true)).toMatchObject({ shadow: true, verdict: 'met' });
    const [check] = await checkPrReviews(env.tempDir, 7, ['T001'], { deps: review });
    expect(check?.met).toEqual([]);
    expect(check?.gaps.map((g) => g.kind)).toEqual(['missing', 'missing']);
    expect(check?.shadow).toEqual([
      { ac: 'AC1', lead: null, shadow: 'met', agree: false },
      { ac: 'AC2', lead: null, shadow: null, agree: false },
    ]);
    // A counted verdict that matches shows agreement.
    await bindTestSession(env, 'ses_20261110000000_d0d0d0');
    vi.stubEnv('CLEO_AGENT_ID', 'agent-lead');
    await record(false);
    const [after] = await checkPrReviews(env.tempDir, 7, ['T001'], { deps: review });
    expect(after?.shadow?.[0]).toEqual({ ac: 'AC1', lead: 'met', shadow: 'met', agree: true });
    // A shadow dispatch on this head is not repeated; the counted mode is separate.
    const again = await runReviewDispatch(env.tempDir, { execute: true, shadow: true }, gh);
    expect(again.decisions[0]?.action).toBe('dispatched-already');
  });
});
