/**
 * The System One benchmark runner (T12495): replay every labelled row through
 * every compared provider with `decideBatch`, next to each site's heuristic,
 * and score the answers.
 *
 * - Provider answer cache off (`cache: false` on every request) and the
 *   in-process outcome cache off, so every row is a real provider call.
 * - One batch deadline of at least {@link MIN_BENCH_TIMEOUT_MS} (spec §1: the
 *   batch endpoint answers its items serially).
 * - A hard total spend cap across all providers and runs, SEPARATE from the
 *   everyday monthly cap: before each batch the spend estimate (per
 *   question, the larger of {@link DECISION_COST_ESTIMATE_MICROS_PER_QUESTION}
 *   and the connection's observed mean reported cost) is added to what was
 *   spent so far, and the run stops cleanly when that would pass the cap.
 *   Billed answers the client rejected (`invalid_response`) count at their
 *   reported cost (else the estimate), so a model that keeps answering in
 *   the wrong shape is still capped. The monthly cap does not gate the benchmark
 *   (`spend: null` on the calls), but every batch's spend is still recorded
 *   in the monthly ledger so month-to-date spend stays true.
 * - Providers take turns batch by batch, so a cap stop leaves them with the
 *   same coverage.
 *
 * @task T12495
 * @epic T12486
 */

import { join } from 'node:path';
import type { DecisionOutcome } from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';
import type { DecisionAuditEntry, DecisionAuditSink } from '../audit.js';
import { hashCanonical } from '../cache.js';
import {
  DECISION_COST_ESTIMATE_MICROS_PER_QUESTION,
  type DecisionBatchEntry,
  decideBatch,
  redactDecisionState,
} from '../client.js';
import { DECIDE_BENCH_DECISION_SITE } from '../sites/registry.js';
import { createFileSpendLedger, type SpendLedger } from '../spend.js';
import type { DecideFetch } from '../transport.js';
import { type BenchDatasetSizes, benchDatasetSizes } from './dataset.js';
import {
  type BenchClassificationMetrics,
  type BenchLatency,
  type BenchPrediction,
  classificationMetrics,
  latencyOf,
} from './metrics.js';
import { type BenchQuestion, benchQuestionFor } from './questions.js';
import { type BenchSpread, spreadOf } from './stats.js';
import {
  BENCH_SITES,
  type BenchConnection,
  type BenchRow,
  type BenchSite,
  positiveLabel,
} from './types.js';

/** Default hard spend cap across providers and runs: $5. */
export const DEFAULT_BENCH_MAX_MICROS = 5_000_000;

/** Minimum (and default) batch deadline, ms. */
export const MIN_BENCH_TIMEOUT_MS = 30_000;

/** Default rows per batch call. */
export const DEFAULT_BENCH_BATCH_SIZE = 16;

/** Largest batch the layahost batch endpoint accepts (64 requests). */
export const MAX_BENCH_BATCH_SIZE = 64;

/** Name of the heuristic pseudo-provider in results. */
export const HEURISTIC_PROVIDER = 'heuristic';

/** Options for {@link runDecideBench}. */
export interface RunDecideBenchOptions {
  /** Labelled rows (already filtered to the sites to run). */
  readonly rows: readonly BenchRow[];
  /** Providers to compare. */
  readonly connections: readonly BenchConnection[];
  /** Repeated runs. Default 1. */
  readonly runs?: number;
  /** Hard total spend cap in micro-dollars. Default {@link DEFAULT_BENCH_MAX_MICROS}. */
  readonly maxMicros?: number;
  /** Rows per batch call, 1–{@link MAX_BENCH_BATCH_SIZE}. Default {@link DEFAULT_BENCH_BATCH_SIZE}. */
  readonly batchSize?: number;
  /** Batch deadline, ms; raised to at least {@link MIN_BENCH_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Monthly ledger the actual spend is recorded in; `null` skips it. Default: the file ledger. */
  readonly spendLedger?: SpendLedger | null;
  /** Transport (tests). Default: the decide transport. */
  readonly fetch?: DecideFetch;
  /**
   * Directory for per-connection provider-state files (detected
   * capabilities). Default `<cleoHome>/decide/bench/`. Each compared
   * connection gets its own file: the everyday state file holds ONE identity,
   * so two connections sharing it would overwrite each other's detection and
   * one would fall back to the Jev minimum (no batch, no `cache: false`).
   */
  readonly providerStateDir?: string;
  /** Clock (tests). */
  readonly now?: () => Date;
}

/** One provider's (or the heuristic's) result on one site in one run. */
export interface BenchSiteResult extends BenchClassificationMetrics {
  /** Site. */
  readonly site: BenchSite;
  /** Rows sent (or scored, for the heuristic). */
  readonly attempted: number;
  /** Rows the provider answered usably (the metrics' `n`). */
  readonly answered: number;
  /** Latency of provider-answered rows: the wall time of the batch call that carried each row. */
  readonly latency: BenchLatency;
  /** Spend accounted to this site, micro-dollars (reported cost, else the estimate). */
  readonly costMicros: number;
  /** Whether the provider reported its cost (`meta.cost_micros` / `cost_usd`). */
  readonly costReported: boolean;
  /** Fallback reason → rows (timeouts, 4xx/5xx, malformed answers, …). */
  readonly fallbacks: Readonly<Record<string, number>>;
  /** Rows the provider answered with a value outside the site's labels. */
  readonly unusable: number;
}

/** One provider in one run. */
export interface BenchProviderRun {
  /** Profile name. */
  readonly provider: string;
  /** Per-site results, in {@link BENCH_SITES} order. */
  readonly sites: readonly BenchSiteResult[];
}

/** One repeated run. */
export interface BenchRunRecord {
  /** 1-based run number. */
  readonly run: number;
  /** Whether every batch of the run was sent (false when the cap stopped it). */
  readonly complete: boolean;
  /** Per provider. */
  readonly providers: readonly BenchProviderRun[];
}

/** Mean and spread of one provider × site across runs. */
export interface BenchAggregateRow {
  /** Profile name (or {@link HEURISTIC_PROVIDER}). */
  readonly provider: string;
  /** Site. */
  readonly site: BenchSite;
  /** Rows answered, per run. */
  readonly answered: BenchSpread;
  /** Accuracy. */
  readonly accuracy: BenchSpread;
  /** Precision. */
  readonly precision: BenchSpread;
  /** Recall. */
  readonly recall: BenchSpread;
  /** F1. */
  readonly f1: BenchSpread;
  /** False-positive rate. */
  readonly falsePositiveRate: BenchSpread;
  /** p50 latency, ms. */
  readonly p50Ms: BenchSpread;
  /** p95 latency, ms. */
  readonly p95Ms: BenchSpread;
  /** Cost per run, micro-dollars. */
  readonly costMicros: BenchSpread;
  /** Fallbacks summed over runs, by reason. */
  readonly fallbacks: Readonly<Record<string, number>>;
}

/** Spend accounting of a benchmark. */
export interface BenchSpendSummary {
  /** The hard cap, micro-dollars. */
  readonly capMicros: number;
  /** Spent (reported cost, else the estimate), micro-dollars. */
  readonly spentMicros: number;
  /** Of which the providers reported. */
  readonly reportedMicros: number;
  /** Whether the cap stopped the benchmark. */
  readonly capReached: boolean;
  /** Where it stopped, when it did. */
  readonly stoppedAt?: {
    readonly run: number;
    readonly site: BenchSite;
    readonly provider: string;
    readonly batch: number;
    readonly estimateMicros: number;
  };
  /** Batch calls made. */
  readonly batchesSent: number;
  /** Batch calls planned (runs × sites × batches × providers). */
  readonly batchesPlanned: number;
  /** Whether the monthly ledger accepted the spend record (false: it could not be written). */
  readonly recordedInMonthlyLedger: boolean;
}

/** The machine-readable benchmark result. */
export interface BenchResults {
  /** Format version. */
  readonly schemaVersion: 1;
  /** Owning task. */
  readonly task: 'T12495';
  /** ISO start time. */
  readonly startedAt: string;
  /** ISO end time. */
  readonly finishedAt: string;
  /** Run configuration; never contains an API key. */
  readonly config: {
    readonly runs: number;
    readonly batchSize: number;
    readonly timeoutMs: number;
    readonly maxMicros: number;
    readonly sites: readonly BenchSite[];
    readonly providers: readonly {
      readonly name: string;
      readonly provider: string;
      readonly baseUrl: string;
      readonly model?: string;
    }[];
  };
  /** Dataset sizes. */
  readonly dataset: BenchDatasetSizes;
  /** The heuristic baseline (deterministic, scored once). */
  readonly heuristic: readonly BenchSiteResult[];
  /** Every run. */
  readonly runs: readonly BenchRunRecord[];
  /** Mean and spread per provider × site (heuristic included). */
  readonly aggregate: readonly BenchAggregateRow[];
  /** Spend. */
  readonly spend: BenchSpendSummary;
}

/** Collector for one provider × site in one run. */
interface Collector {
  attempted: number;
  predictions: BenchPrediction[];
  latencies: number[];
  costMicros: number;
  costReported: boolean;
  fallbacks: Record<string, number>;
  unusable: number;
}

function newCollector(): Collector {
  return {
    attempted: 0,
    predictions: [],
    latencies: [],
    costMicros: 0,
    costReported: false,
    fallbacks: {},
    unusable: 0,
  };
}

function finishCollector(site: BenchSite, c: Collector): BenchSiteResult {
  return {
    site,
    ...classificationMetrics(c.predictions, positiveLabel(site)),
    attempted: c.attempted,
    answered: c.predictions.length,
    latency: latencyOf(c.latencies),
    costMicros: c.costMicros,
    costReported: c.costReported,
    fallbacks: c.fallbacks,
    unusable: c.unusable,
  };
}

/** Reported micro-dollars and the questions they paid for. */
interface ObservedCost {
  micros: number;
  questions: number;
}

/**
 * Estimated cost per question for the pre-batch cap check: the client's
 * reservation estimate, or the connection's observed mean when a pricier
 * model has reported more, so one batch cannot overshoot the cap by much.
 */
function perQuestionEstimate(seen: ObservedCost | undefined): number {
  const mean = seen && seen.questions > 0 ? Math.ceil(seen.micros / seen.questions) : 0;
  return Math.max(DECISION_COST_ESTIMATE_MICROS_PER_QUESTION, mean);
}

/** Provider-reported cost of an outcome in micros (`costMicros`, else `costUsd`). */
function reportedCostMicros(outcome: DecisionOutcome): number | undefined {
  if (outcome.costMicros !== undefined) return outcome.costMicros;
  return outcome.costUsd !== undefined ? Math.round(outcome.costUsd * 1e6) : undefined;
}

/** A profile name made safe for a file name. */
function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'profile';
}

/** Split `items` into chunks of `size`. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Audit key of a request, matching what `decide()` writes for it. */
function auditKey(q: BenchQuestion): string {
  return `${hashCanonical(q.req.questions)}:${hashCanonical(redactDecisionState(q.req.state))}`;
}

/** An in-memory audit sink that keeps fallback reasons by request key. */
function reasonSink(): {
  sink: DecisionAuditSink;
  take: (key: string) => string | undefined;
} {
  const reasons = new Map<string, string[]>();
  return {
    sink: {
      write(entry: DecisionAuditEntry): void {
        if (entry.source !== 'fallback') return;
        const key = `${entry.questionsHash}:${entry.stateHash}`;
        reasons.set(key, [...(reasons.get(key) ?? []), entry.fallbackReason ?? 'unknown']);
      },
    },
    take: (key) => {
      const list = reasons.get(key);
      return list?.shift();
    },
  };
}

/** Score the heuristic on every row (deterministic, no provider). */
function scoreHeuristic(
  sites: readonly BenchSite[],
  questions: ReadonlyMap<BenchSite, readonly { row: BenchRow; q: BenchQuestion }[]>,
): BenchSiteResult[] {
  return sites.map((site) => {
    const c = newCollector();
    for (const { row, q } of questions.get(site) ?? []) {
      const started = performance.now();
      const label = q.predict(q.heuristicAnswers) ?? q.heuristicLabel;
      c.latencies.push(Math.max(0, performance.now() - started));
      c.attempted++;
      c.predictions.push({ gold: row.label, predicted: label });
    }
    return finishCollector(site, c);
  });
}

/** Mean and spread per provider × site. */
function aggregate(
  heuristic: readonly BenchSiteResult[],
  runs: readonly BenchRunRecord[],
  providers: readonly string[],
  sites: readonly BenchSite[],
): BenchAggregateRow[] {
  const rows: BenchAggregateRow[] = [];
  const build = (provider: string, site: BenchSite, results: readonly BenchSiteResult[]) => {
    const fallbacks: Record<string, number> = {};
    for (const r of results) {
      for (const [k, v] of Object.entries(r.fallbacks)) fallbacks[k] = (fallbacks[k] ?? 0) + v;
    }
    const scored = results.filter((r) => r.answered > 0);
    rows.push({
      provider,
      site,
      answered: spreadOf(results.map((r) => r.answered)),
      accuracy: spreadOf(scored.map((r) => r.accuracy)),
      precision: spreadOf(scored.map((r) => r.precision)),
      recall: spreadOf(scored.map((r) => r.recall)),
      f1: spreadOf(scored.map((r) => r.f1)),
      falsePositiveRate: spreadOf(scored.map((r) => r.falsePositiveRate)),
      p50Ms: spreadOf(scored.map((r) => r.latency.p50Ms)),
      p95Ms: spreadOf(scored.map((r) => r.latency.p95Ms)),
      costMicros: spreadOf(results.map((r) => r.costMicros)),
      fallbacks,
    });
  };
  for (const site of sites) {
    build(
      HEURISTIC_PROVIDER,
      site,
      heuristic.filter((h) => h.site === site),
    );
    for (const provider of providers) {
      const results = runs.flatMap((run) =>
        run.providers
          .filter((p) => p.provider === provider)
          .flatMap((p) => p.sites.filter((s) => s.site === site && s.attempted > 0)),
      );
      build(provider, site, results);
    }
  }
  return rows;
}

/**
 * Run the benchmark.
 *
 * Never throws because of a provider: failures become per-row fallbacks with
 * their reason. Stops cleanly at the spend cap and reports what it completed.
 *
 * @param opts - Rows, connections, runs, cap and wiring.
 * @returns The results.
 */
export async function runDecideBench(opts: RunDecideBenchOptions): Promise<BenchResults> {
  const now = opts.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const runs = Math.max(1, Math.floor(opts.runs ?? 1));
  const capMicros = Math.max(0, opts.maxMicros ?? DEFAULT_BENCH_MAX_MICROS);
  const batchSize = Math.min(
    MAX_BENCH_BATCH_SIZE,
    Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BENCH_BATCH_SIZE)),
  );
  const timeoutMs = Math.max(MIN_BENCH_TIMEOUT_MS, opts.timeoutMs ?? MIN_BENCH_TIMEOUT_MS);
  const ledger = opts.spendLedger === undefined ? createFileSpendLedger() : opts.spendLedger;
  const stateDir = opts.providerStateDir ?? join(getCleoHome(), 'decide', 'bench');

  const sites = BENCH_SITES.filter((s) => opts.rows.some((r) => r.site === s));
  const questions = new Map<BenchSite, { row: BenchRow; q: BenchQuestion }[]>();
  for (const row of opts.rows) {
    questions.set(row.site, [
      ...(questions.get(row.site) ?? []),
      { row, q: benchQuestionFor(row) },
    ]);
  }
  const heuristic = scoreHeuristic(sites, questions);

  const batchesPerRun = sites.reduce(
    (n, s) => n + Math.ceil((questions.get(s)?.length ?? 0) / batchSize),
    0,
  );
  let spentMicros = 0;
  let reportedMicros = 0;
  let batchesSent = 0;
  let recordedInMonthlyLedger = true;
  let stoppedAt: BenchSpendSummary['stoppedAt'];
  const runRecords: BenchRunRecord[] = [];
  /** Reported cost per connection so far, for the pre-batch estimate. */
  const observed = new Map<string, ObservedCost>();

  runLoop: for (let run = 1; run <= runs; run++) {
    const collectors = new Map<string, Map<BenchSite, Collector>>();
    for (const c of opts.connections) {
      collectors.set(c.name, new Map(sites.map((s) => [s, newCollector()])));
    }
    const record = (complete: boolean): BenchRunRecord => ({
      run,
      complete,
      providers: opts.connections.map((c) => ({
        provider: c.name,
        sites: sites.map((s) =>
          finishCollector(s, collectors.get(c.name)?.get(s) ?? newCollector()),
        ),
      })),
    });
    for (const site of sites) {
      for (const [b, batch] of chunks(questions.get(site) ?? [], batchSize).entries()) {
        for (const conn of opts.connections) {
          const questionCount = batch.reduce(
            (n, x) => n + Object.keys(x.q.req.questions).length,
            0,
          );
          const estimate = questionCount * perQuestionEstimate(observed.get(conn.name));
          if (spentMicros + estimate > capMicros) {
            stoppedAt = { run, site, provider: conn.name, batch: b + 1, estimateMicros: estimate };
            runRecords.push(record(false));
            break runLoop;
          }
          const reasons = reasonSink();
          const entries: DecisionBatchEntry[] = batch.map(({ q }) => ({
            req: q.req,
            fallback: () => q.heuristicAnswers,
          }));
          const outcomes: DecisionOutcome[] = await decideBatch(
            DECIDE_BENCH_DECISION_SITE.id,
            entries,
            {
              connection: {
                baseUrl: conn.baseUrl,
                apiKey: conn.apiKey,
                ...(conn.model ? { model: conn.model } : {}),
              },
              timeoutMs,
              cache: null,
              budget: null,
              spend: null,
              audit: reasons.sink,
              ...(opts.fetch ? { fetch: opts.fetch } : {}),
              providerStatePath: join(stateDir, `provider-state-${safeFileName(conn.name)}.json`),
            },
          );
          batchesSent++;
          const col = collectors.get(conn.name)?.get(site) ?? newCollector();
          let batchSpend = 0;
          const perQuestion = perQuestionEstimate(observed.get(conn.name));
          const seen = observed.get(conn.name) ?? { micros: 0, questions: 0 };
          for (const [i, { row, q }] of batch.entries()) {
            const outcome = outcomes[i];
            col.attempted++;
            const questionsHere = Object.keys(q.req.questions).length;
            const reported = outcome ? reportedCostMicros(outcome) : undefined;
            if (reported !== undefined) {
              col.costReported = true;
              reportedMicros += reported;
              seen.micros += reported;
              seen.questions += questionsHere;
            }
            if (!outcome || outcome.source !== 'provider') {
              const reason = reasons.take(auditKey(q)) ?? 'unknown';
              col.fallbacks[reason] = (col.fallbacks[reason] ?? 0) + 1;
              // Billed without a usable answer: a 2xx the client rejected
              // (`invalid_response`, at its reported cost), or a call that
              // timed out after send. Other failures are error responses,
              // which the provider does not bill (layahost docs).
              if (reason === 'invalid_response' || reason === 'timeout') {
                batchSpend += reported ?? questionsHere * perQuestion;
              }
              continue;
            }
            batchSpend += reported ?? questionsHere * perQuestion;
            col.latencies.push(outcome.latencyMs);
            const predicted = q.predict(outcome.answers);
            if (predicted === null) {
              col.unusable++;
              continue;
            }
            col.predictions.push({ gold: row.label, predicted });
          }
          observed.set(conn.name, seen);
          col.costMicros += batchSpend;
          spentMicros += batchSpend;
          if (ledger && batchSpend > 0) {
            try {
              await ledger.record(batchSpend);
            } catch {
              recordedInMonthlyLedger = false;
            }
          }
        }
      }
    }
    runRecords.push(record(true));
  }

  const providerNames = opts.connections.map((c) => c.name);
  return {
    schemaVersion: 1,
    task: 'T12495',
    startedAt,
    finishedAt: now().toISOString(),
    config: {
      runs,
      batchSize,
      timeoutMs,
      maxMicros: capMicros,
      sites,
      providers: opts.connections.map((c) => ({
        name: c.name,
        provider: c.provider,
        baseUrl: c.baseUrl,
        ...(c.model ? { model: c.model } : {}),
      })),
    },
    dataset: benchDatasetSizes(opts.rows),
    heuristic,
    runs: runRecords,
    aggregate: aggregate(heuristic, runRecords, providerNames, sites),
    spend: {
      capMicros,
      spentMicros,
      reportedMicros,
      capReached: stoppedAt !== undefined,
      ...(stoppedAt ? { stoppedAt } : {}),
      batchesSent,
      batchesPlanned: batchesPerRun * runs * opts.connections.length,
      recordedInMonthlyLedger,
    },
  };
}
