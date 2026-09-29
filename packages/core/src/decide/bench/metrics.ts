/**
 * Classification metrics for the System One benchmark (T12495).
 *
 * Two-label sites report precision, recall, F1 and false-positive rate for
 * their positive class. The multi-class observation-type site reports macro
 * averages over the labels present in the gold set (one-vs-rest per label).
 *
 * @task T12495
 * @epic T12486
 */

import { percentile } from './stats.js';

/** One scored prediction. */
export interface BenchPrediction {
  /** Gold label. */
  readonly gold: string;
  /** Predicted label. */
  readonly predicted: string;
}

/** Classification quality over a set of predictions. */
export interface BenchClassificationMetrics {
  /** Scored predictions. */
  readonly n: number;
  /** Share predicted correctly. */
  readonly accuracy: number | null;
  /** Precision (positive class, or macro average). */
  readonly precision: number | null;
  /** Recall (positive class, or macro average). */
  readonly recall: number | null;
  /** F1 (positive class, or macro average). */
  readonly f1: number | null;
  /** False-positive rate (positive class, or macro average one-vs-rest). */
  readonly falsePositiveRate: number | null;
}

/** Ratio, or `null` when the denominator is zero. */
function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

/** Harmonic mean of precision and recall. */
function f1Of(p: number | null, r: number | null): number | null {
  if (p === null || r === null) return null;
  return p + r > 0 ? (2 * p * r) / (p + r) : 0;
}

/** One-vs-rest counts for `label`. */
function counts(preds: readonly BenchPrediction[], label: string) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const p of preds) {
    const g = p.gold === label;
    const q = p.predicted === label;
    if (g && q) tp++;
    else if (!g && q) fp++;
    else if (g && !q) fn++;
    else tn++;
  }
  return { tp, fp, fn, tn };
}

/** Mean of the non-null values, or null. */
function meanOf(values: readonly (number | null)[]): number | null {
  const xs = values.filter((v): v is number => v !== null);
  return xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

/**
 * Score predictions.
 *
 * @param preds - Gold and predicted labels.
 * @param positive - The positive class of a two-label site; `null` → macro averages.
 * @returns The metrics (`null` where undefined, e.g. no positives predicted).
 */
export function classificationMetrics(
  preds: readonly BenchPrediction[],
  positive: string | null,
): BenchClassificationMetrics {
  const n = preds.length;
  const accuracy = ratio(preds.filter((p) => p.gold === p.predicted).length, n);
  if (positive !== null) {
    const c = counts(preds, positive);
    const precision = ratio(c.tp, c.tp + c.fp);
    const recall = ratio(c.tp, c.tp + c.fn);
    return {
      n,
      accuracy,
      precision,
      recall,
      f1: f1Of(precision, recall),
      falsePositiveRate: ratio(c.fp, c.fp + c.tn),
    };
  }
  const labels = [...new Set(preds.map((p) => p.gold))].sort();
  const per = labels.map((label) => {
    const c = counts(preds, label);
    const precision = ratio(c.tp, c.tp + c.fp) ?? 0;
    const recall = ratio(c.tp, c.tp + c.fn);
    return {
      precision,
      recall,
      f1: f1Of(precision, recall),
      fpr: ratio(c.fp, c.fp + c.tn),
    };
  });
  return {
    n,
    accuracy,
    precision: meanOf(per.map((p) => p.precision)),
    recall: meanOf(per.map((p) => p.recall)),
    f1: meanOf(per.map((p) => p.f1)),
    falsePositiveRate: meanOf(per.map((p) => p.fpr)),
  };
}

/** p50 and p95 of latencies, in ms. */
export interface BenchLatency {
  /** Median. */
  readonly p50Ms: number | null;
  /** 95th percentile. */
  readonly p95Ms: number | null;
}

/**
 * Latency percentiles.
 *
 * @param samples - Latencies in ms.
 * @returns p50 and p95 (nearest rank).
 */
export function latencyOf(samples: readonly number[]): BenchLatency {
  return { p50Ms: percentile(samples, 50), p95Ms: percentile(samples, 95) };
}
