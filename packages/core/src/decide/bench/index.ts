/**
 * System One accuracy benchmark (`cleo decide bench`): a labelled dataset
 * from CLEO's own history, an owner spot-check, and a capped, repeated
 * comparison of providers against each site's heuristic.
 *
 * Loaded on demand (`@cleocode/core/decide/bench/index.js`); the decide
 * barrel does not re-export it, so the CLI's startup never pays for it.
 *
 * @task T12495
 * @epic T12486
 */

export {
  BENCH_TEXT_MAX_CHARS,
  type BenchDatasetSizes,
  type BuildBenchDatasetOptions,
  benchDatasetSizes,
  buildBenchDataset,
  DEFAULT_BENCH_MAX_ROWS_PER_SITE,
  DEFAULT_BENCH_NEGATIVES_PER_POSITIVE,
  leaksBenchLabel,
  legacyKeywordObservationType,
  MIN_BENCH_NEGATIVES,
  parseBenchDataset,
  readBenchDataset,
  serializeBenchDataset,
  writeBenchDataset,
} from './dataset.js';
export {
  type BenchClassificationMetrics,
  type BenchLatency,
  type BenchPrediction,
  classificationMetrics,
  latencyOf,
} from './metrics.js';
export {
  BENCH_DATASET_FILE,
  BENCH_REPORT_FILE,
  BENCH_RESULTS_FILE,
  BENCH_SPOT_CHECK_FILE,
  type DecideBenchInput,
  DecideBenchInputError,
  type DecideBenchSummary,
  runDecideBenchOperation,
} from './operation.js';
export {
  BenchProfileError,
  BenchProfileInvalidError,
  type BenchProfileResolver,
  benchProfileEnvPrefix,
  createInterimProfileResolver,
  resolveBenchProfiles,
} from './profiles.js';
export { type BenchQuestion, benchQuestionFor } from './questions.js';
export { renderBenchReport } from './report.js';
export {
  type BenchAggregateRow,
  type BenchProviderRun,
  type BenchResults,
  type BenchRunRecord,
  type BenchSiteResult,
  type BenchSpendSummary,
  DEFAULT_BENCH_BATCH_SIZE,
  DEFAULT_BENCH_MAX_MICROS,
  HEURISTIC_PROVIDER,
  MAX_BENCH_BATCH_SIZE,
  MIN_BENCH_TIMEOUT_MS,
  type RunDecideBenchOptions,
  runDecideBench,
} from './runner.js';
export { createStoreBenchSource } from './source.js';
export {
  applyBenchCorrections,
  type BenchCorrection,
  type BenchCorrectionsReceipt,
  type BenchSpotCheckFile,
  type BenchSpotCheckItem,
  DEFAULT_SPOT_CHECK_SIZE,
  parseBenchCorrections,
  readBenchCorrections,
  sampleBenchSpotCheck,
} from './spot-check.js';
export {
  type BenchRandom,
  type BenchSpread,
  createSeededRandom,
  DEFAULT_BENCH_SEED,
  percentile,
  shuffled,
  spreadOf,
} from './stats.js';
export {
  BENCH_LABEL_RULES,
  BENCH_SITES,
  type BenchConnection,
  type BenchDecisionRecord,
  type BenchLabelRule,
  type BenchObservationRecord,
  type BenchProvenance,
  type BenchRow,
  type BenchSite,
  type BenchSource,
  type BenchTaskRecord,
  benchRowSchema,
  CONTRADICTION_LABELS,
  DUPLICATE_LABELS,
  labelsForSite,
  positiveLabel,
} from './types.js';
