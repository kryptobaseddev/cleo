/**
 * `cleo doctor row-identity --refill` (T13231): the explicit from-scratch
 * identity refill of a Nexus-linked store, decided by asking Cleo Nexus.
 * Nexus is always a mock here: has a checkpoint, has none, offline.
 *
 * @task T13231
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { RowIdentityNexusAnswer } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NexusError } from '../../cloud/http.js';
import {
  askNexusProjectHistory,
  type NexusStreamReader,
  nexusStreamHistory,
} from '../../cloud/nexus-project-history.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { prepareRowIdentity, ROW_IDENTITY_RECIPE_KEY } from '../../store/row-identity.js';
import { getNativeTasksDb } from '../../store/sqlite.js';
import { rowIdentityRefill } from '../row-identity-refill.js';

const BOGUS_REL = '00000000-0000-8000-8000-0000000000a1';
const API = 'https://api.nexus.test';

const answer = (a: Partial<RowIdentityNexusAnswer>): RowIdentityNexusAnswer => ({
  apiUrl: API,
  remoteProjectId: 'p1',
  streamId: 'project:p1',
  answer: 'none',
  checkpoints: 0,
  headSeq: 0,
  ...a,
});

describe('cleo doctor row-identity --refill (T13231)', () => {
  let env: TestDbEnv;
  let db: DatabaseSync;
  const relUid = () =>
    (
      db
        .prepare(
          "SELECT uid FROM tasks_task_relations WHERE task_id = 'T001' AND related_to = 'T002'",
        )
        .get() as { uid: string | null } | undefined
    )?.uid ?? null;

  beforeEach(async () => {
    process.env.CLEO_ROW_UID_FILL = '1';
    env = await createTestDb();
    vi.stubEnv('CLEO_HOME', join(env.tempDir, 'cleo-home'));
    mkdirSync(join(env.tempDir, 'cleo-home'), { recursive: true });
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'One', type: 'task' },
      { id: 'T002', title: 'Two', type: 'task' },
    ]);
    const native = getNativeTasksDb(env.tempDir);
    if (!native) throw new Error('no native handle');
    db = native;
    db.exec(
      "INSERT INTO tasks_task_relations (task_id, related_to, relation_type) VALUES ('T001', 'T002', 'related')",
    );
    prepareRowIdentity(db, 'project');
    writeFileSync(
      join(env.cleoDir, 'nexus-link.json'),
      JSON.stringify({
        version: 1,
        links: {
          [API]: {
            apiUrl: API,
            localProjectId: 'p1',
            remoteProjectId: 'p1',
            organizationId: 'o1',
            label: null,
            streamId: 'project:p1',
            linkedAt: '2026-09-30T00:00:00Z',
          },
        },
      }),
    );
    // The pre-release state: a kept uid, marker gone.
    db.prepare("UPDATE tasks_task_relations SET uid = ? WHERE task_id = 'T001'").run(BOGUS_REL);
    db.exec(`DELETE FROM tasks_row_identity_meta WHERE key = '${ROW_IDENTITY_RECIPE_KEY}'`);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await env.cleanup();
    delete process.env.CLEO_ROW_UID_FILL;
  });

  it('locally, a linked store with no vault record is unknown', async () => {
    const report = await rowIdentityRefill(env.tempDir, { probe: async () => [] });
    expect(report.local.state).toBe('unknown');
    expect(report.local.signals.map((s) => s.code)).toEqual(['nexus-linked-no-vault']);
    expect(report.action).toBe('refuse');
  });

  it('Nexus holds a checkpoint: shared, refused, and the remedy names the T12344 re-key', async () => {
    const probe = async () => [answer({ answer: 'present', checkpoints: 2, headSeq: 7 })];
    const report = await rowIdentityRefill(env.tempDir, { apply: true, probe });
    expect(report.verdict.state).toBe('shared');
    expect(report.verdict.signals.map((s) => s.code)).toContain('nexus-checkpoint');
    expect(report.action).toBe('refuse');
    expect(report.remedy.join(' ')).toMatch(/T12344/);
    expect(report.applied).toBe(false);
    expect(relUid()).toBe(BOGUS_REL);
  });

  it('Nexus offline: unknown, refused', async () => {
    const probe = async () => [answer({ answer: 'error', error: 'fetch failed' })];
    const report = await rowIdentityRefill(env.tempDir, { apply: true, probe });
    expect(report.verdict.state).toBe('unknown');
    // The local unknown stays: only an all-"none" answer resolves it.
    expect(report.verdict.signals.map((s) => s.code)).toEqual([
      'nexus-linked-no-vault',
      'nexus-unreachable',
    ]);
    expect(report.applied).toBe(false);
    expect(relUid()).toBe(BOGUS_REL);
  });

  it('Nexus holds nothing: the dry run plans the refill and writes nothing', async () => {
    const report = await rowIdentityRefill(env.tempDir, { probe: async () => [answer({})] });
    expect(report.verdict.state).toBe('unshared');
    expect(report.action).toBe('refill');
    expect(report.planned.tasks_task_relations).toBe(1);
    expect(report.applied).toBe(false);
    expect(report.snapshot).toBeNull();
    expect(relUid()).toBe(BOGUS_REL);
  });

  it('Nexus holds nothing: --apply snapshots, refills and prints the undo', async () => {
    const report = await rowIdentityRefill(env.tempDir, {
      apply: true,
      probe: async () => [answer({})],
    });
    expect(report.applied).toBe(true);
    expect(report.snapshot && existsSync(report.snapshot)).toBe(true);
    expect(report.undo).toContain(String(report.snapshot));
    expect(report.undo).toMatch(/^STOP EVERY cleo PROCESS FIRST/);
    expect(relUid()).not.toBe(BOGUS_REL);
    expect(relUid()).not.toBeNull();
  });

  it('one origin answering "none" does not resolve another that failed', async () => {
    const probe = async () => [
      answer({}),
      answer({ apiUrl: 'https://other.test', answer: 'error', error: 'timeout' }),
    ];
    const report = await rowIdentityRefill(env.tempDir, { apply: true, probe });
    expect(report.verdict.state).toBe('unknown');
    expect(report.applied).toBe(false);
  });

  it('--apply is refused while row uids are off in the process', async () => {
    process.env.CLEO_ROW_UID_FILL = '0';
    const report = await rowIdentityRefill(env.tempDir, {
      apply: true,
      probe: async () => [answer({})],
    });
    expect(report.action).toBe('refill');
    expect(report.applied).toBe(false);
    expect(report.remedy.join(' ')).toMatch(/CLEO_ROW_UID_FILL=1/);
    expect(relUid()).toBe(BOGUS_REL);
  });

  it('asks every linked origin; a failing connection is an error answer, never "none"', async () => {
    const answers = await askNexusProjectHistory(env.tempDir, {
      readerFor: async () => {
        throw new Error('not signed in');
      },
    });
    expect(answers).toEqual([
      expect.objectContaining({ apiUrl: API, answer: 'error', error: 'not signed in' }),
    ]);
  });
});

describe('nexusStreamHistory (T13231)', () => {
  const base = '/v1/streams/project%3Ap1';
  /** A fake cleo-nexus: routes answer a body, or fail like the server does. */
  const reader = (routes: Record<string, object | NexusError>): NexusStreamReader => ({
    async raw(_method, path, schema) {
      const body = routes[path];
      if (body === undefined) throw new NexusError('E_INTERNAL', 'HTTP 404', 404, null);
      if (body instanceof NexusError) throw body;
      const parsed = schema.safeParse(body);
      if (!parsed.success || parsed.data === undefined) throw new Error(`bad body for ${path}`);
      return parsed.data;
    },
  });
  const notFound = (what: string) => new NexusError('E_NOT_FOUND', `${what} not found`, 404, 'r1');

  it("the server's explicit 'stream not found' (a visible project, no stream) holds nothing", async () => {
    expect(await nexusStreamHistory(reader({ [base]: notFound('stream') }), 'project:p1')).toEqual({
      checkpoints: 0,
      headSeq: 0,
    });
  });

  it("'project not found' (a non-member: the server hides the project) is not 'none'", async () => {
    await expect(
      nexusStreamHistory(reader({ [base]: notFound('project') }), 'project:p1'),
    ).rejects.toThrow(/project not found/);
  });

  it('a bare 404 (an unknown route) is not "none"', async () => {
    await expect(nexusStreamHistory(reader({}), 'project:p1')).rejects.toThrow(/HTTP 404/);
  });

  it('a stream with no checkpoint and head 0 holds nothing', async () => {
    const r = reader({
      [base]: { streamId: 'project:p1', headSeq: 0, headCheckpointId: null },
      [`${base}/checkpoints`]: { checkpoints: [] },
    });
    expect(await nexusStreamHistory(r, 'project:p1')).toEqual({ checkpoints: 0, headSeq: 0 });
  });

  it('a head checkpoint counts; an unavailable checkpoint list is not "none"', async () => {
    const r = reader({ [base]: { streamId: 'project:p1', headSeq: 0, headCheckpointId: 'cp-1' } });
    await expect(nexusStreamHistory(r, 'project:p1')).rejects.toThrow(/HTTP 404/);
    const withList = reader({
      [base]: { streamId: 'project:p1', headSeq: 0, headCheckpointId: 'cp-1' },
      [`${base}/checkpoints`]: { checkpoints: [] },
    });
    expect(await nexusStreamHistory(withList, 'project:p1')).toEqual({
      checkpoints: 1,
      headSeq: 0,
    });
  });

  it('journal segments without a checkpoint count through the head sequence', async () => {
    const r = reader({
      [base]: { streamId: 'project:p1', headSeq: 4, headCheckpointId: null },
      [`${base}/checkpoints`]: { checkpoints: [] },
    });
    expect(await nexusStreamHistory(r, 'project:p1')).toEqual({ checkpoints: 0, headSeq: 4 });
  });
});
