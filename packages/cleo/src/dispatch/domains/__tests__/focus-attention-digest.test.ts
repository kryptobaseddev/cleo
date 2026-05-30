/**
 * Focus attention-digest injection tests (T11374 · Epic T11288).
 *
 * Drives the REAL {@link FocusHandler} against a real brain.db (+ tasks.db) via
 * {@link createTestDb}, seeds open attention jots for the calling agent, then
 * asserts `cleo focus <id>` carries the Tier-2 attention MVI digest with the
 * correct live count + `cleo attention show` expand hint, that the envelope
 * stays inside the ≤ 1500-token focus budget, and that the empty case omits the
 * digest without crashing.
 *
 * @task T11374
 * @epic T11288
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const projectRootRef = { current: '/unset' };

vi.mock('../../../../../core/src/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../core/src/paths.js')>(
    '../../../../../core/src/paths.js',
  );
  return {
    ...actual,
    getProjectRoot: vi.fn(() => projectRootRef.current),
  };
});

import { addAttention } from '../../../../../core/src/memory/attention.js';
import { writeFocusState } from '../../../../../core/src/sessions/focus-state-store.js';
import {
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '../../../../../core/src/store/__tests__/test-db-helper.js';
import { closeBrainDb } from '../../../../../core/src/store/memory-sqlite.js';
import { FocusHandler } from '../focus.js';

const ENV_KEYS = ['CLEO_SESSION_ID', 'CLEO_SESSION', 'CLEO_AGENT_ID'];

interface FocusDigestEnvelope {
  tokensEstimated: number;
  attentionDigest?: {
    summary: string;
    count: number;
    preview?: Array<{ id: string; content: string; scopeKind: string }>;
    expand: { kind: string; commands?: string[] };
  };
}

describe('focus attention digest (T11374 · Epic T11288)', () => {
  let env: TestDbEnv;
  let handler: FocusHandler;
  const savedEnv: Record<string, string | undefined> = {};
  const sessionId = 'ses_20260530000030_aaaaaa';

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    env = await createTestDb();
    projectRootRef.current = env.tempDir;
    closeBrainDb();
    handler = new FocusHandler();
    await seedTasks(env.accessor, [
      { id: 'T900', title: 'Saga', type: 'saga' },
      { id: 'T100', title: 'Epic', type: 'epic', parentId: 'T900' },
      { id: 'T001', title: 'Task A', type: 'task', parentId: 'T100' },
    ]);
    process.env['CLEO_SESSION_ID'] = sessionId;
    process.env['CLEO_AGENT_ID'] = 'agent-focus';
    await writeFocusState(env.accessor, sessionId, { currentTask: 'T001' });
  });

  afterEach(async () => {
    closeBrainDb();
    await env.cleanup();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('renders the attention digest with count + expand hint, under budget', async () => {
    await addAttention(env.tempDir, { content: 'remember the WAL reset' });
    await addAttention(env.tempDir, { content: 'epic-wide reminder', scope: 'epic' });

    const res = await handler.query('show', { id: 'T001' });
    expect(res.success).toBe(true);
    const env0 = res.data as FocusDigestEnvelope;

    expect(env0.attentionDigest).toBeDefined();
    expect(env0.attentionDigest?.count).toBe(2);
    expect(env0.attentionDigest?.summary).toContain('2 open attention item');
    expect(env0.attentionDigest?.expand.kind).toBe('suggested-commands');
    expect(env0.attentionDigest?.expand.commands).toEqual(['cleo attention show']);
    expect((env0.attentionDigest?.preview ?? []).length).toBeGreaterThan(0);

    // Focus budget: the envelope stays well inside the ≤ 1500-token ceiling.
    expect(env0.tokensEstimated).toBeLessThanOrEqual(1500);
  });

  it('omits the digest entirely when there are no open items (empty contract)', async () => {
    const res = await handler.query('show', { id: 'T001' });
    expect(res.success).toBe(true);
    const env0 = res.data as FocusDigestEnvelope;
    expect(env0.attentionDigest).toBeUndefined();
    // Envelope still well-formed and under budget.
    expect(env0.tokensEstimated).toBeLessThanOrEqual(1500);
  });
});
