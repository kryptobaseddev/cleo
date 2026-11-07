/**
 * `CLEO_RESOURCE_SAMPLE_FILE` (T14282): the test suite's fixed resource
 * sample, honoured only below the test sandbox marker. Outside it, a hot or
 * calm file has no effect and one stderr line says it was ignored, so it can
 * never fake a calm host on a real machine.
 *
 * @task T14282
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_SANDBOX_MARKER } from '../../store/worktree-build-guard.js';
import { admit } from '../admission-ledger.js';
import { DarwinResourceBackend } from '../darwin-backend.js';
import { LinuxResourceBackend } from '../linux-backend.js';
import { defaultResourceBackend, pressureScore } from '../monitor.js';
import { _resetMemoryGateForTest } from '../pressure-gate.js';
import {
  _resetSampleFixtureForTest,
  RESOURCE_SAMPLE_FILE_ENV,
  sampleFixturePath,
} from '../sample-fixture.js';

const GIB = 1024 ** 3;

function sampleJson(some: number): string {
  const line = { avg10: some, avg60: some, avg300: some, totalUs: 0 };
  const zero = { avg10: 0, avg60: 0, avg300: 0, totalUs: 0 };
  return JSON.stringify({
    sampledAtMs: 0,
    pressureAvailable: true,
    memAvailableBytes: 8 * GIB,
    globalPressure: { some: line, full: zero },
    slicePressure: null,
    cpuPressure: null,
    walObservations: [],
  });
}

let inside: string;
let outside: string;
const saved = process.env[RESOURCE_SAMPLE_FILE_ENV];

beforeEach(() => {
  _resetSampleFixtureForTest();
  _resetMemoryGateForTest();
  // A sandbox of our own (marker at its root), and a directory beside the
  // fork's sandbox, where no marker sits in any ancestor.
  inside = mkdtempSync(join(process.env.CLEO_HOME ?? dirname(process.cwd()), 'fixture-in-'));
  writeFileSync(join(inside, TEST_SANDBOX_MARKER), 'test\n');
  mkdirSync(join(inside, 'deep'));
  outside = mkdtempSync(join(dirname(process.env.CLEO_HOME ?? process.cwd()), 'fixture-out-'));
});

afterEach(() => {
  rmSync(inside, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  if (saved === undefined) delete process.env[RESOURCE_SAMPLE_FILE_ENV];
  else process.env[RESOURCE_SAMPLE_FILE_ENV] = saved;
  _resetSampleFixtureForTest();
  _resetMemoryGateForTest();
});

describe('CLEO_RESOURCE_SAMPLE_FILE (T14282)', () => {
  it('below the sandbox marker, the default backend returns the fixture', async () => {
    const path = join(inside, 'deep', 'hot.json');
    writeFileSync(path, sampleJson(40));
    process.env[RESOURCE_SAMPLE_FILE_ENV] = path;
    expect(sampleFixturePath()).toBe(path);
    const sample = await defaultResourceBackend().sample();
    expect(pressureScore(sample)).toBe(40);
    expect(sample.sampledAtMs).toBeGreaterThan(0);
  });

  it('a hot fixture drives the real admission: the memory gate refuses', async () => {
    const path = join(inside, 'hot.json');
    writeFileSync(path, sampleJson(40));
    process.env[RESOURCE_SAMPLE_FILE_ENV] = path;
    // 4 GiB: above the small-run floor, so the latch holds it (T14206).
    const out = await admit(
      { label: 'tool:test', footprintBytes: 4 * GIB },
      {
        dir: join(inside, 'admission'),
        capacityBytes: 32 * GIB,
        env: {},
        wait: false,
        topMemory: () => [],
      },
    );
    expect(out.admitted).toBe(false);
    if (!out.admitted) expect(out.refusal.memoryPressure?.score).toBe(40);
  });

  it.each([
    ['hot', 40],
    ['calm', 0],
  ])('outside the sandbox a %s file has no effect, with one stderr line', async (_name, some) => {
    const path = join(outside, 'sample.json');
    writeFileSync(path, sampleJson(some));
    const lines: string[] = [];
    const env = { [RESOURCE_SAMPLE_FILE_ENV]: path };
    expect(sampleFixturePath(env, (l) => lines.push(l))).toBeNull();
    expect(sampleFixturePath(env, (l) => lines.push(l))).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${RESOURCE_SAMPLE_FILE_ENV} is ignored`);
    process.env[RESOURCE_SAMPLE_FILE_ENV] = path;
    // The backend reads this machine (the platform sampler, spied to a known value).
    const HOST_SCORE = 7;
    const host = JSON.parse(sampleJson(HOST_SCORE));
    vi.spyOn(DarwinResourceBackend.prototype, 'sample').mockResolvedValue(host);
    vi.spyOn(LinuxResourceBackend.prototype, 'sample').mockResolvedValue(host);
    _resetSampleFixtureForTest();
    expect(pressureScore(await defaultResourceBackend().sample())).toBe(HOST_SCORE);
    vi.restoreAllMocks();
  });

  it('a sandboxed sample used for a project outside the sandbox has no effect, with one stderr line', async () => {
    const path = join(inside, 'calm.json');
    writeFileSync(path, sampleJson(0));
    // A real git project beside the sandbox: no marker in any ancestor.
    const repo = join(outside, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const lines: string[] = [];
    const env = { [RESOURCE_SAMPLE_FILE_ENV]: path };
    expect(sampleFixturePath(env, (l) => lines.push(l), repo)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('the file and the project both lie below');
    // The same file for a project inside the sandbox is honoured.
    expect(sampleFixturePath(env, () => {}, inside)).toBe(path);
    // Resolved the way admission resolves it (CLEO_ROOT), the backend reads the host.
    const savedRoot = process.env.CLEO_ROOT;
    process.env.CLEO_ROOT = repo;
    process.env[RESOURCE_SAMPLE_FILE_ENV] = path;
    try {
      // The backend reads this machine (the platform sampler, spied to a known value).
      const HOST_SCORE = 7;
      const host = JSON.parse(sampleJson(HOST_SCORE));
      vi.spyOn(DarwinResourceBackend.prototype, 'sample').mockResolvedValue(host);
      vi.spyOn(LinuxResourceBackend.prototype, 'sample').mockResolvedValue(host);
      _resetSampleFixtureForTest();
      expect(pressureScore(await defaultResourceBackend().sample())).toBe(HOST_SCORE);
      vi.restoreAllMocks();
    } finally {
      if (savedRoot === undefined) delete process.env.CLEO_ROOT;
      else process.env.CLEO_ROOT = savedRoot;
    }
  });

  it('a marker inside a git checkout is not a sandbox', () => {
    mkdirSync(join(outside, '.git'));
    writeFileSync(join(outside, TEST_SANDBOX_MARKER), 'planted\n');
    const path = join(outside, 'sample.json');
    writeFileSync(path, sampleJson(0));
    expect(sampleFixturePath({ [RESOURCE_SAMPLE_FILE_ENV]: path }, () => {})).toBeNull();
  });
});
