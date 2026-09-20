/** Independent watcher I/O regressions; never contact GitHub or npm. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = resolve('scripts/release-installability-watch.mjs');

describe('watcher process failure truth', () => {
  it('does not turn a failed issue-list read into an empty successful sweep', () => {
    const root = mkdtempSync(join(tmpdir(), 'watch-read-failure-'));
    try {
      mkdirSync(join(root, 'bin'));
      writeFileSync(join(root, 'bin/gh'), '#!/bin/sh\necho "synthetic read denied" >&2\nexit 7\n', {
        mode: 0o700,
      });
      const result = spawnSync(process.execPath, [script], {
        env: { PATH: join(root, 'bin'), HOME: root, TMPDIR: root, DRY_RUN: 'true' },
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('nothing to watch');
      expect(result.stdout + result.stderr).toContain('issue');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Inputs are independent fake I/O; all default network/process functions are replaced. */
function scenario(overrides = {}) {
  const at = Date.parse('2026-09-20T05:00:00Z');
  const state = {
    version: '2026.9.8',
    distTag: 'latest',
    packages: ['cleo', 'core'],
    ...overrides.state,
  };
  const issue = {
    number: 1495,
    title: 'v2026.9.8 published',
    createdAt: '2026-09-20T04:30:00Z',
    labels: [],
    body: `Preserved historical release conclusion.\n<!-- release-installability-state\n${JSON.stringify(state)}\n-->`,
    ...overrides.issue,
  };
  const calls = [];
  const options = {
    env: {
      GITHUB_EVENT_NAME: 'schedule',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_SHA: 'source-revision',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'synthetic/repo',
      ...overrides.env,
    },
    now: () => at,
    github: async (args) => {
      calls.push(args);
      return args[1] === 'list' ? JSON.stringify([issue]) : '';
    },
    checkPackages: async (packages) =>
      packages.map((pkg) => ({ pkg, ok: true, rung: 'installable' })),
    readPackages: async () => ['cleo', 'core'],
    ...overrides.io,
  };
  return { options, calls, state };
}

// Importing only evaluates helpers. It does not execute the real watcher.
const { observeInstallability, parseState, shouldCheckNow, compareVersions } = await import(
  '../release-installability-watch.mjs'
);

describe('watcher structured observations', () => {
  it('records terminal success before closure and keeps immutable provenance', async () => {
    const { options, calls } = scenario();
    const result = await observeInstallability(options);
    expect(result.exitCode).toBe(0);
    expect(result.inventory).toMatchObject({ matched: 1, coverage: 'current' });
    const observed = result.observations[0];
    expect(observed).toMatchObject({
      outcome: 'installable',
      trigger: 'schedule',
      coverage: 'current',
      lastSuccessfulObservationAt: '2026-09-20T05:00:00.000Z',
      persistence: 'succeeded',
      actions: ['state-recorded', 'comment-recorded', 'closed'],
    });
    expect(result.run).toEqual({
      id: '42',
      attempt: '2',
      revision: 'source-revision',
      url: 'https://github.com/synthetic/repo/actions/runs/42',
    });
    expect(calls.map((args) => args[1])).toEqual(['list', 'edit', 'comment', 'close']);
    const body = calls[1][4];
    expect(body).toContain('Preserved historical release conclusion.');
    expect(parseState(body).lastObservation.outcome).toBe('installable');
    expect(result.evidence.installedContent).toBe('unverified');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(observed.results[0])).toBe(true);
    expect(() => {
      observed.results[0].ok = false;
    }).toThrow();
  });

  it('retains pending checks with actual package results without closing', async () => {
    const { options, calls } = scenario({
      io: {
        checkPackages: async () => [
          { pkg: 'cleo', ok: false, rung: 'metadata', reason: 'metadata HTTP 404' },
          { pkg: 'core', ok: true, rung: 'installable' },
        ],
      },
    });
    const result = await observeInstallability(options);
    expect(result.exitCode).toBe(0);
    expect(result.observations[0].outcome).toBe('pending');
    expect(result.observations[0].results[0]).toMatchObject({
      ok: false,
      reason: 'metadata HTTP 404',
    });
    expect(calls.map((args) => args[1])).toEqual(['list', 'edit']);
  });

  it('persists supersession as distinct from installability', async () => {
    const { options, calls } = scenario({
      io: {
        checkPackages: async () => [
          { pkg: 'cleo', ok: false, rung: 'dist-tag', reason: 'latest resolves to "2026.9.9"' },
          { pkg: 'core', ok: true },
        ],
      },
    });
    const result = await observeInstallability(options);
    expect(result.observations[0].outcome).toBe('superseded');
    expect(parseState(calls[1][4]).lastObservation.results[0].ok).toBe(false);
    expect(calls.at(-1)).toEqual(['issue', 'close', '1495', '--reason', 'not planned']);
  });

  it('keeps last successful observation when a later registry attempt fails', async () => {
    const { options, calls } = scenario({
      state: {
        lastSuccessfulObservationAt: '2026-09-19T05:00:00Z',
        lastObservation: { outcome: 'pending' },
      },
      io: {
        checkPackages: async () => {
          throw new Error('secret-token-must-not-be-logged');
        },
      },
    });
    const result = await observeInstallability(options);
    const item = result.observations[0];
    expect(result.exitCode).toBe(1);
    expect(item).toMatchObject({
      outcome: 'failed',
      coverage: 'failed',
      observedAt: null,
      lastAttemptedAt: '2026-09-20T05:00:00.000Z',
      lastSuccessfulObservationAt: '2026-09-19T05:00:00Z',
    });
    expect(item.freshness.status).toBe('stale');
    expect(item.previousObservation.outcome).toBe('pending');
    expect(JSON.stringify(result)).not.toContain('secret-token');
    const saved = parseState(calls[1][4]);
    expect(saved.lastSuccessfulObservationAt).toBe('2026-09-19T05:00:00Z');
    expect(saved.lastObservation.previousObservation).toBeUndefined();
  });

  it.each([
    'edit',
    'comment',
    'close',
  ])('reports a failed %s and retains the observed registry outcome', async (operation) => {
    const { options, calls } = scenario();
    const original = options.github;
    options.github = async (args) => {
      if (args[1] === operation) throw Object.assign(new Error('sensitive body'), { status: 9 });
      return original(args);
    };
    const result = await observeInstallability(options);
    expect(result.exitCode).toBe(1);
    expect(result.observations[0]).toMatchObject({ outcome: 'installable', persistence: 'failed' });
    expect(result.observations[0].diagnostics).toContainEqual(
      expect.objectContaining({ operation: 'issue-write', exitCode: 9 }),
    );
    expect(calls.filter((args) => args[1] === 'close')).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('sensitive body');
  });

  it.each([
    '',
    '{}',
    'null',
    '[{"number":1}]',
  ])('rejects malformed issue inventories (%s)', async (raw) => {
    const { options } = scenario({ io: { github: async () => raw } });
    const result = await observeInstallability(options);
    expect(result.exitCode).toBe(1);
    expect(result.inventory).toMatchObject({ matched: null, coverage: 'failed' });
    expect(result.diagnostics[0].operation).toBe('issue-list');
  });

  it('distinguishes a successful empty read from a failed one', async () => {
    const { options } = scenario({ io: { github: async () => '[]' } });
    const result = await observeInstallability(options);
    expect(result.exitCode).toBe(0);
    expect(result.inventory).toMatchObject({ matched: 0, coverage: 'current' });
    expect(result.observations).toEqual([]);
  });

  it('reports malformed tracker state as failed instead of silently skipping it', async () => {
    const { options, calls } = scenario({ issue: { body: 'No valid state' } });
    const result = await observeInstallability(options);
    expect(result.exitCode).toBe(1);
    expect(result.observations[0].diagnostics[0].code).toBe('E_WATCH_STATE_INVALID');
    expect(calls).toHaveLength(1);
  });

  it('does not promote legacy timestamps to verified new provenance', async () => {
    const { options } = scenario({
      state: { lastCheckedAt: '2026-09-20T04:55:00Z' },
      issue: { createdAt: '2026-09-19T04:00:00Z' },
    });
    const result = await observeInstallability(options);
    expect(result.observations[0]).toMatchObject({
      outcome: 'not-due',
      attemptedAt: null,
      lastSuccessfulObservationAt: null,
      coverage: 'partial',
      freshness: { status: 'missing' },
    });
  });

  it('uses exact version identity rather than ambiguous title substring', async () => {
    const { options, calls } = scenario({ env: { WATCH_VERSION: '2026.9.1', DRY_RUN: 'true' } });
    const result = await observeInstallability(options);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      issueId: null,
      version: '2026.9.1',
      persistence: 'not-requested-dry-run',
    });
    expect(calls).toHaveLength(1);
  });

  it('does not mutate trackers in dry-run mode', async () => {
    const { options, calls } = scenario({ env: { DRY_RUN: 'true' } });
    const result = await observeInstallability(options);
    expect(result.observations[0].outcome).toBe('installable');
    expect(calls).toHaveLength(1);
  });

  it('refuses an incomplete registry result set rather than report success', async () => {
    const { options } = scenario({
      io: { checkPackages: async () => [{ pkg: 'core', ok: true }] },
    });
    const result = await observeInstallability(options);
    expect(result.exitCode).toBe(1);
    expect(result.observations[0]).toMatchObject({ outcome: 'failed', coverage: 'failed' });
  });

  it('does not close a historical tracker verified against a fallback current package list', async () => {
    const { options, calls } = scenario({ state: { packages: undefined } });
    const result = await observeInstallability(options);
    expect(result.observations[0]).toMatchObject({ outcome: 'installable', coverage: 'partial' });
    expect(calls.map((args) => args[1])).toEqual(['list', 'edit']);
  });

  it('reports a bounded issue inventory as partial when its limit is reached', async () => {
    const { options } = scenario({
      env: { DRY_RUN: 'true' },
      io: {
        github: async () =>
          JSON.stringify(
            Array.from({ length: 1000 }, (_, n) => ({
              number: n + 1,
              title: 'legacy',
              body: '',
              createdAt: '2026-09-20T04:30:00Z',
              labels: [],
            })),
          ),
      },
    });
    const result = await observeInstallability(options);
    expect(result.exitCode).toBe(1);
    expect(result.inventory).toMatchObject({ matched: 1000, coverage: 'partial' });
  });
});

describe('existing watcher cadence and version contracts', () => {
  it('retains escalation intervals and prerelease ordering', () => {
    expect(shouldCheckNow(1000, 0)).toBe(true);
    expect(shouldCheckNow(2 * 3600000, 29 * 60000)).toBe(false);
    expect(shouldCheckNow(2 * 3600000, 30 * 60000)).toBe(true);
    expect(shouldCheckNow(7 * 3600000, 59 * 60000)).toBe(false);
    expect(shouldCheckNow(7 * 3600000, 60 * 60000)).toBe(true);
    expect(compareVersions('2026.9.8-beta.1', '2026.9.8')).toBeLessThan(0);
    expect(compareVersions('2026.9.9', '2026.9.8')).toBeGreaterThan(0);
    expect(parseState('<!-- release-installability-state null -->')).toBeNull();
  });
});

describe('watcher actual artifact and summary output', () => {
  it.each([0, 7])('retains a structured artifact and summary when GitHub exits %s', (code) => {
    const root = mkdtempSync(join(tmpdir(), 'watch-artifact-'));
    try {
      mkdirSync(join(root, 'bin'));
      writeFileSync(join(root, 'bin/gh'), `#!/bin/sh\nprintf '[]'\nexit ${code}\n`, {
        mode: 0o700,
      });
      const artifact = join(root, 'observation.json');
      const summary = join(root, 'summary.md');
      const result = spawnSync(process.execPath, [script], {
        env: {
          PATH: join(root, 'bin'),
          HOME: root,
          TMPDIR: root,
          DRY_RUN: 'true',
          WATCH_OBSERVATION_PATH: artifact,
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_EVENT_NAME: 'schedule',
          GITHUB_RUN_ID: 'actual-process-fixture',
        },
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(code === 0 ? 0 : 1);
      const report = JSON.parse(readFileSync(artifact, 'utf8'));
      expect(report).toEqual(JSON.parse(result.stdout));
      expect(report.trigger).toBe('schedule');
      expect(report.run.id).toBe('actual-process-fixture');
      expect(report.inventory.coverage).toBe(code === 0 ? 'current' : 'failed');
      expect(readFileSync(summary, 'utf8')).toContain(`Inventory: ${report.inventory.coverage}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    'WATCH_OBSERVATION_PATH',
    'GITHUB_STEP_SUMMARY',
  ])('returns failure when %s cannot be written', (key) => {
    const root = mkdtempSync(join(tmpdir(), 'watch-output-failure-'));
    try {
      mkdirSync(join(root, 'bin'));
      writeFileSync(join(root, 'bin/gh'), '#!/bin/sh\nprintf "[]"\n', { mode: 0o700 });
      const result = spawnSync(process.execPath, [script], {
        env: {
          PATH: join(root, 'bin'),
          HOME: root,
          TMPDIR: root,
          DRY_RUN: 'true',
          [key]: join(root, 'missing/output'),
        },
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.inventory.coverage).toBe('current');
      expect(report.diagnostics[0].operation).toBe(
        key === 'GITHUB_STEP_SUMMARY' ? 'step-summary-write' : 'observation-artifact-write',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('observation lifetime across independent runs', () => {
  it('retains successful payload across a later failed run and exposes an expiring assessment', async () => {
    const pending = async () => [
      { pkg: 'cleo', ok: false, rung: 'metadata', reason: 'metadata HTTP 404' },
      { pkg: 'core', ok: true },
    ];
    const first = scenario({ io: { checkPackages: pending } });
    const firstReport = await observeInstallability(first.options);
    const recorded = parseState(first.calls[1][4]);
    expect(recorded.lastSuccessfulObservation.outcome).toBe('pending');
    expect(firstReport.observations[0].freshness).toMatchObject({
      status: 'current',
      evaluatedAt: '2026-09-20T05:00:00.000Z',
      staleAfterAt: '2026-09-20T05:20:00.000Z',
    });
    const second = scenario({
      state: recorded,
      io: {
        now: () => Date.parse('2026-09-21T05:00:00Z'),
        checkPackages: async () => {
          throw new Error('failed later read');
        },
      },
    });
    const secondReport = await observeInstallability(second.options);
    const secondState = parseState(second.calls[1][4]);
    expect(secondState.lastSuccessfulObservation).toEqual(recorded.lastSuccessfulObservation);
    expect(secondReport.observations[0].lastSuccessfulObservationAt).toBe(
      '2026-09-20T05:00:00.000Z',
    );
    expect(secondReport.observations[0].freshness.status).toBe('stale');
    expect(secondReport.history).toMatchObject({ coverage: 'partial' });
    expect(secondReport.history.excluded).toContain('Closed trackers');
    // Later publication cannot revise the earlier immutable receipt's time.
    expect(firstReport.observations[0].freshness.status).toBe('current');
  });

  it('keeps missing success unknown after a failed attempt', async () => {
    const { options } = scenario({
      io: {
        checkPackages: async () => {
          throw new Error('unavailable');
        },
      },
    });
    const report = await observeInstallability(options);
    expect(report.observations[0]).toMatchObject({
      lastSuccessfulObservationAt: null,
      observedAt: null,
      freshness: { status: 'missing', ageMs: null },
    });
  });
});
