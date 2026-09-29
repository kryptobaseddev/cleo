/**
 * ADR decision contradiction check as ONE System One decision (T12493).
 *
 * Driven against a local HTTP stub of the Jev `/v1/systemone` endpoint — never
 * the real provider. The fixture has four prior decisions: three share words
 * with the new one (the candidates) and one shares none (never sent). No pair
 * reaches the 0.65 collision threshold, so the deterministic confidence is 1.0.
 *
 * @task T12493
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionAuditEntry, DecisionAuditSink } from '../../decide/audit.js';
import { createMemoryTokenBucket } from '../../decide/budget.js';
import type { DecideOptions } from '../../decide/client.js';

const evaluateDialectic = vi.fn();
vi.mock('../dialectic-evaluator.js', () => ({ evaluateDialectic }));

const { adviseDecisionConflicts, storeDecision, validateDecisionConflicts } = await import(
  '../decisions.js'
);
const { saveDecideCredentials } = await import('../../decide/credentials.js');
const { closeBrainDb } = await import('../../store/memory-sqlite.js');
const { _resetDecideDefaultsForTest } = await import('../../decide/client.js');
const { CONTRADICTION_RELATIONS, DECISION_CONTRADICTION_BUDGET_MS, DECISION_CONTRADICTION_SITE } =
  await import('../decision-contradiction.js');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const NEW = {
  type: 'architecture' as const,
  decision: 'Use PostgreSQL as the primary datastore for brain memory',
  rationale: 'Concurrent writers need row-level locking across agents',
  adrPath: 'docs/adr/ADR-900.md',
  supersedes: undefined as string | undefined,
};

const EXISTING = [
  {
    id: 'D001',
    decision: 'Use SQLite as the primary datastore for brain memory',
    rationale: 'Single file, zero configuration, embedded in every agent',
    supersedes: null,
  },
  {
    id: 'D002',
    decision: 'Keep brain memory schema migrations in drizzle',
    rationale: 'One migration toolchain for every datastore',
    supersedes: null,
  },
  {
    id: 'D003',
    decision: 'Agents write through a single writer queue',
    rationale: 'Avoids lock contention between concurrent writers',
    supersedes: null,
  },
  {
    id: 'D004',
    decision: 'Render icons with the shared glyph table',
    rationale: 'Consistent terminal output',
    supersedes: null,
  },
];

/** Result with no model answer acted on: deterministic, nothing flagged. */
const HEURISTIC_RESULT = {
  collisions: [],
  contradictions: [],
  supersession_graph_violations: [],
  confidence: 1,
};

// ---------------------------------------------------------------------------
// Local Jev stub
// ---------------------------------------------------------------------------

type StubMode =
  | 'fast'
  | 'slow'
  | 'error'
  | 'invalid'
  | 'out-of-range'
  | 'bad-status'
  | 'unsure'
  | 'supersedes'
  | 'refines';

let server: Server;
let baseUrl: string;
let stubMode: StubMode = 'fast';
const received: Array<{ auth: string | undefined; body: Record<string, unknown> }> = [];

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** c1 contradicts; every other candidate is unrelated. */
function stubAnswer(name: string): Record<string, unknown> {
  if (stubMode === 'invalid') return { type: 'choice', choice: 'contradicts', confidence: 0.9 };
  // c1 still contradicts, so acting on the rest of the answer set would flag D001.
  if (stubMode === 'out-of-range' && name === 'c2') {
    return {
      type: 'choice',
      choice: 'bogus',
      probabilities: { bogus: 0.9, unrelated: 0.1 },
      confidence: 0.9,
    };
  }
  if (stubMode === 'refines') {
    return {
      type: 'choice',
      choice: 'refines',
      probabilities: { contradicts: 0.05, supersedes: 0.05, refines: 0.8, unrelated: 0.1 },
      confidence: 0.9,
    };
  }
  if (stubMode === 'supersedes' && name === 'c1') {
    return {
      type: 'choice',
      choice: 'supersedes',
      probabilities: { contradicts: 0.1, supersedes: 0.8, refines: 0.05, unrelated: 0.05 },
      confidence: 0.9,
    };
  }
  const contradicts = name === 'c1' && stubMode !== 'supersedes';
  return {
    type: 'choice',
    choice: contradicts ? 'contradicts' : 'unrelated',
    probabilities: contradicts
      ? { contradicts: 0.8, supersedes: 0.1, refines: 0.05, unrelated: 0.05 }
      : { contradicts: 0.02, supersedes: 0.03, refines: 0.05, unrelated: 0.9 },
    confidence: stubMode === 'unsure' ? 0.4 : 0.9,
  };
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const raw = await readBody(req);
    if (req.method !== 'POST' || req.url !== '/v1/systemone') {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw) as { questions: Record<string, unknown>; model?: string };
    received.push({ auth: req.headers.authorization, body });
    if (stubMode === 'error') {
      res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}');
      return;
    }
    if (stubMode === 'slow') await new Promise((r) => setTimeout(r, 2_000));
    const answers: Record<string, unknown> = {};
    for (const name of Object.keys(body.questions)) answers[name] = stubAnswer(name);
    if (res.destroyed) return;
    res
      .writeHead(stubMode === 'bad-status' ? 999 : 200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ model: body.model, answers, meta: { request_id: 'req_stub' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

// ---------------------------------------------------------------------------
// Wiring helpers
// ---------------------------------------------------------------------------

function memoryAudit(): DecisionAuditSink & { entries: DecisionAuditEntry[] } {
  const entries: DecisionAuditEntry[] = [];
  return { entries, write: (e) => entries.push(e) };
}

function stubWiring(audit: DecisionAuditSink): DecideOptions {
  return {
    connection: { baseUrl, apiKey: 'sk-test-SECRET-1234', model: 'stub-model' },
    budget: createMemoryTokenBucket(),
    cache: null,
    audit,
  };
}

let projectDir: string;
let homeDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  stubMode = 'fast';
  received.length = 0;
  evaluateDialectic.mockReset();
  evaluateDialectic.mockResolvedValue({ globalTraits: [], peerInsights: [] });
  projectDir = mkdtempSync(join(tmpdir(), 'cleo-contradiction-proj-'));
  homeDir = mkdtempSync(join(tmpdir(), 'cleo-contradiction-home-'));
  for (const key of ['CLEO_HOME', 'CLEO_ENV']) saved[key] = process.env[key];
  process.env['CLEO_HOME'] = homeDir;
  // The validator returns early under CLEO_ENV=test.
  delete process.env['CLEO_ENV'];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

function run(
  mode: 'shadow' | 'on' | 'off' | undefined,
  audit: DecisionAuditSink,
  extra: { llmTier?: boolean; params?: Partial<typeof NEW> } = {},
) {
  return validateDecisionConflicts({ ...NEW, ...extra.params }, EXISTING, {
    ...(mode ? { mode } : {}),
    ...(extra.llmTier !== undefined ? { llmTier: extra.llmTier } : {}),
    decide: stubWiring(audit),
    projectRoot: projectDir,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('System One contradiction check — configured', () => {
  it('sends ONE request: top-3 candidates by word overlap, one choice question each', async () => {
    await run('shadow', memoryAudit());

    expect(received).toHaveLength(1);
    const { body, auth } = received[0]!;
    expect(auth).toBe('Bearer sk-test-SECRET-1234');
    const questions = body['questions'] as Record<string, { type: string; criteria: object }>;
    expect(Object.keys(questions)).toEqual(['c1', 'c2', 'c3']);
    for (const q of Object.values(questions)) {
      expect(q.type).toBe('choice');
      expect(Object.keys(q.criteria).sort()).toEqual([...CONTRADICTION_RELATIONS].sort());
    }
    const state = body['state'] as Record<string, { id?: string; decision: string }>;
    expect(state['new']?.decision).toBe(NEW.decision);
    expect([state['c1']?.id, state['c2']?.id, state['c3']?.id]).toEqual(['D001', 'D002', 'D003']);
    // D004 shares no word with the new decision: never sent.
    expect(JSON.stringify(body)).not.toContain('D004');
  });

  it('shadow: acts on the heuristic and audits heuristic + decision answers side by side', async () => {
    const audit = memoryAudit();
    const result = await run('shadow', audit);

    expect(result).toEqual(HEURISTIC_RESULT);
    // Shadow is behaviour-neutral: the pre-T12493 generative check still runs.
    expect(evaluateDialectic).toHaveBeenCalledTimes(1);
    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0]!;
    expect(entry.site).toBe(DECISION_CONTRADICTION_SITE);
    expect(entry.source).toBe('provider');
    expect(entry.model).toBe('stub-model');
    expect(entry.answers['c1']).toMatchObject({ type: 'choice', value: 'contradicts' });
    expect(entry.shadow).toMatchObject({
      mode: 'shadow',
      acted: 'heuristic',
      heuristicVerdict: 'clear',
      agree: false,
      subjects: { c1: 'D001', c2: 'D002', c3: 'D003' },
      heuristicVerdicts: { c1: 'none', c2: 'none', c3: 'none' },
    });
    expect(entry.shadow?.heuristicAnswers['c1']).toMatchObject({
      type: 'choice',
      value: 'unrelated',
    });
    expect(entry.shadow?.rejected).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain('SECRET');
  });

  it('on: the contradiction comes from the typed answer and lowers confidence', async () => {
    const audit = memoryAudit();
    const result = await run('on', audit);

    expect(result.contradictions).toEqual(['D001']);
    expect(result.confidence).toBeCloseTo(0.2, 5);
    expect(audit.entries[0]?.shadow?.acted).toBe('decision');
    expect(evaluateDialectic).not.toHaveBeenCalled();
  });

  it('on: "contradicts" about the decision it declares it supersedes is not a contradiction', async () => {
    const result = await run('on', memoryAudit(), { params: { supersedes: 'D001' } });

    expect(result.contradictions).toEqual([]);
    expect(result.confidence).toBe(1);
  });

  it('on: low-confidence answers are audited but the heuristic acts', async () => {
    stubMode = 'unsure';
    const audit = memoryAudit();
    const result = await run('on', audit);

    expect(result).toEqual(HEURISTIC_RESULT);
    expect(audit.entries[0]?.shadow?.acted).toBe('heuristic');
  });

  it('on: a choice outside the offered options is rejected and the heuristic acts', async () => {
    stubMode = 'out-of-range';
    const audit = memoryAudit();
    const result = await run('on', audit);

    expect(result).toEqual(HEURISTIC_RESULT);
    expect(received).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ source: 'provider' });
    expect(audit.entries[0]?.shadow).toMatchObject({
      acted: 'heuristic',
      agree: null,
      rejected: 'invalid_choice',
    });
  });

  it('slow provider: falls back within the budget and audits `timeout`', async () => {
    stubMode = 'slow';
    const audit = memoryAudit();
    const started = performance.now();
    const result = await run('on', audit);
    const elapsed = performance.now() - started;

    expect(result).toEqual(HEURISTIC_RESULT);
    expect(elapsed).toBeLessThan(DECISION_CONTRADICTION_BUDGET_MS + 150);
    expect(audit.entries[0]).toMatchObject({ source: 'fallback', fallbackReason: 'timeout' });
    expect(audit.entries[0]?.shadow).toMatchObject({ acted: 'heuristic', agree: null });
  });

  it.each([
    ['error', 'server_error'],
    ['invalid', 'invalid_response'],
  ] as const)('provider %s: falls back and audits `%s`', async (mode, reason) => {
    stubMode = mode;
    const audit = memoryAudit();
    const result = await run('on', audit);

    expect(result).toEqual(HEURISTIC_RESULT);
    expect(received).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ source: 'fallback', fallbackReason: reason });
  });

  it('bad HTTP status (999): falls back to the heuristic', async () => {
    stubMode = 'bad-status';
    const audit = memoryAudit();
    const result = await run('on', audit);

    expect(result).toEqual(HEURISTIC_RESULT);
    expect(audit.entries[0]?.source).toBe('fallback');
    expect(audit.entries[0]?.fallbackReason).toBeDefined();
  });

  it('off: a configured provider is never asked', async () => {
    const audit = memoryAudit();
    const result = await run('off', audit);

    expect(result).toEqual(HEURISTIC_RESULT);
    expect(received).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });

  it('on: replaces the generative check unless explicitly opted in', async () => {
    stubMode = 'unsure';
    await run('on', memoryAudit());
    expect(evaluateDialectic).not.toHaveBeenCalled();
    await run('on', memoryAudit(), { llmTier: true });
    expect(evaluateDialectic).toHaveBeenCalledTimes(1);
  });

  it('shadow: the generative check can be switched off explicitly', async () => {
    await run('shadow', memoryAudit(), { llmTier: false });
    expect(evaluateDialectic).not.toHaveBeenCalled();
  });
});

describe('System One contradiction check — supersession', () => {
  it('sends the declared supersedes id in state.new', async () => {
    await run('shadow', memoryAudit(), { params: { supersedes: 'D001' } });

    const state = received[0]?.body['state'] as Record<string, { supersedes?: string }>;
    expect(state['new']?.supersedes).toBe('D001');
  });

  it('on: an UNDECLARED "supersedes" answer counts as a contradiction', async () => {
    stubMode = 'supersedes';
    const result = await run('on', memoryAudit());

    expect(result.contradictions).toEqual(['D001']);
    expect(result.confidence).toBeCloseTo(0.2, 5);
  });

  it('on: "supersedes" about the validly declared target is not counted', async () => {
    stubMode = 'supersedes';
    const result = await run('on', memoryAudit(), { params: { supersedes: 'D001' } });

    expect(result.contradictions).toEqual([]);
    expect(result.confidence).toBe(1);
  });

  it('on: a declared target that is already superseded gets no exemption', async () => {
    const existing = EXISTING.map((d) => (d.id === 'D001' ? { ...d, supersedes: 'D000' } : d));
    const result = await validateDecisionConflicts({ ...NEW, supersedes: 'D001' }, existing, {
      mode: 'on',
      decide: stubWiring(memoryAudit()),
      projectRoot: projectDir,
    });

    expect(result.supersession_graph_violations).toEqual([
      'supersedes:D001:already-superseded-by:D000',
    ]);
    expect(result.contradictions).toEqual(['D001']);
    expect(result.confidence).toBe(0);
  });
});

describe('System One contradiction check — shadow agreement is on the acted axis', () => {
  it.each([
    ['refines everywhere', 'refines', undefined, true],
    ['undeclared supersedes', 'supersedes', undefined, false],
    ['validly declared supersedes', 'supersedes', 'D001', true],
    ['contradicts', 'fast', undefined, false],
  ] as const)('%s (stub %s, declared %s) → agree %s', async (_label, mode, supersedes, agree) => {
    stubMode = mode;
    const audit = memoryAudit();
    await run('shadow', audit, supersedes ? { params: { supersedes } } : {});

    expect(audit.entries[0]?.shadow?.agree).toBe(agree);
  });
});

describe('System One contradiction check — redaction before clipping', () => {
  const PAD = 'Context: every agent opens the store through one chokepoint and records each write. '
    .repeat(6)
    .slice(0, 420);

  // Each secret starts ~15 characters before the 440-character rationale cap,
  // so clipping first would send its prefix un-redacted.
  it.each([
    ['anthropic key', `sk-ant-api03-${'Q'.repeat(80)}`, 'sk-ant'],
    ['github token', `ghp_${'A'.repeat(36)}`, 'ghp_'],
  ])('a %s straddling the cut never leaves the machine', async (_label, secret, marker) => {
    const prior = {
      id: 'D010',
      decision: 'Use SQLite as the primary datastore for brain memory',
      rationale: `${PAD} token ${secret}`,
      supersedes: null,
    };
    await validateDecisionConflicts({ ...NEW, rationale: `${NEW.rationale}. ${PAD}` }, [prior], {
      mode: 'shadow',
      decide: stubWiring(memoryAudit()),
      projectRoot: projectDir,
    });

    expect(received).toHaveLength(1);
    const sent = JSON.stringify(received[0]?.body);
    expect(sent).toContain('D010');
    expect(sent).not.toContain(marker);
  });
});

describe('System One contradiction check — unconfigured', () => {
  it('makes zero network calls and still runs the generative check, as today', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network access is forbidden when unconfigured');
    });
    vi.stubGlobal('fetch', fetchSpy);
    evaluateDialectic.mockResolvedValue({
      globalTraits: [],
      peerInsights: [
        { key: 'contradiction', value: 'conflicts with D001 storage choice', confidence: 0.3 },
      ],
    });

    const result = await validateDecisionConflicts(NEW, EXISTING, { projectRoot: projectDir });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
    expect(evaluateDialectic).toHaveBeenCalledTimes(1);
    // The pre-T12493 result for this insight.
    expect(result).toEqual({
      collisions: [],
      contradictions: ['D001'],
      supersession_graph_violations: [],
      confidence: 0.3,
    });
    expect(existsSync(join(projectDir, '.cleo', 'audit', 'decisions.jsonl'))).toBe(false);
  });

  it('the generative check can be switched off even when unconfigured', async () => {
    const result = await validateDecisionConflicts(NEW, EXISTING, {
      projectRoot: projectDir,
      llmTier: false,
    });

    expect(evaluateDialectic).not.toHaveBeenCalled();
    expect(result).toEqual(HEURISTIC_RESULT);
  });

  it('bounds the WHOLE generative path, backend resolution included', async () => {
    // Never settles: models a backend probe or credential fetch that hangs
    // before the (abortable) model call is ever reached.
    evaluateDialectic.mockReturnValue(new Promise(() => undefined));
    const started = performance.now();
    const result = await validateDecisionConflicts(NEW, EXISTING, {
      projectRoot: projectDir,
      generativeTimeoutMs: 100,
    });

    expect(performance.now() - started).toBeLessThan(1_000);
    expect(result).toEqual(HEURISTIC_RESULT);
  });

  it('bounds the generative check: it receives an abort signal', async () => {
    await validateDecisionConflicts(NEW, EXISTING, { projectRoot: projectDir });

    const opts = evaluateDialectic.mock.calls[0]?.[1] as { abortSignal?: AbortSignal } | undefined;
    expect(opts?.abortSignal).toBeInstanceOf(AbortSignal);
  });
});

describe('advisory store path — the site fires without validateWithLlm (T12715)', () => {
  beforeEach(() => {
    saved['CLEO_DIR'] = process.env['CLEO_DIR'];
    process.env['CLEO_DIR'] = join(projectDir, '.cleo');
    _resetDecideDefaultsForTest();
  });
  afterEach(() => {
    closeBrainDb();
  });

  async function seedPrior(): Promise<void> {
    // No adrPath: the advisory check does not run for the seed.
    await storeDecision(projectDir, {
      type: 'architecture',
      decision: EXISTING[0]!.decision,
      rationale: EXISTING[0]!.rationale,
      confidence: 'high',
    });
  }

  it('an ADR write asks System One once in shadow, never calls the generative model, never blocks', async () => {
    await saveDecideCredentials({ baseUrl, apiKey: 'sk-test-SECRET-1234', model: 'stub-model' });
    await seedPrior();
    expect(received).toHaveLength(0);

    const stored = await storeDecision(projectDir, { ...NEW, confidence: 'high' });

    expect(stored.adrPath).toBe(NEW.adrPath);
    expect(received).toHaveLength(1);
    expect(Object.keys(received[0]!.body['questions'] as object)).toEqual(['c1']);
    expect(evaluateDialectic).not.toHaveBeenCalled();
  });

  it('unconfigured: an ADR write makes no network call', async () => {
    await seedPrior();
    await storeDecision(projectDir, { ...NEW, confidence: 'high' });
    expect(received).toHaveLength(0);
    expect(evaluateDialectic).not.toHaveBeenCalled();
  });

  it('on: a confident contradiction is reported, not thrown', async () => {
    await seedPrior();
    const audit = memoryAudit();
    const reported = await adviseDecisionConflicts(projectDir, NEW, {
      mode: 'on',
      decide: stubWiring(audit),
    });
    expect(reported).toEqual(['D001']);
    expect(audit.entries[0]?.shadow?.acted).toBe('decision');
    expect(evaluateDialectic).not.toHaveBeenCalled();
  });
});
