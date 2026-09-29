/**
 * Observation type chosen by ONE System One `choice` question when the caller
 * gave none (T12494).
 *
 * Driven against a local HTTP stub of the Jev `/v1/systemone` endpoint — never
 * the real provider.
 *
 * @task T12494
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObserveBrainParams } from '@cleocode/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionAuditEntry, DecisionAuditSink } from '../../decide/audit.js';
import { createMemoryTokenBucket } from '../../decide/budget.js';
import type { DecideOptions } from '../../decide/client.js';
import { createMemorySpendLedger, DEFAULT_MONTHLY_SPEND_CAP_MICROS } from '../../decide/spend.js';

const enqueued: ObserveBrainParams[] = [];
vi.mock('../brain-writer-thread.js', () => ({
  enqueueBrainWrite: vi.fn(async (op: { params: ObserveBrainParams }) => {
    enqueued.push(op.params);
    const { classifyObservationTypeByKeywords } = await import('../observation-type-decision.js');
    return {
      kind: 'observe',
      result: {
        id: 'O-test',
        type: op.params.type ?? classifyObservationTypeByKeywords(op.params.text),
        createdAt: '2026-09-28 00:00:00',
      },
    };
  }),
}));

const {
  chooseObservationType,
  classifyObservationTypeByKeywords,
  OBSERVATION_TYPE_BUDGET_MS,
  OBSERVATION_TYPE_OPTIONS,
  OBSERVATION_TYPE_SITE,
} = await import('../observation-type-decision.js');
const { observeBrain } = await import('../retrieval/observe.js');

// ---------------------------------------------------------------------------
// Local Jev stub
// ---------------------------------------------------------------------------

type StubMode = 'fast' | 'slow' | 'unsure' | 'out-of-range';

let server: Server;
let baseUrl: string;
let stubMode: StubMode = 'fast';
const received: Array<Record<string, unknown>> = [];

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as { model?: string };
    received.push(body);
    if (stubMode === 'slow') await new Promise((r) => setTimeout(r, 2_000));
    if (res.destroyed) return;
    const choice = stubMode === 'out-of-range' ? 'diary' : 'decision';
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        model: body.model,
        answers: {
          type: {
            type: 'choice',
            choice,
            probabilities: { [choice]: 0.85, change: 0.15 },
            confidence: stubMode === 'unsure' ? 0.4 : 0.9,
          },
        },
        meta: { request_id: 'req_stub' },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

function memoryAudit(): DecisionAuditSink & { entries: DecisionAuditEntry[] } {
  const entries: DecisionAuditEntry[] = [];
  return { entries, write: (e) => entries.push(e) };
}

/**
 * Stub-provider wiring with an in-memory request budget and spend ledger. The
 * spend gate runs inside the site's wait budget, so the process default (a
 * lock-guarded file ledger) let disk I/O on a loaded CI runner exhaust the
 * 300 ms budget before the stub answered: the heuristic acted with no
 * `rejected` mark, and the site under test was never exercised.
 */
function stubWiring(audit: DecisionAuditSink): DecideOptions {
  return {
    connection: { baseUrl, apiKey: 'sk-test-SECRET-1234', model: 'stub-model' },
    budget: createMemoryTokenBucket(),
    spend: createMemorySpendLedger(),
    spendCapMicros: DEFAULT_MONTHLY_SPEND_CAP_MICROS,
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
  enqueued.length = 0;
  projectDir = mkdtempSync(join(tmpdir(), 'cleo-obs-type-proj-'));
  homeDir = mkdtempSync(join(tmpdir(), 'cleo-obs-type-home-'));
  for (const key of ['CLEO_HOME', 'CLEO_ROOT', 'CLEO_PROJECT_ROOT']) saved[key] = process.env[key];
  process.env['CLEO_HOME'] = homeDir;
  process.env['CLEO_ROOT'] = projectDir;
  process.env['CLEO_PROJECT_ROOT'] = projectDir;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

/** The text mentions `update` → the keyword heuristic says `change`; the stub says `decision`. */
const TEXT = 'Update the address book importer to stream rows';

// ---------------------------------------------------------------------------
// Keyword heuristic
// ---------------------------------------------------------------------------

describe('keyword heuristic — whole words, not substrings', () => {
  it.each([
    ['Update the address book importer', 'change'], // `add` inside `address` no longer means feature
    ['Removed prefix handling from the parser', 'discovery'], // `fix` inside `prefix`
    ['Fixed a crash in the loader', 'bugfix'],
    ['Renaming the store modules', 'refactor'],
    ['Added a flag for dry runs', 'feature'],
    ['Implementation of the queue landed', 'feature'],
    ['We picked SQLite instead of Postgres', 'decision'],
    ['The index is rebuilt nightly', 'discovery'],
  ])('%s → %s', (text, type) => {
    expect(classifyObservationTypeByKeywords(text)).toBe(type);
  });
});

/**
 * The pre-T12494 classifier, verbatim: substring keywords. The reference the
 * whole-word classifier is compared against.
 */
function substringClassifier(text: string): string {
  const groups: Array<[string[], string]> = [
    [['bug', 'fix', 'error', 'crash'], 'bugfix'],
    [['refactor', 'rename', 'extract', 'move'], 'refactor'],
    [['add', 'create', 'implement', 'new'], 'feature'],
    [['decide', 'chose', 'pick', 'instead'], 'decision'],
    [['update', 'change', 'modify', 'upgrade'], 'change'],
  ];
  const lower = text.toLowerCase();
  for (const [keywords, type] of groups) {
    if (keywords.some((k) => lower.includes(k))) return type;
  }
  return 'discovery';
}

/** Realistic observation phrases whose type must NOT change. */
const UNCHANGED = [
  // Compounds of the bugfix group (T12494 review regression — must stay bugfix).
  'Bugfix for the parser',
  'Hotfix shipped',
  'Debugging the writer hang',
  'TypeError thrown',
  'ReferenceError in the loader when dist is stale',
  'Hotfixes landed for both regressions',
  'Quickfix applied to the lockfile', // `fix` compound that is not a keyword
  'The bugs in the queue are fixed',
  'Fixed a crash in the loader',
  'Error handling in the transport was missing',
  'Tests crash when the fork pool is unbounded',
  'Bugged state after the retry',
  'Renamed the store modules',
  'Refactoring the audit sink',
  'Extracted the budget helper into site.ts',
  'Added a dry-run flag to cleo add',
  'Implemented the writer queue',
  'Created a new index on tasks',
  'Decided to use SQLite instead of Postgres',
  'Picked vitest over jest',
  'Picking the right model id matters',
  'Chose the file bucket over an in-memory one',
  'Upgraded drizzle to the v1 beta',
  'Changed the default budget to 300ms',
  'The index is rebuilt nightly',
  'WAL mode is enabled by default',
  'Session summary: nothing notable happened',
];

/** Phrases whose type changes on purpose, with the reason. */
const CHANGED: ReadonlyArray<{ text: string; from: string; to: string; why: string }> = [
  {
    text: 'Updated the address book importer',
    from: 'feature',
    to: 'change',
    why: '`add` inside `address` is not "add"; `updated` is the real signal',
  },
  {
    text: 'Removed prefix handling from the parser',
    from: 'bugfix',
    to: 'discovery',
    why: '`prefix` is not a fix',
  },
  {
    text: 'Prefixes are stripped before hashing',
    from: 'bugfix',
    to: 'discovery',
    why: '`prefixes` is not a fix',
  },
  {
    text: 'Postfix notation in the evaluator',
    from: 'bugfix',
    to: 'discovery',
    why: '`postfix` is not a fix',
  },
  {
    text: 'The fixture loader reads JSON',
    from: 'bugfix',
    to: 'discovery',
    why: '`fixture` is not a fix',
  },
  {
    text: 'Renewed the API key',
    from: 'feature',
    to: 'discovery',
    why: '`new` inside `renewed` is not new capability',
  },
  {
    text: 'Caddy config now proxies the API',
    from: 'feature',
    to: 'discovery',
    why: '`add` inside `caddy`',
  },
  {
    text: 'Newest entries are listed first',
    from: 'feature',
    to: 'discovery',
    why: '`newest` describes ordering, not new capability',
  },
  {
    text: 'Moving the paths SSoT into packages/paths',
    from: 'discovery',
    to: 'refactor',
    why: '`moving` is an inflection of `move`, which the substring rule missed',
  },
];

describe('keyword heuristic — old (substring) vs new (whole word) over realistic phrases', () => {
  it.each(UNCHANGED)('unchanged: %s', (text) => {
    expect(classifyObservationTypeByKeywords(text)).toBe(substringClassifier(text));
  });

  it.each(CHANGED)('changed on purpose: $text ($from → $to: $why)', ({ text, from, to }) => {
    expect(substringClassifier(text)).toBe(from);
    expect(classifyObservationTypeByKeywords(text)).toBe(to);
  });
});

// ---------------------------------------------------------------------------
// chooseObservationType
// ---------------------------------------------------------------------------

describe('chooseObservationType', () => {
  it('unconfigured: keyword type, zero network, nothing audited', async () => {
    const choice = await chooseObservationType(TEXT, undefined, {
      decide: { connection: null },
      projectRoot: projectDir,
    });
    expect(choice).toEqual({ type: 'change', source: 'keyword', confidence: 0.5 });
    expect(received).toHaveLength(0);
    expect(existsSync(join(projectDir, '.cleo', 'audit', 'decisions.jsonl'))).toBe(false);
  });

  it('off: keyword type, zero network', async () => {
    const choice = await chooseObservationType(TEXT, undefined, {
      mode: 'off',
      decide: stubWiring(memoryAudit()),
      projectRoot: projectDir,
    });
    expect(choice.source).toBe('keyword');
    expect(received).toHaveLength(0);
  });

  it('shadow: ONE choice question over the six types, keyword type kept, both answers audited', async () => {
    const audit = memoryAudit();
    const choice = await chooseObservationType(TEXT, 'Importer', {
      mode: 'shadow',
      decide: stubWiring(audit),
      projectRoot: projectDir,
    });

    expect(choice).toEqual({ type: 'change', source: 'keyword', confidence: 0.5 });
    expect(received).toHaveLength(1);
    const questions = received[0]?.['questions'] as Record<string, { criteria: object }>;
    expect(Object.keys(questions)).toEqual(['type']);
    expect(Object.keys(questions['type']?.criteria ?? {}).sort()).toEqual(
      [...OBSERVATION_TYPE_OPTIONS].sort(),
    );
    expect(received[0]?.['state']).toEqual({ title: 'Importer', text: TEXT });

    expect(audit.entries).toHaveLength(1);
    const entry = audit.entries[0]!;
    expect(entry.site).toBe(OBSERVATION_TYPE_SITE);
    expect(entry.answers['type']?.value).toBe('decision');
    expect(entry.shadow).toMatchObject({
      mode: 'shadow',
      acted: 'heuristic',
      heuristicVerdict: 'change',
      agree: false,
    });
    expect(entry.shadow?.heuristicAnswers['type']?.value).toBe('change');
  });

  it('on + confident: the decided type, with source and confidence', async () => {
    const audit = memoryAudit();
    const choice = await chooseObservationType(TEXT, undefined, {
      mode: 'on',
      decide: stubWiring(audit),
      projectRoot: projectDir,
    });
    expect(choice).toEqual({ type: 'decision', source: 'system-one', confidence: 0.9 });
    expect(audit.entries[0]?.shadow?.acted).toBe('decision');
  });

  it('on + below the 0.6 floor: keyword type', async () => {
    stubMode = 'unsure';
    const choice = await chooseObservationType(TEXT, undefined, {
      mode: 'on',
      decide: stubWiring(memoryAudit()),
      projectRoot: projectDir,
    });
    expect(choice.source).toBe('keyword');
    expect(choice.type).toBe('change');
  });

  it('on + a choice outside the offered types: rejected, keyword type', async () => {
    stubMode = 'out-of-range';
    const audit = memoryAudit();
    const choice = await chooseObservationType(TEXT, undefined, {
      mode: 'on',
      decide: stubWiring(audit),
      projectRoot: projectDir,
    });
    expect(choice.source).toBe('keyword');
    expect(audit.entries[0]?.shadow).toMatchObject({
      acted: 'heuristic',
      rejected: 'invalid_choice',
      agree: null,
    });
  });

  it('a hanging provider costs at most the budget: keyword type, timeout audited', async () => {
    stubMode = 'slow';
    const audit = memoryAudit();
    const started = performance.now();
    const choice = await chooseObservationType(TEXT, undefined, {
      mode: 'on',
      decide: stubWiring(audit),
      projectRoot: projectDir,
    });
    const ms = performance.now() - started;
    expect(choice.source).toBe('keyword');
    expect(ms).toBeLessThan(OBSERVATION_TYPE_BUDGET_MS + 200);
    expect(audit.entries[0]?.fallbackReason).toBe('timeout');
  });

  it('redacts, then clips: a secret straddling the cut never leaves the machine', async () => {
    const text = `${'Context about the loader and its queue. '.repeat(20).slice(0, 585)} token ghp_${'A'.repeat(36)}`;
    await chooseObservationType(text, undefined, {
      mode: 'shadow',
      decide: stubWiring(memoryAudit()),
      projectRoot: projectDir,
    });
    expect(received).toHaveLength(1);
    expect(JSON.stringify(received[0])).not.toContain('ghp_');
  });
});

// ---------------------------------------------------------------------------
// observeBrain wiring (real credentials file + config cascade)
// ---------------------------------------------------------------------------

describe('observeBrain — type chosen before the writer queue', () => {
  function configure(mode: 'shadow' | 'on'): void {
    writeFileSync(
      join(homeDir, 'decide-credentials.json'),
      JSON.stringify({ version: 1, baseUrl, apiKey: 'sk-test-0000', model: 'stub-model' }),
      { mode: 0o600 },
    );
    mkdirSync(join(projectDir, '.cleo'), { recursive: true });
    writeFileSync(
      join(projectDir, '.cleo', 'config.json'),
      JSON.stringify({ decide: { sites: { observationType: mode } } }),
    );
  }

  it('on: the decided type is written and reported with its source', async () => {
    configure('on');
    const result = await observeBrain(projectDir, { text: TEXT, askTypeDecision: true });
    expect(received).toHaveLength(1);
    expect(enqueued[0]?.type).toBe('decision');
    expect(result).toMatchObject({
      type: 'decision',
      typeSource: 'system-one',
      typeConfidence: 0.9,
    });
  });

  it('shadow: the writer gets NO type (keyword pass as before); source reported as keyword', async () => {
    configure('shadow');
    // Distinct text: the `on` case above filled the process decision cache.
    const result = await observeBrain(projectDir, {
      text: `${TEXT} in batches`,
      askTypeDecision: true,
    });
    expect(received).toHaveLength(1);
    expect(enqueued[0]?.type).toBeUndefined();
    expect(result).toMatchObject({ type: 'change', typeSource: 'keyword', typeConfidence: 0.5 });
  });

  it('explicit type: never asks', async () => {
    configure('on');
    const result = await observeBrain(projectDir, {
      text: TEXT,
      type: 'feature',
      askTypeDecision: true,
    });
    expect(received).toHaveLength(0);
    expect(enqueued[0]?.type).toBe('feature');
    expect(result.typeSource).toBe('caller');
  });

  it('background writes (no opt-in) NEVER ask, even in `on` mode', async () => {
    configure('on');
    // Shapes of the dialectic peer-insight and extraction-gate episodic writes.
    await observeBrain(projectDir, {
      text: `[preference] ${TEXT} for the dialectic peer`,
      title: 'preference',
      sourceType: 'agent',
      agent: 'peer-1',
    });
    const gated = await observeBrain(projectDir, {
      text: `${TEXT} from the extraction gate`,
      sourceType: 'agent',
      _skipGate: true,
    });
    expect(received).toHaveLength(0);
    expect(enqueued.map((p) => p.type)).toEqual([undefined, undefined]);
    expect(gated.typeSource).toBeUndefined();
    expect(existsSync(join(projectDir, '.cleo', 'audit', 'decisions.jsonl'))).toBe(false);
  });

  it('the interactive memory.observe operation opts in', async () => {
    configure('on');
    const { memoryObserve } = await import('../engine-compat.js');
    const res = await memoryObserve(
      { text: `${TEXT} via the CLI`, askTypeDecision: true },
      projectDir,
    );
    expect(res.success).toBe(true);
    expect(received).toHaveLength(1);
    expect(enqueued[0]?.type).toBe('decision');
    // The opt-in flag is not carried across the writer boundary.
    expect(enqueued[0]?.askTypeDecision).toBeUndefined();
  });
});
