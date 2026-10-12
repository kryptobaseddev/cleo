/**
 * Docs triage through the `docs.triage` decision site (T13446).
 *
 * Driven against a stub {@link DecisionProvider} injected through the decide
 * wiring — never the real Jev API. Covers: candidate selection, the rule
 * fallback, batch request mapping, unconfigured-provider fallback, abort on
 * `insufficient_credits`, `--record` writing proposed D#### decisions, and
 * the no-mutation guarantee on the docs store.
 *
 * @task T13446
 * @saga T13339
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DecisionBatchItem,
  DecisionOutcome,
  DecisionProvider,
  DecisionRequest,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The fire-and-forget symbol cross-link in storeDecision (decision-cross-link.ts)
// does heavy code-index work when the rationale carries symbol-like text (the
// docs.triage rationales do); in a one-process test run it blocks a following
// test's doc writes for the full busy timeout. The cross-link is orthogonal to
// what these tests assert, so it is stubbed out.
vi.mock('../../memory/decision-cross-link.js', () => ({
  autoCrossLinkDecision: vi.fn(async () => {}),
}));

import { eq } from 'drizzle-orm';
import { createMemoryTokenBucket } from '../../decide/budget.js';
import type { DecideOptions } from '../../decide/client.js';
import { DecisionProviderError } from '../../decide/provider.js';
import { createMemorySpendLedger, DEFAULT_MONTHLY_SPEND_CAP_MICROS } from '../../decide/spend.js';
import { createAttachmentStore } from '../../store/attachment-store.js';
import { closeAllDatabases, getDb } from '../../store/sqlite.js';
import { attachments } from '../../store/tasks-schema.js';
import {
  buildDocTriageRequest,
  DOC_TRIAGE_BATCH_CHUNK,
  DOC_TRIAGE_STALENESS_LEVELS,
  DOC_TRIAGE_VERDICTS,
  type DocTriageCandidate,
  heuristicDocTriage,
  listTriageCandidates,
  triageDocs,
} from '../triage.js';

const NOW = new Date('2026-10-10T00:00:00.000Z');

let projectDir: string;
let homeDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'cleo-docs-triage-proj-'));
  homeDir = mkdtempSync(join(tmpdir(), 'cleo-docs-triage-home-'));
  for (const key of ['CLEO_HOME', 'CLEO_ROOT', 'CLEO_PROJECT_ROOT', 'CLEO_DIR'])
    saved[key] = process.env[key];
  process.env['CLEO_HOME'] = homeDir;
  process.env['CLEO_ROOT'] = projectDir;
  process.env['CLEO_PROJECT_ROOT'] = projectDir;
  // The fork sandbox pins CLEO_DIR to its own project store; without this
  // override every test would share that one database.
  process.env['CLEO_DIR'] = join(projectDir, '.cleo');
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closeAllDatabases();
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

/** Seed one draft doc (plus its blob) and return its attachment id. */
async function seedDoc(
  slug: string,
  opts: { createdAt?: string; topics?: string[]; relatedTasks?: string[]; status?: string } = {},
): Promise<string> {
  const store = createAttachmentStore();
  const meta = await store.put(
    Buffer.from(`# ${slug}\n\nBody of ${slug}.\n`, 'utf8'),
    { kind: 'blob', mime: 'text/markdown' } as Parameters<typeof store.put>[1],
    'task',
    'T13340',
    'triage-test',
    projectDir,
    { slug, type: 'note' },
  );
  const db = await getDb(projectDir);
  await db
    .update(attachments)
    .set({
      ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
      ...(opts.topics !== undefined ? { topics: JSON.stringify(opts.topics) } : {}),
      ...(opts.relatedTasks !== undefined
        ? { relatedTasks: JSON.stringify(opts.relatedTasks) }
        : {}),
      ...(opts.status !== undefined
        ? { lifecycleStatus: opts.status as 'draft' | 'archived' }
        : {}),
    })
    .where(eq(attachments.id, meta.id));
  return meta.id;
}

function candidate(overrides: Partial<DocTriageCandidate> = {}): DocTriageCandidate {
  return {
    attachmentId: 'att-1',
    sha256: 'a'.repeat(64),
    slug: 'old-draft',
    kind: 'note',
    status: 'draft',
    topics: [],
    relatedTasks: [],
    summary: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    ownerId: 'T13340',
    ...overrides,
  };
}

/** A stub provider whose batch endpoint answers a fixed verdict per request. */
function stubProvider(
  answer: (req: DecisionRequest, index: number) => DecisionOutcome['answers'],
  onBatch?: (reqs: readonly DecisionRequest[]) => void,
): { provider: DecisionProvider; calls: DecisionRequest[][] } {
  const calls: DecisionRequest[][] = [];
  return {
    calls,
    provider: {
      decide: async (req) => ({
        answers: answer(req, 0),
        source: 'provider',
        latencyMs: 1,
      }),
      capabilities: () => ({
        wire: 'stub/1',
        maxQuestionsPerRequest: 32,
        maxStateChars: 32_000,
        batch: { maxRequests: DOC_TRIAGE_BATCH_CHUNK, maxQuestions: 256 },
      }),
      decideBatch: async (reqs) => {
        calls.push([...reqs]);
        onBatch?.(reqs);
        return reqs.map(
          (req, i): DecisionBatchItem => ({
            ok: true,
            outcome: { answers: answer(req, i), source: 'provider', latencyMs: 1 },
          }),
        );
      },
    },
  };
}

/** Wiring that keeps every gate in memory and never touches a real credential. */
function stubWiring(provider: DecisionProvider): DecideOptions {
  return {
    provider,
    budget: createMemoryTokenBucket(),
    spend: createMemorySpendLedger(),
    spendCapMicros: DEFAULT_MONTHLY_SPEND_CAP_MICROS,
    cache: null,
    audit: null,
  };
}

/** Answers with `archive` verdict (confident) and staleness level 4. */
function archiveAnswers(): DecisionOutcome['answers'] {
  return {
    verdict: {
      type: 'choice',
      value: 'archive',
      probabilities: { archive: 0.9, update: 0.1 },
      confidence: 0.9,
    },
    staleness: { type: 'score', value: 4, probabilities: [0, 0, 0, 0.1, 0.9], confidence: 0.9 },
  };
}

// ---------------------------------------------------------------------------
// Rule fallback
// ---------------------------------------------------------------------------

describe('heuristicDocTriage', () => {
  it('archives an unlinked draft untouched for over a year', () => {
    const h = heuristicDocTriage(candidate(), NOW);
    expect(h.verdict).toBe('archive');
    expect(h.staleness).toBe(DOC_TRIAGE_STALENESS_LEVELS.length - 1);
  });

  it('proposes update for a recent draft with empty topics/related_tasks', () => {
    const h = heuristicDocTriage(candidate({ createdAt: '2026-10-01T00:00:00.000Z' }), NOW);
    expect(h.verdict).toBe('update');
  });

  it('keeps a fresh, linked draft', () => {
    const h = heuristicDocTriage(
      candidate({ createdAt: '2026-10-05T00:00:00.000Z', topics: ['docs'] }),
      NOW,
    );
    expect(h.verdict).toBe('keep');
  });

  it('keeps non-draft docs (triage only proposes on drafts)', () => {
    const h = heuristicDocTriage(candidate({ status: 'accepted' }), NOW);
    expect(h.verdict).toBe('keep');
  });
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe('buildDocTriageRequest', () => {
  it('asks exactly the verdict choice and the staleness score', () => {
    const req = buildDocTriageRequest(candidate({ topics: ['docs'] }), '# Body', NOW);
    const verdict = req.questions['verdict'];
    const staleness = req.questions['staleness'];
    expect(verdict?.type).toBe('choice');
    expect(Object.keys((verdict as { criteria: object }).criteria).sort()).toEqual(
      [...DOC_TRIAGE_VERDICTS].sort(),
    );
    expect(staleness?.type).toBe('score');
    expect((staleness as { criteria: readonly string[] }).criteria).toHaveLength(
      DOC_TRIAGE_STALENESS_LEVELS.length,
    );
    expect(req.state['slug']).toBe('old-draft');
    expect(req.state['topics']).toBe('docs');
  });

  it('redacts then clips: a secret straddling the cut never enters the state', () => {
    const excerpt = `${'Context about the release flow. '.repeat(60)} token ghp_${'A'.repeat(36)}`;
    const req = buildDocTriageRequest(candidate(), excerpt, NOW);
    expect(JSON.stringify(req.state)).not.toContain('ghp_');
  });
});

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

describe('listTriageCandidates', () => {
  it('selects drafts oldest first, parses topics/related_tasks, honours the limit', async () => {
    const oldId = await seedDoc('old', { createdAt: '2025-06-01T00:00:00.000Z' });
    const newId = await seedDoc('new', {
      createdAt: '2026-09-01T00:00:00.000Z',
      topics: ['docs'],
      relatedTasks: ['T13340'],
    });
    await seedDoc('accepted', { createdAt: '2024-01-01T00:00:00.000Z', status: 'accepted' });

    const all = await listTriageCandidates({ projectRoot: projectDir });
    expect(all.map((c) => c.slug)).toEqual(['old', 'new']);
    expect(all[0]?.attachmentId).toBe(oldId);
    expect(all[1]?.topics).toEqual(['docs']);
    expect(all[1]?.relatedTasks).toEqual(['T13340']);

    const limited = await listTriageCandidates({ projectRoot: projectDir, limit: 1 });
    expect(limited.map((c) => c.attachmentId)).toEqual([oldId]);
    expect(newId).not.toBe(limited[0]?.attachmentId);

    const accepted = await listTriageCandidates({ projectRoot: projectDir, status: 'accepted' });
    expect(accepted.map((c) => c.slug)).toEqual(['accepted']);
  });

  it('rejects an unknown lifecycle status', async () => {
    await expect(
      listTriageCandidates({ projectRoot: projectDir, status: 'bogus' }),
    ).rejects.toThrow(/Invalid lifecycle status/);
  });
});

// ---------------------------------------------------------------------------
// triageDocs
// ---------------------------------------------------------------------------

describe('triageDocs', () => {
  it('unconfigured provider: mode off, rule verdicts, zero provider calls', async () => {
    await seedDoc('old', { createdAt: '2025-06-01T00:00:00.000Z' });
    const { provider, calls } = stubProvider(archiveAnswers);
    const report = await triageDocs({
      projectRoot: projectDir,
      now: NOW,
      // No provider and connection: null — the site resolves to `off`.
      decide: { ...stubWiring(provider), provider: undefined, connection: null },
    });
    expect(report.mode).toBe('off');
    expect(report.scanned).toBe(1);
    expect(report.proposals[0]).toMatchObject({ verdict: 'archive', source: 'rule' });
    expect(calls).toHaveLength(0);
    expect(report.fallbackReasons).toEqual({});
  });

  it('shadow: batches one request per doc (two questions each), heuristic acts, decided answers ride along', async () => {
    await seedDoc('a', { createdAt: '2026-10-01T00:00:00.000Z' });
    await seedDoc('b', { createdAt: '2025-06-01T00:00:00.000Z' });
    const { provider, calls } = stubProvider(archiveAnswers);
    const report = await triageDocs({
      projectRoot: projectDir,
      now: NOW,
      mode: 'shadow',
      decide: stubWiring(provider),
    });

    expect(report.mode).toBe('shadow');
    expect(calls).toHaveLength(1);
    // Oldest first: b (2025) precedes a (2026); each request carries both questions.
    expect(calls[0]).toHaveLength(2);
    expect(calls[0]?.[0]?.state['slug']).toBe('b');
    expect(Object.keys(calls[0]?.[0]?.questions ?? {}).sort()).toEqual(['staleness', 'verdict']);

    const [first, second] = report.proposals;
    // Shadow: the heuristic verdict acts even though the stub said 'archive'.
    expect(first).toMatchObject({ slug: 'b', verdict: 'archive', source: 'rule' });
    expect(second).toMatchObject({ slug: 'a', verdict: 'update', source: 'rule' });
    expect(second?.decided).toMatchObject({ verdict: 'archive', verdictConfidence: 0.9 });
    expect(report.aborted).toBe(false);
  });

  it('on + confident: the decided verdict acts', async () => {
    await seedDoc('recent-linked', {
      createdAt: '2026-10-05T00:00:00.000Z',
      topics: ['docs'],
    });
    const { provider } = stubProvider(archiveAnswers);
    const report = await triageDocs({
      projectRoot: projectDir,
      now: NOW,
      mode: 'on',
      decide: stubWiring(provider),
    });
    expect(report.proposals[0]).toMatchObject({
      verdict: 'archive',
      source: 'system-one',
      confidence: 0.9,
      staleness: 4,
    });
  });

  it('on + a verdict outside the offered options: rejected, heuristic acts', async () => {
    await seedDoc('recent', { createdAt: '2026-10-01T00:00:00.000Z' });
    const { provider } = stubProvider(() => ({
      verdict: {
        type: 'choice',
        value: 'shred',
        probabilities: { shred: 1 },
        confidence: 0.95,
      },
      staleness: { type: 'score', value: 0, probabilities: [1, 0, 0, 0, 0], confidence: 0.9 },
    }));
    const report = await triageDocs({
      projectRoot: projectDir,
      now: NOW,
      mode: 'on',
      decide: stubWiring(provider),
    });
    expect(report.proposals[0]?.verdict).toBe('update');
    expect(report.proposals[0]?.source).toBe('rule');
    expect(report.proposals[0]?.decided?.verdict).toBeNull();
  });

  it('insufficient_credits aborts the run: fallback reason counted, heuristic proposals stand', async () => {
    await seedDoc('a', { createdAt: '2026-10-01T00:00:00.000Z' });
    const provider: DecisionProvider = {
      decide: async () => {
        throw new DecisionProviderError('insufficient_credits', '402');
      },
    };
    const report = await triageDocs({
      projectRoot: projectDir,
      now: NOW,
      mode: 'on',
      decide: stubWiring(provider),
    });
    expect(report.aborted).toBe(true);
    expect(report.abortReason).toBe('insufficient_credits');
    expect(report.fallbackReasons['insufficient_credits']).toBe(1);
    expect(report.proposals[0]?.source).toBe('rule');
  });

  it('--record persists proposed D#### decisions and never mutates the doc', async () => {
    const id = await seedDoc('old', { createdAt: '2025-06-01T00:00:00.000Z' });
    const { provider } = stubProvider(archiveAnswers);
    const before = await (await getDb(projectDir))
      .select()
      .from(attachments)
      .where(eq(attachments.id, id))
      .get();

    const report = await triageDocs({
      projectRoot: projectDir,
      now: NOW,
      mode: 'shadow',
      record: true,
      decide: stubWiring(provider),
    });

    expect(report.recorded).toBe(1);
    const proposal = report.proposals[0];
    expect(proposal?.decisionId).toMatch(/^D\d+$/);

    const { recallDecision } = await import('../../memory/decisions.js');
    const row = await recallDecision(projectDir, proposal?.decisionId ?? '');
    expect(row).not.toBeNull();
    expect(row?.confirmationState).toBe('proposed');
    expect(row?.decidedBy).toBe('agent');
    expect(row?.decision).toContain('docs.triage verdict for old: archive');
    // storeDecision's write-guard drops contextTaskId when the task is absent
    // from tasks.db (T13340 is not seeded here), so it is not asserted.

    // No-mutation guarantee: the attachment row is byte-identical.
    const after = await (await getDb(projectDir))
      .select()
      .from(attachments)
      .where(eq(attachments.id, id))
      .get();
    expect(after).toEqual(before);
  });

  it('a repeated --record keeps one proposed decision per (doc, verdict) (T13575)', async () => {
    const id = await seedDoc('old', { createdAt: '2025-06-01T00:00:00.000Z' });
    const run = async () => {
      const { provider } = stubProvider(archiveAnswers);
      return triageDocs({
        projectRoot: projectDir,
        now: NOW,
        mode: 'shadow',
        record: true,
        decide: stubWiring(provider),
      });
    };
    const first = await run();
    const second = await run();
    const decisionId = first.proposals[0]?.decisionId;
    expect(second.proposals[0]?.decisionId).toBe(decisionId);

    const { listDecisions } = await import('../../memory/decisions.js');
    const { total } = await listDecisions(projectDir);
    expect(total).toBe(1);

    // The decision links the doc structurally, with autoCapture at its default (off).
    const doc = await (await getDb(projectDir))
      .select({ sha256: attachments.sha256 })
      .from(attachments)
      .where(eq(attachments.id, id))
      .get();
    const { getBrainAccessor } = await import('../../store/memory-accessor.js');
    const edges = await (await getBrainAccessor(projectDir)).getPageEdges(
      `decision:${decisionId}`,
      'out',
    );
    expect(edges.map((e) => [e.toId, e.edgeType])).toEqual([
      [`llmtxt:${doc?.sha256}`, 'references'],
    ]);
    // Neither end dangles, although autoCapture is off (T13600).
    const accessor = await getBrainAccessor(projectDir);
    expect((await accessor.getPageNode(`llmtxt:${doc?.sha256}`))?.nodeType).toBe('llmtxt');
    expect((await accessor.getPageNode(`decision:${decisionId}`))?.nodeType).toBe('decision');
  });

  it('without --record nothing is persisted', async () => {
    await seedDoc('old', { createdAt: '2025-06-01T00:00:00.000Z' });
    const { provider } = stubProvider(archiveAnswers);
    const report = await triageDocs({
      projectRoot: projectDir,
      now: NOW,
      mode: 'shadow',
      decide: stubWiring(provider),
    });
    expect(report.recorded).toBe(0);
    expect(report.proposals[0]?.decisionId).toBeUndefined();

    const { listDecisions } = await import('../../memory/decisions.js');
    const { total } = await listDecisions(projectDir);
    expect(total).toBe(0);
  });

  it('an empty candidate set yields an empty report without asking anything', async () => {
    const { provider, calls } = stubProvider(archiveAnswers);
    const report = await triageDocs({
      projectRoot: projectDir,
      now: NOW,
      mode: 'shadow',
      decide: stubWiring(provider),
    });
    expect(report.scanned).toBe(0);
    expect(report.proposals).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
