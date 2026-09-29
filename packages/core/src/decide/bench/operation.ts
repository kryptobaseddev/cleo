/**
 * `cleo decide bench` as one core operation (T12495): build or reuse the
 * dataset, apply owner corrections, draw the spot-check sample and — unless
 * `sampleOnly` — run the providers and write the results and the report.
 *
 * Files, all in `outDir` (default `<projectRoot>/.cleo/decide-bench/`, which
 * git ignores):
 *
 * - `dataset.jsonl` — the labelled, redacted rows. Reused on later calls so
 *   the owner's corrections stick; `rebuild` builds it again from the stores.
 * - `spot-check.json` — the stratified sample for the owner.
 * - `results.json` / `report.md` — written by a run.
 *
 * Dataset building, corrections and sampling never contact a provider.
 *
 * @task T12495
 * @epic T12486
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getProjectRoot } from '../../paths.js';
import type { SpendLedger } from '../spend.js';
import type { DecideFetch } from '../transport.js';
import {
  type BenchDatasetSizes,
  benchDatasetSizes,
  buildBenchDataset,
  readBenchDataset,
  writeBenchDataset,
} from './dataset.js';
import { type BenchProfileResolver, resolveBenchProfiles } from './profiles.js';
import { renderBenchReport } from './report.js';
import {
  type BenchAggregateRow,
  type BenchSpendSummary,
  DEFAULT_BENCH_MAX_MICROS,
  runDecideBench,
} from './runner.js';
import { createStoreBenchSource } from './source.js';
import {
  applyBenchCorrections,
  type BenchCorrectionsReceipt,
  readBenchCorrections,
  sampleBenchSpotCheck,
} from './spot-check.js';
import { DEFAULT_BENCH_SEED } from './stats.js';
import { BENCH_SITES, type BenchConnection, type BenchSite, type BenchSource } from './types.js';

/** Dataset file name inside the output directory. */
export const BENCH_DATASET_FILE = 'dataset.jsonl';

/** Spot-check file name inside the output directory. */
export const BENCH_SPOT_CHECK_FILE = 'spot-check.json';

/** Results file name inside the output directory. */
export const BENCH_RESULTS_FILE = 'results.json';

/** Report fragment file name inside the output directory. */
export const BENCH_REPORT_FILE = 'report.md';

/** Invalid benchmark input (maps to a validation error in the CLI). */
export class DecideBenchInputError extends Error {
  /** How to fix it. */
  readonly fix: string;

  /**
   * @param message - What is wrong.
   * @param fix - How to fix it.
   */
  constructor(message: string, fix: string) {
    super(message);
    this.name = 'DecideBenchInputError';
    this.fix = fix;
  }
}

/** Input of {@link runDecideBenchOperation}. */
export interface DecideBenchInput {
  /** Project whose stores are read. Default: the resolved project root. */
  readonly projectRoot?: string;
  /** Output directory. Default `<projectRoot>/.cleo/decide-bench`. */
  readonly outDir?: string;
  /** Profile names to compare (required unless `sampleOnly`). */
  readonly profiles?: readonly string[];
  /** Sites to sample and run. Default: all. */
  readonly sites?: readonly string[];
  /** Build the dataset and the sample only; no provider is contacted. */
  readonly sampleOnly?: boolean;
  /** Owner corrections file to apply before sampling. */
  readonly correctionsPath?: string;
  /** Hard total spend cap in US dollars. Default $5. */
  readonly maxUsd?: number;
  /** Repeated runs. Default 1. */
  readonly runs?: number;
  /** Rows per batch call. */
  readonly batchSize?: number;
  /** Rebuild the dataset from the stores even when one exists. */
  readonly rebuild?: boolean;
  /** PRNG seed for negatives and the sample. */
  readonly seed?: number;
  /** Spot-check sample size. Default 30. */
  readonly sampleSize?: number;
  /** Store port (tests). Default: the core accessors. */
  readonly source?: BenchSource;
  /** Profile resolver (tests; T12733 profiles later). Default: the interim adapter. */
  readonly resolver?: BenchProfileResolver;
  /** Explicit connections; skip profile resolution. */
  readonly connections?: readonly BenchConnection[];
  /** Transport (tests). */
  readonly fetch?: DecideFetch;
  /** Directory for per-connection provider-state files (tests). */
  readonly providerStateDir?: string;
  /** Monthly ledger to record spend in; `null` skips. Default: the file ledger. */
  readonly spendLedger?: SpendLedger | null;
}

/** Output of {@link runDecideBenchOperation}. */
export interface DecideBenchSummary {
  /** Output directory. */
  readonly outDir: string;
  /** Files written or reused. */
  readonly files: {
    readonly dataset: string;
    readonly spotCheck: string;
    readonly results?: string;
    readonly report?: string;
  };
  /** Whether an existing dataset was reused. */
  readonly datasetReused: boolean;
  /** Dataset sizes (all sites). */
  readonly dataset: BenchDatasetSizes;
  /** Sites sampled and run. */
  readonly sites: readonly BenchSite[];
  /** Items in the spot-check sample. */
  readonly spotCheckItems: number;
  /** Applied corrections, when a file was given. */
  readonly corrections?: BenchCorrectionsReceipt;
  /** Whether providers were run. */
  readonly ran: boolean;
  /** Spend, when run. */
  readonly spend?: BenchSpendSummary;
  /** Mean and spread per provider × site, when run. */
  readonly aggregate?: readonly BenchAggregateRow[];
}

/** Narrow the requested sites. */
function parseSites(sites: readonly string[] | undefined): BenchSite[] {
  if (!sites || sites.length === 0) return [...BENCH_SITES];
  const out: BenchSite[] = [];
  for (const s of sites) {
    const site = BENCH_SITES.find((b) => b === s.trim());
    if (!site) {
      throw new DecideBenchInputError(`unknown site '${s}'`, `--sites ${BENCH_SITES.join(',')}`);
    }
    if (!out.includes(site)) out.push(site);
  }
  return out;
}

/** Validate a positive number flag. */
function positive(value: number | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) {
    throw new DecideBenchInputError(`${name} must be a positive number`, `${name} <n>`);
  }
  return value;
}

/**
 * Run `cleo decide bench`.
 *
 * @param input - Flags and wiring.
 * @returns What was written and, after a run, the spend and the aggregate.
 * @throws DecideBenchInputError on invalid input (unknown site or profile, no profiles).
 */
export async function runDecideBenchOperation(
  input: DecideBenchInput = {},
): Promise<DecideBenchSummary> {
  const sites = parseSites(input.sites);
  const maxUsd = positive(input.maxUsd, '--max-usd', DEFAULT_BENCH_MAX_MICROS / 1e6);
  const runs = Math.floor(positive(input.runs, '--runs', 1));
  const batchSize =
    input.batchSize === undefined
      ? undefined
      : Math.floor(positive(input.batchSize, '--batch-size', 1));
  const seed = input.seed ?? DEFAULT_BENCH_SEED;
  if (!Number.isSafeInteger(seed)) {
    throw new DecideBenchInputError('--seed must be an integer', '--seed 12495');
  }
  const wantsRun = input.sampleOnly !== true;
  const profiles = input.profiles ?? [];
  if (wantsRun && profiles.length === 0 && !input.connections?.length) {
    throw new DecideBenchInputError(
      'no providers to compare',
      'cleo decide bench --profiles layahost,jev (or --sample-only to build the dataset and sample without spend)',
    );
  }
  // Resolve profiles before any file is written, so a typo fails fast.
  let connections: readonly BenchConnection[] = input.connections ?? [];
  if (wantsRun && connections.length === 0) {
    try {
      connections = resolveBenchProfiles(profiles, input.resolver);
    } catch (err) {
      throw new DecideBenchInputError(
        err instanceof Error ? err.message : 'unknown profile',
        'CLEO_DECIDE_PROFILE_<NAME>_KEY=… (and _URL for a non-layahost host)',
      );
    }
  }

  const projectRoot = input.projectRoot ?? getProjectRoot();
  const outDir = resolve(input.outDir ?? join(projectRoot, '.cleo', 'decide-bench'));
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const datasetPath = join(outDir, BENCH_DATASET_FILE);
  const spotCheckPath = join(outDir, BENCH_SPOT_CHECK_FILE);

  const reuse = input.rebuild !== true && existsSync(datasetPath);
  let rows = reuse
    ? await readBenchDataset(datasetPath)
    : await buildBenchDataset(input.source ?? createStoreBenchSource(projectRoot), { seed });
  let corrections: BenchCorrectionsReceipt | undefined;
  if (input.correctionsPath) {
    const applied = applyBenchCorrections(rows, await readBenchCorrections(input.correctionsPath));
    rows = applied.rows;
    corrections = applied.receipt;
  }
  if (!reuse || corrections) await writeBenchDataset(datasetPath, rows);

  const selected = rows.filter((r) => sites.includes(r.site));
  const spotCheck = sampleBenchSpotCheck(selected, {
    seed,
    ...(input.sampleSize !== undefined ? { size: input.sampleSize } : {}),
  });
  await writeFile(spotCheckPath, `${JSON.stringify(spotCheck, null, 2)}\n`, { mode: 0o600 });

  const base = {
    outDir,
    datasetReused: reuse,
    dataset: benchDatasetSizes(rows),
    sites,
    spotCheckItems: spotCheck.items.length,
    ...(corrections ? { corrections } : {}),
  };
  if (!wantsRun) {
    return { ...base, files: { dataset: datasetPath, spotCheck: spotCheckPath }, ran: false };
  }

  const results = await runDecideBench({
    rows: selected,
    connections,
    runs,
    maxMicros: Math.round(maxUsd * 1e6),
    ...(batchSize !== undefined ? { batchSize } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.providerStateDir ? { providerStateDir: input.providerStateDir } : {}),
    ...(input.spendLedger !== undefined ? { spendLedger: input.spendLedger } : {}),
  });
  const resultsPath = join(outDir, BENCH_RESULTS_FILE);
  const reportPath = join(outDir, BENCH_REPORT_FILE);
  await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`, { mode: 0o600 });
  await writeFile(reportPath, renderBenchReport(results), { mode: 0o600 });
  return {
    ...base,
    files: {
      dataset: datasetPath,
      spotCheck: spotCheckPath,
      results: resultsPath,
      report: reportPath,
    },
    ran: true,
    spend: results.spend,
    aggregate: results.aggregate,
  };
}
