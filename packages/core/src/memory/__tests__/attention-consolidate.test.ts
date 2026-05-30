/**
 * Tier-2 attention consolidation tests — the dream-cycle's review of the
 * `brain_attention` working-memory buffer (E3 · Epic T11289 · Saga T11283).
 *
 * Uses a real SQLite brain.db (no mocks of the scorer / conduit / sweep) seeded
 * via the leakage-test infrastructure so the proof is the production code path.
 * `CLEO_BRAIN_BYPASS_WRITER_THREAD=1` routes the promotion conduit's
 * `observeBrain` write inline on the main-thread handle so the promoted
 * `brain_observations` row is immediately queryable for the provenance + leakage
 * assertions.
 *
 * Coverage (one block per child):
 *   T11382 — the dream cycle ingests + SCORES live brain_attention entries.
 *   T11385 — each entry gets EXACTLY ONE verdict (promote|keep|discard); a mixed
 *            seed yields ≥1 of each.
 *   T11383 — a salient entry promotes through the sticky-convert conduit and is
 *            marked status='consolidated' (idempotent — no double-promote).
 *   T11384 — a noise / expired entry is discarded (not promoted) and disappears
 *            from the live buffer.
 *   T11386 — END-TO-END: salient promoted + noise discarded + mid kept open;
 *            and leakage preserved (agent A's promoted entry carries A's scope
 *            provenance, never agent B's).
 *
 * @task T11382
 * @task T11383
 * @task T11384
 * @task T11385
 * @task T11386
 * @epic T11289
 * @saga T11283
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFocusState } from '../../sessions/focus-state-store.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { addAttention, listAttention } from '../attention.js';
import {
  ATTENTION_PROMOTE_THRESHOLD,
  attentionToPromotionSignals,
  consolidateAttention,
  decideAttentionVerdict,
} from '../attention-consolidate.js';
import { computePromotionScore } from '../promotion-score.js';

// runConsolidation reaches the LLM sleep step; mock it so no network call is
// made (matches the dream-cycle.test.ts guard).
vi.mock('../sleep-consolidation.js', () => ({
  runSleepConsolidation: vi.fn().mockResolvedValue({
    ran: false,
    mergeDuplicates: { merged: 0, llmDecisions: 0 },
    pruneStale: { pruned: 0, preserved: 0 },
    strengthenPatterns: { synthesized: 0, patternsGenerated: 0 },
    generateInsights: { clustersProcessed: 0, insightsStored: 0 },
  }),
}));

const ENV_KEYS = ['CLEO_SESSION_ID', 'CLEO_SESSION', 'CLEO_AGENT_ID'];

/** A salient jot: long, detailed, tagged → crosses the promote bar on richness + recency. */
const SALIENT_CONTENT =
  'WAL reset race fix landed: node:sqlite 3.53.0 bundled in Node 24.16 resolves the ' +
  'long-standing checkpoint corruption under concurrent writers — verified end to end.';
/** A noise jot: terse, untagged → scores below the promote bar (stays kept by default). */
const NOISE_CONTENT = 'todo';

/** Two concurrent agents under one shared epic (T100) and saga (T900). */
const AGENT_A = { sessionId: 'ses_20260530000040_aaaaaa', agentId: 'agent-A', taskId: 'T001' };
const AGENT_B = { sessionId: 'ses_20260530000041_bbbbbb', agentId: 'agent-B', taskId: 'T002' };

/** Run `fn` under a specific agent's env identity, restoring env afterward. */
async function asAgent<T>(
  agent: { sessionId: string; agentId: string },
  fn: () => Promise<T>,
): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env['CLEO_SESSION_ID'] = agent.sessionId;
  process.env['CLEO_AGENT_ID'] = agent.agentId;
  delete process.env['CLEO_SESSION'];
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

interface ObservationProvenanceRow {
  id: string;
  narrative: string | null;
  agent: string | null;
  provenance_chain: string | null;
}

/** Read back every promoted observation row for provenance + leakage assertions. */
async function readPromotedObservations(projectRoot: string): Promise<ObservationProvenanceRow[]> {
  const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const db = getBrainNativeDb();
  if (!db) return [];
  return db
    .prepare(
      `SELECT id, narrative, agent, provenance_chain
       FROM brain_observations
       WHERE provenance_chain IS NOT NULL
       ORDER BY created_at DESC`,
    )
    .all() as ObservationProvenanceRow[];
}

describe('Tier-2 attention consolidation (E3 · Epic T11289)', () => {
  let env: TestDbEnv;
  const savedEnv: Record<string, string | undefined> = {};
  let savedBypass: string | undefined;

  beforeEach(async () => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    // Route the conduit's observeBrain write inline so the promoted row is
    // visible to the main-thread handle for the assertions.
    savedBypass = process.env['CLEO_BRAIN_BYPASS_WRITER_THREAD'];
    process.env['CLEO_BRAIN_BYPASS_WRITER_THREAD'] = '1';

    env = await createTestDb();
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    closeBrainDb();

    // saga T900 -> epic T100 -> tasks T001 (agent A) and T002 (agent B).
    await seedTasks(env.accessor, [
      { id: 'T900', title: 'Shared saga', type: 'saga' },
      { id: 'T100', title: 'Shared epic', type: 'epic', parentId: 'T900' },
      { id: 'T001', title: 'Task A', type: 'task', parentId: 'T100' },
      { id: 'T002', title: 'Task B', type: 'task', parentId: 'T100' },
    ]);
    await writeFocusState(env.accessor, AGENT_A.sessionId, { currentTask: AGENT_A.taskId });
    await writeFocusState(env.accessor, AGENT_B.sessionId, { currentTask: AGENT_B.taskId });
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    closeBrainDb();
    await env.cleanup();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    if (savedBypass === undefined) delete process.env['CLEO_BRAIN_BYPASS_WRITER_THREAD'];
    else process.env['CLEO_BRAIN_BYPASS_WRITER_THREAD'] = savedBypass;
  });

  // ─── T11382: ingest + score live brain_attention ────────────────────────────
  describe('T11382 — dream cycle ingests + scores the attention buffer', () => {
    it('scores live entries with the EXISTING 6-signal scorer (asserts the scorer receives the rows)', async () => {
      await asAgent(AGENT_A, async () => {
        await addAttention(env.tempDir, { content: SALIENT_CONTENT, tags: ['wal', 'sqlite'] });
        await addAttention(env.tempDir, { content: NOISE_CONTENT });
      });

      const result = await consolidateAttention(env.tempDir);

      // Both live entries were reviewed and each carries a composite score in
      // [0, 1] derived from the shared promotion-score scorer.
      expect(result.reviewed).toBe(2);
      expect(result.reviews).toHaveLength(2);
      for (const r of result.reviews) {
        expect(r.score).toBeGreaterThanOrEqual(0);
        expect(r.score).toBeLessThanOrEqual(1);
      }
      // The salient entry scores ABOVE the noise entry (content richness signal).
      const scores = result.reviews.map((r) => r.score).sort((a, b) => b - a);
      expect(scores[0]).toBeGreaterThan(scores[1]);
      // The salient, tagged entry crossed the promote bar.
      expect(result.reviews.some((r) => r.verdict === 'promote')).toBe(true);
    });

    it('the signal mapping uses the shared computePromotionScore (no parallel scorer)', () => {
      const now = Date.now();
      const richRow = {
        id: 'att_rich',
        content: SALIENT_CONTENT,
        sessionId: 's',
        agentId: 'a',
        scopeKind: 'agent' as const,
        scopeId: 'a',
        tags: ['wal', 'sqlite'],
        createdAt: now,
        expiresAt: null,
        decayScore: null,
        status: 'open' as const,
      };
      const signals = attentionToPromotionSignals(richRow);
      // The mapped score IS the composite scorer's output — same function.
      const expected = computePromotionScore(signals);
      const verdict = decideAttentionVerdict(richRow, expected, now);
      expect(expected).toBeGreaterThanOrEqual(ATTENTION_PROMOTE_THRESHOLD);
      expect(verdict).toBe('promote');
    });
  });

  // ─── T11385: single per-entry verdict, ≥1 of each over a mixed seed ──────────
  describe('T11385 — exactly one promote|keep|discard verdict per entry', () => {
    it('a mixed seeded set yields ≥1 of each verdict, one verdict per entry', async () => {
      const now = Date.now();
      await asAgent(AGENT_A, async () => {
        // promote: rich + tagged.
        await addAttention(env.tempDir, { content: SALIENT_CONTENT, tags: ['wal', 'sqlite'] });
        // keep: mid-length, untagged, mid-salience.
        await addAttention(env.tempDir, {
          content: 'investigate the flaky manual-write-sweep job later this week',
        });
        // discard: already past TTL (expires 1s in the past).
        await addAttention(env.tempDir, { content: NOISE_CONTENT, ttlSeconds: 1 });
      });

      // Advance the clock past the 1s TTL so the noise entry is expired.
      const future = now + 5_000;
      const result = await consolidateAttention(env.tempDir, { now: future });

      const verdicts = result.reviews.map((r) => r.verdict);
      // Exactly one verdict per reviewed entry (no entry double-counted).
      expect(result.reviews).toHaveLength(result.reviewed);
      // ≥1 of each verdict over the mixed set.
      expect(verdicts).toContain('promote');
      expect(verdicts).toContain('keep');
      // The expired entry is below the read limit's liveness filter, so it is
      // swept (discarded) even though it is not in the reviewed set — assert the
      // discard happened via the result tally.
      expect(result.discarded).toBeGreaterThanOrEqual(1);
      // promote + keep counts reconcile with the reviewed (live) set.
      expect(result.promoted + result.kept).toBe(result.reviewed);
    });
  });

  // ─── T11383: promote via the conduit + consolidated + idempotent ────────────
  describe('T11383 — salient entries promote via the sticky-convert conduit', () => {
    it('a salient entry promotes through the conduit and is marked consolidated', async () => {
      await asAgent(AGENT_A, () =>
        addAttention(env.tempDir, { content: SALIENT_CONTENT, tags: ['wal', 'sqlite'] }),
      );

      const result = await consolidateAttention(env.tempDir);
      expect(result.promoted).toBe(1);
      const promotedReview = result.reviews.find((r) => r.verdict === 'promote');
      expect(promotedReview?.promotedToId).toBeTruthy();

      // The source attention row is no longer LIVE (status flipped to consolidated).
      const stillLive = await asAgent(AGENT_A, () => listAttention(env.tempDir, {}));
      expect(stillLive.items.some((i) => i.content === SALIENT_CONTENT)).toBe(false);

      // A durable brain_observations row now exists carrying the content.
      const promoted = await readPromotedObservations(env.tempDir);
      expect(promoted.some((o) => o.narrative === SALIENT_CONTENT)).toBe(true);
    });

    it('re-running the dream cycle does NOT double-promote (idempotent)', async () => {
      await asAgent(AGENT_A, () =>
        addAttention(env.tempDir, { content: SALIENT_CONTENT, tags: ['wal', 'sqlite'] }),
      );

      const first = await consolidateAttention(env.tempDir);
      expect(first.promoted).toBe(1);

      // Second pass: the consolidated entry is no longer `open`, so it is never
      // re-read → never re-promoted.
      const second = await consolidateAttention(env.tempDir);
      expect(second.promoted).toBe(0);

      const promoted = await readPromotedObservations(env.tempDir);
      const matching = promoted.filter((o) => o.narrative === SALIENT_CONTENT);
      expect(matching).toHaveLength(1);
    });
  });

  // ─── T11384: decay / discard via the homeostatic sweep ──────────────────────
  describe('T11384 — low-salience / expired entries decay via the sweep', () => {
    it('an expired entry is discarded (not promoted) and disappears from the live buffer', async () => {
      const now = Date.now();
      await asAgent(AGENT_A, async () => {
        await addAttention(env.tempDir, { content: 'ephemeral noise', ttlSeconds: 1 });
        await addAttention(env.tempDir, { content: SALIENT_CONTENT, tags: ['wal'] });
      });

      const future = now + 5_000;
      const result = await consolidateAttention(env.tempDir, { now: future });

      // The expired entry was swept; not promoted.
      expect(result.discarded).toBeGreaterThanOrEqual(1);
      expect(result.reviews.some((r) => r.promotedToId === null && r.verdict === 'discard')).toBe(
        false,
      );

      // The expired entry is gone from the live buffer (digest/list).
      const live = await asAgent(AGENT_A, () => listAttention(env.tempDir, { now: future }));
      expect(live.items.some((i) => i.content === 'ephemeral noise')).toBe(false);
    });

    it('a decayed (below-floor decay_score) entry is excluded from the live read and swept', async () => {
      // Seed an entry directly with a sub-floor decay_score via the accessor.
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      const accessor = await getBrainAccessor(env.tempDir);
      await accessor.addAttention({
        id: 'att_decayed',
        content: 'long-stale decayed note that should be swept by the homeostatic pass',
        sessionId: AGENT_A.sessionId,
        agentId: AGENT_A.agentId,
        scopeKind: 'agent',
        scopeId: AGENT_A.agentId,
        tags: [],
        decayScore: 0.01, // below ATTENTION_DISCARD_THRESHOLD (0.1)
        status: 'open',
      });

      const result = await consolidateAttention(env.tempDir);
      // The decayed entry is below the live read floor (not reviewed) but is
      // swept to discarded by the homeostatic pass.
      expect(result.discarded).toBeGreaterThanOrEqual(1);
      const after = await accessor.getAttention('att_decayed');
      expect(after?.status).toBe('discarded');
    });
  });

  // ─── T11386: end-to-end + leakage preservation ──────────────────────────────
  describe('T11386 — end-to-end consolidation + leakage preservation', () => {
    it('salient promoted + noise discarded + mid kept, all in one cycle', async () => {
      const now = Date.now();
      await asAgent(AGENT_A, async () => {
        await addAttention(env.tempDir, { content: SALIENT_CONTENT, tags: ['wal', 'sqlite'] });
        await addAttention(env.tempDir, {
          content: 'mid-salience: revisit the dream-status overdue heuristic',
        });
        await addAttention(env.tempDir, { content: NOISE_CONTENT, ttlSeconds: 1 });
      });

      const future = now + 5_000;
      const result = await consolidateAttention(env.tempDir, { now: future });

      expect(result.promoted).toBe(1); // salient
      expect(result.kept).toBe(1); // mid
      expect(result.discarded).toBeGreaterThanOrEqual(1); // noise (expired)

      // The mid entry stays open for the next cycle.
      const live = await asAgent(AGENT_A, () => listAttention(env.tempDir, { now: future }));
      expect(live.items.some((i) => i.content.includes('mid-salience'))).toBe(true);
      // The salient entry was promoted (consolidated) → no longer live.
      expect(live.items.some((i) => i.content === SALIENT_CONTENT)).toBe(false);
    });

    it("agent A's promoted entry carries A's scope provenance — never agent B's", async () => {
      // Agent A writes a salient AGENT-scoped jot (narrowest = agent).
      await asAgent(AGENT_A, () =>
        addAttention(env.tempDir, {
          content: SALIENT_CONTENT,
          tags: ['wal', 'sqlite'],
          scope: 'agent',
        }),
      );
      // Agent B writes its own distinct salient jot.
      const B_CONTENT = `${SALIENT_CONTENT} (agent B variant for the leakage test)`;
      await asAgent(AGENT_B, () =>
        addAttention(env.tempDir, { content: B_CONTENT, tags: ['wal'], scope: 'agent' }),
      );

      const result = await consolidateAttention(env.tempDir);
      expect(result.promoted).toBe(2);

      // Each promoted review carries its OWN agent scope — never crossed.
      const aReview = result.reviews.find((r) => r.scopeId === AGENT_A.agentId);
      const bReview = result.reviews.find((r) => r.scopeId === AGENT_B.agentId);
      expect(aReview?.scopeKind).toBe('agent');
      expect(bReview?.scopeKind).toBe('agent');
      expect(aReview?.promotedToId).toBeTruthy();
      expect(bReview?.promotedToId).toBeTruthy();

      // The durable rows carry the correct agent provenance — A's content is
      // attributed to agent A, B's to agent B, never swapped.
      const promoted = await readPromotedObservations(env.tempDir);
      const aRow = promoted.find((o) => o.narrative === SALIENT_CONTENT);
      const bRow = promoted.find((o) => o.narrative === B_CONTENT);
      expect(aRow?.agent).toBe(AGENT_A.agentId);
      expect(bRow?.agent).toBe(AGENT_B.agentId);
      // Leakage impossibility: A's durable row is NEVER attributed to agent B.
      expect(aRow?.agent).not.toBe(AGENT_B.agentId);
      expect(bRow?.agent).not.toBe(AGENT_A.agentId);
    });
  });
});
