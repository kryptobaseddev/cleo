/**
 * Tier 3 of duplicate detection as ONE batched System One decision (T12492).
 *
 * Driven against a local HTTP stub of the Jev `/v1/systemone` endpoint — never
 * the real provider. The fixture puts four active tasks in the Tier-3 zone
 * (Tier-1 in [0.50, 0.92), word-Jaccard in [0.40, 0.85)) with every Tier-1
 * score below the warn threshold, so the heuristic verdict is `insert`.
 *
 * @task T12492
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionAuditEntry, DecisionAuditSink } from '../../decide/audit.js';
import { createMemoryTokenBucket } from '../../decide/budget.js';
import type { DecideOptions } from '../../decide/client.js';

vi.mock('../../memory/brain-embedding.js', () => ({
  isEmbeddingAvailable: () => false,
  embedText: async () => null,
}));

const llmResolverCalls = vi.fn();
vi.mock('../../llm/role-resolver.js', () => ({
  resolveLLMForRole: async (...args: unknown[]) => {
    llmResolverCalls(...args);
    return { sealedCredential: null, credential: null };
  },
}));

const { checkDuplicates, DUPLICATE_DECISION_BUDGET_MS, DUPLICATE_DECISION_SITE } = await import(
  '../duplicate-detector.js'
);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const NEW_TITLE = 'Add retry logic to the webhook sender';
const NEW_DESCRIPTION = 'Retry failed webhook deliveries with exponential backoff';

function task(id: string, title: string, description: string): Task {
  return { id, title, description, status: 'pending' } as Task;
}

const TASKS: Task[] = [
  task(
    'T101',
    'Add retry logic to the webhook delivery',
    'Retry failed webhook deliveries with backoff and jitter',
  ),
  task(
    'T102',
    'Add retry logic to webhook sending',
    'Retry failed webhook deliveries using backoff',
  ),
  task(
    'T103',
    'Retry logic for the webhook sender',
    'Failed webhook deliveries retry with exponential backoff',
  ),
  task(
    'T104',
    'Add retry handling to the webhook sender',
    'Retry webhook deliveries that failed, with backoff',
  ),
  task(
    'T105',
    'Implement CSV export for reports page tables',
    'Allow exporting the report tables to CSV files',
  ),
];

const fakeAccessor = {
  queryTasks: async () => ({ tasks: TASKS, total: TASKS.length }),
};
const accessor = fakeAccessor as Parameters<typeof checkDuplicates>[2];

/** What the pre-T12492 path answers for this fixture with no LLM available. */
const HEURISTIC_RESULT = {
  maxScore: 0,
  candidates: [],
  shouldReject: false,
  shouldWarn: false,
  tier: 'bm25',
};

// ---------------------------------------------------------------------------
// Local Jev stub
// ---------------------------------------------------------------------------

type StubMode = 'fast' | 'slow' | 'error';

let server: Server;
let baseUrl: string;
let stubMode: StubMode = 'fast';
const received: Array<{ auth: string | undefined; body: Record<string, unknown> }> = [];

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
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
    for (const name of Object.keys(body.questions)) {
      // c1 is the duplicate; the rest are not.
      answers[name] = { type: 'noul', noul: name === 'c1' ? 0.93 : 0.08, confidence: 0.9 };
    }
    if (res.destroyed) return;
    res
      .writeHead(200, { 'content-type': 'application/json' })
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
let previousHome: string | undefined;

beforeEach(() => {
  stubMode = 'fast';
  received.length = 0;
  llmResolverCalls.mockClear();
  projectDir = mkdtempSync(join(tmpdir(), 'cleo-dup-decision-proj-'));
  homeDir = mkdtempSync(join(tmpdir(), 'cleo-dup-decision-home-'));
  previousHome = process.env['CLEO_HOME'];
  process.env['CLEO_HOME'] = homeDir;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = previousHome;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('System One duplicate decision — configured', () => {
  it('sends ONE request with at most 3 noul questions and a bounded state', async () => {
    const audit = memoryAudit();
    await checkDuplicates(NEW_TITLE, NEW_DESCRIPTION, accessor, [], projectDir, {
      mode: 'shadow',
      decide: stubWiring(audit),
    });

    expect(received).toHaveLength(1);
    const { body, auth } = received[0]!;
    expect(auth).toBe('Bearer sk-test-SECRET-1234');
    expect(Object.keys(body['questions'] as object)).toEqual(['c1', 'c2', 'c3']);
    const state = body['state'] as Record<string, { id?: string; title: string }>;
    expect(state['new']?.title).toBe(NEW_TITLE);
    // Highest word-Jaccard first: T103, T101, T104; T102 and T105 are left out.
    expect([state['c1']?.id, state['c2']?.id, state['c3']?.id]).toEqual(['T103', 'T101', 'T104']);
    expect(JSON.stringify(state).length).toBeLessThan(4_000);
  });

  it('shadow: acts on the heuristic and audits heuristic + decision answers side by side', async () => {
    const audit = memoryAudit();
    const result = await checkDuplicates(NEW_TITLE, NEW_DESCRIPTION, accessor, [], projectDir, {
      mode: 'shadow',
      decide: stubWiring(audit),
    });

    expect(result).toEqual(HEURISTIC_RESULT);
    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0]!;
    expect(entry.site).toBe(DUPLICATE_DECISION_SITE);
    expect(entry.source).toBe('provider');
    expect(entry.model).toBe('stub-model');
    expect(entry.requestId).toBe('req_stub');
    expect(entry.latencyMs).toBeGreaterThanOrEqual(0);
    expect(entry.answers['c1']).toMatchObject({ type: 'noul', value: true, probability: 0.93 });
    expect(entry.shadow).toMatchObject({
      mode: 'shadow',
      acted: 'heuristic',
      heuristicVerdict: 'insert',
      agree: false,
      subjects: { c1: 'T103', c2: 'T101', c3: 'T104' },
    });
    expect(entry.shadow?.heuristicAnswers['c1']).toMatchObject({ type: 'noul', value: false });
    expect(JSON.stringify(entry)).not.toContain('SECRET');
  });

  it('on: acts on the decision and rejects the candidate it judged a duplicate', async () => {
    const audit = memoryAudit();
    const result = await checkDuplicates(NEW_TITLE, NEW_DESCRIPTION, accessor, [], projectDir, {
      mode: 'on',
      decide: stubWiring(audit),
    });

    expect(result).toMatchObject({ shouldReject: true, tier: 'decision', maxScore: 0.93 });
    expect(result.candidates.map((c) => c.id)).toEqual(['T103']);
    expect(audit.entries[0]?.shadow?.acted).toBe('decision');
  });

  it('slow provider: falls back within the budget and audits `timeout`', async () => {
    stubMode = 'slow';
    const audit = memoryAudit();
    const started = performance.now();
    const result = await checkDuplicates(NEW_TITLE, NEW_DESCRIPTION, accessor, [], projectDir, {
      mode: 'on',
      decide: stubWiring(audit),
    });
    const elapsed = performance.now() - started;

    expect(result).toEqual(HEURISTIC_RESULT);
    // Whole check (lexical tiers + decision) inside budget + epsilon.
    expect(elapsed).toBeLessThan(DUPLICATE_DECISION_BUDGET_MS + 150);
    expect(audit.entries[0]).toMatchObject({ source: 'fallback', fallbackReason: 'timeout' });
    expect(audit.entries[0]?.shadow).toMatchObject({ acted: 'heuristic', agree: null });
  });

  it('provider error: falls back to the heuristic and audits the reason', async () => {
    stubMode = 'error';
    const audit = memoryAudit();
    const result = await checkDuplicates(NEW_TITLE, NEW_DESCRIPTION, accessor, [], projectDir, {
      mode: 'on',
      decide: stubWiring(audit),
    });

    expect(result).toEqual(HEURISTIC_RESULT);
    expect(received).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ source: 'fallback', fallbackReason: 'server_error' });
  });

  it('off: a configured provider is never asked', async () => {
    const audit = memoryAudit();
    const result = await checkDuplicates(NEW_TITLE, NEW_DESCRIPTION, accessor, [], projectDir, {
      mode: 'off',
      decide: stubWiring(audit),
    });

    expect(result).toEqual(HEURISTIC_RESULT);
    expect(received).toHaveLength(0);
    expect(audit.entries).toHaveLength(0);
  });
});

describe('System One duplicate decision — unconfigured', () => {
  it('makes zero network calls, skips the generative LLM tier, and answers as today', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('network access is forbidden when unconfigured');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const result = await checkDuplicates(NEW_TITLE, NEW_DESCRIPTION, accessor, [], projectDir);

    expect(result).toEqual(HEURISTIC_RESULT);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);
    expect(llmResolverCalls).not.toHaveBeenCalled();
    expect(existsSync(join(projectDir, '.cleo', 'audit', 'decisions.jsonl'))).toBe(false);
  });

  it('still runs the generative LLM tier when explicitly opted in', async () => {
    const result = await checkDuplicates(NEW_TITLE, NEW_DESCRIPTION, accessor, [], projectDir, {
      llmTier: true,
    });

    expect(llmResolverCalls).toHaveBeenCalledTimes(1);
    expect(result).toEqual(HEURISTIC_RESULT);
  });
});
