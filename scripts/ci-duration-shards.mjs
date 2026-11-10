#!/usr/bin/env node
/**
 * Duration-balanced unit-test shards (T14369).
 *
 * vitest's `--shard` splits by file count, so shards with the slow files ran
 * ~15 min while others ran ~9. This module splits by measured per-file time:
 *
 *   - Main's unit shards write each file's duration (`ci-flaky-quarantine.mjs
 *     run --timings`) and upload it as a `test-timings-*` artifact.
 *   - `fetch` (the `changes` job, ONCE per run) downloads those artifacts from
 *     the newest completed main run that has them and merges them into one
 *     file. Every shard reads that same file, so all shards compute the same
 *     partition; a per-shard fetch could disagree and drop or repeat files.
 *   - `ci-duration-sequencer.mjs` (vitest's `sequence.sequencer`) partitions
 *     the files with {@link partitionByDuration} when `VITEST_SHARD_TIMINGS`
 *     names a file with timings, and falls back to vitest's file-count split
 *     when it does not.
 *
 * Usage: ci-duration-shards.mjs fetch --out <file>
 *   Never fails: no data (or a `gh` error) writes `{"files":{}}`, the fallback.
 *
 * @task T14369
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Artifact name prefix the unit shards upload their timings under. */
export const TIMINGS_ARTIFACT_PREFIX = 'test-timings-';

/** Completed main runs `fetch` tries, newest first, before giving up. */
export const MAX_RUNS_TRIED = 5;

/**
 * Per-file wall time (ms) from a vitest JSON report, keyed by repo-relative
 * POSIX path. A file without both timestamps is skipped.
 *
 * @param {string} raw - The report text.
 * @param {string} repoRoot - Absolute repo root the report's paths are under.
 * @returns {Record<string, number>}
 */
export function timingsFromVitestReport(raw, repoRoot) {
  /** @type {Record<string, number>} */
  const files = {};
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    return files;
  }
  if (!report || !Array.isArray(report.testResults)) return files;
  for (const r of report.testResults) {
    if (!r || typeof r.name !== 'string') continue;
    if (typeof r.startTime !== 'number' || typeof r.endTime !== 'number') continue;
    const rel = path.isAbsolute(r.name) ? path.relative(repoRoot, r.name) : r.name;
    const file = rel.split(path.sep).join('/');
    files[file] = Math.max(files[file] ?? 0, Math.max(0, r.endTime - r.startTime));
  }
  return files;
}

/**
 * Merge timing maps; a file seen twice keeps its longest time.
 *
 * @param {readonly Record<string, number>[]} maps
 * @returns {Record<string, number>}
 */
export function mergeTimings(maps) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const m of maps) {
    for (const [file, ms] of Object.entries(m)) {
      if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
        out[file] = Math.max(out[file] ?? 0, ms);
      }
    }
  }
  return out;
}

/**
 * Read a timings file (`{"files": {path: ms}}`). Missing, unreadable or
 * empty means no timings: `null`, the file-count fallback.
 *
 * @param {string | undefined} file
 * @returns {Record<string, number> | null}
 */
export function readTimingsFile(file) {
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const files = mergeTimings([parsed?.files ?? {}]);
    return Object.keys(files).length > 0 ? files : null;
  } catch {
    return null;
  }
}

/**
 * Split items into `count` shards of near-equal total duration (longest
 * processing time first: each item, slowest first, goes to the lightest
 * shard). A file with no timing is estimated at the mean of the known ones.
 * Deterministic: ties break on `key`, then on the lower shard index, so every
 * shard computes the same partition from the same input.
 *
 * @template {{ key: string, file: string }} T
 * @param {readonly T[]} items - `key` is unique per item; `file` is the timings key.
 * @param {Record<string, number>} timings
 * @param {number} count - Number of shards (>= 1).
 * @returns {T[][] | null} one array per shard, or `null` when no item has a timing
 */
export function partitionByDuration(items, timings, count) {
  const known = items.filter((i) => Object.hasOwn(timings, i.file));
  if (known.length === 0) return null;
  const mean = known.reduce((s, i) => s + timings[i.file], 0) / known.length;
  const weighted = items
    .map((item) => ({ item, ms: Object.hasOwn(timings, item.file) ? timings[item.file] : mean }))
    .sort(
      (a, b) => b.ms - a.ms || (a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : 0),
    );
  /** @type {T[][]} */
  const shards = Array.from({ length: count }, () => []);
  const totals = new Array(count).fill(0);
  for (const { item, ms } of weighted) {
    let lightest = 0;
    for (let s = 1; s < count; s++) if (totals[s] < totals[lightest]) lightest = s;
    shards[lightest].push(item);
    totals[lightest] += ms;
  }
  return shards;
}

/** Run `gh`; stdout on success, `null` on any failure. */
function gh(/** @type {string[]} */ args) {
  const repo = process.env.GITHUB_REPOSITORY;
  const r = spawnSync(
    process.env.DURATION_SHARDS_GH || 'gh',
    repo ? [...args, '--repo', repo] : args,
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    console.warn(
      `gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.error || '').toString().trim()}`,
    );
    return null;
  }
  return r.stdout;
}

/** Every `*.json` under `dir`, recursively. */
function jsonFiles(/** @type {string} */ dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsonFiles(p));
    else if (name.endsWith('.json')) out.push(p);
  }
  return out;
}

/**
 * The `fetch` subcommand: merged timings of the newest completed main run of
 * ci.yml (push or nightly) that uploaded any, or none.
 *
 * @returns {{ files: Record<string, number>, runId: number | null }}
 */
export function fetchTimings() {
  const listed = gh([
    'run',
    'list',
    '--workflow',
    'ci.yml',
    '--branch',
    'main',
    '--status',
    'completed',
    '--limit',
    '20',
    '--json',
    'databaseId,event',
  ]);
  /** @type {{ databaseId: number, event: string }[]} */
  let runs = [];
  try {
    runs = JSON.parse(listed ?? '[]');
  } catch {
    runs = [];
  }
  const candidates = runs
    .filter((r) => r.event === 'push' || r.event === 'schedule')
    .slice(0, MAX_RUNS_TRIED);
  for (const run of candidates) {
    const dir = mkdtempSync(path.join(tmpdir(), 'shard-timings-'));
    const ok = gh([
      'run',
      'download',
      String(run.databaseId),
      '--pattern',
      `${TIMINGS_ARTIFACT_PREFIX}*`,
      '--dir',
      dir,
    ]);
    if (ok === null) continue;
    const files = mergeTimings(jsonFiles(dir).map((f) => readTimingsFile(f) ?? {}));
    if (Object.keys(files).length > 0) return { files, runId: run.databaseId };
  }
  return { files: {}, runId: null };
}

function main() {
  const [sub, ...rest] = process.argv.slice(2);
  const i = rest.indexOf('--out');
  const out = i === -1 ? undefined : rest[i + 1];
  if (sub !== 'fetch' || !out) {
    console.error('usage: ci-duration-shards.mjs fetch --out <file>');
    return 2;
  }
  const { files, runId } = fetchTimings();
  writeFileSync(out, `${JSON.stringify({ runId, files })}\n`);
  const n = Object.keys(files).length;
  console.log(
    n > 0
      ? `Shard timings: ${n} files from main run ${runId}; shards split by duration.`
      : 'Shard timings: none found; shards split by file count.',
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
