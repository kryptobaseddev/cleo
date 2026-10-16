/**
 * `cleo lean gain`: the measured ct-lean scoreboard (T13669).
 *
 * Mirrors Ponytail 5.1.0's `/ponytail-gain` (DietrichGebert, MIT): it shows
 * benchmark averages and never a per-repo savings number, because the
 * unbuilt version of a live repo was never written, so there is nothing real
 * to subtract from. The only counted per-repo figure is `cleo lean debt`.
 *
 * The numbers are the T13424 benchmark (research doc
 * `t13424-ct-lean-vs-ponytail-benchmark`). Update {@link LEAN_GAIN} when a
 * newer run (T13672) is published.
 *
 * @task T13669
 * @epic T13418
 */

import type { LeanGainReport } from '@cleocode/contracts';

/** The measured scoreboard. Shares are totals over 24 cells per arm vs no skill. */
export const LEAN_GAIN: LeanGainReport = Object.freeze({
  heading: 'ct-lean 1.0.0 vs baseline, T13424 benchmark, Opus 5.5, 8 tasks × 3 runs',
  source: 't13424-ct-lean-vs-ponytail-benchmark',
  method:
    "Ponytail 5.1.0's agentic harness: headless Claude Code (Opus 5.5), 8 tasks × 3 runs per arm, scored on the files left behind",
  metrics: Object.freeze([
    { name: 'Source lines of code', ctLeanShare: 660 / 1896, ponytailShare: 599 / 1896 },
    { name: 'Output tokens', ctLeanShare: 47325 / 78015, ponytailShare: 44918 / 78015 },
    { name: 'Cost', ctLeanShare: 2.48 / 3.31, ponytailShare: 2.69 / 3.31 },
    { name: 'Wall time', ctLeanShare: 484 / 723, ponytailShare: 450 / 723 },
  ]),
  hiddenChecks: Object.freeze({
    baseline: '23/24',
    ponytail: '24/24',
    ctLean: '23/24 (1.0.0); 3/3 on the miss after 1.0.1',
  }),
  note: 'Benchmark averages, not this repo. CLEO never prints a per-repo savings number; for counted figures in this repo run `cleo lean debt`.',
});

/** Width of a full scoreboard bar (the no-skill baseline). */
const BAR = 20;

function bar(share: number): string {
  const filled = Math.max(0, Math.min(BAR, Math.round(share * BAR)));
  return `${'█'.repeat(filled)}${'·'.repeat(BAR - filled)}`;
}

/**
 * Render the scoreboard as plain-text bars (ct-lean share of the baseline).
 *
 * @param report - the scoreboard (default {@link LEAN_GAIN}).
 * @returns the card, one line per metric.
 */
export function renderLeanGain(report: LeanGainReport = LEAN_GAIN): string {
  const pct = (share: number) => `${Math.round(share * 100)}%`.padStart(4);
  const lines = [
    `${report.heading} (${report.source})`,
    `  ${report.method}`,
    '',
    `  ${'no skill'.padEnd(22)} ${bar(1)} 100%`,
    ...report.metrics.map(
      (m) =>
        `  ${m.name.padEnd(22)} ${bar(m.ctLeanShare)} ${pct(m.ctLeanShare)}  ▼ ${pct(1 - m.ctLeanShare).trim()}   (Ponytail ${pct(m.ponytailShare).trim()})`,
    ),
    `  Hidden checks passed   ct-lean ${report.hiddenChecks.ctLean} · Ponytail ${report.hiddenChecks.ponytail} · no skill ${report.hiddenChecks.baseline}`,
    '',
    `  ${report.note}`,
    `  Source: cleo docs fetch ${report.source}`,
  ];
  return lines.join('\n');
}
