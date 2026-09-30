/**
 * System One accuracy benchmark (T12495): dataset rules, spot-check and
 * corrections, metrics, the profile adapter, and the runner against a fake
 * Jev server (a local HTTP server answering the OpenAPI shapes) — never a
 * real provider.
 *
 * @task T12495
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyBenchCorrections,
  type BenchConnection,
  type BenchRow,
  type BenchSource,
  benchQuestionFor,
  buildBenchDataset,
  classificationMetrics,
  createInterimProfileResolver,
  DecideBenchInputError,
  legacyKeywordObservationType,
  parseBenchCorrections,
  parseBenchDataset,
  renderBenchReport,
  resolveBenchProfiles,
  runDecideBench,
  runDecideBenchOperation,
  sampleBenchSpotCheck,
  serializeBenchDataset,
} from '../bench/index.js';
import { _resetDecideDefaultsForTest } from '../client.js';
import { _resetProviderStateMemoForTest } from '../provider-state.js';
import { DECISION_PROVIDER_PRESETS } from '../providers.js';
import { createMemorySpendLedger } from '../spend.js';

const SECRET = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

/** A small project history: duplicates, siblings, typed observations, superseding decisions. */
function fixtureSource(): BenchSource {
  return {
    async tasks() {
      const task = (
        id: string,
        title: string,
        extra: Partial<{
          parentId: string | null;
          status: string;
          cancellationReason: string;
          notes: string[];
          relates: { taskId: string; type: string; reason?: string }[];
          description: string;
        }> = {},
      ) => ({
        id,
        title,
        description: extra.description ?? `${title} — details`,
        status: extra.status ?? 'pending',
        parentId: extra.parentId === undefined ? 'T100' : extra.parentId,
        ...(extra.cancellationReason ? { cancellationReason: extra.cancellationReason } : {}),
        notes: extra.notes ?? [],
        relates: extra.relates ?? [],
      });
      return [
        task('T100', 'Epic: memory', { parentId: null }),
        task('T101', 'Fix the brain writer lock timeout', {
          relates: [{ taskId: 'T102', type: 'duplicates', reason: 'same bug' }],
        }),
        task('T102', 'Fix brain writer lock timeout on busy DB'),
        task('T103', 'Add observation search pagination', {
          status: 'cancelled',
          cancellationReason: 'Duplicate of T104',
        }),
        task('T104', 'Paginate observation search results'),
        task('T105', 'Document the decide bench', {
          notes: ['2026-09-29: dedup — duplicate of T106'],
          description: `uses key ${SECRET} in the example`,
        }),
        task('T106', 'Write docs for decide bench'),
        task('T107', 'Rename the sentient tick'),
        task('T108', 'Wire the nexus freshness probe', {
          relates: [{ taskId: 'T109', type: 'related' }],
        }),
        task('T109', 'Speed up the nexus incremental build'),
        task('T110', 'Add a changeset for release'),
        task('T111', 'Remove the legacy tasks.db fallback'),
        task('T112', 'Audit the worktree guard'),
      ];
    },
    async observations() {
      return [
        // Explicit: stored "decision" differs from both keyword defaults (bugfix).
        { id: 'O1', type: 'decision', title: 'Chose SQLite', narrative: 'crash in the old store' },
        // Explicit: "discovery" while keywords say feature (add).
        { id: 'O2', type: 'discovery', title: 'Found', narrative: 'we add retries in the client' },
        // Defaulted (agrees with the current keywords): excluded.
        { id: 'O3', type: 'bugfix', title: 'Bug', narrative: 'fixed a crash' },
        // Not an offered type: excluded.
        { id: 'O4', type: 'observation', title: 'x', narrative: 'something' },
        // Explicit: "refactor" while keywords say change.
        { id: 'O5', type: 'refactor', title: 'Tidy', narrative: 'update the config loader' },
      ];
    },
    async decisions() {
      return [
        { id: 'D1', type: 'architecture', decision: 'Use SQLite for tasks', rationale: 'simple' },
        {
          id: 'D2',
          type: 'architecture',
          decision: 'Use Postgres instead of SQLite for tasks',
          rationale: 'scale',
          supersedes: 'D1',
        },
        { id: 'D3', type: 'process', decision: 'Release weekly', rationale: 'cadence' },
        {
          id: 'D4',
          type: 'process',
          decision: 'Release daily instead of weekly',
          rationale: 'faster',
          supersededBy: null,
        },
        {
          id: 'D5',
          type: 'technical',
          decision: 'Pin Node 24',
          rationale: 'LTS',
          supersededBy: 'D6',
        },
        { id: 'D6', type: 'technical', decision: 'Move to Node 26 instead', rationale: 'LTS' },
        { id: 'D7', type: 'process', decision: 'Owner answers via ask tool', rationale: 'HITL' },
      ];
    },
  };
}

describe('buildBenchDataset', () => {
  it('labels duplicates from relations, cancellation reasons and notes, with provenance', async () => {
    const rows = await buildBenchDataset(fixtureSource(), { sites: ['duplicateDetection'] });
    const positives = rows.filter((r) => r.label === 'duplicate');
    expect(positives.map((r) => [r.id, r.provenance.rule]).sort()).toEqual([
      ['duplicateDetection:T101+T102', 'duplicates-relation'],
      ['duplicateDetection:T103+T104', 'cancelled-duplicate-reason'],
      ['duplicateDetection:T105+T106', 'note-duplicate-reference'],
    ]);
    const negatives = rows.filter((r) => r.label === 'distinct');
    expect(negatives.length).toBeGreaterThan(0);
    for (const n of negatives) {
      expect(n.provenance.rule).toBe('same-parent-unrelated');
      // Never a positive pair, never a related pair.
      expect(['T101+T102', 'T103+T104', 'T105+T106', 'T108+T109']).not.toContain(
        n.provenance.sourceIds.join('+'),
      );
    }
  });

  it('redacts secrets with the System One redaction before storing text', async () => {
    const rows = await buildBenchDataset(fixtureSource(), { sites: ['duplicateDetection'] });
    const text = serializeBenchDataset(rows);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('[REDACTED]');
  });

  it('keeps only observations whose type a caller must have set', async () => {
    const rows = await buildBenchDataset(fixtureSource(), { sites: ['observationType'] });
    expect(rows.map((r) => [r.id, r.label])).toEqual([
      ['observationType:O1', 'decision'],
      ['observationType:O2', 'discovery'],
      ['observationType:O5', 'refactor'],
    ]);
    expect(legacyKeywordObservationType('we address it')).toBe('feature');
  });

  it('labels supersedes edges (both pointers) as conflicts and unlinked pairs as compatible', async () => {
    const rows = await buildBenchDataset(fixtureSource(), { sites: ['decisionContradiction'] });
    const positives = rows.filter((r) => r.label === 'conflict').map((r) => r.id);
    expect(positives.sort()).toEqual([
      'decisionContradiction:D2>D1',
      'decisionContradiction:D6>D5',
    ]);
    const negatives = rows.filter((r) => r.label === 'compatible');
    expect(negatives.length).toBeGreaterThan(0);
    for (const n of negatives) {
      const pair = [...n.provenance.sourceIds].sort().join('+');
      expect(['D1+D2', 'D5+D6']).not.toContain(pair);
    }
  });

  it('is deterministic for a seed and round-trips through JSONL', async () => {
    const a = await buildBenchDataset(fixtureSource(), { seed: 7 });
    const b = await buildBenchDataset(fixtureSource(), { seed: 7 });
    expect(serializeBenchDataset(a)).toBe(serializeBenchDataset(b));
    expect(parseBenchDataset(serializeBenchDataset(a))).toEqual(a);
    expect(() => parseBenchDataset('{"id":"x"}\n')).toThrow(/line 1/);
  });

  it('never sends the declared supersedes in the contradiction question', async () => {
    const rows = await buildBenchDataset(fixtureSource(), { sites: ['decisionContradiction'] });
    const row = rows.find((r) => r.id === 'decisionContradiction:D2>D1');
    if (!row) throw new Error('missing row');
    const q = benchQuestionFor(row);
    expect(JSON.stringify(q.req.state)).not.toContain('supersedes');
    expect(q.req.cache).toBe(false);
    expect(Object.keys(q.req.questions)).toEqual(['c1']);
  });
});

describe('spot-check and corrections', () => {
  it('samples about 30 items stratified by site and label, every stratum represented', async () => {
    const rows = await buildBenchDataset(fixtureSource());
    const sample = sampleBenchSpotCheck(rows, { size: 12, seed: 1 });
    expect(sample.items.length).toBe(Math.min(12, rows.length));
    const strata = new Set(rows.map((r) => `${r.site}/${r.label}`));
    const sampled = new Set(sample.items.map((i) => `${i.site}/${i.proposedLabel}`));
    expect(sampled).toEqual(strata);
    for (const item of sample.items) expect(item.options[0]).toBe(item.proposedLabel);
  });

  it('applies confirmations, relabels and drops, and marks rows owner-verified', async () => {
    const rows = await buildBenchDataset(fixtureSource(), { sites: ['duplicateDetection'] });
    const [first, second, third] = rows;
    if (!first || !second || !third) throw new Error('fixture too small');
    const corrections = parseBenchCorrections(
      JSON.stringify({
        corrections: [
          { id: first.id, label: first.label },
          {
            id: second.id,
            label: second.label === 'duplicate' ? 'distinct' : 'duplicate',
            note: 'no',
          },
          { id: third.id, drop: true },
          { id: 'nope', label: 'duplicate' },
        ],
      }),
    );
    const { rows: out, receipt } = applyBenchCorrections(rows, corrections);
    expect(receipt).toMatchObject({ confirmed: 1, relabelled: 1, dropped: 1 });
    expect(receipt.unmatched).toContain('nope');
    expect(out.length).toBe(rows.length - 1);
    expect(out.find((r) => r.id === first.id)?.ownerVerified).toBe(true);
    const relabelled = out.find((r) => r.id === second.id);
    expect(relabelled?.correctedFrom).toBe(second.label);
    expect(relabelled?.ownerNote).toBe('no');
    // A label the site does not allow is rejected, not applied.
    const bad = applyBenchCorrections(rows, [{ id: first.id, label: 'maybe' }]);
    expect(bad.receipt.rejected).toEqual([{ id: first.id, label: 'maybe' }]);
    expect(() => parseBenchCorrections('{"x":1}')).toThrow(/corrections/);
  });
});

describe('classificationMetrics', () => {
  it('computes positive-class metrics for a two-label site', () => {
    const m = classificationMetrics(
      [
        { gold: 'duplicate', predicted: 'duplicate' },
        { gold: 'duplicate', predicted: 'distinct' },
        { gold: 'distinct', predicted: 'duplicate' },
        { gold: 'distinct', predicted: 'distinct' },
        { gold: 'distinct', predicted: 'distinct' },
      ],
      'duplicate',
    );
    expect(m).toEqual({
      n: 5,
      accuracy: 0.6,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      falsePositiveRate: 1 / 3,
    });
  });

  it('macro-averages a multi-class site', () => {
    const m = classificationMetrics(
      [
        { gold: 'a', predicted: 'a' },
        { gold: 'b', predicted: 'a' },
      ],
      null,
    );
    expect(m.accuracy).toBe(0.5);
    expect(m.recall).toBe(0.5); // a: 1, b: 0
  });
});

describe('profile adapter (until T12733 lands)', () => {
  it('resolves env profiles, the layahost preset and the stored connection', () => {
    const resolver = createInterimProfileResolver(
      {
        CLEO_DECIDE_PROFILE_LAYAHOST_KEY: 'k1',
        CLEO_DECIDE_PROFILE_JEV_KEY: 'k2',
        CLEO_DECIDE_PROFILE_JEV_URL: 'http://127.0.0.1:9',
      },
      () => null,
    );
    const [laya, jev] = resolveBenchProfiles(['layahost', 'jev'], resolver);
    expect(laya?.baseUrl).toMatch(/^https:\/\//);
    expect(laya?.apiKey).toBe('k1');
    expect(jev).toMatchObject({ name: 'jev', provider: 'jev', baseUrl: 'http://127.0.0.1:9' });
    expect(() => resolveBenchProfiles(['ghost'], resolver)).toThrow(/ghost/);
    // A profile without a URL takes its provider's preset URL (T12733 gave jev one).
    const noUrl = createInterimProfileResolver({ CLEO_DECIDE_PROFILE_JEV_KEY: 'k' }, () => null);
    expect(noUrl.resolve('jev')).toMatchObject({
      provider: 'jev',
      baseUrl: DECISION_PROVIDER_PRESETS.jev.defaultBaseUrl,
    });
    // A provider without a preset URL still needs one: an unknown kind parses to jev,
    // so assert the guard through a URL that is present but invalid instead.
    const badUrl = createInterimProfileResolver(
      { CLEO_DECIDE_PROFILE_JEV_KEY: 'k', CLEO_DECIDE_PROFILE_JEV_URL: 'ftp://x' },
      () => null,
    );
    expect(() => badUrl.resolve('jev')).toThrow(/invalid URL/);
  });
});

// ─── Fake Jev server ─────────────────────────────────────────────────────────

interface Call {
  readonly method: string;
  readonly path: string;
  readonly auth: string;
  readonly body: string;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Read a request body. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c.toString('utf-8');
    });
    req.on('end', () => resolve(data));
  });
}

/** Whether a JSON value is an object. */
function isObject(v: Json | undefined): v is { [k: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Words of a value's JSON. */
function words(v: Json | undefined): Set<string> {
  return new Set(
    JSON.stringify(v ?? '')
      .toLowerCase()
      .match(/[a-z]{4,}/g) ?? [],
  );
}

/** The fake model: answers each question from the state. */
function answer(request: Json): Json {
  if (!isObject(request) || !isObject(request['questions'])) return {};
  const state = request['state'];
  const answers: { [k: string]: Json } = {};
  for (const [name, q] of Object.entries(request['questions'])) {
    if (!isObject(q)) continue;
    if (q['type'] === 'noul' && isObject(state)) {
      const a = words(isObject(state['new']) ? state['new']['title'] : '');
      const b = words(isObject(state[name]) ? state[name]['title'] : '');
      const shared = [...a].filter((w) => b.has(w)).length;
      const p = shared >= 2 ? 0.9 : 0.1;
      answers[name] = { type: 'noul', noul: p, confidence: Math.max(p, 1 - p) };
    } else if (q['type'] === 'choice' && isObject(q['criteria'])) {
      const options = Object.keys(q['criteria']);
      const text = JSON.stringify(state).toLowerCase();
      const pick = options.includes('contradicts')
        ? text.includes('instead')
          ? 'supersedes'
          : 'unrelated'
        : (options.find((o) => text.includes(o)) ?? 'discovery');
      const probabilities: { [k: string]: Json } = {};
      for (const o of options) probabilities[o] = o === pick ? 0.8 : 0.2 / (options.length - 1);
      answers[name] = { type: 'choice', choice: pick, confidence: 0.7, probabilities };
    }
  }
  return { answers, meta: { cost_micros: 5, request_id: 'r' } };
}

/** {@link answer} as a plain Jev host sends it: no `confidence`, no `meta` (no cost). */
function plainJevAnswer(request: Json): { [k: string]: Json } {
  const a = answer(request);
  if (!isObject(a) || !isObject(a['answers'])) return {};
  const answers: { [k: string]: Json } = {};
  for (const [name, value] of Object.entries(a['answers'])) {
    if (!isObject(value)) continue;
    const { confidence: _drop, ...rest } = value;
    answers[name] = rest;
  }
  return { answers };
}

/** {@link answer} with a different reported cost. */
function pricedAnswer(request: Json, micros: number): { [k: string]: Json } {
  const a = answer(request);
  return isObject(a) ? { ...a, meta: { cost_micros: micros } } : {};
}

let server: Server;
let baseUrl: string;
const calls: Call[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void readBody(req).then((body) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      const auth = req.headers.authorization ?? '';
      calls.push({ method: req.method ?? '', path, auth, body });
      const send = (status: number, json: Json): void => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
      };
      if (path === '/v1/usage') return send(200, { balance: { micros: 1_000_000 } });
      if (path === '/v1/templates') return send(200, { templates: [] });
      if (path === '/v1/systemone/batch') {
        const parsed: Json = JSON.parse(body);
        const requests =
          isObject(parsed) && Array.isArray(parsed['requests']) ? parsed['requests'] : [];
        // The "jev" key fails every third item with a 500; "bad" answers
        // every item with a billed but malformed 2xx; "pricey" costs 100 µ$.
        const flaky = auth === 'Bearer jev-key';
        const bad = auth === 'Bearer bad-key';
        const pricey = auth === 'Bearer pricey-key';
        const plain = auth === 'Bearer plain-key';
        return send(200, {
          responses: requests.map((r, index) =>
            bad
              ? { index, status: 200, body: { answers: {}, meta: { cost_micros: 5 } } }
              : flaky && index % 3 === 2
                ? { index, status: 500, body: { error: { type: 'server_error' } } }
                : {
                    index,
                    status: 200,
                    body: pricey
                      ? { ...pricedAnswer(r, 100) }
                      : plain
                        ? plainJevAnswer(r)
                        : answer(r),
                  },
          ),
          request_id: 'b',
        });
      }
      if (path === '/v1/systemone') {
        const malformed = auth === 'Bearer bad-key';
        return send(
          200,
          malformed
            ? { answers: {}, meta: { cost_micros: 5 } }
            : auth === 'Bearer plain-key'
              ? plainJevAnswer(JSON.parse(body))
              : answer(JSON.parse(body)),
        );
      }
      return send(404, { error: { type: 'not_found' } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let dir: string;
let savedHome: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-bench-'));
  // Anything that falls through to a default path lands in the temp home.
  savedHome = process.env['CLEO_HOME'];
  process.env['CLEO_HOME'] = join(dir, 'home');
  calls.length = 0;
  _resetDecideDefaultsForTest();
  _resetProviderStateMemoForTest();
});
afterEach(() => {
  if (savedHome === undefined) delete process.env['CLEO_HOME'];
  else process.env['CLEO_HOME'] = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

function connections(): BenchConnection[] {
  return [
    { name: 'layahost', provider: 'layahost', baseUrl, apiKey: 'laya-key', model: 'laya-auto' },
    { name: 'jev', provider: 'jev', baseUrl, apiKey: 'jev-key' },
  ];
}

describe('runDecideBench against a fake Jev server', () => {
  it('scores both providers per site next to the heuristic, cache off, cost from meta', async () => {
    const rows = await buildBenchDataset(fixtureSource());
    const ledger = createMemorySpendLedger();
    const results = await runDecideBench({
      rows,
      connections: connections(),
      runs: 2,
      batchSize: 4,
      spendLedger: ledger,
      providerStateDir: join(dir, 'state'),
    });

    // A batch of one row goes out as a single /v1/systemone call.
    const decisionCalls = calls.filter((c) => c.path.startsWith('/v1/systemone'));
    expect(decisionCalls.some((c) => c.path === '/v1/systemone/batch')).toBe(true);
    const sentRequests = decisionCalls.flatMap((c): Json[] => {
      const body: Json = JSON.parse(c.body);
      if (c.path === '/v1/systemone') return [body];
      return isObject(body) && Array.isArray(body['requests']) ? body['requests'] : [];
    });
    for (const r of sentRequests) expect(isObject(r) && r['cache']).toBe(false);
    for (const c of decisionCalls) expect(c.body).not.toContain(SECRET);
    // Every row reached both providers in both runs (no client-side cache).
    expect(sentRequests.length).toBe(rows.length * 2 * 2);

    expect(results.runs).toHaveLength(2);
    expect(results.runs.every((r) => r.complete)).toBe(true);
    expect(results.heuristic.map((h) => h.site)).toEqual([
      'duplicateDetection',
      'observationType',
      'decisionContradiction',
    ]);
    const laya = results.aggregate.find(
      (a) => a.provider === 'layahost' && a.site === 'decisionContradiction',
    );
    expect(laya?.accuracy.n).toBe(2);
    expect(laya?.accuracy.stddev).toBe(0);
    const jevDup = results.runs[0]?.providers
      .find((p) => p.provider === 'jev')
      ?.sites.find((s) => s.site === 'duplicateDetection');
    expect(jevDup?.fallbacks['server_error']).toBeGreaterThan(0);
    expect(jevDup?.answered).toBeLessThan(jevDup?.attempted ?? 0);
    const layaObs = results.runs[0]?.providers
      .find((p) => p.provider === 'layahost')
      ?.sites.find((s) => s.site === 'observationType');
    expect(layaObs?.costReported).toBe(true);
    expect(layaObs?.latency.p50Ms).not.toBeNull();

    // Actual spend is recorded in the monthly ledger too.
    expect((await ledger.status())?.spentMicros).toBe(results.spend.spentMicros);
    expect(results.spend.reportedMicros).toBeGreaterThan(0);
    expect(JSON.stringify(results)).not.toContain('laya-key');

    const report = renderBenchReport(results);
    expect(report).toContain('## System One accuracy benchmark');
    expect(report).toContain('| layahost |');
    expect(report).toContain('| heuristic |');
    expect(report).toContain('cleo decide bench --profiles layahost,jev');
  });

  it('stops cleanly at the cap before a batch whose estimate would pass it', async () => {
    const rows = await buildBenchDataset(fixtureSource());
    // 15 µ$ per question estimate, 4 rows per batch → 60 µ$ per batch; cap allows 2.
    const results = await runDecideBench({
      rows,
      connections: connections(),
      runs: 3,
      batchSize: 4,
      maxMicros: 130,
      spendLedger: null,
      providerStateDir: join(dir, 'state'),
    });
    expect(results.spend.capReached).toBe(true);
    expect(results.spend.stoppedAt).toMatchObject({ run: 1, estimateMicros: 60 });
    expect(results.spend.spentMicros).toBeLessThanOrEqual(130);
    expect(results.spend.batchesSent).toBe(
      calls.filter((c) => c.path.startsWith('/v1/systemone')).length,
    );
    expect(results.spend.batchesSent).toBeLessThan(results.spend.batchesPlanned);
    expect(results.runs.at(-1)?.complete).toBe(false);
    expect(renderBenchReport(results)).toContain('Stopped at the cap');
  });
});

describe('billed but unusable answers and pricier models (review of #1715)', () => {
  it('caps a model that keeps answering in the wrong shape', async () => {
    const rows = await buildBenchDataset(fixtureSource());
    const results = await runDecideBench({
      rows,
      connections: [{ name: 'bad', provider: 'jev', baseUrl, apiKey: 'bad-key' }],
      runs: 50,
      batchSize: 4,
      maxMicros: 200,
      spendLedger: null,
      providerStateDir: join(dir, 'state'),
    });
    expect(results.spend.capReached).toBe(true);
    expect(results.spend.spentMicros).toBeGreaterThan(0);
    expect(results.spend.spentMicros).toBeLessThanOrEqual(200);
    const dup = results.runs[0]?.providers[0]?.sites.find((s) => s.site === 'duplicateDetection');
    expect(dup?.fallbacks['invalid_response']).toBeGreaterThan(0);
    expect(dup?.answered).toBe(0);
  });

  it('carries the reported cost onto an invalid_response fallback', async () => {
    const { decide } = await import('../client.js');
    const req = {
      state: 'x',
      questions: { q: { type: 'noul' as const, criteria: 'is it?' } },
    };
    const outcome = await decide(
      'cli.decide-bench',
      req,
      () => ({ q: { type: 'noul', value: false, probability: 0.1, confidence: 0.5 } }),
      {
        provider: {
          decide: async () => ({
            // A choice answer to a noul question: billed, then rejected.
            answers: {
              q: { type: 'choice', value: 'a', probabilities: { a: 1 }, confidence: 1 },
            },
            source: 'provider',
            latencyMs: 1,
            costMicros: 40,
          }),
        },
        cache: null,
        budget: null,
        spend: null,
        audit: null,
      },
    );
    expect(outcome.source).toBe('fallback');
    expect(outcome.costMicros).toBe(40);
  });

  it('estimates the next batch from the observed cost, so a pricier model stops in time', async () => {
    const rows = await buildBenchDataset(fixtureSource());
    const results = await runDecideBench({
      rows,
      connections: [{ name: 'pricey', provider: 'jev', baseUrl, apiKey: 'pricey-key' }],
      batchSize: 4,
      maxMicros: 1_000,
      spendLedger: null,
      providerStateDir: join(dir, 'state'),
    });
    // 4 rows × 100 µ$ = 400 per batch: two batches fit, the third would not.
    expect(results.spend.spentMicros).toBe(800);
    expect(results.spend.stoppedAt?.estimateMicros).toBe(400);
  });
});

describe('plain Jev host: no confidence, no cost', () => {
  it('answers usably and marks the unreported cost as an estimate', async () => {
    const rows = await buildBenchDataset(fixtureSource());
    const results = await runDecideBench({
      rows,
      connections: [{ name: 'plain', provider: 'jev', baseUrl, apiKey: 'plain-key' }],
      batchSize: 4,
      maxMicros: 10_000,
      spendLedger: null,
      providerStateDir: join(dir, 'state'),
    });
    const sites = results.runs[0]?.providers[0]?.sites ?? [];
    for (const site of sites) {
      expect(site.fallbacks['invalid_response'] ?? 0).toBe(0);
      expect(site.answered).toBe(site.attempted);
      expect(site.costReported).toBe(false);
    }
    expect(results.spend.reportedMicros).toBe(0);
    const row = results.aggregate.find((a) => a.provider === 'plain');
    expect(row?.costReported).toBe(false);
    expect(renderBenchReport(results)).toMatch(/\| plain \|.*~\$[0-9.]+ \(est\.\)/);
  });
});

describe('leakage and profile validation (review of #1715)', () => {
  it('drops pair rows whose text gives the label away', async () => {
    const task = (id: string, title: string, description: string) => ({
      id,
      title,
      description,
      status: 'pending',
      parentId: 'T1',
      notes: [],
      relates: [] as { taskId: string; type: string }[],
    });
    const source: BenchSource = {
      tasks: async () => [
        {
          ...task('T10', 'Search pagination', 'Duplicate of T11, closing'),
          relates: [{ taskId: 'T11', type: 'duplicates' }],
        },
        task('T11', 'Paginate search', 'cursor based'),
        {
          ...task('T12', 'Retry writer', 'retries'),
          relates: [{ taskId: 'T13', type: 'duplicates' }],
        },
        task('T13', 'Writer retries', 'backoff'),
      ],
      observations: async () => [],
      decisions: async () => [],
    };
    const rows = await buildBenchDataset(source, { sites: ['duplicateDetection'] });
    const ids = rows.filter((r) => r.label === 'duplicate').map((r) => r.id);
    expect(ids).toEqual(['duplicateDetection:T12+T13']);
  });

  it('reports an invalid URL or model instead of an unknown profile', () => {
    const badUrl = createInterimProfileResolver(
      { CLEO_DECIDE_PROFILE_JEV_KEY: 'k', CLEO_DECIDE_PROFILE_JEV_URL: 'http://example.com' },
      () => null,
    );
    expect(() => badUrl.resolve('jev')).toThrow(/invalid URL/);
    const badModel = createInterimProfileResolver(
      { CLEO_DECIDE_PROFILE_LAYAHOST_KEY: 'k', CLEO_DECIDE_PROFILE_LAYAHOST_MODEL: 'bad model!' },
      () => null,
    );
    expect(() => resolveBenchProfiles(['layahost'], badModel)).toThrow(/invalid model/);
  });
});

describe('runDecideBenchOperation', () => {
  it('builds the dataset and the spot-check offline, then reuses it and applies corrections', async () => {
    const out = join(dir, 'out');
    const first = await runDecideBenchOperation({
      projectRoot: dir,
      outDir: out,
      sampleOnly: true,
      source: fixtureSource(),
    });
    expect(first.ran).toBe(false);
    expect(first.datasetReused).toBe(false);
    expect(calls).toHaveLength(0);
    const sample: { items: { id: string; proposedLabel: string }[] } = JSON.parse(
      readFileSync(first.files.spotCheck, 'utf-8'),
    );
    expect(sample.items.length).toBe(Math.min(30, first.dataset.total));

    const item = sample.items[0];
    if (!item) throw new Error('empty sample');
    const correctionsPath = join(dir, 'corrections.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(correctionsPath, JSON.stringify([{ id: item.id, label: item.proposedLabel }]));
    const second = await runDecideBenchOperation({
      projectRoot: dir,
      outDir: out,
      sampleOnly: true,
      correctionsPath,
      // A source that would throw proves the dataset is reused, not rebuilt.
      source: {
        tasks: () => Promise.reject(new Error('rebuilt')),
        observations: () => Promise.reject(new Error('rebuilt')),
        decisions: () => Promise.reject(new Error('rebuilt')),
      },
    });
    expect(second.datasetReused).toBe(true);
    expect(second.corrections?.confirmed).toBe(1);
    expect(second.dataset.ownerVerified).toBe(1);
    const rows: BenchRow[] = parseBenchDataset(readFileSync(second.files.dataset, 'utf-8'));
    expect(rows.find((r) => r.id === item.id)?.ownerVerified).toBe(true);
  });

  it('runs the providers and writes results.json and report.md', async () => {
    const out = join(dir, 'out');
    const summary = await runDecideBenchOperation({
      projectRoot: dir,
      outDir: out,
      source: fixtureSource(),
      sites: ['decisionContradiction'],
      connections: connections(),
      maxUsd: 1,
      spendLedger: null,
      providerStateDir: join(dir, 'state'),
    });
    expect(summary.ran).toBe(true);
    expect(summary.sites).toEqual(['decisionContradiction']);
    const results: { config: { sites: string[] } } = JSON.parse(
      readFileSync(summary.files.results ?? '', 'utf-8'),
    );
    expect(results.config.sites).toEqual(['decisionContradiction']);
    expect(readFileSync(summary.files.report ?? '', 'utf-8')).toContain('Decision contradiction');
  });

  it('rejects a run without providers and unknown sites, before touching the store', async () => {
    await expect(runDecideBenchOperation({ projectRoot: dir, outDir: dir })).rejects.toBeInstanceOf(
      DecideBenchInputError,
    );
    await expect(
      runDecideBenchOperation({ projectRoot: dir, sampleOnly: true, sites: ['nope'] }),
    ).rejects.toThrow(/unknown site/);
    await expect(
      runDecideBenchOperation({ projectRoot: dir, sampleOnly: true, maxUsd: -1 }),
    ).rejects.toThrow(/max-usd/);
  });
});
