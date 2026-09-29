/**
 * Markdown report fragment for a System One benchmark (T12495): method,
 * dataset sizes, a per-site table, latency, cost and re-run instructions.
 * Meant to be pasted into the README, a docs page and the site; this module
 * only renders it.
 *
 * @task T12495
 * @epic T12486
 */

import type { BenchAggregateRow, BenchResults } from './runner.js';
import { HEURISTIC_PROVIDER } from './runner.js';
import type { BenchSpread } from './stats.js';

/** Human site names. */
const SITE_TITLES: Readonly<Record<string, string>> = {
  duplicateDetection: 'Duplicate task detection (`tasks.duplicate-detection`)',
  observationType: 'Observation type (`memory.observation-type`)',
  decisionContradiction: 'Decision contradiction (`memory.decision-contradiction`)',
};

/** Format a ratio spread as a percentage with its standard deviation. */
function pct(s: BenchSpread): string {
  if (s.mean === null) return '—';
  const mean = (s.mean * 100).toFixed(1);
  return s.n > 1 && s.stddev !== null ? `${mean}% ± ${(s.stddev * 100).toFixed(1)}` : `${mean}%`;
}

/** Format a millisecond spread. */
function ms(s: BenchSpread): string {
  if (s.mean === null) return '—';
  return s.n > 1 && s.stddev !== null
    ? `${s.mean.toFixed(0)} ± ${s.stddev.toFixed(0)}`
    : s.mean.toFixed(s.mean < 10 ? 2 : 0);
}

/** Format micro-dollars as dollars. */
function usd(micros: number): string {
  return `$${(micros / 1e6).toFixed(micros < 10_000 ? 6 : 4)}`;
}

/** Format fallbacks as `reason×n`. */
function fallbacks(row: BenchAggregateRow): string {
  const parts = Object.entries(row.fallbacks).map(([k, v]) => `${k}×${v}`);
  return parts.length > 0 ? parts.join(', ') : '0';
}

/** One table row. */
function tableRow(row: BenchAggregateRow): string {
  const n = row.answered.mean === null ? '—' : row.answered.mean.toFixed(0);
  const cost = row.provider === HEURISTIC_PROVIDER ? '$0' : usd(row.costMicros.mean ?? 0);
  return `| ${row.provider} | ${n} | ${pct(row.accuracy)} | ${pct(row.precision)} | ${pct(row.recall)} | ${pct(row.f1)} | ${pct(row.falsePositiveRate)} | ${ms(row.p50Ms)} | ${ms(row.p95Ms)} | ${cost} | ${fallbacks(row)} |`;
}

/**
 * Render the Markdown fragment.
 *
 * @param results - Benchmark results.
 * @param opts - The re-run command to print (default: built from the config).
 * @returns Markdown (starts at a level-2 heading so it embeds anywhere).
 */
export function renderBenchReport(
  results: BenchResults,
  opts: { readonly rerunCommand?: string } = {},
): string {
  const providers = results.config.providers.map((p) => p.name);
  const rerun =
    opts.rerunCommand ??
    `cleo decide bench --profiles ${providers.join(',') || '<a,b>'} --sites ${results.config.sites.join(',')} --runs ${results.config.runs} --max-usd ${results.config.maxMicros / 1e6}`;
  const lines: string[] = [];
  lines.push('## System One accuracy benchmark');
  lines.push('');
  lines.push(
    `Measured ${results.finishedAt.slice(0, 10)} with \`cleo decide bench\` (T12495): ${providers.join(' vs ')} against each site's heuristic, ${results.config.runs} run(s).`,
  );
  lines.push('');
  lines.push('### Method');
  lines.push('');
  lines.push(
    "- **Control group: CLEO's own history.** Duplicate pairs come from `duplicates` relations, tasks cancelled as a duplicate of a named task and duplicate notes; distinct pairs are same-parent tasks with no relation. Observation types are those a caller set explicitly (the stored type differs from both keyword defaults). Contradiction positives are supersedes edges; negatives are random pairs with no supersedes edge.",
  );
  lines.push(
    '- Pair rows whose text gives the label away (one side names the other\'s id, or says "duplicate of T123" / "supersedes D12") are dropped.',
  );
  lines.push(
    '- The dataset and the owner spot-check sample (`dataset.jsonl`, `spot-check.json`) stay local and are never published: they hold redacted project text. Only this aggregate report is shared.',
  );
  lines.push(
    '- Every row is the exact question the site asks (the site request builders), redacted with the same patterns System One uses, sent through `decideBatch` with the provider cache off (`cache: false`).',
  );
  lines.push(
    `- Metrics are over rows the provider answered; fallbacks (timeouts, errors, malformed answers) are counted separately. Latency is the wall time of the batch call that carried a row (batch size ${results.config.batchSize}). Cost is the provider-reported \`meta.cost_micros\` (the estimate when not reported).`,
  );
  lines.push(
    '- Two-label sites report precision, recall, F1 and false-positive rate for the positive class (duplicate, conflict); the observation-type site reports macro averages. Values are the mean ± standard deviation across runs.',
  );
  lines.push('');
  lines.push('### Dataset');
  lines.push('');
  lines.push('| Site | Rows | Labels |');
  lines.push('|---|---|---|');
  for (const [site, labels] of Object.entries(results.dataset.bySite)) {
    const total = Object.values(labels).reduce((s, n) => s + n, 0);
    const detail = Object.entries(labels)
      .map(([l, n]) => `${l} ${n}`)
      .join(', ');
    lines.push(`| ${site} | ${total} | ${detail} |`);
  }
  lines.push('');
  lines.push(
    `${results.dataset.total} rows, ${results.dataset.ownerVerified} verified by the owner in the spot-check.`,
  );
  lines.push('');
  lines.push('### Results');
  for (const site of results.config.sites) {
    lines.push('');
    lines.push(`#### ${SITE_TITLES[site] ?? site}`);
    lines.push('');
    lines.push(
      '| Provider | n | Accuracy | Precision | Recall | F1 | FP rate | p50 ms | p95 ms | Cost/run | Fallbacks |',
    );
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const row of results.aggregate.filter((r) => r.site === site)) lines.push(tableRow(row));
    if (site === 'observationType') {
      lines.push('');
      lines.push(
        '> The keyword heuristic scores near zero here by construction: a row is only used when its type differs from the keyword default. Compare the providers with each other on this site.',
      );
    }
  }
  lines.push('');
  lines.push('### Cost');
  lines.push('');
  lines.push(
    `Spent ${usd(results.spend.spentMicros)} (${usd(results.spend.reportedMicros)} reported by the providers) of a ${usd(results.spend.capMicros)} cap, in ${results.spend.batchesSent} of ${results.spend.batchesPlanned} planned batch calls.`,
  );
  if (results.spend.capReached && results.spend.stoppedAt) {
    const s = results.spend.stoppedAt;
    lines.push('');
    lines.push(
      `**Stopped at the cap** in run ${s.run}, site ${s.site}, batch ${s.batch} (${s.provider}): the next batch's estimate (${usd(s.estimateMicros)}) would have passed it. The tables cover what was completed.`,
    );
  }
  lines.push('');
  lines.push('### Re-run');
  lines.push('');
  lines.push('```bash');
  lines.push(
    'cleo decide bench --sample-only        # build the dataset and the spot-check sample, no spend',
  );
  lines.push('cleo decide bench --corrections <file> --sample-only   # apply owner corrections');
  lines.push(rerun);
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}
