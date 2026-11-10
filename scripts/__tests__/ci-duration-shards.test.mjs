/**
 * Tests for the duration-balanced unit-test shards (T14369): the partition
 * never drops or repeats a file, uses durations when present, and falls back
 * to vitest's file-count split when no timings exist.
 *
 * @task T14369
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DurationShardSequencer } from '../ci-duration-sequencer.mjs';
import {
  mergeTimings,
  partitionByDuration,
  readTimingsFile,
  timingsFromVitestReport,
} from '../ci-duration-shards.mjs';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../ci-duration-shards.mjs',
);
const ROOT = '/repo';

/** `n` spec-like items with files `f0..f(n-1)`. */
const items = (n) =>
  Array.from({ length: n }, (_, i) => ({ key: `p:f${i}.test.ts`, file: `f${i}.test.ts` }));

/** Every key exactly once across the shards. */
function expectExactCover(shards, all) {
  const seen = shards.flat().map((i) => i.key);
  expect(seen).toHaveLength(all.length);
  expect(new Set(seen)).toEqual(new Set(all.map((i) => i.key)));
}

let dir;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'duration-shards-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.VITEST_SHARD_TIMINGS;
});

describe('partitionByDuration', () => {
  it('covers every file exactly once for any shard count, with full, partial or skewed timings', () => {
    for (const n of [1, 7, 8, 9, 50, 777]) {
      const all = items(n);
      const full = Object.fromEntries(all.map((i, k) => [i.file, ((k * 7919) % 1000) + 1]));
      const partial = Object.fromEntries(all.filter((_, k) => k % 3 === 0).map((i) => [i.file, 5]));
      for (const timings of [full, partial]) {
        for (const count of [1, 2, 4, 8, 12]) {
          const shards = partitionByDuration(all, timings, count);
          expect(shards).toHaveLength(count);
          expectExactCover(shards, all);
        }
      }
    }
  });

  it('balances by duration, not file count', () => {
    // Two 600 s files and twenty 30 s files: a count split would put both
    // slow files in one shard of 11; by duration each shard carries ~600+300.
    const all = items(22);
    const timings = Object.fromEntries(all.map((i, k) => [i.file, k < 2 ? 600_000 : 30_000]));
    const shards = partitionByDuration(all, timings, 2);
    const totals = shards.map((s) => s.reduce((t, i) => t + timings[i.file], 0));
    expect(totals).toEqual([900_000, 900_000]);
    expect(shards[0].map((i) => i.file)).toContain('f0.test.ts');
    expect(shards[1].map((i) => i.file)).toContain('f1.test.ts');
  });

  it('is deterministic whatever the input order', () => {
    const all = items(40);
    const timings = Object.fromEntries(all.map((i, k) => [i.file, (k % 5) * 100]));
    const a = partitionByDuration(all, timings, 8);
    const b = partitionByDuration([...all].reverse(), timings, 8);
    expect(b).toEqual(a);
  });

  it('returns null (the file-count fallback) when no file has a timing', () => {
    expect(partitionByDuration(items(10), {}, 4)).toBeNull();
    expect(partitionByDuration(items(10), { 'other.test.ts': 5 }, 4)).toBeNull();
  });
});

describe('timings files', () => {
  it('reads per-file durations from a vitest JSON report, repo-relative', () => {
    const raw = JSON.stringify({
      testResults: [
        { name: `${ROOT}/packages/a.test.ts`, startTime: 1000, endTime: 4000 },
        { name: `${ROOT}/packages/b.test.ts`, startTime: 1000 },
        { name: 'packages/c.test.ts', startTime: 10, endTime: 30 },
      ],
    });
    expect(timingsFromVitestReport(raw, ROOT)).toEqual({
      'packages/a.test.ts': 3000,
      'packages/c.test.ts': 20,
    });
    expect(timingsFromVitestReport('not json', ROOT)).toEqual({});
  });

  it('merges shards keeping the longest time, and reads an empty or missing file as none', () => {
    expect(mergeTimings([{ a: 1, b: 5 }, { a: 3 }])).toEqual({ a: 3, b: 5 });
    const empty = path.join(dir, 'empty.json');
    writeFileSync(empty, '{"files":{}}');
    expect(readTimingsFile(empty)).toBeNull();
    expect(readTimingsFile(path.join(dir, 'missing.json'))).toBeNull();
    expect(readTimingsFile(undefined)).toBeNull();
  });
});

describe('DurationShardSequencer', () => {
  const root = '/repo';
  const specs = Array.from({ length: 30 }, (_, i) => ({
    moduleId: `${root}/pkg/f${i}.test.ts`,
    project: { name: 'core' },
  }));
  const sequencer = (count) =>
    new DurationShardSequencer({ config: { root, shard: { index: 1, count } }, cache: {} });

  async function allShards(count) {
    const out = [];
    for (let index = 1; index <= count; index++) {
      const s = sequencer(count);
      s.ctx.config.shard = { index, count };
      out.push(await s.shard(specs));
    }
    return out;
  }

  it('uses the timings file when present: every spec once, slow files apart', async () => {
    const file = path.join(dir, 't.json');
    const files = Object.fromEntries(
      specs.map((_, i) => [`pkg/f${i}.test.ts`, i < 4 ? 100_000 : 1_000]),
    );
    writeFileSync(file, JSON.stringify({ files }));
    process.env.VITEST_SHARD_TIMINGS = file;
    const shards = await allShards(4);
    expect(shards.flat()).toHaveLength(specs.length);
    expect(new Set(shards.flat())).toEqual(new Set(specs));
    for (let i = 0; i < 4; i++) expect(shards[i]).toContain(specs[i]);
  });

  it("falls back to vitest's file-count split when no timings exist", async () => {
    process.env.VITEST_SHARD_TIMINGS = path.join(dir, 'missing.json');
    const shards = await allShards(4);
    expect(shards.map((s) => s.length)).toEqual([8, 8, 7, 7]);
    expect(new Set(shards.flat())).toEqual(new Set(specs));
  });
});

describe('fetch subcommand', () => {
  /** A stand-in `gh`: `run list` prints `runs`; `run download <id>` writes `artifacts[id]`. */
  function fakeGh(runs, artifacts) {
    const bin = path.join(dir, 'gh');
    writeFileSync(path.join(dir, 'runs.json'), JSON.stringify(runs));
    writeFileSync(path.join(dir, 'artifacts.json'), JSON.stringify(artifacts));
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2), d = ${JSON.stringify(dir)};
if (a[1] === 'list') { process.stdout.write(fs.readFileSync(path.join(d, 'runs.json'))); process.exit(0); }
const arts = JSON.parse(fs.readFileSync(path.join(d, 'artifacts.json'), 'utf8'))[a[2]];
if (!arts) { console.error('no valid artifacts found to download'); process.exit(1); }
const out = a[a.indexOf('--dir') + 1];
for (const [name, files] of Object.entries(arts)) {
  fs.mkdirSync(path.join(out, name), { recursive: true });
  fs.writeFileSync(path.join(out, name, 'test-timings.json'), JSON.stringify({ files }));
}
`,
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  function fetch(bin) {
    const out = path.join(dir, 'out.json');
    const r = spawnSync(process.execPath, [SCRIPT, 'fetch', '--out', out], {
      encoding: 'utf8',
      env: { ...process.env, DURATION_SHARDS_GH: bin, GITHUB_REPOSITORY: '' },
    });
    expect(r.status).toBe(0);
    return JSON.parse(readFileSync(out, 'utf8'));
  }

  it('merges the newest completed main run that has timings, skipping PR runs and runs without', () => {
    const bin = fakeGh(
      [
        { databaseId: 9, event: 'pull_request' },
        { databaseId: 8, event: 'push' },
        { databaseId: 7, event: 'push' },
      ],
      {
        9: { 'test-timings-x-1': { 'pr.test.ts': 1 } },
        7: { 'test-timings-x-1': { 'a.test.ts': 10 }, 'test-timings-x-2': { 'b.test.ts': 20 } },
      },
    );
    expect(fetch(bin)).toEqual({ runId: 7, files: { 'a.test.ts': 10, 'b.test.ts': 20 } });
  });

  it('writes empty timings (the fallback) when no run has any', () => {
    const bin = fakeGh([{ databaseId: 8, event: 'push' }], {});
    expect(fetch(bin)).toEqual({ runId: null, files: {} });
  });
});
