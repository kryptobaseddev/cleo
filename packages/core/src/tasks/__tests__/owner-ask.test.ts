/**
 * `cleo ask` parks a task on an owner question and the asker continues;
 * `cleo ask answer` resumes it (T14302, D11232).
 *
 * @task T14302
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER_SESSION_MARK } from '../../security/owner-override-auth.js';
import {
  bindTestSession,
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '../../store/__tests__/test-db-helper.js';
import { getBrainAccessor } from '../../store/memory-accessor.js';
import { setSessionOwnerAuthToken } from '../../store/session-store.js';
import {
  answerOwner,
  askOwner,
  listOpenOwnerQuestions,
  listOwnerAnswersSince,
  type OwnerQuestionRequest,
} from '../owner-ask.js';
import { coreTaskNext } from '../task-next.js';
import { updateTask } from '../update.js';

let env: TestDbEnv;

const ASKER = 'ses_20261105000000_a5a5a5';
const RELAY = 'ses_20261105000000_7e7e7e';
const OWNER = 'ses_20261105000000_0000ee';

/** A headless harness: a bound CLEO session and no provider session key. */
const headless = (session: string) => ({ CLEO_SESSION_ID: session });
/** A Claude Code harness, whose ask tool is AskUserQuestion. */
const claudeCode = (session: string) => ({
  CLEO_SESSION_ID: session,
  CLAUDE_CODE_SESSION_ID: 'cc-session',
});

const request: OwnerQuestionRequest = {
  question: 'Which store keeps the cache?',
  options: [
    { label: 'SQLite', description: 'One file, no new service; slower fan-out' },
    { label: 'Redis', description: 'Fast fan-out; one more service to run' },
  ],
  recommended: 'SQLite',
};

beforeEach(async () => {
  env = await createTestDb();
  vi.stubEnv('CLEO_DIR', env.cleoDir);
  for (const id of [ASKER, RELAY, OWNER]) await bindTestSession(env, id);
  await setSessionOwnerAuthToken(OWNER, OWNER_SESSION_MARK, env.tempDir);
  await seedTasks(env.accessor, [
    { id: 'T001', title: 'Pick the cache store', status: 'pending', priority: 'critical' },
    { id: 'T002', title: 'Write the importer', status: 'pending', priority: 'low' },
  ]);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await env.cleanup();
});

describe('cleo ask', () => {
  it('AC5: a headless asker parks the task, gets the next one, and the answer makes the first ready', async () => {
    expect((await coreTaskNext(env.tempDir, { brain: false })).suggestions[0]?.id).toBe('T001');

    const asked = await askOwner(env.tempDir, 'T001', request, headless(ASKER));

    const parked = await env.accessor.loadSingleTask('T001');
    expect(parked?.status).toBe('blocked');
    expect(parked?.labels).toContain('owner-decision');
    expect(parked?.blockedBy).toBe(`owner decision ${asked.decisionId}`);
    const next = await coreTaskNext(env.tempDir, { count: 5, brain: false });
    expect(next.suggestions.map((s) => s.id)).toEqual(['T002']);

    const open = await listOpenOwnerQuestions(env.tempDir);
    expect(open).toEqual([
      expect.objectContaining({
        decisionId: asked.decisionId,
        taskId: 'T001',
        question: request.question,
        options: ['SQLite', 'Redis'],
      }),
    ]);
    const question = await (await getBrainAccessor(env.tempDir)).getDecision(asked.decisionId);
    expect(question).toMatchObject({ confirmationState: 'proposed', decidedBy: 'agent' });

    const answered = await answerOwner(
      env.tempDir,
      { decisionId: asked.decisionId, option: 'sqlite', via: 'ask-tool' },
      claudeCode(RELAY),
    );

    expect(answered).toMatchObject({ taskId: 'T001', option: 'SQLite' });
    expect(answered.answeredBy).toEqual({ via: 'ask-tool', session: RELAY });
    const resumed = await env.accessor.loadSingleTask('T001');
    expect(resumed?.status).toBe('pending');
    expect(resumed?.labels ?? []).not.toContain('owner-decision');
    expect(resumed?.blockedBy ?? null).toBeNull();
    expect((await coreTaskNext(env.tempDir, { brain: false })).suggestions[0]?.id).toBe('T001');

    const brain = await getBrainAccessor(env.tempDir);
    expect(await brain.getDecision(answered.decisionId)).toMatchObject({
      decidedBy: 'owner',
      confirmationState: 'accepted',
      supersedes: asked.decisionId,
    });
    expect((await brain.getDecision(answered.decisionId))?.rationale).toContain(
      `Answered via ask-tool, recorded by session ${RELAY}`,
    );
    expect(await listOpenOwnerQuestions(env.tempDir)).toEqual([]);
    expect(
      (await listOwnerAnswersSince(env.tempDir, '2000-01-01T00:00:00.000Z')).map(
        (a) => a.decisionId,
      ),
    ).toEqual([answered.decisionId]);
  });

  it('refuses a malformed question before anything is written', async () => {
    await expect(
      askOwner(env.tempDir, 'T001', { ...request, recommended: 'Postgres' }, headless(ASKER)),
    ).rejects.toThrow(/not one of the option labels/);
    await expect(
      askOwner(
        env.tempDir,
        'T001',
        { ...request, options: request.options.slice(0, 1) },
        headless(ASKER),
      ),
    ).rejects.toThrow(/give 2-4/);
    await expect(askOwner(env.tempDir, 'T999', request, headless(ASKER))).rejects.toThrow(
      /T999 not found/,
    );
    expect((await env.accessor.loadSingleTask('T001'))?.status).toBe('pending');
    expect(await listOpenOwnerQuestions(env.tempDir)).toEqual([]);
  });
});

describe('cleo ask answer authority (D11232)', () => {
  it('the asking session with no ask tool may not relay; an owner-marked session answers without --via', async () => {
    const { decisionId } = await askOwner(env.tempDir, 'T001', request, headless(ASKER));

    await expect(
      answerOwner(env.tempDir, { decisionId, option: 'Redis', via: 'ask-tool' }, headless(ASKER)),
    ).rejects.toThrow(/has no ask tool/);
    await expect(
      answerOwner(env.tempDir, { decisionId, option: 'Redis' }, headless(RELAY)),
    ).rejects.toThrow(/Only an owner-marked session/);
    expect((await env.accessor.loadSingleTask('T001'))?.status).toBe('blocked');

    const answered = await answerOwner(
      env.tempDir,
      { decisionId, option: 'Redis' },
      headless(OWNER),
    );
    expect(answered.answeredBy).toEqual({ via: 'owner-session', session: OWNER });
    await expect(
      answerOwner(env.tempDir, { decisionId, option: 'Redis' }, headless(OWNER)),
    ).rejects.toThrow(/already superseded/);
  });

  it('the asking session may relay when its harness has an ask tool; mbx relays need the message id', async () => {
    const { decisionId } = await askOwner(env.tempDir, 'T001', request, claudeCode(ASKER));
    await expect(
      answerOwner(env.tempDir, { decisionId, option: 'Redis', via: 'mbx-owner' }, headless(RELAY)),
    ).rejects.toThrow(/needs --source/);
    await expect(
      answerOwner(env.tempDir, { decisionId, option: 'Mongo', via: 'ask-tool' }, claudeCode(ASKER)),
    ).rejects.toThrow(/is not an option/);
    const answered = await answerOwner(
      env.tempDir,
      { decisionId, option: 'Redis', via: 'ask-tool' },
      claudeCode(ASKER),
    );
    expect(answered.answeredBy).toEqual({ via: 'ask-tool', session: ASKER });
  });

  it('refuses to resume a task whose label was removed by hand', async () => {
    const { decisionId } = await askOwner(env.tempDir, 'T001', request, headless(ASKER));
    await updateTask({ taskId: 'T001', removeLabels: ['owner-decision'] }, env.tempDir);
    await expect(
      answerOwner(env.tempDir, { decisionId, option: 'Redis' }, headless(OWNER)),
    ).rejects.toThrow(/no longer carries the owner-decision label/);
  });
});
