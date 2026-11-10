/**
 * Reviewer dispatch (T14372): shadow by default and counted mode gated; one
 * dispatch per routine PR head lacking verdicts, recorded with the PR number,
 * head sha and the reviewer's own session; a new head dispatches again, up to
 * a cap; lead-reserved and unreadable file lists are never dispatched; a
 * worker's verdict binds to its dispatch and cannot be forged; shadow
 * verdicts never count and are compared only with the lead's.
 *
 * GitHub is a stub; the task store is a real temp store.
 *
 * @task T14372
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindTestSession,
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '../../store/__tests__/test-db-helper.js';
import { getSession } from '../../store/session-store.js';
import type { TrainPr } from '../merge-train.js';
import {
  classifyReviewRoute,
  MAX_REVIEW_DISPATCHES_PER_PR,
  type PrFile,
  type PrFileList,
  REVIEW_DISPATCH_ACTION,
  type ReviewDispatchDeps,
  runReviewDispatch,
} from '../review-dispatch.js';
import {
  buildReviewPacket,
  checkPrReviews,
  REVIEW_SECRET_ENV,
  REVIEW_SECRET_FILE_ENV,
  recordReviewVerdict,
} from '../review-verdict.js';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);

/** The diff the review packet reads; routing reads the file list, never this. */
const DIFF = [
  'diff --git a/packages/core/src/list.ts b/packages/core/src/list.ts',
  '--- a/packages/core/src/list.ts',
  '+++ b/packages/core/src/list.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

const mod = (path: string): PrFile => ({ path, status: 'modified' });
const list = (...files: PrFile[]): PrFileList => ({ files, changedFiles: files.length });
const ROUTINE = list(mod('packages/core/src/list.ts'), {
  path: '.changeset/list.md',
  status: 'added',
});

let env: TestDbEnv;

/** A stub GitHub: one open PR whose head and files the test can change. */
function stub(pr: { head: string; files?: PrFileList; counted?: boolean }): ReviewDispatchDeps {
  const open = (): TrainPr => ({
    number: 7,
    headSha: pr.head,
    isDraft: false,
    body: 'Closes: T001 AC1,AC2',
    labels: [],
    baseRef: 'main',
  });
  return {
    openPrs: async () => [open()],
    prFiles: async () => pr.files ?? ROUTINE,
    review: { prHead: async () => pr.head, prDiff: async () => DIFF },
    countedEnabled: async () => pr.counted === true,
  };
}

const review = { prHead: async () => HEAD, prDiff: async () => DIFF };

async function dispatchRows(): Promise<Array<Record<string, unknown>>> {
  const rows = await env.accessor.queryAuditLog({
    taskIds: ['T001'],
    actions: [REVIEW_DISPATCH_ACTION],
  });
  return rows.map((r) => JSON.parse(r.detailsJson ?? '{}') as Record<string, unknown>);
}

/** Run as this session and agent, with this per-dispatch secret (the reviewer's environment). */
function actAs(sessionId: string, agentId: string, secret = ''): void {
  vi.stubEnv('CLEO_SESSION_ID', sessionId);
  vi.stubEnv('CLEO_AGENT_ID', agentId);
  vi.stubEnv(REVIEW_SECRET_ENV, secret);
  vi.stubEnv(REVIEW_SECRET_FILE_ENV, '');
}

/** Every file under `dir`, recursively. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

async function verdict(ac: string, v: 'met' | 'unmet', shadow: boolean) {
  const packet = await buildReviewPacket(env.tempDir, 7, 'T001', review);
  return recordReviewVerdict(
    env.tempDir,
    {
      prNumber: 7,
      taskId: 'T001',
      ac,
      verdict: v,
      reason: 'judged from the diff',
      packetSha256: packet.packetSha256,
      shadow,
    },
    { deps: review },
  );
}

/** Dispatch at HEAD and return the reviewer's session, agent id and secret. */
async function dispatchAt(counted = false): Promise<{
  session: string;
  agent: string;
  secret: string;
  secretFile: string;
  brief: string;
  decision: unknown;
}> {
  const r = await runReviewDispatch(
    env.tempDir,
    { execute: true, counted },
    stub({ head: HEAD, counted }),
  );
  const d = r.decisions[0]?.dispatches?.[0];
  const secretFile = r.decisions[0]?.reviewerSecretFile;
  if (d === undefined || secretFile === undefined)
    throw new Error(`no dispatch: ${r.decisions[0]?.reason}`);
  return {
    session: d.reviewerSessionId,
    agent: d.reviewerAgentId,
    secret: readFileSync(secretFile, 'utf-8'),
    secretFile,
    brief: r.decisions[0]?.brief ?? '',
    decision: r.decisions[0],
  };
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
  it('a source change with a changeset is routine', () => {
    expect(classifyReviewRoute(ROUTINE)).toEqual({ route: 'routine', reasons: [] });
  });

  it.each([
    ['migration', 'packages/core/migrations/drizzle-tasks/20261110_x/migration.sql'],
    ['migration', 'packages/nexus/migrations/0001.ts'],
    ['store-sync', 'packages/core/src/store/sync/apply/rows.ts'],
    ['gate', 'scripts/lint-paths-ssot.mjs'],
    ['gate', '.github/workflows/ci.yml'],
    ['evidence', 'packages/core/src/tasks/evidence.ts'],
    ['evidence', 'packages/core/src/tasks/review-verdict.ts'],
    ['review-integrity', 'packages/contracts/src/review-verdict.ts'],
    ['review-integrity', 'packages/cleo/src/cli/commands/review.ts'],
    ['review-integrity', 'packages/core/src/sessions/terminal-identity.ts'],
    ['review-integrity', 'packages/core/src/task-work/claims.ts'],
    ['review-integrity', 'packages/core/templates/CLEO-INJECTION.md'],
    ['review-integrity', 'AGENTS.md'],
    ['review-integrity', '.cleo/project-context.json'],
  ])('a %s path (%s) is lead-reserved', (kind, path) => {
    const r = classifyReviewRoute(list(...ROUTINE.files, mod(path)));
    expect(r.route).toBe('lead');
    expect(r.reasons).toContainEqual({ kind, path });
  });

  it('a rename is judged by its old path and by its new path', () => {
    const out = classifyReviewRoute(
      list({
        path: 'packages/core/src/util/old-sessions.ts',
        status: 'renamed',
        previousPath: 'packages/core/src/sessions/handoff.ts',
      }),
    );
    expect(out.reasons).toEqual([
      { kind: 'review-integrity', path: 'packages/core/src/sessions/handoff.ts' },
    ]);
    const into = classifyReviewRoute(
      list({ path: 'scripts/lint-new.mjs', status: 'renamed', previousPath: 'tools/new.mjs' }),
    );
    expect(into.reasons).toEqual([{ kind: 'gate', path: 'scripts/lint-new.mjs' }]);
  });

  it('a deleted file is lead-reserved, a deleted changeset is not', () => {
    expect(
      classifyReviewRoute(list({ path: 'packages/core/src/old.ts', status: 'removed' })),
    ).toEqual({
      route: 'lead',
      reasons: [{ kind: 'deletion', path: 'packages/core/src/old.ts' }],
    });
    expect(classifyReviewRoute(list({ path: '.changeset/old.md', status: 'removed' })).route).toBe(
      'routine',
    );
  });

  it('paths with spaces and quotes are judged exactly as GitHub lists them', () => {
    expect(classifyReviewRoute(list(mod('packages/core/src/a "b" c.ts'))).route).toBe('routine');
    const quoted = `packages/core/src/sessions/it's "x".ts`;
    expect(classifyReviewRoute(list(mod(quoted))).reasons).toEqual([
      { kind: 'review-integrity', path: quoted },
    ]);
  });

  it('fails closed: an unknown status, a rename without its old path, a control character, or a truncated list', () => {
    const unread = (l: PrFileList) =>
      classifyReviewRoute(l).reasons.filter((r) => r.kind === 'unrecognised');
    expect(unread(list({ path: 'packages/core/src/x.ts', status: 'typechange' }))).toHaveLength(1);
    expect(unread(list({ path: 'packages/core/src/x.ts', status: 'renamed' }))).toHaveLength(1);
    expect(unread(list(mod('packages/core/src/x\n.ts')))).toHaveLength(1);
    expect(unread(list(mod('')))).toHaveLength(1);
    expect(unread({ files: ROUTINE.files, changedFiles: 3000 })).toEqual([
      { kind: 'unrecognised', path: 'file list has 2 entries, the PR reports 3000' },
    ]);
  });
});

describe('runReviewDispatch (T14372)', () => {
  it('AC1: a PR missing verdicts gets exactly one (shadow) dispatch, recorded with PR number, head sha and its own session', async () => {
    const gh = stub({ head: HEAD });
    const first = await runReviewDispatch(env.tempDir, { execute: true }, gh);
    expect(first.mode).toBe('shadow');
    expect(first.decisions[0]).toMatchObject({ prNumber: 7, headSha: HEAD, action: 'dispatch' });
    const [row] = await dispatchRows();
    expect(row).toMatchObject({
      prNumber: 7,
      headSha: HEAD,
      taskId: 'T001',
      acs: ['AC1', 'AC2'],
      mode: 'shadow',
      reviewerAgentId: 'reviewer-shadow-pr7-aaaaaaa',
    });
    const session = await getSession(String(row?.reviewerSessionId), env.tempDir);
    expect(session).toMatchObject({ status: 'active', agentHandle: 'reviewer-shadow-pr7-aaaaaaa' });
    const brief = first.decisions[0]?.brief ?? '';
    expect(brief).toContain(`CLEO_SESSION_ID=${row?.reviewerSessionId}`);
    expect(brief).toContain('--shadow');
    expect(brief).toMatch(/findings: T####,T####" .*or "findings: none"/);

    const again = await runReviewDispatch(env.tempDir, { execute: true }, gh);
    expect(again.decisions[0]?.action).toBe('dispatched-already');
    expect(await dispatchRows()).toHaveLength(1);
  });

  it('AC3: a changed head re-dispatches, the unchanged head does not, up to the per-PR cap', async () => {
    const pr = { head: HEAD };
    const gh = stub(pr);
    await runReviewDispatch(env.tempDir, { execute: true }, gh);
    await runReviewDispatch(env.tempDir, { execute: true }, gh);
    expect(await dispatchRows()).toHaveLength(1);
    pr.head = NEXT;
    const moved = await runReviewDispatch(env.tempDir, { execute: true }, gh);
    expect(moved.decisions[0]).toMatchObject({ headSha: NEXT, action: 'dispatch' });
    expect((await dispatchRows()).map((d) => d.headSha).sort()).toEqual([HEAD, NEXT]);
    pr.head = 'c'.repeat(40);
    await runReviewDispatch(env.tempDir, { execute: true }, gh);
    pr.head = 'd'.repeat(40);
    const capped = await runReviewDispatch(env.tempDir, { execute: true }, gh);
    expect(capped.decisions[0]?.action).toBe('skip');
    expect(capped.decisions[0]?.reason).toContain(`cap ${MAX_REVIEW_DISPATCHES_PER_PR}`);
    expect(await dispatchRows()).toHaveLength(MAX_REVIEW_DISPATCHES_PER_PR);
  });

  it('counted dispatch is refused while review.workers.counted is off, and allowed once the owner enables it', async () => {
    await expect(
      runReviewDispatch(env.tempDir, { execute: true, counted: true }, stub({ head: HEAD })),
    ).rejects.toThrow(/review\.workers\.counted is not true/);
    expect(await dispatchRows()).toEqual([]);
    const ok = await runReviewDispatch(
      env.tempDir,
      { execute: true, counted: true },
      stub({ head: HEAD, counted: true }),
    );
    expect(ok.mode).toBe('counted');
    expect((await dispatchRows())[0]).toMatchObject({
      mode: 'counted',
      reviewerAgentId: 'reviewer-counted-pr7-aaaaaaa',
    });
  });

  it('a dry run decides the same and records nothing', async () => {
    const r = await runReviewDispatch(env.tempDir, {}, stub({ head: HEAD }));
    expect(r).toMatchObject({ dryRun: true, ran: true });
    expect(r.decisions[0]?.action).toBe('dispatch');
    expect(r.decisions[0]?.dispatches?.[0]?.reviewerSessionId).toBe('');
    expect(await dispatchRows()).toEqual([]);
  });

  it('a lead-reserved or unreadable PR is never dispatched', async () => {
    const files = list(...ROUTINE.files, mod('packages/core/src/sessions/index.ts'));
    const r = await runReviewDispatch(env.tempDir, { execute: true }, stub({ head: HEAD, files }));
    expect(r.decisions[0]).toMatchObject({ action: 'lead', routing: { route: 'lead' } });
    const odd = list({ path: 'packages/core/src/x.ts', status: 'mystery' });
    const u = await runReviewDispatch(
      env.tempDir,
      { execute: true },
      stub({ head: HEAD, files: odd }),
    );
    expect(u.decisions[0]?.action).toBe('lead');
    expect(await dispatchRows()).toEqual([]);
  });

  it('a dispatcher that authored the task is refused', async () => {
    actAs('ses_author', 'agent-author');
    await bindTestSession(env, 'ses_author');
    const r = await runReviewDispatch(env.tempDir, { execute: true }, stub({ head: HEAD }));
    expect(r.decisions[0]?.action).toBe('skip');
    expect(r.decisions[0]?.reason).toMatch(/dispatcher is an author of T001/);
    expect(await dispatchRows()).toEqual([]);
  });
});

describe('the dispatched reviewer (T14372)', () => {
  it('AC2: the reviewer records under the session its dispatch created; an author session is refused', async () => {
    const { session, agent, secret } = await dispatchAt();
    actAs(session, agent, secret);
    const v = await verdict('AC1', 'met', true);
    expect(v).toMatchObject({ shadow: true, reviewer: { sessionId: session, agentId: agent } });
    expect(v.authors.sessionIds).not.toContain(session);
    // An author running with the reviewer's agent id is refused as an author.
    await bindTestSession(env, 'ses_author');
    actAs('ses_author', agent);
    await expect(verdict('AC2', 'met', true)).rejects.toThrow(/is an author of T001/);
  });

  it('the predictable reviewer id cannot be forged from a fresh session, nor the session used under another id', async () => {
    const { session, agent } = await dispatchAt();
    const forger = await bindTestSession(env, 'ses_20261110000000_f0f0f0');
    actAs(forger, agent);
    await expect(verdict('AC1', 'met', true)).rejects.toThrow(/No dispatch of T001/);
    actAs(forger, 'reviewer-counted-pr7-aaaaaaa');
    await expect(verdict('AC1', 'met', false)).rejects.toThrow(/No dispatch of T001/);
    actAs(session, 'agent-lead');
    await expect(verdict('AC1', 'met', false)).rejects.toThrow(/No dispatch of T001/);
  });

  it('a shadow-dispatched reviewer cannot record a counted verdict, and the lead cannot record shadow ones', async () => {
    const { session, agent, secret } = await dispatchAt();
    actAs(session, agent, secret);
    await expect(verdict('AC1', 'met', false)).rejects.toThrow(/dispatched in shadow mode/);
    const lead = await bindTestSession(env, 'ses_20261110000000_d0d0d0');
    actAs(lead, 'agent-lead');
    await expect(verdict('AC1', 'met', true)).rejects.toThrow(/No dispatch of T001/);
  });

  it('shadow verdicts never count, and are compared only with the lead’s, never a worker’s', async () => {
    const shadowWorker = await dispatchAt();
    actAs(shadowWorker.session, shadowWorker.agent, shadowWorker.secret);
    await verdict('AC1', 'met', true);
    await verdict('AC2', 'unmet', true);
    const [check] = await checkPrReviews(env.tempDir, 7, ['T001'], { deps: review });
    expect(check?.met).toEqual([]);
    expect(check?.gaps.map((g) => g.kind)).toEqual(['missing', 'missing']);

    // A counted worker's verdict counts toward the merge but is not the lead's.
    actAs('', '');
    const countedWorker = await dispatchAt(true);
    actAs(countedWorker.session, countedWorker.agent, countedWorker.secret);
    await verdict('AC1', 'met', false);
    const [byWorker] = await checkPrReviews(env.tempDir, 7, ['T001'], { deps: review });
    expect(byWorker?.met).toEqual(['AC1']);
    expect(byWorker?.shadow?.[0]).toEqual({ ac: 'AC1', lead: null, shadow: 'met', agree: false });

    const lead = await bindTestSession(env, 'ses_20261110000000_d0d0d0');
    actAs(lead, 'agent-lead');
    await verdict('AC2', 'unmet', false);
    const [after] = await checkPrReviews(env.tempDir, 7, ['T001'], { deps: review });
    expect(after?.shadow).toEqual([
      { ac: 'AC1', lead: null, shadow: 'met', agree: false },
      { ac: 'AC2', lead: 'unmet', shadow: 'unmet', agree: true },
    ]);
  });
});

describe('the per-dispatch secret (T14403)', () => {
  it('AC1: the dispatch session and agent id without the secret, or with a wrong one, are refused; the right one is accepted', async () => {
    const { session, agent, secret } = await dispatchAt();
    actAs(session, agent);
    await expect(verdict('AC1', 'met', true)).rejects.toThrow(/No per-dispatch secret/);
    actAs(session, agent, `${secret}x`);
    await expect(verdict('AC1', 'met', true)).rejects.toThrow(/The wrong per-dispatch secret/);
    const other = await runReviewDispatch(
      env.tempDir,
      { execute: true, counted: true },
      stub({ head: HEAD, counted: true }),
    );
    actAs(session, agent, readFileSync(String(other.decisions[0]?.reviewerSecretFile), 'utf-8'));
    await expect(verdict('AC1', 'met', true)).rejects.toThrow(/The wrong per-dispatch secret/);
    actAs(session, agent, secret);
    expect(await verdict('AC1', 'met', true)).toMatchObject({ shadow: true, ac: 'AC1' });
  });

  it('the reviewer reads the secret from the file its dispatch returned, mode 0600 in a 0700 directory', async () => {
    const { session, agent, secretFile } = await dispatchAt();
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(secretFile, '..')).mode & 0o777).toBe(0o700);
    actAs(session, agent);
    vi.stubEnv(REVIEW_SECRET_FILE_ENV, `${secretFile}.missing`);
    await expect(verdict('AC1', 'met', true)).rejects.toThrow(/No per-dispatch secret/);
    vi.stubEnv(REVIEW_SECRET_FILE_ENV, secretFile);
    expect(await verdict('AC1', 'met', true)).toMatchObject({ shadow: true, ac: 'AC1' });
  });

  it('AC2: the secret is stored only as its hash and never reaches an audit row, the brief, a file or a log', async () => {
    const writes: string[] = [];
    const capture = (chunk: string | Uint8Array): boolean => {
      writes.push(String(chunk));
      return true;
    };
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(capture);
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(capture);
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        writes.push(a.map(String).join(' '));
      }),
    );
    let secret = '';
    let secretFile = '';
    try {
      const d = await dispatchAt();
      secret = d.secret;
      secretFile = d.secretFile;
      // The dispatcher's envelope carries the path, never the secret.
      expect(JSON.stringify(d.decision)).not.toContain(secret);
      expect(d.brief).not.toContain(secret);
      expect(d.brief).toContain(`${REVIEW_SECRET_FILE_ENV}=${secretFile}`);
      actAs(d.session, d.agent);
      vi.stubEnv(REVIEW_SECRET_FILE_ENV, secretFile);
      await verdict('AC1', 'met', true);
      actAs(d.session, d.agent, 'wrong');
      vi.stubEnv(REVIEW_SECRET_FILE_ENV, '');
      await expect(verdict('AC2', 'met', true)).rejects.toThrow(/wrong per-dispatch secret/);
    } finally {
      out.mockRestore();
      err.mockRestore();
      for (const l of logs) l.mockRestore();
    }
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [row] = await dispatchRows();
    expect(row?.reviewerSecretSha256).toBe(createHash('sha256').update(secret).digest('hex'));
    const rows = await env.accessor.queryAuditLog({ taskIds: ['T001'] });
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(JSON.stringify(r)).not.toContain(secret);
    expect(writes.join('\n')).not.toContain(secret);
    // Nothing on disk but its own file (the store with its WAL, logs, config) holds the secret.
    const files = filesUnder(env.tempDir).filter((f) => f !== secretFile);
    expect(files.length).toBeGreaterThan(1);
    for (const file of files) expect(readFileSync(file).includes(secret), file).toBe(false);
  });
});
